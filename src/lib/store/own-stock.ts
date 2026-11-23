/**
 * Corrida K: el stock propio (filas kind "stock") y los descuentos por pedidos para Match Venta, SIN pasar por getStore()
 * (como price-sizes.ts: la subida de Excel y las páginas del portal no registran el medidor de uso). Postgres: conexión
 * propia que se cierra al terminar. JSON: el mismo archivo que getStore().
 */
import path from "node:path";
import type { PriceRow, PriceSource } from "../ingest/types";
import { JsonStore } from "./json-store";
import { serverlessPostgres } from "./pg-options";
import type { StockDeduction } from "./types";

export interface OwnStockSnapshot {
  rows: PriceRow[];
  deductions: StockDeduction[];
}

export async function readOwnStock(): Promise<OwnStockSnapshot> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const sql = serverlessPostgres(url, { max: 1 });
    try {
      const rows = await sql`
        select id, provider, kind, code, description, brand, model, size, size_display, size_raw, is_tyre, stock, stock_by_warehouse, price_date, source, source_ref, notes, currency
        from prices where kind = 'stock'`;
      let deductions: StockDeduction[] = [];
      try {
        const d = await sql`
          select d.id, d.order_key, d.label, d.row_id, d.origin, d.warehouse, d.quantity, d.description, d.created_at
          from stock_deductions d left join stock_loads l on l.origin = d.origin
          where d.released_at is null and d.load_at is not distinct from l.loaded_at order by d.id`;
        deductions = d.map((r) => ({
          id: Number(r.id),
          orderKey: String(r.order_key),
          label: String(r.label ?? ""),
          rowId: String(r.row_id),
          origin: String(r.origin),
          warehouse: String(r.warehouse),
          quantity: Number(r.quantity),
          description: String(r.description ?? ""),
          createdAt: new Date(r.created_at as string).toISOString(),
        }));
      } catch {
        deductions = []; // tablas de la corrida H aún sin migrar: sin descuentos
      }
      return {
        rows: rows.map((r) => ({
          id: String(r.id),
          provider: String(r.provider),
          kind: "stock",
          code: r.code === null ? undefined : String(r.code),
          description: String(r.description ?? ""),
          brand: String(r.brand ?? ""),
          model: String(r.model ?? ""),
          size: String(r.size ?? ""),
          sizeDisplay: String(r.size_display ?? ""),
          sizeRaw: String(r.size_raw ?? ""),
          isTyre: Boolean(r.is_tyre),
          cost: null,
          priceIncludesTax: false,
          currency: String(r.currency ?? "USD"),
          stock: r.stock === null ? null : Number(r.stock),
          stockByWarehouse: (r.stock_by_warehouse as Record<string, number> | null) ?? undefined,
          priceDate: String(r.price_date),
          source: String(r.source) as PriceSource,
          sourceRef: String(r.source_ref ?? ""),
          notes: r.notes === null ? undefined : String(r.notes),
        })),
        deductions,
      };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  const store = new JsonStore(process.env.STORE_PATH || path.resolve(process.cwd(), "data/store.json"), process.env.STORE_SEED_PATH || path.resolve(process.cwd(), "data/seed.json.gz"));
  return { rows: (await store.allRows()).filter((r) => r.kind === "stock"), deductions: await store.listStockDeductions() };
}

/** Lo que Match Venta espera como `prices` (OwnStockSource): una sola lectura para las dos cosas. */
export function ownStockSource(): { allRows(): Promise<PriceRow[]>; listStockDeductions(): Promise<StockDeduction[]> } {
  let snap: Promise<OwnStockSnapshot> | null = null;
  const get = () => (snap ??= readOwnStock());
  return { allRows: async () => (await get()).rows, listStockDeductions: async () => (await get()).deductions };
}
