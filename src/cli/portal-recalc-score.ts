/**
 * Corrida G — recalcula el puntaje de atractivo (0–100), el nivel A/B/C y su explicación de todas las empresas, con los
 * pesos de config/portal.json (clave `scoring`) y el catálogo de medidas de las listas de precios. Idempotente.
 * Muestra la distribución por nivel, las 10 primeras y cuánto tardó cada parte.
 *
 *   npm run portal:recalc-score              escribe en Postgres (DATABASE_URL) o en data/portal-store.json
 *   npm run portal:recalc-score -- --json    fuerza el store JSON local (igual que PORTAL_STORE=json)
 *   npm run portal:recalc-score -- --top 20  cuántas primeras mostrar (por defecto 10)
 */
import "./env";
import { parseArgs } from "node:util";
import { loadPortalConfig } from "../lib/portal/config";
import { explainLine } from "../lib/portal/scoring/explain";
import { recalcScores } from "../lib/portal/scoring/recalc";
import { getPortalStore } from "../lib/portal/store";
import { getStore } from "../lib/store";

const { values } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    top: { type: "string", default: "10" },
  },
});

async function main(): Promise<void> {
  if (values.json) process.env.PORTAL_STORE = "json";
  const cfg = loadPortalConfig().scoring;
  const store = await getPortalStore();
  const prices = await getStore();
  console.log(`Store: ${process.env.DATABASE_URL && process.env.PORTAL_STORE !== "json" ? "Postgres" : "JSON local"}`);
  try {
    const r = await recalcScores(store, cfg, { prices, log: (m) => console.log(m) });
    await store.flush();
    const pct = (n: number) => (r.empresas ? `${Math.round((100 * n) / r.empresas)}%` : "0%");
    console.log(`\nEmpresas: ${r.empresas}. Tiempo: ${(r.durationMs / 1000).toFixed(1)} s (leer ${r.phases.leer} ms, calcular ${r.phases.calcular} ms, guardar ${r.phases.guardar} ms).`);
    console.log(`Cortes: A desde ${r.cuts.cutA ?? "—"} puntos, B desde ${r.cuts.cutB ?? "—"}.`);
    console.log(`Nivel A: ${r.conteo.A} (${pct(r.conteo.A)}) · B: ${r.conteo.B} (${pct(r.conteo.B)}) · C: ${r.conteo.C} (${pct(r.conteo.C)})`);
    const n = Math.max(1, Math.min(50, Number(values.top) || 10));
    console.log(`\nLas ${Math.min(n, r.top.length)} primeras (estimación):`);
    const top = r.top.slice(0, n);
    for (const [i, t] of top.entries()) {
      const c = await store.getCompany(t.companyId);
      console.log(`${String(i + 1).padStart(2)}. [${t.nivel}] ${t.score.toFixed(1).padStart(5)}  ${c?.razonSocial ?? `#${t.companyId}`}\n      ${explainLine(c?.scoreDetalle)}`);
    }
  } finally {
    await store.close();
    await prices.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
