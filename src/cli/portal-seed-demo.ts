/**
 * Ventas de demostración para el portal (is_demo = true, vendedor Frank, últimos 12 meses). Borra antes las demo, así
 * que se puede repetir. Necesita empresas importadas (npm run portal:import-mtc).
 *
 *   npm run portal:seed-demo
 *   npm run portal:seed-demo -- --json           fuerza el store JSON local (igual que PORTAL_STORE=json)
 *   npm run portal:seed-demo -- --count 12 --seed 7
 */
import "./env";
import { parseArgs } from "node:util";
import { fmtTable } from "./env";
import { DEMO_COMPANY_COUNT, DEMO_SEED, seedDemoSales } from "../lib/portal/sales/demo";
import { getPortalStore } from "../lib/portal/store";

const { values } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    count: { type: "string" },
    seed: { type: "string" },
  },
});

async function main(): Promise<void> {
  if (values.json) process.env.PORTAL_STORE = "json";
  const count = values.count !== undefined ? Number(values.count) : DEMO_COMPANY_COUNT;
  const seed = values.seed !== undefined ? Number(values.seed) : DEMO_SEED;
  if (!Number.isInteger(count) || count < 8 || count > 12) throw new Error("--count debe estar entre 8 y 12");
  if (!Number.isInteger(seed)) throw new Error(`--seed inválido: ${values.seed}`);
  const store = await getPortalStore();
  try {
    if ((await store.countCompanies()) === 0) throw new Error("No hay empresas: corre antes npm run portal:import-mtc");
    const r = await seedDemoSales(store, { count, seed });
    console.log(`Demo: ${r.deleted} ventas demo anteriores borradas, ${r.inserted} nuevas en ${r.companies.length} empresas.`);
    console.log(`Encontradas por nombre: ${r.found.map((f) => `${f.target} → ${f.razonSocial} (${f.ruc})`).join("; ") || "ninguna"}`);
    if (r.missing.length) console.log(`No encontradas: ${r.missing.join(", ")}`);
    const rows = r.companies.map((c) => {
      const mine = r.sales.filter((s) => s.ruc === c.ruc);
      return {
        ruc: c.ruc,
        empresa: c.razonSocial.slice(0, 48),
        unidades: c.unidades,
        llantasPiso: c.llantasPiso,
        medida: c.medidas[0] ?? "(sin medida)",
        facturas: mine.length,
        neumaticos: mine.reduce((a, s) => a + s.cantidad, 0),
      };
    });
    console.log("");
    console.log(fmtTable(rows));
    await store.flush();
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
