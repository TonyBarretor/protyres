/**
 * Corrida K — tabla de equivalencias de medida de Match Venta (migración posible / requiere revisión técnica) para las
 * medidas de los productos prioritarios, con la regla de sizes.ts (mismo aro, diámetro exterior ±tolerancia). Compara
 * contra las medidas del padrón, del stock, de las ventas y una lista de medidas comunes.
 *
 *   npm run match:equivalencias                  imprime la tabla (JSON para config/portal.json match.equivalencias)
 *   npm run match:equivalencias -- --write       la escribe en config/portal.json (reemplaza solo match.equivalencias)
 *   npm run match:equivalencias -- --json        fuerza el store JSON local
 */
import "./env";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { loadPortalConfig, portalConfigPath } from "../lib/portal/config";
import { saleLines } from "../lib/portal/match/recalc";
import { buildEquivalenceTable, outerDiameterMm, replaceEquivalencias } from "../lib/portal/match/sizes";
import { ownStockProducts } from "../lib/portal/match/stock";
import { loadSalesSettings } from "../lib/portal/sales/config";
import { getPortalStore } from "../lib/portal/store";
import { getStore } from "../lib/store";

const { values } = parseArgs({ options: { write: { type: "boolean", default: false }, json: { type: "boolean", default: false } } });

async function main(): Promise<void> {
  if (values.json) process.env.PORTAL_STORE = "json";
  const cfg = loadPortalConfig().match;
  const store = await getPortalStore();
  const prices = await getStore();
  try {
    const stock = ownStockProducts(await prices.allRows(), await prices.listStockDeductions(), cfg);
    const products = await store.listMatchProducts();
    const seeds = new Set([...products.filter((p) => p.prioridad).map((p) => p.code), ...cfg.productos.map((p) => p.codigo)]);
    const targets = [...new Set(stock.filter((s) => seeds.has(s.code)).map((s) => s.size))].sort();
    const fleet = new Set<string>();
    for (const c of await store.matchInputs()) for (const m of Object.keys(c.medidas)) fleet.add(m);
    const sales = saleLines(await store.querySales({ tipoLinea: ["neumatico"] }), loadSalesSettings().leasingRucs);
    const candidates = [...fleet, ...stock.map((s) => s.size), ...sales.map((s) => s.medida).filter((m): m is string => !!m)];
    const table = buildEquivalenceTable(targets, candidates, cfg);
    for (const [size, eq] of Object.entries(table)) {
      console.log(`${size} (${Math.round(outerDiameterMm(size, cfg.perfilConvencional) ?? 0)} mm)`);
      console.log(`  migración posible: ${eq.migracion.map((e) => `${e.desde} (${e.diferenciaPct > 0 ? "+" : ""}${e.diferenciaPct}%)`).join(", ") || "ninguna"}`);
      console.log(`  requiere revisión técnica: ${eq.revision.map((e) => `${e.desde} (${e.diferenciaPct > 0 ? "+" : ""}${e.diferenciaPct}%)`).join(", ") || "ninguna"}`);
    }
    if (values.write) {
      const file = portalConfigPath();
      fs.writeFileSync(file, replaceEquivalencias(fs.readFileSync(file, "utf8"), table));
      console.log(`\nGuardada en ${file} (match.equivalencias). Después: npm run portal:recalc-match.`);
    } else console.log(`\n${JSON.stringify(table, null, 2)}\n\nPara guardarla en config/portal.json: npm run match:equivalencias -- --write`);
  } finally {
    await prices.close();
    await store.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
