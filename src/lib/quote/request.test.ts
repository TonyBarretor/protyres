import { beforeAll, describe, expect, it } from "vitest";
import { describeRequest, extractUb, parseDiscount, parseQuantity, parseRequestRegex, parseTaxMode, parseTerms } from "./request";

beforeAll(() => {
  process.env.LLM_DISABLED = "1";
});

describe("salesman one-liners", () => {
  it("full request with discount and tax mode", () => {
    const r = parseRequestRegex("Fenixway 295/80R22.5 Valor 87 x4 para Transportes ABC, juan@abc.com, dscto 10% sin igv");
    expect(r.lines.length).toBe(1);
    const l = r.lines[0];
    expect(l.brand).toBe("Fenixway");
    expect(l.size?.canonical).toBe("295/80R22.5");
    expect(l.model).toBe("VALOR 87");
    expect(l.quantity).toBe(4);
    expect(r.customerCompany).toBe("Transportes ABC");
    expect(r.customerEmail).toBe("juan@abc.com");
    expect(r.discountPct).toBe(10);
    expect(r.showPricesWithTax).toBe(false);
    expect(describeRequest(r)).toBe("Fenixway 295/80R22.5 VALOR 87 x4 · Transportes ABC · juan@abc.com · dscto 10% · sin IGV");
  });
  it("position words and leading quantity", () => {
    const r = parseRequestRegex("02 llantas delanteras 7.50-16 16PR para Jose Luis Muñoz");
    expect(r.lines[0].size?.canonical).toBe("7.5-16");
    expect(r.lines[0].quantity).toBe(2);
    expect(r.lines[0].position).toBe("DEL");
    expect(r.lines[0].ply).toBe(16);
    expect(r.customerName).toBe("Jose Luis Muñoz");
  });
  it("one size, two positions with their own quantities -> two lines (never summed)", () => {
    const cases = [
      "FENIXWAY 295/80R22.5 VALOR 18PR MIXTA X2 Y TRACCIÓN X8, ATN: SRTA. KARINA QUISPE, CON IGV",
      "Fenixway 295/80R22.5 Valor 18PR x2 mixtas y x8 de tracción para Transportes ABC, juan@abc.com",
      "FENIXWAY 295/80R22.5 VALOR 18PR MIXTA X2\nFENIXWAY 295/80R22.5 VALOR 18PR TRACCIÓN X8",
    ];
    for (const text of cases) {
      const r = parseRequestRegex(text);
      expect(r.lines.map((l) => [l.position, l.quantity, l.model])).toEqual([
        ["MIX", 2, "VALOR"],
        ["TRAC", 8, "VALOR"],
      ]);
      expect(r.lines.every((l) => l.brand === "Fenixway" && l.ply === 18 && l.size?.canonical === "295/80R22.5")).toBe(true);
    }
    expect(parseRequestRegex("295/80R22.5 2 mixtas, 8 de tracción").lines.map((l) => [l.position, l.quantity])).toEqual([
      ["MIX", 2],
      ["TRAC", 8],
    ]);
    expect(parseRequestRegex("FENIXWAY 295/80R22.5 VALOR 18PR X10").lines.map((l) => l.quantity)).toEqual([10]);
    expect(parseRequestRegex("295/80R22.5 x4 delanteras, dscto 5%").lines.map((l) => [l.position, l.quantity])).toEqual([["DEL", 4]]);
  });
  it("a quote typed the way the client formats it: application words, plates, a rim", () => {
    const r = parseRequestRegex(`LT7.50R16 14PR SET BLM-923 FENIXWAY VALOR 96 TCF x2
ARO 8.25x22.5 BFX-904 KUMA ACERO EJE EUROP 10H x1
11R22.5 18PR BVV-704 FENIXWAY VALOR 85 POST ON/OFF x8
295/80R22.5 18PR AHN-988 FENIXWAY VALOR 99 MIXT DEL x4
425/65R22.5 20PR ARA-986 WESTLAKE AT557 MIXT x2
para ANCRO SRL, atención: Srta. Karina Quispe, pago: crédito, plazo: 60 días, con igv`);
    expect(r.lines.map((l) => [l.size?.display ?? l.text, l.brand, l.model, l.ply, l.application, l.plate, l.position, l.quantity])).toEqual([
      ["7.50R16", "Fenixway", "VALOR 96", 14, undefined, "BLM-923", undefined, 2],
      ["ARO 8.25x22.5 KUMA ACERO EJE EUROP 10H", undefined, undefined, undefined, "ARO", "BFX-904", undefined, 1],
      ["11R22.5", "Fenixway", "VALOR 85", 18, "POST ON/OFF", "BVV-704", "TRAC", 8],
      ["295/80R22.5", "Fenixway", "VALOR 99", 18, "MIXT DEL", "AHN-988", "DEL", 4],
      ["425/65R22.5", "Westlake", "AT557", 20, "MIXT", "ARA-986", "MIX", 2],
    ]);
    expect(r.customerCompany).toBe("ANCRO SRL");
    expect(r.attention).toBe("Srta. Karina Quispe");
    // model codes that look like plates are left alone
    expect(parseRequestRegex("Westlake 425/65R22.5 AT557 x2").lines[0].plate).toBeUndefined();
    expect(parseRequestRegex("11R22.5 placa BVV704 x8").lines[0].plate).toBe("BVV-704");
  });
  it("helpers", () => {
    expect(parseQuantity("11R22.5 x6")).toBe(6);
    expect(parseQuantity("6 unidades 11R22.5")).toBe(6);
    expect(parseQuantity("02 llantas")).toBe(2);
    expect(parseQuantity("215/75 x R17.5 PIKIN 1 Posterior")).toBe(1); // "1 posterior": a quantity before a position word
    expect(parseDiscount("dscto 15%")).toBe(15);
    expect(parseDiscount("con 12.5 % de descuento")).toBe(12.5);
    expect(parseDiscount("11R22.5 x2")).toBeUndefined();
    expect(parseTaxMode("precios con igv")).toBe(true);
    expect(parseTaxMode("mas igv")).toBe(false);
    expect(parseTaxMode("11R22.5")).toBeUndefined();
  });
});

describe("Prosegur fields: UB, unidad, solicitante, número", () => {
  it("UB per line is kept apart from the model and the quantity", () => {
    const r = parseRequestRegex("215/75R17.5 18PR FENIXWAY VALOR 99 x2 UB 1830\n295/80R22.5 FENIXWAY VALOR 87 ub 1900 x4\n11R22.5 VALOR 96 u.b. 2105 mixta x8\nARO 8.25x22.5 KUMA x1 UB 1830");
    expect(r.lines.map((l) => [l.size?.canonical ?? l.text, l.model, l.quantity, l.ub])).toEqual([
      ["215/75R17.5", "VALOR 99", 2, "1830"],
      ["295/80R22.5", "VALOR 87", 4, "1900"],
      ["11R22.5", "VALOR 96", 8, "2105"],
      ["ARO 8.25x22.5 KUMA", undefined, 1, "1830"],
    ]);
    expect(r.ub).toBeUndefined(); // UB written on an item line is that item's, not the quote's
    expect(describeRequest(r)).toContain("1. Fenixway 215/75R17.5 VALOR 99 18PR UB 1830 x2");
    // a 3-digit UB is not a quantity, a 4-digit one before a position word neither
    expect(parseRequestRegex("Michelin 11R22.5 XZE2+ UB 451").lines[0]).toMatchObject({ quantity: 1, ub: "451", model: "XZE2+" });
    expect(parseRequestRegex("Michelin 11R22.5 XZE2+ UB 1830 delantera").lines[0]).toMatchObject({ quantity: 1, ub: "1830", position: "DEL" });
    // same tyre, two UBs: two lines (never merged)
    expect(parseRequestRegex("215/75R17.5 VALOR 99 x2 UB 1830\n215/75R17.5 VALOR 99 x2 UB 1900").lines.map((l) => [l.quantity, l.ub])).toEqual([
      [2, "1830"],
      [2, "1900"],
    ]);
    // one UB for a line split by positions applies to every group
    expect(parseRequestRegex("Fenixway 295/80R22.5 Valor 18PR mixta x2 y tracción x8 UB 1830").lines.map((l) => [l.position, l.quantity, l.ub])).toEqual([
      ["MIX", 2, "1830"],
      ["TRAC", 8, "1830"],
    ]);
    expect(extractUb("CLUB 1830")).toBeUndefined();
    expect(extractUb("UB 18300")).toBe("18300");
    expect(extractUb("UB 183001")).toBeUndefined();
  });

  it("unidad / ub / solicitante terms, the last value wins", () => {
    const text = `prosegur
215/75R17.5 FENIXWAY VALOR 99 x2
unidad: Ayacucho
ub: 1830
solicitante: Sr. Johann Castañeda
correo flota@prosegur.com.pe`;
    const r = parseRequestRegex(text);
    expect(r).toMatchObject({ unit: "Ayacucho", ub: "1830", requester: "Sr. Johann Castañeda", customerEmail: "flota@prosegur.com.pe" });
    expect(r.customerName).toBeUndefined(); // "Sr. Johann" belongs to solicitante, not to the customer
    expect(r.lines.length).toBe(1);
    expect(r.lines[0]).toMatchObject({ model: "VALOR 99", quantity: 2 });
    expect(describeRequest(r)).toContain("unidad Ayacucho · UB 1830 · solicitante Sr. Johann Castañeda");
    expect(parseTerms("unidad atendida: Cusco, atención: Sr. Pérez")).toMatchObject({ unit: "Cusco", attention: "Sr. Pérez" });
    expect(parseTerms("sede: Arequipa").unit).toBe("Arequipa");
    expect(parseTerms("UB 1830").ub).toBe("1830");
    expect(parseTerms("atención: Sr. Pérez, ub 1830").attention).toBe("Sr. Pérez");
    // corrections appended later override the first value
    expect(parseTerms("unidad: Ayacucho\nub: 1830\nunidad: Cusco\nub 1900\npago: contado\npago: letras")).toMatchObject({ unit: "Cusco", ub: "1900", paymentType: "letras" });
  });

  it("'número 451' sets the quote number and is neither a quantity nor a size", () => {
    for (const n of ["número 451", "numero 451", "nro 451", "n° 451", "Nº 451", "nro. 451"]) {
      const r = parseRequestRegex(`215/75R17.5 FENIXWAY VALOR 99 x2\n${n}`);
      expect(r.quoteNumber).toBe(451);
      expect(r.lines.map((l) => [l.size?.canonical, l.quantity, l.model])).toEqual([["215/75R17.5", 2, "VALOR 99"]]);
    }
    expect(parseRequestRegex("215/75R17.5 VALOR 99 x2, número 451").lines[0].quantity).toBe(2);
    expect(parseRequestRegex("215/75R17.5 VALOR 99 x2, número 451").quoteNumber).toBe(451);
    expect(parseRequestRegex("Orden N° 4500123\n215/75R17.5 x2").quoteNumber).toBeUndefined();
    expect(parseRequestRegex("número 451").lines).toEqual([]);
  });

  it("a customer name ends with its line", () => {
    const r = parseRequestRegex("215/75R17.5 VALOR 99 x2\npara PROSEGUR SA\nvalidez 7 días\nsin igv\nnúmero 451");
    expect(r.customerCompany).toBe("PROSEGUR SA");
    expect(r.validityDays).toBe(7);
    expect(r.showPricesWithTax).toBe(false);
  });
});

describe("customer emails (tables pasted as text)", () => {
  it("sugar-mill RFQ with tyres, patches and quantities", () => {
    const text = `Estimado proveedor, buen día.
La presente es para invitarle a presentar su mejor propuesta económica por los siguientes materiales, puestos en nuestro almacén de Casa Grande.
Fecha máxima de presentación: 06/10
Hora: 12:00
Material Descripción UM Cantidad
5657944 LLANTA 12.5/80 X 18 - 12 PLY R4 UND 2
5102162 LLANTA 19.5L X 24-10 PLY -POST (1T5 UND 2
5583916 PARCHE PARA LLANTA RS-35 VIPAL UND 25
5583917 PARCHE PARA LLANTA VFP-6 VIPAL UND 50
5554521 LLANTA TRACCION 12R22.5 MOD G377 UND 19
5600686 LLANTA 16.9R30 GOOD YEAR SUPER TRACTION UND 2`;
    const r = parseRequestRegex(text);
    const lines = r.lines.map((l) => [l.size?.canonical ?? l.text, l.quantity, l.brand ?? "", l.model ?? "", l.position ?? "", l.ply ?? ""]);
    expect(lines).toEqual([
      ["12.5/80-18", 2, "", "R4", "", 12],
      ["19.5L-24", 2, "", "1T5", "TRAC", 10],
      ["PARCHE PARA LLANTA RS-35 VIPAL", 25, "Vipal", "", "", ""],
      ["PARCHE PARA LLANTA VFP-6 VIPAL", 50, "Vipal", "", "", ""],
      ["12R22.5", 19, "", "G377", "TRAC", ""],
      ["16.9R30", 2, "Goodyear", "SUPER TRACTION", "TRAC", ""],
    ]);
  });

  it("fleet RFQ with one row per tyre is merged", () => {
    const text = `Buen día:
Por favor para cotizar lo siguiente:
Placa unidad Medida de Llanta Planta Zonal Cant Ubicación de Llantas Marcado
BYV-762 215/75 x R17.5 PIKIN 1 Posterior 10 01 26
BYV-762 215/75 x R17.5 PIKIN 1 Posterior 10 02 26
BYV-762 215/75 x R17.5 PIKIN 1 Posterior 10 03 26
BYV-762 215/75 x R17.5 PIKIN 1 Posterior 10 04 26
MONT-13 300 x R15 ICA 1 Delantera 10 05 26
MONT-13 300 x R15 ICA 1 Delantera 10 06 26`;
    const r = parseRequestRegex(text);
    expect(r.lines.map((l) => [l.size?.canonical, l.quantity, l.position])).toEqual([
      ["215/75R17.5", 4, "TRAC"],
      ["300-15", 2, "DEL"],
    ]);
  });

  it("forwarded WhatsApp with a screenshot caption", () => {
    const r = parseRequestRegex("Frank buenas tardes me cotizas llantas 02 llantas delanteras y dos aros\n7.50-16-16 pr track king set\n11x22.5 16 TL AG888");
    expect(r.lines.map((l) => [l.size?.canonical ?? l.text, l.quantity])).toEqual([
      ["aros", 2],
      ["7.5-16", 1],
      ["11-22.5", 1],
    ]);
    expect(r.lines[1].brand).toBe("Track King");
    expect(r.lines[1].ply).toBe(16);
  });
});
