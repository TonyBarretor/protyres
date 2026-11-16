/**
 * Corrida H, punto 4: contador de stock en el store JSON (el de Postgres hace lo mismo: src/test-pg/stock.pg.test.ts).
 * Disponible = cargado − descontado desde esa carga; la cantidad cargada no se toca.
 */
import { describe, expect, it, vi } from "vitest";
import type { PriceRow } from "../ingest/types";
import { JsonStore } from "./json-store";
import { stockOriginKey } from "./types";

const stockRow = (id: string, stock: number): PriceRow => ({
  id,
  provider: "Protyres",
  kind: "stock",
  description: id,
  brand: "Fenixway",
  model: id,
  size: "215/75R17.5",
  sizeDisplay: "215/75R17.5",
  sizeRaw: "215/75R17.5",
  isTyre: true,
  cost: null,
  priceIncludesTax: false,
  currency: "USD",
  stock,
  priceDate: "2026-11-16",
  source: "pdf",
  sourceRef: "STOCK.pdf",
});
const ded = (rowId: string, quantity: number) => ({ rowId, origin: stockOriginKey("Protyres", "stock"), warehouse: "SAN LUIS", quantity, description: rowId });

describe("contador de stock (JSON)", () => {
  it("descuenta aparte, un pedido no descuenta dos veces, anular devuelve y una carga nueva reinicia solo su origen", async () => {
    const s = JsonStore.memory();
    await s.upsertRows([stockRow("v99", 12), stockRow("v89", 20)]);
    await s.setStockDeductions("oc:1:A", "OC A", [ded("v99", 8), ded("v89", 2)]);
    expect((await s.listStockDeductions()).map((d) => [d.orderKey, d.rowId, d.quantity])).toEqual([
      ["oc:1:A", "v99", 8],
      ["oc:1:A", "v89", 2],
    ]);
    expect((await s.getRows(["v99"]))[0].stock).toBe(12); // la carga no cambia
    // rehacer el mismo pedido reemplaza
    await s.setStockDeductions("oc:1:A", "OC A", [ded("v99", 5)]);
    await s.setStockDeductions("oc:2:B", "OC B", [ded("v99", 1)]);
    expect((await s.listStockDeductions()).map((d) => [d.orderKey, d.quantity])).toEqual([
      ["oc:1:A", 5],
      ["oc:2:B", 1],
    ]);
    // anular
    expect(await s.releaseStockDeductions("oc:1:A")).toBe(1);
    expect(await s.releaseStockDeductions("oc:1:A")).toBe(0);
    expect((await s.listStockDeductions()).map((d) => d.orderKey)).toEqual(["oc:2:B"]);
    // una lista de otro origen no reinicia; una carga nueva del mismo origen sí
    await s.upsertRows([{ ...stockRow("jch1", 5), provider: "JCH", kind: "provider" }]);
    expect(await s.listStockDeductions()).toHaveLength(1);
    await s.upsertRows([stockRow("v99", 30)], { replace: { provider: "Protyres", kind: "stock" } });
    expect(await s.listStockDeductions()).toEqual([]);
    // y lo que se descuente después cuenta sobre la carga nueva
    await s.setStockDeductions("oc:3:C", "OC C", [ded("v99", 3)]);
    expect((await s.listStockDeductions()).map((d) => d.quantity)).toEqual([3]);
  });
});

describe("contador de stock (JSON): cargas en el mismo milisegundo", () => {
  it("una carga nueva reinicia aunque llegue en el mismo instante que la anterior (como Postgres)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T15:00:00Z"));
    try {
      const s = JsonStore.memory();
      await s.upsertRows([stockRow("v99", 12)]);
      await s.setStockDeductions("oc:2:B", "OC B", [ded("v99", 1)]);
      await s.upsertRows([stockRow("v99", 30)], { replace: { provider: "Protyres", kind: "stock" } });
      expect(await s.listStockDeductions()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
