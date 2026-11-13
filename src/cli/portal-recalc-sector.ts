/**
 * Recalcula el sector (carga / pasajeros / mixto) de todas las empresas desde su flota guardada, con la regla de mayoría
 * de config/portal.json (import.sectorMajority), sin reimportar el padrón. Solo escribe las que cambian.
 *
 *   npm run portal:recalc-sector                    escribe en Postgres (DATABASE_URL) o en data/portal-store.json
 *   npm run portal:recalc-sector -- --dry-run       solo calcula e imprime cuántas cambiarían y de qué a qué
 *   npm run portal:recalc-sector -- --json          fuerza el store JSON local (igual que PORTAL_STORE=json)
 *   npm run portal:recalc-sector -- --umbral 0.85   otro umbral solo para esta corrida (0.5 < umbral ≤ 1)
 */
import "./env";
import { parseArgs } from "node:util";
import { loadPortalConfig } from "../lib/portal/config";
import { formatRecalcSummary, recalcSectors } from "../lib/portal/mtc/recalc-sector";
import { getPortalStore } from "../lib/portal/store";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    umbral: { type: "string" },
  },
});

async function main(): Promise<void> {
  if (values.json) process.env.PORTAL_STORE = "json";
  let majority = loadPortalConfig().import.sectorMajority;
  if (values.umbral !== undefined) {
    const n = Number(values.umbral);
    if (!(n > 0.5 && n <= 1)) throw new Error(`--umbral inválido: ${values.umbral} (debe ser mayor que 0.5 y como máximo 1)`);
    majority = n;
  }
  const dryRun = values["dry-run"];
  const store = await getPortalStore();
  console.log(`Store: ${process.env.DATABASE_URL && process.env.PORTAL_STORE !== "json" ? "Postgres" : "JSON local"}`);
  try {
    const summary = await recalcSectors({ store, majority, dryRun });
    console.log(formatRecalcSummary(summary));
    if (!dryRun) await store.flush();
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
