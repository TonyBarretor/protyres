/**
 * Corrida J (administrador): importa del padrón MTC (data/mtc/*.csv, los mismos CSV que `npm run portal:import-mtc`)
 * una o varias empresas puntuales por RUC, aunque tengan menos de 10 unidades (el import completo las deja fuera).
 * Trae la empresa con su flota vigente, llantas (dato MTC) y medida probable; si ya existía (creada a mano o de un
 * import anterior) se actualiza sin perder dueño, contactos, actividad, oportunidades ni vehículos cargados a mano.
 * Recalcula el puntaje solo de esas empresas.
 *
 *   npm run portal:import-ruc -- 20123456789                 escribe en Postgres (DATABASE_URL) o en data/portal-store.json
 *   npm run portal:import-ruc -- 20123456789 20987654321     varias
 *   npm run portal:import-ruc -- 20123456789 --dry-run       solo dice qué encontró
 *   npm run portal:import-ruc -- 20123456789 --json          fuerza el store JSON local (igual que PORTAL_STORE=json)
 */
import "./env";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadPortalConfig } from "../lib/portal/config";
import { formatImportSummary, importMtc } from "../lib/portal/mtc/import";
import { loadTyreRules } from "../lib/portal/mtc/inference";
import { recalcScoresSafely } from "../lib/portal/scoring/recalc";
import { recalcMatchSafely } from "../lib/portal/match/recalc";
import { getPortalStore } from "../lib/portal/store";
import { getStore } from "../lib/store";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

async function main(): Promise<void> {
  const rucs = positionals.flatMap((p) => p.split(/[,\s]+/)).map((p) => p.replace(/\D/g, "")).filter(Boolean);
  if (!rucs.length) throw new Error("Uso: npm run portal:import-ruc -- <RUC> [<RUC> …] [--dry-run] [--json]");
  const bad = rucs.filter((r) => r.length !== 11);
  if (bad.length) throw new Error(`RUC inválido (11 dígitos): ${bad.join(", ")}`);
  if (values.json) process.env.PORTAL_STORE = "json";
  const cfg = loadPortalConfig();
  const dir = path.resolve(process.cwd(), cfg.import.dir);
  if (!fs.existsSync(dir)) throw new Error(`No existe la carpeta del padrón: ${dir}`);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .sort()
    .map((f) => path.join(dir, f));
  if (!files.length) throw new Error(`No hay CSV del padrón en ${dir}`);

  const dryRun = values["dry-run"];
  const store = dryRun ? null : await getPortalStore();
  if (store) console.log(`Store: ${process.env.DATABASE_URL && process.env.PORTAL_STORE !== "json" ? "Postgres" : "JSON local"}`);
  const t0 = Date.now();
  try {
    const summary = await importMtc({ files, config: cfg.import, rules: loadTyreRules(), store, dryRun, onlyRucs: rucs, log: (m) => console.log(m) });
    console.log("");
    console.log(formatImportSummary(summary));
    if (store && summary.empresas > 0) {
      const found = await store.getCompaniesByRucs(rucs);
      const prices = await getStore();
      await recalcScoresSafely(store, cfg.scoring, { companyIds: found.map((c) => c.id), prices, why: "import por RUC", log: (m) => console.log(m) });
      await recalcMatchSafely({ store, prices, why: "import por RUC", log: (m) => console.log(m) });
      await prices.close();
      for (const c of found) console.log(`${c.ruc} ${c.razonSocial}: ${c.unidades} unidades, ${c.llantasPiso} llantas en piso — /portal/empresas/${c.id}`);
      await store.flush();
    }
    console.log(`\nListo en ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
    if (summary.faltantes.length) process.exitCode = 2;
  } finally {
    await store?.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
