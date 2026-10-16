import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadCustomerProfiles, SettingsSchema, type CustomerProfile, type Settings } from "../settings";
import { buildQuote, manualItem } from "./build";
import { PROSEGUR_MAX_ITEMS, prosegurDescription, prosegurFileName, prosegurSystem, renderProsegurXlsx } from "./prosegur-xlsx";
import { parseRequestRegex } from "./request";
import type { Quote } from "./types";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18 },
  quote: { numberFormat: "{MES} {YYYY} - {NNN}", brandOrigin: { Fenixway: "CHINA PREMIUM" } },
});
let profile: CustomerProfile;

function quoteOf(text: string, prices: number[], number = "OCTUBRE 2026 - 451"): Quote {
  const req = parseRequestRegex(text);
  const items = req.lines.map((l, i) => manualItem(l, prices[i] ?? 100, undefined, settings));
  return buildQuote({ number, request: req, items, settings, today: "2026-10-15", customerProfile: "prosegur" });
}

async function reload(buffer: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb.worksheets[0];
}

beforeAll(() => {
  process.env.LLM_DISABLED = "1";
  profile = loadCustomerProfiles().find((p) => p.format === "prosegur")!;
});

describe("Prosegur Excel (Formato Proveedores)", () => {
  it("fills the template: header boxes, item rows, totals; keeps logo and merged cells", async () => {
    const quote = quoteOf(
      `215/75R17.5 18PR FENIXWAY VALOR 99 x2
295/80R22.5 18PR FENIXWAY VALOR 87 x4 UB 1900
para PROSEGUR SA
unidad: Ayacucho
ub: 1830
solicitante: Johann Castañeda`,
      [123.17, 372],
    );
    expect(quote.unit).toBe("Ayacucho");
    const { buffer, fileName } = await renderProsegurXlsx(quote, settings, profile);
    expect(fileName).toBe("Cotizacion 451 Ayacucho - UB 1830 y 1900.xlsx"); // quote UB + the item's own
    const ws = await reload(buffer);
    const v = (a: string) => ws.getCell(a).value;

    expect(v("E1")).toBe("Nombre de Archivo: Cotizacion 451 Ayacucho - UB 1830 y 1900");
    expect(v("C5")).toBe("PROFESSIONAL TYRES S.A.C.");
    expect(v("C6")).toBe(20565716396);
    expect(v("G5")).toBe(451);
    expect(v("G6")).toBe("AYACUCHO");
    expect(v("K5")).toBe("JOHANN CASTAÑEDA");
    const date = v("K6");
    expect(date instanceof Date && date.toISOString().slice(0, 10)).toBe("2026-10-15"); // a real date, not =TODAY()
    expect(ws.getCell("K6").numFmt).toBe("mm-dd-yy");

    const row = (r: number) => "ABCDEFGHIJKL".split("").map((c) => v(`${c}${r}`));
    expect(row(19)).toEqual([1, "AYACUCHO", 1830, null, "LLANTAS", "215/75R17.5 18PR FENIXWAY VALOR 99", 2, "UNI", "REPUESTO", "USD", 123.17, { formula: "+K19*G19", result: 246.34 }]);
    expect(row(20)).toEqual([2, "AYACUCHO", 1900, null, "LLANTAS", "295/80R22.5 18PR FENIXWAY VALOR 87", 4, "UNI", "REPUESTO", "USD", 372, { formula: "+K20*G20", result: 1488 }]);
    expect(row(21).every((x) => x === null)).toBe(true);

    expect(v("L30")).toEqual({ formula: "SUM(L19:L29)", result: 1734.34 });
    expect(v("L31")).toEqual({ formula: "SUM(L30*18/100)", result: 312.18 });
    expect(v("L32")).toEqual({ formula: "SUM(L30:L31)", result: 2046.52 });
    for (const a of ["C8", "C9", "D11", "G11", "K11", "D12", "G12", "K12", "E14", "H14"]) expect(v(a)).toBeNull(); // service boxes blank

    // what the client's template carries stays
    expect(ws.getImages().length).toBe(1);
    expect(Object.keys((ws as unknown as { _merges: Record<string, unknown> })._merges).length).toBeGreaterThanOrEqual(30);
    expect(v("A30")).toBe("Obligatorio mencionar si incluye o no IGV");
    expect(v("A31")).toBe("Obligatorio mencionar el tipo de moneda");
    expect(v("E3")).toBe("COTIZACIÓN PROVEEDORES");
    expect(ws.getColumn("F").width).toBeCloseTo(51.43, 1);
  });

  it("names the file after the quote number, unit and UB; the salesman can override it", () => {
    const quote = quoteOf("215/75R17.5 VALOR 99 x2 UB 2001\nunidad: Cusco", [100], "NOVIEMBRE 2026 - 018");
    quote.date = "2026-11-03";
    expect(prosegurFileName(quote, settings, profile)).toBe("Cotizacion 18 Cusco - UB 2001.xlsx"); // no quote UB: the item's
    quote.files = { xlsxName: "Cotizacion Prosegur Cusco" };
    expect(prosegurFileName(quote, settings, profile)).toBe("Cotizacion Prosegur Cusco.xlsx");
    const noUnit = quoteOf("215/75R17.5 VALOR 99 x2", [100]);
    expect(prosegurFileName(noUnit, settings, profile)).toBe("Cotizacion 451.xlsx"); // missing parts leave no dangling " - UB"
  });

  it("Sistema and Descripción for tyres, rims and accessories", () => {
    const q = quoteOf("11R22.5 Michelin XZE2+ x1\nARO 8.25x22.5 KUMA ACERO x1\nPARCHE RS-35 VIPAL x10", [400, 85, 3.5]);
    Object.assign(q.items[0], { loadIndex: "146/143", speedIndex: "L" }); // as an item from a price list has it (no ply)
    expect(q.items.map((it) => [prosegurSystem(it), prosegurDescription(it)])).toEqual([
      ["LLANTAS", "11R22.5 146/143L MICHELIN XZE2+"],
      ["AROS", "ARO 8.25X22.5 KUMA ACERO"],
      ["ACCESORIOS", "PARCHE RS-35 VIPAL"],
    ]);
  });

  it(`more than ${PROSEGUR_MAX_ITEMS} items is refused with a clear message`, async () => {
    const text = Array.from({ length: 12 }, (_, i) => `${200 + i}/75R17.5 VALOR 99 x1`).join("\n");
    const quote = quoteOf(text, Array(12).fill(100));
    expect(quote.items.length).toBe(12);
    await expect(renderProsegurXlsx(quote, settings, profile)).rejects.toThrow(/11 filas de ítems y esta cotización tiene 12/);
  });
});
