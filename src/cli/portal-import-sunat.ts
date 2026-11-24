/**
 * Corrida L: importa del "Padrón reducido del RUC" de SUNAT (descarga libre, ya bajado a data/sunat/) el domicilio
 * fiscal, el estado y la condición de los RUC del portal (padrón MTC, empresas manuales y clientes de ventas) y sus
 * locales anexos. Lee los zip en streaming, sin descomprimirlos (ver src/lib/portal/sunat/import.ts). Idempotente.
 * No consulta la web de SUNAT: la única fuente son los dos archivos.
 *
 *   npm run portal:import-sunat                              escribe en Postgres (DATABASE_URL) o en data/portal-store.json
 *   npm run portal:import-sunat -- --json                    fuerza el store JSON local (igual que PORTAL_STORE=json)
 *   npm run portal:import-sunat -- --archivo X.zip --anexos Y.zip    otros archivos (.zip o .txt)
 *   npm run portal:import-sunat -- --sin-anexos              solo el padrón principal (los locales que había se conservan)
 *   npm run portal:import-sunat -- --fecha 2026-11-23        fecha "según SUNAT al …" (por defecto, la de la entrada del zip)
 */
import "./env";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadPortalConfig } from "../lib/portal/config";
import { formatSunatSummary, importSunat } from "../lib/portal/sunat/import";
import { getPortalStore } from "../lib/portal/store";

const { values } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    archivo: { type: "string" },
    anexos: { type: "string" },
    "sin-anexos": { type: "boolean", default: false },
    fecha: { type: "string" },
  },
});

async function main(): Promise<void> {
  if (values.json) process.env.PORTAL_STORE = "json";
  const cfg = loadPortalConfig().sunat;
  const dir = path.resolve(process.cwd(), cfg.dir);
  const archivo = path.resolve(process.cwd(), values.archivo ?? path.join(dir, cfg.archivo));
  const anexos = values["sin-anexos"] ? null : path.resolve(process.cwd(), values.anexos ?? path.join(dir, cfg.anexos));
  for (const f of [archivo, anexos]) if (f && !fs.existsSync(f)) throw new Error(`No existe ${f}. Descarga el padrón reducido del RUC de SUNAT (orientacion.sunat.gob.pe) en ${dir}.`);
  if (values.fecha !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.fecha)) throw new Error(`--fecha inválida (AAAA-MM-DD): ${values.fecha}`);
  const store = await getPortalStore();
  console.log(`Store: ${process.env.DATABASE_URL && process.env.PORTAL_STORE !== "json" ? "Postgres" : `JSON local (${process.env.PORTAL_STORE_PATH || "data/portal-store.json"})`}`);
  try {
    const summary = await importSunat({ store, archivo, anexos, fecha: values.fecha, log: (m) => console.log(m) });
    await store.flush();
    console.log("");
    console.log(formatSunatSummary(summary));
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
