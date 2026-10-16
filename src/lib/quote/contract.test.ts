import { beforeAll, describe, expect, it } from "vitest";
import { loadCustomerProfiles, SettingsSchema, type CustomerProfile, type Settings } from "../settings";
import { contractItemLabel, contractQuoteItem, onlyContractLines, parseContractRequestRegex, parseNewContractItem, resolveContract, startsWithContractAlias, type Contract } from "./contract";
import { profileGuide, profileRequestText, splitProfileHeader } from "./profiles";
import { parseRequestRegex } from "./request";
import type { QuoteRequest } from "./types";

let prosegur: CustomerProfile;
let settings: Settings;
let contract: Contract;

beforeAll(() => {
  process.env.LLM_DISABLED = "1";
  settings = SettingsSchema.parse({ company: { name: "Professional Tyres" }, pricing: { currency: "USD" }, quote: { brandOrigin: { Fenixway: "CHINA PREMIUM" } }, customers: loadCustomerProfiles() });
  prosegur = settings.customers.find((p) => p.name === "Prosegur")!;
  contract = resolveContract(prosegur)!;
});

/** What the bot does with a Prosegur message: header -> "unidad:" / "ub:" lines, the profile's defaults, then the contract-aware parse. */
function read(text: string): QuoteRequest {
  const t = profileRequestText(settings, prosegur, text, { startsItem: (rest) => startsWithContractAlias(rest, contract.items) });
  return parseContractRequestRegex(t.text, contract.items);
}
const codes = (r: QuoteRequest) => r.lines.map((l) => [l.contract?.id ?? null, l.quantity]);

describe("Prosegur contract: config and DB rows", () => {
  it("customers.json has the 3 contract items; the DB wins per id (field by field) and adds items", () => {
    expect(contract.note).toBe("Contrato Prosegur 2 años · precios sin IGV");
    expect(contract.items.map(contractItemLabel)).toEqual([
      "v99 · Fenixway Valor 99 · 215/75R17.5 18PR · MIXT · US$ 123.17",
      "v89 · Fenixway Valor 89 · 215/75R17.5 18PR · POST · US$ 126.42",
      "f77 · Fenixway Flama 77 · 215/75R17.5 18PR · sin aplicación · US$ 116.34",
    ]);
    const merged = resolveContract(prosegur, [
      { id: "V99", price: 125.5, updatedBy: "18605180534" }, // only the price stored: the rest is the config's
      { id: "f77", application: "POST", price: 116.34 },
      { id: "f66", brand: "Fenixway", model: "Flama 66", size: "215/75R17.5", ply: 18, application: "POST", price: 118, aliases: ["f66", "flama 66"] },
      { id: "x1", brand: "Nada" }, // an extra item without a price is ignored
    ])!;
    expect(merged.items.map((i) => [i.id, i.price, i.application, i.source, i.inConfig])).toEqual([
      ["v99", 125.5, "MIXT", "db", true],
      ["v89", 126.42, "POST", "config", true],
      ["f77", 116.34, "POST", "db", true],
      ["f66", 118, "POST", "db", false],
    ]);
    expect(merged.items[0]).toMatchObject({ brand: "Fenixway", model: "Valor 99", size: "215/75R17.5", ply: 18, aliases: ["v99", "v 99", "valor 99", "mixta", "mixt"], updatedBy: "18605180534" });
  });

  it("a contract line becomes a quote item at the contract price", () => {
    const r = read("prosegur ayacucho 1830\n2 v99");
    const it = contractQuoteItem(r.lines[0], 2, settings);
    expect(it).toMatchObject({ description: "215/75R17.5 18PR FENIXWAY VALOR 99", brand: "Fenixway", model: "Valor 99", size: "215/75R17.5", sizeDisplay: "215/75R17.5", ply: 18, application: "MIXT", quantity: 2, unitPrice: 123.17, listPrice: 123.17, discountPct: 0, total: 246.34, origin: "contract", provider: "contrato", code: "v99", countryOfOrigin: "CHINA PREMIUM" });
    expect(contractQuoteItem(r.lines[0], 2, settings, 130)).toMatchObject({ unitPrice: 130, listPrice: 123.17, discountPct: 0, total: 260, origin: "contract" }); // "precio 1 130"
  });

  it("'nuevo: f66 = …' is read into an item (aliases: code + model)", () => {
    expect(parseNewContractItem("f66 = Fenixway Flama 66 215/75R17.5 18PR POST 118.00", contract)).toMatchObject({ id: "f66", aliases: ["f66", "flama 66"], brand: "Fenixway", model: "Flama 66", size: "215/75R17.5", ply: 18, application: "POST", price: 118, currency: "USD" });
    expect(parseNewContractItem("F55 = Fenixway Flama 55 115,50", contract)).toMatchObject({ id: "f55", model: "Flama 55", size: "215/75R17.5", ply: 18, application: null, price: 115.5 }); // the contract's size and ply
    expect(parseNewContractItem("f66 = Fenixway Flama 66 POST", contract)).toMatch(/Falta el precio/);
    expect(parseNewContractItem("Fenixway Flama 66 118", contract)).toMatch(/Escríbelo así/);
  });
});

describe("Prosegur shorthand: header and contract lines", () => {
  it("the four ways of writing 2 v99 + 4 v89", () => {
    for (const text of [
      "prosegur ayacucho 1830\n2 v99\n4 v89",
      "prosegur ayacucho 1830, 2 v99, 4 v89",
      "prosegur ayacucho 1830\n215 mixta v99 quiero 2\n215 posterior v89 quiero 4",
      "prosegur ayacucho ub 1830\nv99 x2\nv89 x4 ub 1845",
    ]) {
      const r = read(text);
      expect(codes(r), text).toEqual([
        ["v99", 2],
        ["v89", 4],
      ]);
      expect(r, text).toMatchObject({ unit: "Ayacucho", ub: "1830", customerCompany: "PROSEGUR SA", paymentType: "FACTURA", deliveryTerm: "48 HRS POST OC", showPricesWithTax: false });
      expect(r.lines.map((l) => [l.brand, l.model, l.size?.canonical, l.ply, l.application]), text).toEqual([
        ["Fenixway", "Valor 99", "215/75R17.5", 18, "MIXT"],
        ["Fenixway", "Valor 89", "215/75R17.5", 18, "POST"],
      ]);
    }
    // "ub 1845" on a line is that line's UB; the header's is the quote's
    expect(read("prosegur ayacucho ub 1830\nv99 x2\nv89 x4 ub 1845").lines.map((l) => l.ub)).toEqual([undefined, "1845"]);
  });

  it("header: unit words up to the UB, an item code, a comma or the end of the line", () => {
    const head = (t: string) => {
      const h = splitProfileHeader(prosegur, t, (rest) => startsWithContractAlias(rest, contract.items));
      return [h.unit, h.ub];
    };
    expect(head("prosegur ayacucho 1830")).toEqual(["Ayacucho", "1830"]);
    expect(head("Prosegur AYACUCHO u.b. 1830")).toEqual(["Ayacucho", "1830"]);
    expect(head("coti para prosegur ayacucho")).toEqual(["Ayacucho", undefined]);
    expect(head("Prosegur S.A. cerro de pasco ub:2001")).toEqual(["Cerro de Pasco", "2001"]);
    expect(head("prosegur unidad lima norte 1900, 2 v99")).toEqual(["Lima Norte", "1900"]);
    expect(head("prosegur ayacucho v99 x2")).toEqual(["Ayacucho", undefined]); // the code ends the unit
    expect(head("prosegur ayacucho mixta x2")).toEqual(["Ayacucho", undefined]);
    expect(head("prosegur 1830")).toEqual([undefined, "1830"]);
    expect(head("prosegur")).toEqual([undefined, undefined]);
    expect(head("prosegur\nMichelin 295/80R22.5 X Multi Z x2")).toEqual([undefined, undefined]); // the name alone on its line
    expect(head("Michelin 295/80R22.5 x2 para Prosegur, ana@prosegur.pe")).toEqual([undefined, undefined]);
    const mid = read("coti para prosegur ayacucho\n2 v99");
    expect(mid).toMatchObject({ unit: "Ayacucho", customerCompany: "PROSEGUR SA" });
    expect(mid.ub).toBeUndefined();
    expect(codes(mid)).toEqual([["v99", 2]]);
    expect(profileRequestText(settings, prosegur, "prosegur ayacucho 1830")).toMatchObject({ bare: true, header: ["unidad: Ayacucho", "ub: 1830"] });
    expect(profileRequestText(settings, prosegur, "prosegur")).toMatchObject({ bare: true, header: [] });
  });

  it("a full line naming an item by brand + model is a contract line; another model of the same size is not", () => {
    const r = read("prosegur ayacucho 1830\n215/75R17.5 18PR Fenixway Valor 99 x2\n215/75R17.5 Fenixway Valor 87 x2");
    expect(codes(r)).toEqual([
      ["v99", 2],
      [null, 2],
    ]);
    expect(r.lines[1]).toMatchObject({ brand: "Fenixway", model: "VALOR 87" }); // for the price lists
    expect(r.lines[1].contract).toBeUndefined();
    expect(codes(read("prosegur ayacucho 1830\nFlama 77 x3"))).toEqual([["f77", 3]]);
  });

  it("mixed request: contract lines first, the others (with their own position groups) for the normal parser", () => {
    const r = read("prosegur ayacucho 1830\n2 v99\nMichelin 295/80R22.5 X Multi Z x2\n295/80R22.5 2 mixtas, 8 de tracción\n4 v89");
    expect(r.lines.map((l) => [l.contract?.id ?? l.size?.canonical, l.model ?? "", l.position ?? "", l.quantity])).toEqual([
      ["v99", "Valor 99", "", 2],
      ["v89", "Valor 89", "", 4],
      ["295/80R22.5", "X MULTI Z", "", 2],
      ["295/80R22.5", "", "MIX", 2],
      ["295/80R22.5", "", "TRAC", 8], // "8 de tracción" belongs to the 295/80R22.5 line, it is not a v89
    ]);
  });

  it("quantities, plates, UBs; same item twice is one line; two items on one line", () => {
    expect(codes(read("prosegur ayacucho 1830\n2 mixtas\n4 posteriores"))).toEqual([
      ["v99", 2],
      ["v89", 4],
    ]);
    expect(codes(read("prosegur ayacucho 1830\nv99 x 3\ndos v89\nf77"))).toEqual([
      ["v99", 3],
      ["v89", 2],
      ["f77", 1],
    ]);
    expect(codes(read("prosegur ayacucho 1830\n2 unds v99\nv99 1"))).toEqual([["v99", 3]]); // merged
    expect(codes(read("prosegur ayacucho 1830 2 v99 4 v89"))).toEqual([
      ["v99", 2],
      ["v89", 4],
    ]);
    expect(codes(read("prosegur ayacucho 1830\n2 v99 y 4 posteriores"))).toEqual([
      ["v99", 2],
      ["v89", 4],
    ]);
    const r = read("prosegur ayacucho\nv99 x2 BLM-923\nv89 1845 x4\n215/75 v89 quiero 1 18pr ub 2001");
    expect(r.lines.map((l) => [l.contract?.id, l.quantity, l.plate, l.ub])).toEqual([
      ["v99", 2, "BLM-923", undefined],
      ["v89", 4, undefined, "1845"], // a bare 4-digit number on an item line is its UB
      ["v89", 1, undefined, "2001"],
    ]);
    expect(r.ub).toBeUndefined();
  });

  it("position words only make a contract line where they look like an item; field lines never do", () => {
    const r = read("prosegur ayacucho 1830\n2 v99\nfavor entregar mañana en la base post OC\nentrega: 48 HRS POST OC\nMichelin mixta x2");
    expect(codes(r)).toEqual([["v99", 2]]);
    expect(r.deliveryTerm).toBe("48 HRS POST OC");
    // the contract items' own application wins over the words of the line
    expect(read("prosegur ayacucho 1830\nv89 mixta x2").lines[0]).toMatchObject({ contract: { id: "v89" }, application: "POST" });
  });

  it("a message that is nothing but contract lines (items sent one message at a time)", () => {
    const only = (t: string) => onlyContractLines(t, contract.items)?.map((l) => [l.contract?.id, l.quantity, l.ub]) ?? null;
    expect(only("4 v89")).toEqual([["v89", 4, undefined]]);
    expect(only("2 v99, 4 v89 ub 1845")).toEqual([
      ["v99", 2, undefined],
      ["v89", 4, "1845"],
    ]);
    expect(only("215/75R17.5 18PR Fenixway Valor 99 x2")).toEqual([["v99", 2, undefined]]);
    expect(only("4 v89\nsolicitante: Ana")).toBeNull(); // something else too
    expect(only("Michelin 295/80R22.5 X Multi Z x2")).toBeNull();
    expect(only("Johann Castañeda")).toBeNull();
    expect(only("")).toBeNull();
  });

  it("requests without contract lines parse exactly as before", () => {
    for (const text of ["prosegur\nMichelin 295/80R22.5 X Multi Z x2\nBridgestone 11R22.5 R268 x4\ncorreo flota@prosegur.com.pe", "Michelin 295/80R22.5 X Multi Z x2 UB 1830 para Prosegur, ana@prosegur.pe\nunidad: Lima\nsolicitante: Ana\npago: contado"]) {
      expect(parseContractRequestRegex(text, contract.items)).toEqual(parseRequestRegex(text));
      const t = profileRequestText(settings, prosegur, text, { startsItem: (rest) => startsWithContractAlias(rest, contract.items) });
      expect(t.header).toEqual([]);
    }
  });

  it("the bare 'prosegur' guide is three lines with the codes", () => {
    const guide = profileGuide(prosegur, contract.items.map((i) => i.id));
    expect(guide.split("\n")).toEqual([
      "Primera línea: *prosegur ayacucho 1830* (unidad y UB)",
      "Debajo, una llanta por línea: *2 v99*, *4 v89* (códigos: v99, v89, f77)",
      "Te mando PDF + Excel; revisa y responde *enviar*.",
    ]);
  });
});
