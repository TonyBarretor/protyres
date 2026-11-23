/**
 * Corrida K — análisis de ventas reales por tamaño de flota, sector y departamento (antes de fijar el peso del Volumen
 * de Match Venta). Solo lee: imprime la tabla con el tamaño de cada muestra y la recomendación (no la aplica).
 *
 *   npm run match:analisis-flotas
 *   npm run match:analisis-flotas -- --json      fuerza el store JSON local
 */
import "./env";
import { parseArgs } from "node:util";
import { loadPortalConfig } from "../lib/portal/config";
import { analyzeFleets, formatAnalysis } from "../lib/portal/match/analysis";
import { saleLines } from "../lib/portal/match/recalc";
import { loadSalesSettings } from "../lib/portal/sales/config";
import { getPortalStore } from "../lib/portal/store";

const { values } = parseArgs({ options: { json: { type: "boolean", default: false } } });

async function main(): Promise<void> {
  if (values.json) process.env.PORTAL_STORE = "json";
  const store = await getPortalStore();
  try {
    const cfg = loadPortalConfig().match;
    const companies = await store.matchInputs();
    const sales = saleLines(await store.querySales({ tipoLinea: ["neumatico"] }), loadSalesSettings().leasingRucs);
    if (!sales.length) console.log("Aviso: no hay ventas reales cargadas (Subir ventas): el análisis sale vacío.");
    console.log(formatAnalysis(analyzeFleets(companies, sales, cfg)));
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
