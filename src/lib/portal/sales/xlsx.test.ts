import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SALES_COLUMN_MAP, excelSerialToIso, loadSalesColumnMap, normalizeHeader, parseSaleDate, parseSaleNumber, readSalesXlsx } from "./xlsx";

async function book(rows: unknown[][], opts: { title?: boolean } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Ventas");
  if (opts.title) ws.addRow(["Reporte de ventas — noviembre"]);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("helpers", () => {
  it("normalizeHeader folds accents, case and spaces", () => {
    expect(normalizeHeader("  RAZÓN   Social: ")).toBe("razon social");
    expect(normalizeHeader("Diseño")).toBe("diseno");
  });
  it("parseSaleDate: Date, Excel serial, dd/mm/aaaa, ISO; invalid → null", () => {
    expect(parseSaleDate(new Date(Date.UTC(2026, 2, 5)))).toBe("2026-03-05");
    expect(excelSerialToIso(46086)).toBe("2026-03-05");
    expect(parseSaleDate(46086)).toBe("2026-03-05");
    expect(parseSaleDate("5/3/2026")).toBe("2026-03-05");
    expect(parseSaleDate("05-03-2026")).toBe("2026-03-05");
    expect(parseSaleDate("2026-03-05")).toBe("2026-03-05");
    expect(parseSaleDate("31/02/2026")).toBeNull();
    expect(parseSaleDate("ayer")).toBeNull();
  });
  it("parseSaleNumber: separators and currency", () => {
    expect(parseSaleNumber("1,234.50")).toBe(1234.5);
    expect(parseSaleNumber("1.234,50")).toBe(1234.5);
    expect(parseSaleNumber("S/ 1,200")).toBe(1200);
    expect(parseSaleNumber("12,5")).toBe(12.5);
    expect(parseSaleNumber(8)).toBe(8);
    expect(parseSaleNumber("ocho")).toBeNull();
  });
  it("loadSalesColumnMap reads config/portal.json", () => {
    const map = loadSalesColumnMap(path.join(__dirname, "..", "..", "..", "..", "config", "portal.json"));
    expect(map.fecha).toContain("fecha factura");
    expect(map.ruc).toContain("vat");
    expect(Object.keys(map).sort()).toEqual(Object.keys(DEFAULT_SALES_COLUMN_MAP).sort());
  });
});

describe("readSalesXlsx", () => {
  it("maps headers with other accents/case, validates per row", async () => {
    const buf = await book(
      [
        ["FECHA FACTURA", "Nif", "Razón Social", "MEDIDA", "Marca", "DISEÑO", "Cant.", "Precio Unitario", "Total", "Vendedor", "Notas"],
        [new Date(Date.UTC(2026, 9, 1)), "20100148162", "Prosegur", "235/75R17.5", "Fenixway", "Valor 99", 8, 145.5, 1164, "Frank", "x"],
        ["15/09/2026", "RUC 20555901179", "Movil Bus", "295/80R22.5", "Linglong", "KTS300", "12", "250", null, "Frank", ""],
        [46086, "20431084172", "Ancro", "215/75R17.5", "Marshal", "KRS03", 4, null, null, null, null],
        ["no es fecha", "20431084172", "Ancro", null, null, null, 4, null, null, null, null],
        ["01/10/2026", "", "Sin RUC", null, null, null, 4, null, null, null, null],
        ["01/10/2026", "20431084172", "Ancro", null, null, null, "cuatro", null, null, null, null],
        [null, null, null, null, null, null, null, null, null, null, null],
      ],
      { title: true },
    );
    const r = await readSalesXlsx(buf, { columnMap: DEFAULT_SALES_COLUMN_MAP });
    expect(r.sheet).toBe("Ventas");
    expect(r.headerRow).toBe(2);
    expect(r.missing).toEqual([]);
    expect(r.mapping.fecha).toEqual({ header: "FECHA FACTURA", col: 1 });
    expect(r.mapping.ruc?.header).toBe("Nif");
    expect(r.mapping.diseno?.header).toBe("DISEÑO");
    expect(r.mapping.cantidad?.header).toBe("Cant.");
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toEqual({
      fecha: "2026-10-01",
      ruc: "20100148162",
      razonSocial: "Prosegur",
      medida: "235/75R17.5",
      marca: "Fenixway",
      diseno: "Valor 99",
      cantidad: 8,
      precioUnitario: 145.5,
      total: 1164,
      vendedor: "Frank",
      origen: "excel",
      isDemo: false,
    });
    expect(r.rows[1]).toMatchObject({ fecha: "2026-09-15", ruc: "20555901179", cantidad: 12, total: 3000 });
    expect(r.rows[2]).toMatchObject({ fecha: "2026-03-05", precioUnitario: null, total: null, vendedor: null });
    expect(r.errors.map((e) => e.row)).toEqual([6, 7, 8]);
    expect(r.errors[0].error).toMatch(/fecha inválida/);
    expect(r.errors[1].error).toMatch(/sin RUC/);
    expect(r.errors[2].error).toMatch(/cantidad no numérica/);
  });

  it("custom column map and missing required columns", async () => {
    const buf = await book([
      ["Invoice Date", "Customer VAT", "Qty"],
      ["2026-10-02", "20100148162", 2],
    ]);
    const missing = await readSalesXlsx(buf, { columnMap: DEFAULT_SALES_COLUMN_MAP });
    expect(missing.missing).toEqual(["ruc"]);
    expect(missing.rows).toEqual([]);
    expect(missing.errors[0].error).toMatch(/Faltan columnas obligatorias: ruc/);
    const ok = await readSalesXlsx(buf, { columnMap: { ...DEFAULT_SALES_COLUMN_MAP, ruc: ["customer vat"] } });
    expect(ok.rows).toEqual([expect.objectContaining({ fecha: "2026-10-02", ruc: "20100148162", cantidad: 2 })]);
  });
});
