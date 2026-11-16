/**
 * Corrida H, punto 4: contador de stock (de apoyo; la referencia del inventario sigue siendo Odoo). Muestra los
 * descuentos activos de los pedidos (sin liberar y hechos sobre la última carga de su origen) y el disponible de cada
 * producto: cargado − en pedidos.
 *
 *   npm run portal:stock                       descuentos activos con el disponible
 *   npm run portal:stock -- --medida 215/75R17.5   disponible de esa medida (filas de stock propio)
 *
 * Store: Postgres con DATABASE_URL; si no, data/store.json (o STORE_PATH).
 */
import "./env";
import { parseArgs } from "node:util";
import { availableText, committedMap } from "../lib/portal/order/origin";
import { getStore } from "../lib/store";
import { findTyreSizes } from "../lib/tyre/spec";

const { values } = parseArgs({ options: { medida: { type: "string" } } });

async function main(): Promise<void> {
  const store = await getStore();
  console.log(`Store: ${process.env.DATABASE_URL ? "Postgres" : "JSON local"} · contador de apoyo: la referencia del inventario es Odoo`);
  try {
    const list = await store.listStockDeductions();
    const committed = committedMap(list);
    const rows = (await store.allRows()).filter((r) => r.kind === "stock");
    if (values.medida) {
      const size = findTyreSizes(values.medida)[0]?.canonical ?? values.medida;
      for (const r of rows.filter((x) => x.size === size)) {
        const c = committed.get(r.id) ?? 0;
        console.log(`  ${[r.sizeDisplay, r.brand, r.model].filter(Boolean).join(" ").padEnd(40)} ${r.stock === null ? "sin dato" : availableText({ cargadas: r.stock, enPedidos: c, disponible: r.stock - c })}`);
      }
      return;
    }
    if (!list.length) {
      console.log("No hay descuentos activos: el disponible es lo cargado.");
      return;
    }
    console.log(`${list.length} descuentos activos:`);
    for (const d of list) {
      const row = rows.find((r) => r.id === d.rowId);
      const c = committed.get(d.rowId) ?? 0;
      console.log(`  ${d.createdAt.slice(0, 10)}  ${d.label.padEnd(28)} ${String(d.quantity).padStart(4)} × ${d.description.padEnd(38)} ${d.warehouse.padEnd(10)} ${row && row.stock !== null ? availableText({ cargadas: row.stock, enPedidos: c, disponible: row.stock - c }) : ""}`);
    }
  } finally {
    await store.close();
  }
}

main().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
