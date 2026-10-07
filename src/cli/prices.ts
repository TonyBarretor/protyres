/**
 * Look at what is in the store.
 *   npm run prices                      -> lists loaded (provider / kind / rows)
 *   npm run prices -- 11R22.5           -> all prices for a size (any notation), own stock first
 *   npm run prices -- 11R22.5 --brand fenixway
 *   npm run prices -- --find "parche vipal"   -> free-text search in descriptions
 */
import "./env";
import { parseArgs } from "node:util";
import { getStore } from "../lib/store";
import { parseTyreSize } from "../lib/tyre/spec";
import { fold } from "../lib/tyre/brands";
import { latestPerTyre, textSimilarity } from "../lib/quote/match";
import { fmtTable } from "./env";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { brand: { type: "string" }, find: { type: "string" }, all: { type: "boolean", default: false }, history: { type: "boolean", default: false } },
});

async function main() {
  const store = await getStore();
  if (positionals.length === 0 && !values.all && !values.find) {
    const p = await store.providers();
    console.log(fmtTable(p.map((x) => ({ proveedor: x.provider, tipo: x.kind, filas: x.rows, fuentes: x.sources.join(","), ultimo_precio: x.lastPriceDate }))));
    await store.close();
    return;
  }
  let rows = await store.allRows();
  if (values.find) {
    const q = values.find;
    rows = rows
      .map((r) => ({ r, s: textSimilarity(q, r.description) }))
      .filter((x) => x.s >= 0.3)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.r);
  } else if (positionals[0]) {
    const size = parseTyreSize(positionals[0]);
    if (!size) throw new Error(`no entiendo la medida "${positionals[0]}"`);
    rows = rows.filter((r) => r.size === size.canonical);
    console.log(`medida: ${size.display} (${size.canonical})`);
  }
  if (values.brand) rows = rows.filter((r) => fold(r.brand) === fold(values.brand!));
  if (!values.history) rows = latestPerTyre(rows);
  const order = { stock: 0, own: 1, provider: 2 };
  rows.sort((a, b) => order[a.kind] - order[b.kind] || (a.cost ?? Infinity) - (b.cost ?? Infinity));
  console.log(
    fmtTable(
      rows.map((r) => ({
        tipo: r.kind,
        proveedor: r.provider,
        cod: r.code ?? "",
        marca: r.brand,
        modelo: r.model,
        medida: r.sizeDisplay || r.description.slice(0, 28),
        pr: r.ply ?? "",
        pos: r.position ?? "",
        precio: r.cost ?? "",
        mon: r.currency,
        igv: r.priceIncludesTax ? "inc" : "",
        stock: r.stock ?? "",
        fecha: r.priceDate,
      })),
    ),
  );
  await store.close();
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
