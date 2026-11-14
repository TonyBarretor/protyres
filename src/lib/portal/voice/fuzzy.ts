/**
 * Comparación aproximada de lo dictado (prueba con Deepgram real, 2026-11-13). Deepgram a veces oye otra cosa: "ZBUSS"
 * dicho "zeta bus" llega como "Septa BUSS", "Fenixway" como "Fénix Suite". No se fuerza cada caso con un reemplazo: se
 * compara por cómo SUENA en español (clave fonética) con Jaro-Winkler, contra lo que existe (empresas, marcas, diseños).
 *
 *  - phoneticKey: minúsculas sin tildes; z/ce/ci -> s, c/qu/k -> k, v -> b, w -> u, x -> ks, h muda, ll/y -> y, dobles
 *    letras una sola, solo letras.
 *  - spokenForms: las siglas impronunciables se dicen letra por letra ("ZBUSS" -> "zeta bus", "ATC" -> "a te ce").
 *  - matchSpokenName: nombre dictado contra candidatas -> clear (una clara), doubt (varias parecidas o una regular) o none.
 *  - fixCatalogTerms: palabras dictadas que se parecen mucho a una marca o al nombre de un diseño del catálogo -> esa marca
 *    o diseño (los diseños exigen el mismo número: "Balor 99" -> "Valor 99").
 */

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

export function phoneticKey(s: string): string {
  let t = fold(s).replace(/[^a-zñ ]/g, " ");
  t = t
    .replace(/ñ/g, "n")
    .replace(/qu/g, "k")
    .replace(/c(?=[ei])/g, "s")
    .replace(/ch/g, "C")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    .replace(/x/g, "ks")
    .replace(/v/g, "b")
    .replace(/w/g, "u")
    .replace(/ll/g, "y")
    .replace(/y(?=\s|$)/g, "i")
    .replace(/h/g, "")
    .replace(/g(?=[ei])/g, "j")
    .replace(/\s+/g, "");
  return t.replace(/(.)\1+/g, "$1");
}

const LETTER: Record<string, string> = {
  a: "a", b: "be", c: "ce", d: "de", e: "e", f: "efe", g: "ge", h: "hache", i: "i", j: "jota", k: "ka", l: "ele", m: "eme",
  n: "ene", o: "o", p: "pe", q: "cu", r: "erre", s: "ese", t: "te", u: "u", v: "ve", w: "doble ve", x: "equis", y: "ye", z: "zeta",
};
const ONSET = /^(?:[aeiou]|bl|br|cl|cr|dr|fl|fr|gl|gr|kl|kr|pl|pr|tr|ch|ll|[bcdfghjklmnñpqrstvwxyz][aeiouy])/;

/** Formas habladas de una palabra (clave fonética): tal cual y, si es sigla o empieza impronunciable, deletreada. */
export function spokenForms(word: string): string[] {
  const w = fold(word).replace(/[^a-z]/g, "");
  if (!w) return [];
  const out = new Set([phoneticKey(w)]);
  // sigla corta ("ATC", "JCH"): letra por letra
  if (w.length <= 4 && /^[aeiou]?[^aeiou]+$/.test(w)) out.add(phoneticKey([...w].map((c) => LETTER[c] ?? c).join(" ")));
  // "ZBUSS": la primera letra deletreada y el resto como se lee
  if (w.length > 2 && !ONSET.test(w)) out.add(phoneticKey(`${LETTER[w[0]] ?? w[0]} ${w.slice(1)}`));
  return [...out];
}

/** Jaro-Winkler (0..1). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  let trans = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) trans++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - trans / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

// ── empresas ──

/** Palabras que no distinguen una empresa (forma social y genéricas). */
const GENERIC = new Set(
  "s a c sac s a a saa e i r l eirl s r l srl s a sa ltda cia y de del la las el los e en transportes transporte trans empresa empresas grupo corporacion inversiones servicios negociaciones comercial comercializadora distribuidora expreso turismo".split(" "),
);

/** Formas habladas del nombre distintivo de una empresa ("TRANSPORTES ZBUSS S.A.C." -> "sbus", "setabus"). */
export function companyForms(name: string, opts: { prefixes?: boolean } = {}): string[] {
  const words = fold(name)
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !GENERIC.has(w) && !/^\d+$/.test(w));
  if (!words.length) return [phoneticKey(name)];
  // combinaciones de las formas de cada palabra (máx. 3 palabras distintivas)
  // combinaciones de las formas de cada palabra (máx. 3 palabras distintivas), también solo las primeras ("Zeta Bus" de
  // "Zeta Bus Express"): así "zeta bus" queda en duda entre ZBUSS y Zeta Bus Express en vez de elegir una
  const out = new Set<string>();
  let acc = [""];
  for (const w of words.slice(0, 3)) {
    acc = acc.flatMap((p) => spokenForms(w).map((f) => p + f)).slice(0, 12);
    if (opts.prefixes !== false) for (const a of acc) if (a.length >= 4) out.add(a);
  }
  if (opts.prefixes === false) for (const a of acc) if (a) out.add(a);
  return out.size ? [...out] : [phoneticKey(name)];
}

export interface NameCandidate {
  id: number | string;
  name: string;
}
export interface NameMatch<T extends NameCandidate> {
  kind: "clear" | "doubt" | "none";
  best: T | null;
  score: number;
  /** Para preguntar (doubt): las parecidas, de mejor a peor (máx. 3). */
  candidates: T[];
}

/** Umbrales: una candidata es clara con ≥ CLEAR y ventaja ≥ MARGIN sobre la segunda; desde DOUBT se pregunta. */
export const NAME_CLEAR = 0.9;
export const NAME_DOUBT = 0.82;
export const NAME_MARGIN = 0.04;
/** Con claves de menos de 6 letras, por debajo de esto no cuenta como parecido. */
export const SHORT_KEY_MIN = 0.95;

function nameScore(spoken: string, forms: string[]): number {
  const sk = companyForms(spoken, { prefixes: false });
  let best = 0;
  for (const a of sk)
    for (const b of forms) {
      const j = jaroWinkler(a, b);
      // claves cortas ("beta" / "seta"): una letra distinta ya es otra palabra; se exige casi igualdad
      best = Math.max(best, Math.min(a.length, b.length) < 6 && j < SHORT_KEY_MIN ? 0 : j);
    }
  return best;
}

export function matchSpokenName<T extends NameCandidate>(spoken: string, candidates: T[]): NameMatch<T> {
  const scored = candidates
    .map((c) => ({ c, s: nameScore(spoken, companyForms(c.name)) }))
    .filter((x) => x.s >= NAME_DOUBT)
    .sort((a, b) => b.s - a.s);
  if (!scored.length) return { kind: "none", best: null, score: 0, candidates: [] };
  const [first, second] = scored;
  const clear = first.s >= NAME_CLEAR && (!second || first.s - second.s >= NAME_MARGIN);
  return { kind: clear ? "clear" : "doubt", best: first.c, score: first.s, candidates: scored.slice(0, 3).map((x) => x.c) };
}

// ── marcas y diseños ──

/** Palabras corrientes que nunca son el comienzo de una marca mal oída. */
const COMMON = new Set(
  "la el los las de del con por para en y a al un una unos unas su sus se que me nos le les lo mi tu señor señora ingeniero jefe jefa gerente compras flota cargo carga visite visité llame llamé hable hablé quieren quiere usan usa tienen tiene quedamos".split(" ").map((w) => w.normalize("NFD").replace(/[\u0300-\u036f]/g, "")),
);

export interface CatalogTerms {
  brands: string[];
  designs: { brand: string; model: string }[];
}

/** Umbral para corregir una marca/diseño: alto, solo letras ≥ 5, misma primera letra (sonido). */
export const TERM_MIN = 0.9;

interface Term {
  out: string;
  key: string;
  /** Cifras que deben seguir (diseños "Valor 99"); null para marcas. */
  num: string | null;
  words: number;
}

/**
 * Solo las marcas más presentes del catálogo (la lista viene ordenada: lo propio y las de más filas primero) y sus diseños:
 * el catálogo real tiene 231 marcas y las raras se parecen a palabras o apellidos ("Antares", "Atlas", "Titan").
 */
export const FUZZY_TOP_BRANDS = 40;

function catalogTerms(c: CatalogTerms): Term[] {
  const terms: Term[] = [];
  const seen = new Set<string>();
  const top = c.brands.slice(0, FUZZY_TOP_BRANDS);
  const topSet = new Set(top.map((b) => fold(b)));
  for (const b of top) {
    const key = phoneticKey(b);
    if (key.length < 5 || seen.has(`b:${key}`)) continue;
    seen.add(`b:${key}`);
    terms.push({ out: b, key, num: null, words: b.trim().split(/\s+/).length });
  }
  for (const d of c.designs) {
    if (topSet.size && !topSet.has(fold(d.brand))) continue;
    const m = d.model.trim().match(/^([\p{L}][\p{L}\s]*?)\s*(\d[\w.-]*)?$/u);
    if (!m) continue;
    const alpha = m[1].trim();
    const key = phoneticKey(alpha);
    if (key.length < 4 || seen.has(`d:${key}:${m[2] ?? ""}`)) continue;
    seen.add(`d:${key}:${m[2] ?? ""}`);
    terms.push({ out: alpha, key, num: m[2] ?? null, words: alpha.split(/\s+/).length });
  }
  return terms;
}

const compact = (s: string) => fold(s).replace(/[\s-]+/g, "");

/**
 * Corrige marcas y diseños mal oídos ("Fénix Suite" -> "Fenixway", "Balor 99" -> "Valor 99"). Lo que ya coincide (sin
 * contar mayúsculas ni tildes) no se toca. Devuelve el texto y los cambios (para decirlos).
 */
export function fixCatalogTerms(text: string, catalog: CatalogTerms): { text: string; changes: { from: string; to: string }[] } {
  const terms = catalogTerms(catalog);
  if (!terms.length) return { text, changes: [] };
  const tokens = [...text.matchAll(/[\p{L}]+|\d[\w.,/-]*/gu)].map((m) => ({ s: m[0], start: m.index!, end: m.index! + m[0].length }));
  const changes: { from: string; to: string; start: number; end: number }[] = [];
  const lenOk = (a: string, b: string) => Math.abs(a.length - b.length) <= Math.max(2, Math.round(0.25 * b.length));
  const window = (i: number, n: number) => {
    const win = tokens.slice(i, i + n);
    if (win.length < n || win.some((w) => /^\d/.test(w.s))) return null;
    return { win, phrase: text.slice(win[0].start, win[n - 1].end), next: tokens[i + n] };
  };
  const numOk = (t: Term, next: (typeof tokens)[number] | undefined) => !t.num || (!!next && next.s.replace(/[.,]$/, "") === t.num);
  for (let i = 0; i < tokens.length; i++) {
    // lo que ya está bien (marca o diseño tal cual) se salta entero
    let exact = 0;
    for (let n = 3; n >= 1 && !exact; n--) {
      const w = window(i, n);
      if (w && terms.some((t) => numOk(t, w.next) && fold(w.phrase) === fold(t.out))) exact = n;
    }
    if (exact) {
      i += exact - 1;
      continue;
    }
    // marca partida o junta ("fenix way" -> Fenixway, "westlake" -> Westlake, "doublecoin" -> Double Coin), en minúsculas
    // también: es la misma palabra sin espacios (corrida F, punto 9)
    let joined: { n: number; t: Term; phrase: string; start: number; end: number } | null = null;
    for (let n = 3; n >= 1 && !joined; n--) {
      const w = window(i, n);
      if (!w) continue;
      const c = compact(w.phrase);
      const t = c.length >= 5 ? terms.find((x) => x.num === null && compact(x.out) === c && (n > 1 || x.words > 1)) : undefined;
      if (t) joined = { n, t, phrase: w.phrase, start: w.win[0].start, end: w.win[n - 1].end };
    }
    if (joined) {
      changes.push({ from: joined.phrase, to: joined.t.out, start: joined.start, end: joined.end });
      i += joined.n - 1;
      continue;
    }
    let hit: { n: number; t: Term; phrase: string; start: number; end: number; score: number } | null = null;
    for (let n = 3; n >= 1; n--) {
      const w = window(i, n);
      if (!w) continue;
      const key = phoneticKey(w.phrase);
      if (key.length < 5) continue;
      // un nombre de marca mal oído llega como nombre propio ("Fénix Suite", "PUMBO"): palabras en minúscula ("de compras")
      // no se tocan; y lo que empieza por una palabra corriente tampoco ("la", "de", "con"…)
      if (!w.win.some((x) => /^\p{Lu}/u.test(x.s)) || COMMON.has(fold(w.win[0].s))) continue;
      for (const t of terms) {
        if (!numOk(t, w.next) || Math.abs(n - t.words) > 1 || key[0] !== t.key[0] || !lenOk(key, t.key)) continue;
        const score = jaroWinkler(key, t.key);
        if (score >= TERM_MIN && (!hit || score > hit.score)) hit = { n, t, phrase: w.phrase, start: w.win[0].start, end: w.win[n - 1].end, score };
      }
    }
    if (hit) {
      changes.push({ from: hit.phrase, to: hit.t.out, start: hit.start, end: hit.end });
      i += hit.n - 1;
    }
  }
  let out = text;
  for (const c of [...changes].reverse()) out = `${out.slice(0, c.start)}${c.to}${out.slice(c.end)}`;
  return { text: out, changes: changes.map(({ from, to }) => ({ from, to })) };
}
