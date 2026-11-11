/**
 * Borra las ventas de demostración (solo is_demo = true; las reales no se tocan).
 *
 *   npm run portal:clear-demo
 *   npm run portal:clear-demo -- --json          fuerza el store JSON local (igual que PORTAL_STORE=json)
 */
import "./env";
import { parseArgs } from "node:util";
import { clearDemoSales } from "../lib/portal/sales/demo";
import { getPortalStore } from "../lib/portal/store";

const { values } = parseArgs({ options: { json: { type: "boolean", default: false } } });

async function main(): Promise<void> {
  if (values.json) process.env.PORTAL_STORE = "json";
  const store = await getPortalStore();
  try {
    const n = await clearDemoSales(store);
    console.log(`Ventas demo borradas: ${n}.`);
    await store.flush();
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
