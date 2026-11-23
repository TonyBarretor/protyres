/**
 * Corrida K, punto 1: el reporte de stock de Odoo con dos almacenes y reserva ("CÓDIGO MEDIDA MARCA MODELO DISPON.
 * ALMACEN SAN LUIS DISPON. ALMACEN CALLAO RESERVA"). El texto plano pierde las posiciones: "P0949 … 40" no dice si el 40
 * es de San Luis, de Callao o reserva. El lector asigna cada número a su columna por la X del encabezado.
 *
 * Fixture inventado (make-pdf.ts); el PDF real (data/, fuera de git) se prueba aparte y se salta si no está.
 */
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { makeStockPdf } from "./__fixtures__/make-pdf";
import { detectPdfLayout } from "./protyres-pdf";
import { ingestPdf, pdfToText } from "./pdf";
import { reservedOf } from "./stock-warehouses";
import { resolveSourceOptions } from "./sources";

beforeAll(() => {
  process.env.LLM_DISABLED = "1";
});

const FIXTURE = makeStockPdf([
  { codigo: "AR9001", medida: 'ARO 22.5" FIERRO', sanLuis: 3 },
  { codigo: "SV9002", medida: "SERV. REENCAUCHE PRUEBA 295/80R22.5", sanLuis: 2 },
  { codigo: "T9003", medida: "295/80R22.5 18PR RUTA 10", marca: "FENIXWAY", modelo: "RUTA 10", sanLuis: 12, callao: 30 },
  { codigo: "T9004", medida: "12R22.5 18PR BLOQUE 20", marca: "FENIXWAY", modelo: "BLOQUE 20", sanLuis: 40 },
  { codigo: "T9005", medida: "215/75R17.5 18PR URBANA 30", marca: "FENIXWAY", modelo: "URBANA 30", callao: 9 },
  { codigo: "T9006", medida: "315/80R22.5 20PR MIXTA 40", marca: "FENIXWAY", modelo: "MIXTA 40", sanLuis: 20, callao: 8, reserva: 5 },
  { codigo: "T9007", medida: "265/65R17 10PR CAMPO 50", marca: "MARSHAL", modelo: "CAMPO 50", sanLuis: 0 },
]);

describe("nombre del archivo de stock", () => {
  // el archivo real se llama STOCK_PROTYRES_23112026.pdf (con guion bajo): la regla solo aceptaba "STOCK PROTYRES"
  it.each(["STOCK_PROTYRES_23112026.pdf", "STOCK PROTYRES 23-11-2026.pdf", "stock_protyres.pdf"])("%s es stock de Protyres", (name) => {
    expect(resolveSourceOptions(name)).toMatchObject({ provider: "Protyres", kind: "stock" });
  });
});

describe("stock de Odoo con almacenes (fixture inventado)", () => {
  it("reconoce el diseño por el encabezado", async () => {
    const { text } = await pdfToText(FIXTURE);
    expect(detectPdfLayout(text)).toBe("odoo-stock-warehouses");
  });

  it("asigna cada número a su almacén por la columna: San Luis, Callao y reserva por separado", async () => {
    const res = await ingestPdf(FIXTURE, { provider: "Protyres", sourceRef: "STOCK PROTYRES_01012026.pdf", kind: "stock" });
    const by = new Map(res.rows.map((r) => [r.code, r]));
    expect(res.stats.method).toBe("odoo-stock-warehouses-pdf");
    expect(by.get("T9003")).toMatchObject({ size: "295/80R22.5", brand: "Fenixway", model: "RUTA 10", stock: 42, stockByWarehouse: { "San Luis": 12, Callao: 30 } });
    // un solo número bajo SAN LUIS es de San Luis (no de Callao ni reserva)
    expect(by.get("T9004")).toMatchObject({ size: "12R22.5", stock: 40, stockByWarehouse: { "San Luis": 40 } });
    // un solo número bajo CALLAO es de Callao
    expect(by.get("T9005")).toMatchObject({ size: "215/75R17.5", stock: 9, stockByWarehouse: { Callao: 9 } });
    // reserva aparte: stock = almacenes − reserva; la reserva queda en la fila
    const r6 = by.get("T9006")!;
    expect(r6.stockByWarehouse).toEqual({ "San Luis": 20, Callao: 8 });
    expect(reservedOf(r6)).toBe(5);
    expect(r6.stock).toBe(23);
    expect(by.get("T9007")).toMatchObject({ stock: 0 });
    expect(reservedOf(by.get("T9003")!)).toBe(0);
    // lo que no es neumático se guarda (el stock es de todo), pero sin medida
    expect(by.get("AR9001")?.isTyre).toBe(false);
    expect(res.rows).toHaveLength(7);
  });
});

const REAL = "/Users/tonybarreto/Desktop/coworkSandbox/protyres/data/referencia-360tyres/STOCK_PROTYRES_23112026.pdf";
const LOCAL = "data/referencia-360tyres/STOCK_PROTYRES_23112026.pdf";
const realFile = [LOCAL, REAL].find((f) => fs.existsSync(f));

describe.skipIf(!realFile)("stock real del 23/11/2026 (data/, fuera de git)", () => {
  // tabla de la especificación (corrida K): San Luis, Callao, total
  const TABLE: [string, number, number][] = [
    ["P0428", 58, 28],
    ["P0433", 58, 42],
    ["P0949", 40, 0],
    ["P0985", 47, 0],
    ["P1098", 28, 0],
    ["P1530", 38, 0],
    ["P1533", 10, 0],
    ["P1527", 91, 0],
    ["P1793", 68, 6],
    ["P0336", 62, 60],
  ];

  it("los 10 códigos prioritarios con San Luis y Callao, 636 en total y por medida", async () => {
    const res = await ingestPdf(fs.readFileSync(realFile!), { provider: "Protyres", sourceRef: "STOCK_PROTYRES_23112026.pdf", kind: "stock" });
    const by = new Map(res.rows.map((r) => [r.code, r]));
    const bySize: Record<string, number> = {};
    let total = 0;
    for (const [code, sl, ca] of TABLE) {
      const r = by.get(code)!;
      expect(r, code).toBeDefined();
      expect(r.stockByWarehouse?.["San Luis"] ?? 0, `${code} San Luis`).toBe(sl);
      expect(r.stockByWarehouse?.Callao ?? 0, `${code} Callao`).toBe(ca);
      expect(r.stock, `${code} total`).toBe(sl + ca);
      bySize[r.size] = (bySize[r.size] ?? 0) + (r.stock ?? 0);
      total += r.stock ?? 0;
    }
    expect(total).toBe(636);
    expect(bySize).toEqual({ "295/80R22.5": 174, "215/75R17.5": 150, "315/80R22.5": 124, "12R22.5": 97, "265/65R17": 91 });
    expect(res.rows.length).toBeGreaterThanOrEqual(36);
  });
});
