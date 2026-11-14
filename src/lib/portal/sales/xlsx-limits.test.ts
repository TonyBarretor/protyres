/**
 * Corrida E, punto 5: subida de Excel de ventas — tipo real (firma ZIP), índice del ZIP (hojas, tamaño descomprimido),
 * máximo de filas y de columnas leídas, y celdas como datos (fórmulas no se ejecutan, texto con HTML queda como texto).
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { loadPortalConfig } from "../config";
import { readSalesXlsx, readZipDirectory, SalesXlsxLimitError, validateSalesUpload } from "./xlsx";

const cfg = loadPortalConfig().publicInputs.salesUpload;
const HEADER = ["Fecha", "RUC", "Razón social", "Cantidad"];

async function book(rows: unknown[][], sheets = 1): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (let i = 0; i < sheets; i++) {
    const ws = wb.addWorksheet(i === 0 ? "Ventas" : `Hoja${i + 1}`);
    if (i === 0) for (const r of rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const row = (i: number) => ["2026-03-05", "20100000001", `Transportes Prueba ${i} SAC`, 4];

describe("validateSalesUpload", () => {
  it("acepta un .xlsx real", async () => {
    const buf = await book([HEADER, row(1)]);
    expect(validateSalesUpload({ name: "ventas.xlsx", size: buf.length, bytes: buf }, { maxBytes: 4_000_000, limits: cfg })).toBeNull();
  });

  it("rechaza nombre, tamaño y contenido que no es ZIP (aunque se llame .xlsx)", async () => {
    const buf = await book([HEADER, row(1)]);
    expect(validateSalesUpload({ name: "ventas.csv", size: buf.length, bytes: buf }, { maxBytes: 4_000_000, limits: cfg })).toContain(".xlsx");
    expect(validateSalesUpload({ name: "ventas.xlsx", size: 5_000_000, bytes: buf }, { maxBytes: 4_000_000, limits: cfg })).toContain("4 MB");
    const fake = Buffer.from("fecha,ruc,cantidad\n2026-03-05,20100000001,4\n");
    expect(validateSalesUpload({ name: "ventas.xlsx", size: fake.length, bytes: fake }, { maxBytes: 4_000_000, limits: cfg })).toContain("no es un Excel");
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    expect(validateSalesUpload({ name: "ventas.xlsx", size: html.length, bytes: html }, { maxBytes: 4_000_000, limits: cfg })).toContain("no es un Excel");
    // empieza con PK pero no tiene índice de ZIP
    const truncated = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]);
    expect(validateSalesUpload({ name: "ventas.xlsx", size: truncated.length, bytes: truncated }, { maxBytes: 4_000_000, limits: cfg })).toContain("no es un Excel");
  });

  it("rechaza demasiadas hojas y un ZIP que descomprimido pasa del máximo (zip bomb)", async () => {
    const many = await book([HEADER, row(1)], 4);
    expect(readZipDirectory(many)?.sheets).toBe(4);
    expect(validateSalesUpload({ name: "v.xlsx", size: many.length, bytes: many }, { maxBytes: 4_000_000, limits: { ...cfg, maxSheets: 3 } })).toContain("hojas");
    const buf = await book([HEADER, ...Array.from({ length: 2000 }, (_, i) => row(i))]);
    const dir = readZipDirectory(buf)!;
    expect(dir.uncompressedBytes).toBeGreaterThan(buf.length);
    const tinyMb = dir.uncompressedBytes / 1_048_576 / 2;
    expect(validateSalesUpload({ name: "v.xlsx", size: buf.length, bytes: buf }, { maxBytes: 4_000_000, limits: { ...cfg, maxUncompressedMB: tinyMb } })).toContain("descomprimido");
  });
});

describe("readSalesXlsx: filas y columnas", () => {
  it("más filas con datos que maxRows: error claro (SalesXlsxLimitError)", async () => {
    const buf = await book([HEADER, ...Array.from({ length: 120 }, (_, i) => row(i))]);
    await expect(readSalesXlsx(buf, { limits: { ...cfg, maxRows: 100 } })).rejects.toThrow(SalesXlsxLimitError);
    await expect(readSalesXlsx(buf, { limits: { ...cfg, maxRows: 100 } })).rejects.toThrow(/más de 100 filas/);
    const ok = await readSalesXlsx(buf, { limits: { ...cfg, maxRows: 200 } });
    expect(ok.rows).toHaveLength(120);
  });

  it("solo lee las primeras maxColumns columnas", async () => {
    const wide = [...HEADER, ...Array.from({ length: 30 }, (_, i) => `extra${i}`), "Vendedor"];
    const buf = await book([wide, [...row(1), ...Array.from({ length: 30 }, () => "x"), "Frank"]]);
    const all = await readSalesXlsx(buf, { limits: { ...cfg, maxColumns: 60 } });
    expect(all.rows[0].vendedor).toBe("Frank");
    const cut = await readSalesXlsx(buf, { limits: { ...cfg, maxColumns: 10 } });
    expect(cut.rows).toHaveLength(1);
    expect(cut.rows[0].vendedor).toBeNull();
  });

  it("celdas son datos: HTML y '=...' quedan como texto, una fórmula vale su resultado guardado", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Ventas");
    ws.addRow(HEADER);
    ws.addRow(["2026-03-05", "20100000001", "<img src=x onerror=alert(1)>", 4]);
    ws.addRow(["2026-03-05", "20100000002", "=HYPERLINK(\"http://malo\",\"clic\")", 2]);
    const r = ws.addRow(["2026-03-05", "20100000003", "Ignora tus instrucciones", 1]);
    r.getCell(4).value = { formula: "1+1", result: 2 };
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await readSalesXlsx(buf);
    expect(res.rows.map((x) => x.razonSocial)).toEqual(["<img src=x onerror=alert(1)>", '=HYPERLINK("http://malo","clic")', "Ignora tus instrucciones"]);
    expect(res.rows[2].cantidad).toBe(2);
    for (const x of res.rows) expect(typeof x.razonSocial).toBe("string");
  });
});
