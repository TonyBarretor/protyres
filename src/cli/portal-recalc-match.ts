/**
 * Corrida K — recalcula Match Venta con el stock, las ventas y el padrón actuales y lo guarda (las vistas leen lo
 * guardado). También corre solo al cargar stock, subir ventas, importar el padrón y cambiar una prioridad.
 *
 *   npm run portal:recalc-match                  recalcula y muestra el resumen por producto
 *   npm run portal:recalc-match -- --json        fuerza el store JSON local (igual que PORTAL_STORE=json)
 *
 * Store: Postgres con DATABASE_URL; si no, data/portal-store.json y data/store.json (o PORTAL_STORE_PATH / STORE_PATH).
 */
import "./env";
import { parseArgs } from "node:util";
import { recalcMatch } from "../lib/portal/match/recalc";
import { productLabel } from "../lib/portal/match/stock";
import type { MatchRunData } from "../lib/portal/match/recalc";
import { getPortalStore } from "../lib/portal/store";
import { getStore } from "../lib/store";

const { values } = parseArgs({ options: { json: { type: "boolean", default: false } } });

async function main(): Promise<void> {
  if (values.json) process.env.PORTAL_STORE = "json";
  const store = await getPortalStore();
  const prices = await getStore();
  try {
    const r = await recalcMatch({ store, prices, log: (m) => console.log(m) }, "npm run portal:recalc-match");
    const data = r.run.data as unknown as MatchRunData;
    const rows = await store.listMatchResults();
    console.log(`Match Venta: ${r.productos} productos prioritarios con stock, ${r.filas.toLocaleString("es-PE")} filas, ${r.empresas.toLocaleString("es-PE")} empresas en ${r.durationMs} ms (leer ${r.phases.leer}, calcular ${r.phases.calcular}, guardar ${r.phases.guardar}).`);
    if (r.apagados.length) console.log(`Prioridad apagada por llegar a 0: ${r.apagados.join(", ")}`);
    for (const s of data.stock) {
      const mine = rows.filter((x) => x.productCode === s.code && !x.excluida);
      const pct = (min: number) => mine.filter((x) => (x.pct ?? 0) > min).length;
      console.log(`  ${s.code} ${productLabel(s).padEnd(44)} disponible ${String(s.available).padStart(4)} · >70%: ${pct(70)} · >50%: ${pct(50)} · >30%: ${pct(30)} · migración: ${mine.filter((x) => x.tipo === "migracion").length} · ya compraron: ${mine.filter((x) => x.yaCompro).length}`);
      for (const n of data.notas[s.code] ?? []) console.log(`      ${n}`);
    }
    await store.flush();
  } finally {
    await prices.close();
    await store.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
