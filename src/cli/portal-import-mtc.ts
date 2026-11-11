/**
 * Importa el padrón MTC (data/mtc/*.csv) al portal: empresas con 10+ unidades vigentes y su flota, con llantas
 * (dato MTC) y medida probable (inferida). Idempotente; la flota de cada empresa importada queda igual a la del padrón
 * vigente (borra las placas que ya no figuran); las empresas que bajan del umbral no se tocan (ver src/lib/portal/mtc/import.ts).
 *
 *   npm run portal:import-mtc                    escribe en Postgres (DATABASE_URL) o en data/portal-store.json
 *   npm run portal:import-mtc -- --dry-run       solo calcula e imprime el resumen
 *   npm run portal:import-mtc -- --json          fuerza el store JSON local (igual que PORTAL_STORE=json)
 *   npm run portal:import-mtc -- --min 20        umbral de unidades (por defecto import.minUnits de config/portal.json)
 */
import "./env";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadPortalConfig } from "../lib/portal/config";
import { formatImportSummary, importMtc } from "../lib/portal/mtc/import";
import { loadTyreRules } from "../lib/portal/mtc/inference";
import { getPortalStore } from "../lib/portal/store";
import { seedUsers } from "../lib/portal/users";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    min: { type: "string" },
  },
});

async function main(): Promise<void> {
  if (values.json) process.env.PORTAL_STORE = "json";
  const cfg = loadPortalConfig();
  const config = { ...cfg.import };
  if (values.min !== undefined) {
    const n = Number(values.min);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--min inválido: ${values.min}`);
    config.minUnits = n;
  }
  const dir = path.resolve(process.cwd(), config.dir);
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
    const summary = await importMtc({ files, config, rules: loadTyreRules(), store, dryRun, log: (m) => console.log(m) });
    console.log("");
    console.log(formatImportSummary(summary));
    if (store) {
      const seeded = await seedUsers(store);
      console.log("");
      console.log(`Usuarios del portal: ${seeded.users.map((u) => `${u.nombre} (${u.rol})`).join(", ") || "ninguno"}`);
      for (const w of seeded.warnings) console.log(`Aviso: ${w}`);
      console.log(`Totales en el store: ${(await store.countCompanies()).toLocaleString("es-PE")} empresas, ${(await store.countFleet()).toLocaleString("es-PE")} vehículos`);
      await store.flush();
    }
    console.log(`\nListo en ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
  } finally {
    await store?.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
