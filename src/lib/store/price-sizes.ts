/**
 * Corrida G: filas de precios mínimas (medida, tipo, stock) para el puntaje de atractivo, SIN pasar por getStore()
 * (src/lib/store/index.ts registra el medidor de uso, y la subida de Excel no debe alcanzarlo: public-entries.test.ts).
 * Postgres: una consulta con conexión propia que se cierra al terminar. JSON: el mismo archivo que getStore().
 */
import path from "node:path";
import postgres from "postgres";
import type { PriceRow } from "../ingest/types";
import { JsonStore } from "./json-store";
import { serverlessPgOptions } from "./pg-options";

export type PriceSizeRow = Pick<PriceRow, "size" | "kind" | "stock" | "isTyre">;

export async function readPriceSizes(): Promise<PriceSizeRow[]> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const sql = postgres(url, serverlessPgOptions({ max: 1 }));
    try {
      const rows = await sql`select size, kind, stock, is_tyre from prices where is_tyre and size <> ''`;
      return rows.map((r) => ({ size: String(r.size), kind: String(r.kind) as PriceRow["kind"], stock: r.stock === null ? null : Number(r.stock), isTyre: Boolean(r.is_tyre) }));
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  const store = new JsonStore(process.env.STORE_PATH || path.resolve(process.cwd(), "data/store.json"), process.env.STORE_SEED_PATH || path.resolve(process.cwd(), "data/seed.json.gz"));
  return store.allRows();
}

/** Lo que recalc.ts espera como `prices`. */
export const priceSizesSource = { allRows: readPriceSizes };
