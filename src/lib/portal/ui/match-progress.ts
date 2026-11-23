/**
 * Corrida K, punto 6 (pantalla): avance de Match Venta por producto prioritario para la tarjeta del producto y el
 * Tablero. Stock: la foto del último cálculo (no se lee la tabla de precios al abrir la página); cotizado: las
 * cotizaciones guardadas desde que se marcó la prioridad (solo lectura, el cotizador no cambia).
 */
import { loadMatchStock, matchProgress, type MatchProgressRow } from "../match";
import type { PortalStore } from "../store/types";
import type { Quote } from "../../quote/types";
import { readRecentQuotes } from "../../store/own-stock";

export async function loadMatchProgress(store: PortalStore, opts: { quotes?: (since: Date | null) => Promise<Quote[]> } = {}): Promise<MatchProgressRow[]> {
  const { stock } = await loadMatchStock({ store, prices: null });
  if (!stock.length) return [];
  const products = await store.listMatchProducts();
  const since = products
    .filter((p) => p.prioridad && p.prioridadAt)
    .map((p) => p.prioridadAt!.getTime())
    .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
  const read = opts.quotes ?? ((s: Date | null) => readRecentQuotes(s));
  const quotes = await read(Number.isFinite(since) ? new Date(since) : null).catch(() => [] as Quote[]);
  return matchProgress(store, { stock, quotes });
}
