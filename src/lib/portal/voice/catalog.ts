/**
 * Catálogo para la voz (corrida D, punto 8): marcas, diseños y medidas de las listas de precios del cotizador.
 * Sirve para dos cosas: los keyterms de Deepgram (vocabulary.ts) y validar la medida dictada (dictation.ts checkSizes).
 * Orden: primero lo propio (kind "own", el catálogo de 360 Tyres), luego por cantidad de filas.
 */
import type { PriceRow } from "../../ingest/types";
import { profileId, profileKey, usesUnits } from "../../quote/profiles";
import type { CustomerProfile } from "../../settings";
import type { PriceStore } from "../../store/types";
import type { DictationProfile } from "./dictation";

export interface VoiceCatalog {
  /** Marcas, de la más presente a la menos. */
  brands: string[];
  /** Diseños con su marca (marca + diseño sin repetir, sin distinguir mayúsculas), lo propio primero. */
  designs: { brand: string; model: string }[];
  /** Medidas canónicas ("295/80R22.5"), lo propio primero y luego las más presentes. */
  sizes: string[];
  /** Clientes de cotizaciones anteriores (empresa), de la más reciente a la más antigua (para el cliente dictado). */
  customers?: string[];
  /** Clientes con perfil (config/customers.json) y las sucursales de sus cotizaciones (corrida H: Prosegur por voz). */
  profiles?: DictationProfile[];
  /** Lonas (PR) de cada medida en las listas (corrida I: las dictadas se validan contra estas). Solo medidas con dato. */
  plies?: Record<string, number[]>;
}

type Row = Pick<PriceRow, "brand" | "model" | "size" | "isTyre" | "kind"> & Partial<Pick<PriceRow, "ply">>;

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
    plies: pliesOf(tyres),
  };
}

/** Las lonas de cada medida (solo las filas que las traen). */
function pliesOf(rows: Row[]): Record<string, number[]> {
  const out: Record<string, Set<number>> = {};
  for (const r of rows) if (r.size?.trim() && typeof r.ply === "number" && r.ply > 0) (out[r.size.trim()] ??= new Set()).add(r.ply);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
}

let cache: { at: number; store: PriceStore; catalog: VoiceCatalog } | null = null;
/** Cuánto se reutiliza el catálogo leído (las listas cambian pocas veces al día). */
export const VOICE_CATALOG_TTL_MS = 10 * 60 * 1000;

/** Los clientes con perfil para la voz: nombres, sucursales de sus cotizaciones (`unit`) y si piden UB. */
export function voiceProfiles(profiles: CustomerProfile[], quotes: { customerProfile?: string; unit?: string }[] = []): DictationProfile[] {
  // solo los de contrato o con unidad / UB (Prosegur): un perfil que solo pide placa (ANCRO, corrida J) se dicta como
  // cualquier cliente ("para Ancro") y el cotizador lo reconoce por el nombre
  return profiles.filter((p) => usesUnits(p) || !!p.contract?.items.length).map((p) => {
    const id = profileId(p);
    const units = new Map<string, string>();
    for (const q of quotes) if (q.customerProfile === id && q.unit?.trim()) units.set(q.unit.trim().toLowerCase(), q.unit.trim());
    return { key: profileKey(p), name: p.name, names: [...new Set([...p.aliases, p.name, p.company].filter(Boolean))], units: [...units.values()], ub: p.required.includes("ub") };
  });
}

/**
 * El catálogo del store del cotizador, con caché de VOICE_CATALOG_TTL_MS (solo se lee cuando llega una nota de voz).
 * `profiles`: los clientes con perfil de la configuración del cotizador (Prosegur), para reconocerlos en lo dictado.
 */
export async function voiceCatalogFromStore(store: PriceStore, now = Date.now(), profiles: CustomerProfile[] = []): Promise<VoiceCatalog> {
  if (cache && cache.store === store && now - cache.at < VOICE_CATALOG_TTL_MS) return profiles.length && !cache.catalog.profiles?.length ? { ...cache.catalog, profiles: voiceProfiles(profiles) } : cache.catalog;
  const [rows, quotes] = await Promise.all([store.allRows(), store.listQuotes(300).catch(() => [])]);
  const seen = new Set<string>();
  const customers: string[] = [];
  for (const q of quotes) {
    const name = q.customer?.company?.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    customers.push(name);
  }
  const catalog = { ...voiceCatalogFromRows(rows), customers, ...(profiles.length ? { profiles: voiceProfiles(profiles, quotes) } : {}) };
  cache = { at: now, store, catalog };
  return catalog;
}
