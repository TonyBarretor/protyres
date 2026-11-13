/**
 * Vocabulario de la voz: los términos clave que se mandan a Deepgram (`keyterm`) y los reemplazos que se aplican a la
 * transcripción (términos aprendidos con `aprende X = Y`, guardados en la tabla `vocabulary` del PortalStore).
 *
 * Límite de Deepgram (docs de Keyterm Prompting, Nova-3): 500 tokens en total entre todos los keyterms; recomiendan
 * concentrarse en los 20–50 más importantes. Aquí: como mucho MAX_KEYTERMS (100) términos y un presupuesto estimado de
 * KEYTERM_TOKEN_BUDGET (450) tokens, con prioridad: fijos > aprendidos > [catálogo: 15 diseños, 10 marcas y 10 medidas
 * principales] > clientes > marcas > medidas > [resto del catálogo]. El tramo del catálogo (corrida D, punto 8: cotizar por
 * voz) va antes que los clientes para que un vendedor con muchas empresas no lo deje fuera; sin catálogo, como antes.
 */
import { KNOWN_BRANDS } from "../../tyre/brands";
import { displayName } from "../report/match";
import type { VocabularyEntry } from "../store/types";
import type { VoiceCatalog } from "./catalog";

export const MAX_KEYTERMS = 100;
/** Margen bajo los 500 tokens de Deepgram (la estimación por caracteres es aproximada). */
export const KEYTERM_TOKEN_BUDGET = 450;

/** Siempre van: nombres propios del negocio que el modelo genérico escribe mal. */
export const FIXED_KEYTERMS = ["Fenixway", "Flama 77", "enllante", "CPK"];

/** Medidas de camión/bus más comunes en Perú. */
export const COMMON_SIZES = [
  "11R22.5",
  "12R22.5",
  "295/80R22.5",
  "315/80R22.5",
  "275/80R22.5",
  "385/65R22.5",
  "215/75R17.5",
  "235/75R17.5",
  "1000R20",
  "1100R20",
  "1200R20",
  "7.50R16",
  "8.25R16",
];

/** Reemplazos de fábrica (además de los aprendidos): cómo suele transcribirse algo -> cómo se escribe. */
export const DEFAULT_REPLACEMENTS: { term: string; meaning: string }[] = [
  { term: "flama setenta y siete", meaning: "Flama 77" },
  { term: "fenix way", meaning: "Fenixway" },
  { term: "en llante", meaning: "enllante" },
];

export interface KeytermSources {
  /** Razones sociales de las empresas asignadas / con oportunidad del vendedor. */
  companies?: string[];
  /** Vocabulario aprendido (store.listVocabulary()). */
  learned?: Pick<VocabularyEntry, "term" | "meaning">[];
  /** Por defecto KNOWN_BRANDS. */
  brands?: string[];
  /** Por defecto COMMON_SIZES. */
  sizes?: string[];
  /** Marcas, diseños y medidas de las listas de precios (voice/catalog.ts). */
  catalog?: VoiceCatalog;
  maxTerms?: number;
  tokenBudget?: number;
}

/** Lo principal del catálogo que va antes que los clientes (ver la cabecera). */
export const CATALOG_TOP = { designs: 15, brands: 10, sizes: 10 };

/** Tokens estimados de un término (≈3 caracteres por token en español y siglas, +1 de separación). */
export function estimateTokens(term: string): number {
  return Math.ceil(term.length / 3) + 1;
}

/** Lista de keyterms para Deepgram: sin repetidos (sin distinguir mayúsculas), en orden de prioridad, dentro del límite. */
export function buildKeyterms(src: KeytermSources = {}): string[] {
  const maxTerms = src.maxTerms ?? MAX_KEYTERMS;
  const budget = src.tokenBudget ?? KEYTERM_TOKEN_BUDGET;
  const cat = src.catalog;
  const models = (cat?.designs ?? []).map((d) => d.model);
  const candidates = [
    ...FIXED_KEYTERMS,
    ...(src.learned ?? []).map((v) => v.meaning),
    ...models.slice(0, CATALOG_TOP.designs),
    ...(cat?.brands ?? []).slice(0, CATALOG_TOP.brands),
    ...(cat?.sizes ?? []).slice(0, CATALOG_TOP.sizes),
    ...(src.companies ?? []).map((c) => displayName(c)),
    ...(src.brands ?? KNOWN_BRANDS),
    ...(src.sizes ?? COMMON_SIZES),
    ...models.slice(CATALOG_TOP.designs),
    ...(cat?.sizes ?? []).slice(CATALOG_TOP.sizes),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const raw of candidates) {
    const t = (raw ?? "").trim().replace(/\s+/g, " ");
    if (!t || t.length > 60 || seen.has(t.toLowerCase())) continue;
    const cost = estimateTokens(t);
    if (used + cost > budget) continue; // uno largo no impide que entren otros cortos
    seen.add(t.toLowerCase());
    out.push(t);
    used += cost;
    if (out.length >= maxTerms) break;
  }
  return out;
}

const ACCENTS: Record<string, string> = { a: "aáàä", e: "eéèë", i: "iíìï", o: "oóòö", u: "uúùü", n: "nñ" };

/** Patrón del término: sin distinguir tildes, espacios flexibles (null si vacío). */
function termPattern(term: string): string | null {
  const words = term
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return null;
  return words
    .map((w) =>
      [...w]
        .map((ch) => (ACCENTS[ch] ? `[${ACCENTS[ch]}]` : ch.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")))
        .join(""),
    )
    .join("[\\s,]+");
}

/**
 * Reemplaza en `text` los términos aprendidos (y los de fábrica) por su significado, sin distinguir mayúsculas ni tildes
 * y solo palabras completas. Una sola pasada (lo ya reemplazado no se vuelve a tocar) y, donde se solapan, gana el término
 * más largo: "pepe grande" antes que "pepe". Los aprendidos mandan sobre los de fábrica.
 */
export function applyVocabulary(text: string, vocab: Pick<VocabularyEntry, "term" | "meaning">[] = [], opts: { defaults?: boolean } = {}): string {
  const all = [...vocab, ...(opts.defaults === false ? [] : DEFAULT_REPLACEMENTS)];
  const seen = new Set<string>();
  const entries: { pattern: string; meaning: string; len: number }[] = [];
  for (const v of all) {
    const key = v.term.trim().toLowerCase();
    const meaning = v.meaning.trim();
    if (!key || !meaning || seen.has(key)) continue;
    seen.add(key);
    const pattern = termPattern(v.term);
    if (pattern) entries.push({ pattern, meaning, len: key.length });
  }
  if (!entries.length) return text.normalize("NFC");
  entries.sort((a, b) => b.len - a.len);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${entries.map((e) => `(${e.pattern})`).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  return text.normalize("NFC").replace(re, (...args: unknown[]) => {
    const groups = args.slice(1, entries.length + 1);
    const i = groups.findIndex((g) => g !== undefined);
    return i >= 0 ? entries[i].meaning : String(args[0]);
  });
}

/** "aprende flama setenta y siete = Flama 77" -> { term, meaning }; null si no es ese comando. */
export function parseLearnCommand(text: string): { term: string; meaning: string } | null {
  const m = /^\s*aprende\s+(.+?)\s*(?:=|:|->|→|\bes\b)\s*(.+?)\s*$/i.exec(text);
  if (!m) return null;
  const term = m[1].replace(/^["'“”]+|["'“”]+$/g, "").trim();
  const meaning = m[2].replace(/^["'“”]+|["'“”]+$/g, "").trim();
  return term && meaning ? { term, meaning } : null;
}
