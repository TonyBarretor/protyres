import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ingestCsv, ingestExcel } from "./tabular";
import { ingestPdf, pdfToText } from "./pdf";
import { ingestWhatsAppText, looksLikePriceMessage } from "./whatsapp-text";
import { parseMoney } from "./util";
import type { PriceRow } from "./types";

const samples = path.resolve(process.cwd(), "samples");
const read = (f: string) => fs.readFileSync(path.join(samples, f));

beforeAll(() => {
  // make the heuristics deterministic in CI: no LLM
  process.env.LLM_DISABLED = "1";
});

const find = (rows: PriceRow[], size: string, brand?: string) =>
  rows.find((r) => r.size === size && (!brand || r.brand === brand));

describe("parseMoney", () => {
  it.each([
    ["410", 410, undefined],
    ["$ 410.00", 410, "USD"],
    ["US$ 1,250.50", 1250.5, "USD"],
    ["S/ 1.250,00", 1250, "PEN"],
    ["S/. 820", 820, "PEN"],
    ["410,00", 410, undefined],
    ["1.250", 1250, undefined],
    ["1,250", 1250, undefined],
    ["299.9", 299.9, undefined],
    [425.5, 425.5, undefined],
  ])("%s -> %s %s", (input, value, currency) => {
    const m = parseMoney(input as string | number);
    expect(m?.value).toBe(value);
    expect(m?.currency).toBe(currency);
  });
  it("returns null for non-numbers", () => {
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("consultar")).toBeNull();
  });
});

describe("Excel ingestion (samples/proveedor-a-lista.xlsx)", () => {
  it("reads a classic table, brand sections + description column, and a header-less sheet", async () => {
    const res = await ingestExcel(read("proveedor-a-lista.xlsx"), { provider: "Llantas del Sur", sourceRef: "proveedor-a-lista.xlsx", priceDate: "2026-10-01" });
    const { rows } = res;

    // sheet LISTA: header on row 4, title rows ignored, TOTAL row ignored
    const mz = find(rows, "295/80R22.5", "Michelin");
    expect(mz).toBeDefined();
    expect(mz!.model).toBe("X MULTI Z");
    expect(mz!.cost).toBe(410);
    expect(mz!.currency).toBe("USD");
    expect(mz!.stock).toBe(20);
    expect(mz!.loadIndex).toBe("152/148");
    expect(mz!.speedIndex).toBe("M");
    expect(find(rows, "11R22.5", "Bridgestone")?.cost).toBe(385); // "11 R 22,5"
    expect(find(rows, "10R20", "Westlake")).toBeDefined(); // 1000R20 and 10.00R20 both map to 10R20
    expect(rows.filter((r) => r.size === "10R20" && r.brand === "Westlake").length).toBe(2); // two models
    expect(find(rows, "385/65R22.5", "Hankook")?.cost).toBe(468);
    expect(rows.some((r) => r.raw?.includes("TOTAL"))).toBe(false);

    // sheet CAMIONETA: section rows + description, PEN prices, comma decimals
    const ltx = find(rows, "265/70R16", "Michelin");
    expect(ltx).toBeDefined();
    expect(ltx!.currency).toBe("PEN");
    expect(ltx!.cost).toBe(820);
    expect(ltx!.model.toUpperCase()).toContain("LTX FORCE");
    expect(ltx!.stock).toBe(1);
    expect(find(rows, "205/65R16C", "Michelin")?.cost).toBe(690);
    const ht = find(rows, "LT265/70R17", "Pirelli"); // brand carried from the "PIRELLI" section row
    expect(ht).toBeDefined();
    expect(ht!.cost).toBe(910);
    expect(find(rows, "31X10.5R15", "Pirelli")?.cost).toBe(745);

    // sheet Hoja3: no header -> cell scan
    expect(find(rows, "11R22.5", "Triangle")?.cost).toBe(310);
    expect(find(rows, "12R22.5", "Triangle")?.cost).toBe(345);

    expect(rows.every((r) => r.provider === "Llantas del Sur" && r.priceDate === "2026-10-01")).toBe(true);
    expect(res.stats.rowsParsed).toBe(rows.length);
  });

  it("accepts an explicit column mapping (letters or header names)", async () => {
    const res = await ingestExcel(read("proveedor-a-lista.xlsx"), {
      provider: "P",
      sourceRef: "x.xlsx",
      allSheets: false,
      columns: { brand: "A", size: "MEDIDA", model: "C", price: "E", stock: "F" },
    });
    expect(find(res.rows, "12R22.5", "Goodyear")?.cost).toBe(440);
  });
});

describe("CSV ingestion", () => {
  it("parses quoted thousands and currency symbols", () => {
    const res = ingestCsv(read("proveedor-c-lista.csv").toString("utf8"), { provider: "Importaciones C", sourceRef: "proveedor-c-lista.csv" });
    expect(find(res.rows, "295/80R22.5", "Michelin")?.cost).toBe(1250);
    expect(find(res.rows, "11R22.5", "Yokohama")?.cost).toBe(370);
    expect(find(res.rows, "11R22.5", "Yokohama")?.model).toBe("TY517");
    expect(find(res.rows, "315/80R22.5", "Continental")?.cost).toBe(455.75);
    expect(find(res.rows, "295/80R22.5", "Yokohama")?.stock).toBeNull();
  });
});

describe("PDF ingestion (samples/proveedor-b-lista.pdf)", () => {
  it("extracts text", async () => {
    const { text, pages } = await pdfToText(read("proveedor-b-lista.pdf"));
    expect(pages).toBe(1);
    expect(text).toContain("295/80R22.5");
  });

  it("parses rows with the line heuristics", async () => {
    const res = await ingestPdf(read("proveedor-b-lista.pdf"), { provider: "Importadora Norte", sourceRef: "proveedor-b-lista.pdf", method: "heuristic" });
    expect(res.rows.length).toBe(7);
    const z = find(res.rows, "295/80R22.5", "Michelin");
    expect(z?.cost).toBe(415);
    expect(z?.model).toBe("X MULTI Z");
    expect(z?.stock).toBe(18);
    expect(find(res.rows, "11R22.5", "Aeolus")?.cost).toBe(275);
    expect(find(res.rows, "10R20", "Westlake")?.cost).toBe(262);
    expect(res.rows.every((r) => r.currency === "USD")).toBe(true);
  });
});

describe("WhatsApp text ingestion (regex fallback)", () => {
  it("detects price messages", () => {
    expect(looksLikePriceMessage(read("whatsapp-01.txt").toString())).toBe(true);
    expect(looksLikePriceMessage("Michelin 11R22.5 X Multi Z x4 para Transportes ABC")).toBe(true); // ambiguous on purpose: handled by forwarded flag
    expect(looksLikePriceMessage("hola, buenos días")).toBe(false);
  });

  it("several tyres in one sentence", async () => {
    const res = await ingestWhatsAppText(read("whatsapp-01.txt").toString(), { provider: "Proveedor WA", sourceRef: "wamid.1" });
    const sizes = res.rows.map((r) => `${r.brand} ${r.size} ${r.cost}`).sort();
    expect(sizes).toEqual(["Bridgestone 11R22.5 385", "Michelin 295/80R22.5 410", "Westlake 10R20 290"].sort());
    expect(find(res.rows, "295/80R22.5")?.model).toBe("X MULTI Z");
    expect(find(res.rows, "11R22.5")?.model).toBe("R268");
  });

  it("one brand header then several lines, stock in parentheses", async () => {
    const res = await ingestWhatsAppText(read("whatsapp-02.txt").toString(), { provider: "Proveedor WA", sourceRef: "wamid.2" });
    expect(res.rows.length).toBe(3);
    expect(res.rows.every((r) => r.brand === "Aeolus")).toBe(true);
    expect(find(res.rows, "11R22.5")?.cost).toBe(270);
    expect(find(res.rows, "11R22.5")?.stock).toBe(40);
    expect(find(res.rows, "12R22.5")?.cost).toBe(310);
    expect(find(res.rows, "295/80R22.5")?.model).toBe("HN355");
  });

  it("soles with thousands separator", async () => {
    const res = await ingestWhatsAppText(read("whatsapp-03.txt").toString(), { provider: "Proveedor WA", sourceRef: "wamid.3" });
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].brand).toBe("Double Coin");
    expect(res.rows[0].cost).toBe(1150);
    expect(res.rows[0].currency).toBe("PEN");
    expect(res.rows[0].model).toBe("RR680");
  });
});
