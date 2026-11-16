/**
 * Corrida H, 3b: importa la lista de proveedores (Excel de contactos: EMPRESA · CONTACTO · TELEFONO · CORREO · MARCAS) a
 * la tabla `suppliers`. Se puede repetir: actualiza por nombre y conserva las condiciones de pago y entrega recordadas.
 * El Excel y los teléfonos son datos del cliente: van bajo data/ (ignorado por git), nunca en el repo.
 *
 *   npm run portal:import-suppliers                                  data/referencia-360tyres/Contactos_de_Proveedores.xlsx
 *   npm run portal:import-suppliers -- --file otra/lista.xlsx
 *   npm run portal:import-suppliers -- --dry-run                     solo muestra lo que importaría
 *   npm run portal:import-suppliers -- --list                        muestra los proveedores guardados
 *
 * Store: Postgres con DATABASE_URL; si no, data/store.json (o STORE_PATH).
 */
import "./env";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { importSuppliers } from "../lib/portal/order/suppliers-import";
import { getStore } from "../lib/store";

const DEFAULT_FILE = "data/referencia-360tyres/Contactos_de_Proveedores.xlsx";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    list: { type: "boolean", default: false },
  },
});

/** "987 654 321" -> "987 *** 321": la consola no muestra teléfonos completos. */
const maskPhone = (p: string | undefined) => (p ? p.replace(/^(\d{3})\s?\d{3}\s?(\d{3})$/, "$1 *** $2") : "—");

async function main(): Promise<void> {
  const store = await getStore();
  console.log(`Store: ${process.env.DATABASE_URL ? "Postgres" : "JSON local"}`);
  try {
    if (!values.list) {
      const file = values.file ?? DEFAULT_FILE;
      if (!fs.existsSync(file)) throw new Error(`No encuentro ${file} (pásalo con --file).`);
      const r = await importSuppliers(store, fs.readFileSync(file), { dryRun: values["dry-run"] });
      for (const w of r.warnings) console.log(`⚠️ ${w}`);
      console.log(values["dry-run"] ? `Se importarían ${r.suppliers.length} proveedores:` : `Proveedores: ${r.inserted} nuevos, ${r.updated} actualizados.`);
      for (const x of r.suppliers) console.log(`  ${x.name.padEnd(22)} ${(x.contact ?? "—").padEnd(20)} ${maskPhone(x.phone).padEnd(13)} cotizador: ${(x.provider ?? "—").padEnd(6)} marcas: ${x.brands.join(", ") || "—"}`);
      return;
    }
    const list = await store.listSuppliers();
    console.log(`${list.length} proveedores guardados:`);
    for (const x of list) console.log(`  ${x.name.padEnd(22)} ${(x.contact ?? "—").padEnd(20)} ${maskPhone(x.phone).padEnd(13)} cotizador: ${(x.provider ?? "—").padEnd(6)} pago: ${x.lastPayment ?? "—"} · entrega: ${x.lastDelivery ?? "—"}`);
  } finally {
    await store.close();
  }
}

main().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
