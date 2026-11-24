/**
 * Corrida K (ajuste 3): allRows() traía la tabla de precios entera (9.166 filas, 5,7 MB) en cada llamada: 10–13 s contra
 * el pooler remoto, y el guion de Frank la pide ~30 veces (cotizar, oc, stock, catálogo de voz, puntajes, Match). Ahora
 * PgStore la guarda en memoria y antes de usarla comprueba con una consulta mínima (filas y última modificación) que la
 * tabla no cambió, también si la cambió otra instancia (Vercel corre varias).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PriceRow } from "../lib/ingest/types";
import { pgQueryCount } from "../lib/store/pg-options";
import { PgStore } from "../lib/store/pg-store";
import { testDbUrl, truncateAll } from "./harness";

let a: PgStore;
let b: PgStore;
const saved = process.env.PG_CONTAR;

beforeAll(async () => {
  process.env.PG_CONTAR = "1"; // el contador se activa al conectar
  await truncateAll(testDbUrl());
  a = await PgStore.connect(testDbUrl());
  b = await PgStore.connect(testDbUrl()); // "otra instancia"
});
afterAll(async () => {
  await a?.close();
  await b?.close();
  if (saved === undefined) delete process.env.PG_CONTAR;
  else process.env.PG_CONTAR = saved;
});

function row(i: number, cost = 100 + i, provider = "PRUEBA"): PriceRow {
  return {
    id: `c-${provider}-${i}`, provider, kind: "provider", description: `Llanta ${i}`, brand: "VALOR", model: "99", size: "295/80R22.5",
    sizeDisplay: "295/80R22.5", sizeRaw: "295/80R22.5", isTyre: true, cost, priceIncludesTax: false, currency: "USD", priceDate: "2026-11-23", source: "excel", sourceRef: "prueba.xlsx",
  } as PriceRow;
}

const ids = (rows: PriceRow[]) => rows.map((r) => r.id).sort();

describe("allRows con caché validada contra la base", () => {
  it("la segunda lectura sin cambios es una sola consulta mínima, con las mismas filas", async () => {
    await a.upsertRows(Array.from({ length: 50 }, (_, i) => row(i)));
    const first = await a.allRows();
    expect(first).toHaveLength(50);
    const q0 = pgQueryCount.n;
    const second = await a.allRows();
    expect(pgQueryCount.n - q0).toBe(1);
    // esa consulta no trae las filas (antes era el select completo de la tabla)
    const q = pgQueryCount.last.at(-1)!.toLowerCase();
    expect(q).toContain("count(");
    expect(q).not.toContain('"description"');
    expect(second).toEqual(first);
  });

  it("devuelve copias: modificar lo devuelto no cambia la siguiente lectura", async () => {
    const rows = await a.allRows();
    rows[0].cost = 999_999;
    rows.pop();
    const again = await a.allRows();
    expect(again).toHaveLength(50);
    expect(again.find((r) => r.id === "c-PRUEBA-0")?.cost).toBe(100);
  });

  it("un cambio de precio, una fila nueva o un borrado hecho por OTRA instancia se ve en la siguiente lectura", async () => {
    await a.allRows();
    await b.upsertRows([row(0, 555)]);
    expect((await a.allRows()).find((r) => r.id === "c-PRUEBA-0")?.cost).toBe(555);
    await b.upsertRows([row(0, 1, "OTRO")]);
    expect(ids(await a.allRows())).toContain("c-OTRO-0");
    await b.deleteProvider("OTRO");
    expect(ids(await a.allRows())).not.toContain("c-OTRO-0");
    // reemplazo de la carga del mismo origen (mismo número de filas, otros precios)
    await b.upsertRows(Array.from({ length: 50 }, (_, i) => row(i, 200 + i)), { replace: { provider: "PRUEBA" } });
    const after = await a.allRows();
    expect(after).toHaveLength(50);
    expect(after.every((r) => r.cost! >= 200)).toBe(true);
  });

  it("lo que escribe la misma instancia se ve enseguida", async () => {
    await a.allRows();
    await a.upsertRows([row(7, 777)]);
    expect((await a.allRows()).find((r) => r.id === "c-PRUEBA-7")?.cost).toBe(777);
  });
});
