/**
 * Corrida H, puntos 3b y 4 — proveedores y contador de stock en PgStore contra Postgres real: las mismas escrituras que
 * en el store JSON dan las mismas lecturas (importar dos veces, condiciones recordadas, descontar, rehacer, anular, carga
 * nueva que reinicia el origen); y dos pedidos que rehacen la misma OC a la vez no dejan el descuento duplicado.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PriceRow } from "../lib/ingest/types";
import { JsonStore } from "../lib/store/json-store";
import { PgStore } from "../lib/store/pg-store";
import { stockOriginKey, type PriceStore, type Supplier } from "../lib/store/types";
import { testDbUrl, truncateAll } from "./harness";
import { bothTraces, diffTraces } from "./parity";

let pg: PgStore;

beforeAll(async () => {
  await truncateAll(testDbUrl());
  pg = await PgStore.connect(testDbUrl());
});
afterAll(async () => {
  await pg?.close();
});

const stockRow = (id: string, stock: number, provider = "Protyres", kind: PriceRow["kind"] = "stock"): PriceRow => ({
  id, provider, kind, description: id, brand: "Fenixway", model: id, size: "215/75R17.5", sizeDisplay: "215/75R17.5", sizeRaw: "215/75R17.5", isTyre: true,
  cost: kind === "stock" ? null : 100, priceIncludesTax: false, currency: "USD", stock, priceDate: "2026-11-16", source: "pdf", sourceRef: "STOCK.pdf",
});
const ded = (rowId: string, quantity: number) => ({ rowId, origin: stockOriginKey("Protyres", "stock"), warehouse: "SAN LUIS", quantity, description: rowId });
const SUPPLIERS: Supplier[] = [
  { key: "jchllantas", name: "JCH LLANTAS", contact: "ANA DEMO", phone: "900 000 010", brands: ["WEST LAKE", "CHINAS"], provider: "JCH" },
  { key: "vanllantas", name: "VAN LLANTAS", contact: "LUIS DEMO", brands: ["MICHELLIN"] },
];
const T = new Date("2026-11-16T15:00:00Z");
// lo que no depende del store (ids y horas de creación)
const strip = (ds: Awaited<ReturnType<PriceStore["listStockDeductions"]>>) => ds.map(({ id: _i, createdAt: _c, ...d }) => d);
const stripS = (xs: Supplier[]) => xs.map(({ updatedAt: _u, ...x }) => x);

async function scenario(s: PriceStore, trace: (label: string, v: unknown) => void): Promise<void> {
  trace("suppliers.import1", await s.upsertSuppliers(SUPPLIERS));
  await s.setSupplierTerms("jchllantas", { payment: "LETRAS 60", delivery: "ALMACEN LURIN" });
  await s.setSupplierTerms("vanllantas", { payment: "CONTADO" });
  trace("suppliers.import2", await s.upsertSuppliers(SUPPLIERS.map((x) => ({ ...x, contact: `${x.contact} 2` }))));
  trace("suppliers.list", stripS(await s.listSuppliers()));

  await s.upsertRows([stockRow("v99", 12), stockRow("v89", 20)]);
  await s.setStockDeductions("oc:1:A", "OC A", [ded("v99", 8), ded("v89", 2)], T);
  trace("ded.1", strip(await s.listStockDeductions()));
  await s.setStockDeductions("oc:1:A", "OC A", [ded("v99", 5)], T);
  await s.setStockDeductions("oc:2:B", "OC B", [ded("v99", 1), ded("v89", 0)], T);
  trace("ded.redo", strip(await s.listStockDeductions()));
  trace("ded.release", await s.releaseStockDeductions("oc:1:A", T));
  trace("ded.release.again", await s.releaseStockDeductions("oc:1:A", T));
  trace("ded.afterRelease", strip(await s.listStockDeductions()));
  await s.upsertRows([stockRow("jch1", 5, "JCH", "provider")]);
  trace("ded.otherOrigin", strip(await s.listStockDeductions()));
  await s.upsertRows([stockRow("v99", 30)], { replace: { provider: "Protyres", kind: "stock" } });
  trace("ded.newLoad", strip(await s.listStockDeductions()));
  await s.setStockDeductions("oc:3:C", "OC C", [ded("v99", 3)], T);
  trace("ded.afterLoad", strip(await s.listStockDeductions()));
}

describe("proveedores y contador de stock (PgStore = JsonStore)", () => {
  it("mismo recorrido, mismas lecturas", async () => {
    const { json, pg: pgTrace } = await bothTraces(JsonStore.memory(), pg, scenario);
    expect(diffTraces(json, pgTrace)).toEqual([]);
    expect(pgTrace["ded.newLoad"]).toEqual([]);
    expect((pgTrace["suppliers.list"] as Supplier[])[0]).toMatchObject({ name: "JCH LLANTAS", contact: "ANA DEMO 2", lastPayment: "LETRAS 60", lastDelivery: "ALMACEN LURIN" });
  });

  it("rehacer la misma OC a la vez desde dos conexiones no deja el descuento duplicado", async () => {
    const other = await PgStore.connect(testDbUrl());
    try {
      await Promise.all([pg.setStockDeductions("oc:9:Z", "OC Z", [ded("v99", 2)], T), other.setStockDeductions("oc:9:Z", "OC Z", [ded("v99", 2)], T)]);
      const mine = (await pg.listStockDeductions()).filter((d) => d.orderKey === "oc:9:Z");
      // setStockDeductions toma un candado por pedido (pg_advisory_xact_lock): la segunda espera a la primera y la reemplaza
      expect(mine.map((d) => d.quantity)).toEqual([2]);
    } finally {
      await other.close();
    }
  });
});
