/**
 * Catálogo para la voz (corrida D, punto 8): marcas, diseños y medidas de las listas de precios del cotizador.
 * Sirve para dos cosas: los keyterms de Deepgram (vocabulary.ts) y validar la medida dictada (dictation.ts checkSizes).
 * Orden: primero lo propio (kind "own", el catálogo de 360 Tyres), luego por cantidad de filas.
 */
import type { PriceRow } from "../../ingest/types";
import type { PriceStore } from "../../store/types";

export interface VoiceCatalog {
  /** Marcas, de la más presente a la menos. */
  brands: string[];
  /** Diseños con su marca (marca + diseño sin repetir, sin distinguir mayúsculas), lo propio primero. */
  designs: { brand: string; model: string }[];
  /** Medidas canónicas ("295/80R22.5"), lo propio primero y luego las más presentes. */
  sizes: string[];
  /** Clientes de cotizaciones anteriores (empresa), de la más reciente a la más antigua (para el cliente dictado). */
  customers?: string[];
}

type Row = Pick<PriceRow, "brand" | "model" | "size" | "isTyre" | "kind">;

function ranked<T>(rows: Row[], key: (r: Row) => T | null, id: (t: T) => string): T[] {
  const score = new Map<string, { item: T; own: number; n: number; first: number }>();
  rows.forEach((r, i) => {
    const item = key(r);
    if (item === null) return;
    const k = id(item);
    const cur = score.get(k) ?? { item, own: 0, n: 0, first: i };
    cur.n++;
    if (r.kind === "own") cur.own++;
    // la forma de lo propio manda ("Valor 99" del catálogo propio antes que "VALOR 99" de un proveedor)
    if (r.kind === "own" && cur.own === 1) cur.item = item;
    score.set(k, cur);
  });
  return [...score.values()].sort((a, b) => (b.own > 0 ? 1 : 0) - (a.own > 0 ? 1 : 0) || b.n - a.n || a.first - b.first).map((s) => s.item);
}

export function voiceCatalogFromRows(rows: Row[]): VoiceCatalog {
  const tyres = rows.filter((r) => r.isTyre);
  const low = (s: string) => s.trim().toLowerCase();
  return {
    brands: ranked(tyres, (r) => (r.brand?.trim() ? r.brand.trim() : null), low),
    designs: ranked(tyres, (r) => (r.brand?.trim() && r.model?.trim() ? { brand: r.brand.trim(), model: r.model.trim() } : null), (d) => `${low(d.brand)}|${low(d.model)}`),
    sizes: ranked(tyres, (r) => (r.size?.trim() ? r.size.trim() : null), (s) => s),
  };
}

let cache: { at: number; store: PriceStore; catalog: VoiceCatalog } | null = null;
/** Cuánto se reutiliza el catálogo leído (las listas cambian pocas veces al día). */
export const VOICE_CATALOG_TTL_MS = 10 * 60 * 1000;

/** El catálogo del store del cotizador, con caché de VOICE_CATALOG_TTL_MS (solo se lee cuando llega una nota de voz). */
export async function voiceCatalogFromStore(store: PriceStore, now = Date.now()): Promise<VoiceCatalog> {
  if (cache && cache.store === store && now - cache.at < VOICE_CATALOG_TTL_MS) return cache.catalog;
  const [rows, quotes] = await Promise.all([store.allRows(), store.listQuotes(300).catch(() => [])]);
  const seen = new Set<string>();
  const customers: string[] = [];
  for (const q of quotes) {
    const name = q.customer?.company?.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    customers.push(name);
  }
  const catalog = { ...voiceCatalogFromRows(rows), customers };
  cache = { at: now, store, catalog };
  return catalog;
}
