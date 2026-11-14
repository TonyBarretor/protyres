/**
 * Cotización por voz (corrida D, punto 8): lo dictado -> el mismo texto que el cotizador ya entiende escrito.
 * Puro (sin store ni red): lo usa bot/voice-quote.ts después de transcribir.
 *
 *  1. spokenToDigits: números en palabras -> cifras ("doscientos noventa y cinco" -> 295, "veintidós punto cinco" -> 22.5,
 *     "veintidós y medio" -> 22.5, "una docena" -> 12, "media docena" -> 6, "mil" -> 1000). "un"/"una" solo antes de
 *     llanta/unidad/docena (si no, son artículos: "para una empresa").
 *  2. normalizeSpokenSizes: medidas dictadas sueltas -> forma escrita: "295 80 22.5", "295 barra 80 erre 22.5",
 *     "295 sobre 80 R 22 5" -> 295/80R22.5; "11 erre 22.5", "11 22.5" -> 11R22.5; "1000 R 20" -> 1000R20;
 *     "7 50 R 16" -> 7.50R16. Lo demás lo reconoce findTyreSizes como siempre.
 *  3. normalizeDictation: el pedido completo, en líneas como las escribe el vendedor:
 *       "cotízame ocho Flama 77 en 295 80 22.5 a 254 para ZBUSS, a 45 días"
 *       -> "Flama 77 295/80R22.5 x8 precio 254\npara ZBUSS\nplazo: 45 días"
 *     (cantidad "x8", precio "precio 254", cliente en su línea "para …", plazo "plazo: N días", "margen N%",
 *     "dscto N%", "con/sin igv"). Varias llantas: una línea por medida.
 *  4. normalizeVoiceCorrection: una corrección dictada con la cotización a la vista ("no, eran doce" -> "cantidad 12",
 *     "precio doscientos cincuenta y nueve" -> "precio 259", "cámbialo a Valor 99" -> "modelo Valor 99", "margen diez" ->
 *     "margen 10", "a sesenta días" -> "plazo: 60 días"). Un "ok"/"sí" dictado es { kind: "confirm" }: por voz nunca se
 *     arma el PDF (se pide escribir *ok*).
 *  2b. (corrida F, punto 9) antes de lo anterior, la zona de la medida se resuelve contra el catálogo (voice/sizes.ts):
 *     "295 80, ER 22.5" y "2 9 5 80 R 22.5" -> 295/80R22.5; varias posibles -> se pregunta; la cantidad no se pega.
 *  5. checkSizes: cada medida contra las del catálogo; si no está, las candidatas (misma medida con otra construcción,
 *     aro con ".5" que no se dijo, o ancho ±10 mm con el mismo perfil y aro). Nunca elige: quien llama pregunta.
 */
import { fixCatalogTerms } from "./fuzzy";
import { resolveSpokenSizes, type AmbiguousSize, type SizeResolution } from "./sizes";
import { fold } from "../../tyre/brands";
import { findTyreSizes, parseTyreSize, sizeLoose } from "../../tyre/spec";

// ── 1. números dictados ──

const UNITS: Record<string, number> = { cero: 0, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9 };
const TEENS: Record<string, number> = {
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiuno: 21, veintiun: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const TENS: Record<string, number> = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
const HUNDREDS: Record<string, number> = {
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500,
  seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
};
/** "un"/"una" son número solo antes de estas palabras. */
const COUNTABLE = /^(?:llantas?|neumaticos?|unidad(?:es)?|docenas?|juegos?)$/;

interface Tok {
  raw: string;
  /** fold() de una palabra; "" para separadores y cifras. */
  w: string;
  kind: "word" | "num" | "sep";
}

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(/(\p{L}+)|(\d+(?:[.,]\d+)?)|([^\p{L}\d]+)/gu)) {
    if (m[1]) out.push({ raw: m[1], w: fold(m[1]), kind: "word" });
    else if (m[2]) out.push({ raw: m[2], w: "", kind: "num" });
    else out.push({ raw: m[3], w: "", kind: "sep" });
  }
  return out;
}

/** Índice de la siguiente palabra/cifra después de i (saltando solo espacios), o -1. */
function nextIdx(toks: Tok[], i: number): number {
  let j = i + 1;
  while (j < toks.length && toks[j].kind === "sep" && /^\s+$/.test(toks[j].raw)) j++;
  return j < toks.length && toks[j].kind !== "sep" ? j : -1;
}

/** Lee un número en palabras desde toks[i]: { value, end } (end = último token usado) o null. */
function readWords(toks: Tok[], i: number): { value: number; end: number } | null {
  let value = 0;
  let end = -1;
  let j = i;
  const w = () => (j >= 0 && j < toks.length && toks[j].kind === "word" ? toks[j].w : "");
  // mil / N mil
  if (w() === "mil") {
    value = 1000;
    end = j;
    const n = nextIdx(toks, j);
    if (n < 0) return { value, end };
    j = n;
  }
  const start = j;
  let small = 0;
  let used = false;
  if (HUNDREDS[w()] !== undefined) {
    small = HUNDREDS[w()];
    used = true;
    end = j;
    const n = nextIdx(toks, j);
    j = n;
  }
  if (j >= 0 && TEENS[w()] !== undefined) {
    small += TEENS[w()];
    used = true;
    end = j;
  } else if (j >= 0 && TENS[w()] !== undefined) {
    small += TENS[w()];
    used = true;
    end = j;
    // "noventa y cinco"
    const y = nextIdx(toks, j);
    if (y >= 0 && toks[y].w === "y") {
      const u = nextIdx(toks, y);
      if (u >= 0 && toks[u].kind === "word" && UNITS[toks[u].w] !== undefined && toks[u].w !== "cero") {
        small += UNITS[toks[u].w];
        end = u;
      }
    }
  } else if (j >= 0 && UNITS[w()] !== undefined) {
    small += UNITS[w()];
    used = true;
    end = j;
  }
  if (!used && end < 0) return null;
  if (!used && j !== start) return null;
  return { value: value + small, end };
}

/** "doscientos noventa y cinco ochenta erre veintidós y medio" -> "295 80 erre 22.5". Las cifras escritas no cambian. */
export function spokenToDigits(text: string): string {
  // "por ciento", y "por 100" como lo escribe el smart_format de Deepgram tras una cifra ("12 por 100")
  const toks = tokenize((text ?? "").replace(/(?<![\p{L}])por\s+ciento(?![\p{L}])/giu, "%").replace(/(\d)\s+por\s+100(?!\d|[.,]\d)/giu, "$1 %"));
  const out: string[] = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    // "media docena" -> 6, "una docena" -> 12, "N docenas" (N ya en cifras más abajo)
    if (t.kind === "word" && t.w === "media") {
      const n = nextIdx(toks, i);
      if (n >= 0 && toks[n].w === "docena") {
        out.push("6");
        i = n + 1;
        continue;
      }
    }
    if (t.kind === "word" && (t.w === "un" || t.w === "una" || t.w === "uno")) {
      const n = nextIdx(toks, i);
      if (n >= 0 && toks[n].w === "docena") {
        out.push("12");
        i = n + 1;
        continue;
      }
      if (n < 0 || !COUNTABLE.test(toks[n].w)) {
        out.push(t.raw);
        i++;
        continue;
      }
      out.push("1");
      i++;
      continue;
    }
    let value: number | null = null;
    let end = i;
    if (t.kind === "num") {
      value = parseFloat(t.raw.replace(",", "."));
      end = i;
    } else if (t.kind === "word") {
      const r = readWords(toks, i);
      if (r) {
        value = r.value;
        end = r.end;
      }
    }
    if (value === null) {
      out.push(t.raw);
      i++;
      continue;
    }
    let str = t.kind === "num" && i === end ? t.raw.replace(",", ".") : String(value);
    // decimales: "punto cinco", "coma cinco", "y medio"; "N docenas"
    const n1 = nextIdx(toks, end);
    if (n1 >= 0 && (toks[n1].w === "punto" || toks[n1].w === "coma") && !str.includes(".")) {
      const n2 = nextIdx(toks, n1);
      const d = n2 >= 0 ? (toks[n2].kind === "num" ? { value: parseFloat(toks[n2].raw), end: n2, raw: toks[n2].raw } : (() => { const r = readWords(toks, n2); return r ? { ...r, raw: toks[n2].w === "cero" ? "0" : String(r.value) } : null; })()) : null;
      if (d && /^\d+$/.test(d.raw)) {
        // "siete punto cincuenta" -> 7.50; "veintidós punto cinco" -> 22.5; "punto cero cinco" no se usa
        str = `${str}.${d.raw}`;
        end = d.end;
      }
    } else if (n1 >= 0 && toks[n1].w === "y" && !str.includes(".")) {
      const n2 = nextIdx(toks, n1);
      if (n2 >= 0 && toks[n2].w === "medio") {
        str = `${str}.5`;
        end = n2;
      }
    } else if (n1 >= 0 && (toks[n1].w === "docenas" || toks[n1].w === "docena") && /^\d+$/.test(str)) {
      str = String(parseInt(str, 10) * 12);
      end = n1;
    }
    out.push(str);
    i = end + 1;
  }
  return out.join("");
}

// ── 2. medidas dictadas ──

const RIMS = new Set(["13", "14", "15", "16", "17", "18", "19", "20", "22", "24", "17.5", "19.5", "22.5", "24.5"]);
const HALF_RIMS = new Set(["17", "19", "22", "24"]);

/** El aro dictado: "22.5", "22 5" (solo 17/19/22/24 seguidos de un 5 suelto que no es cantidad). */
const RIM_RE = String.raw`(\d{2}(?:\.5)?)(?:\s+(5)(?![\d.]|\s*(?:llantas?|unidades|unid|und|x\b|%)))?`;

/**
 * "295 80 22.5" -> "295/80R22.5", "11 R 22.5" -> "11R22.5" (ver la cabecera). Antes: "erre"/"ere" -> R, "barra"/"sobre"
 * -> "/". Solo toca secuencias con forma de medida (ancho, perfil y aro plausibles).
 */
export function normalizeSpokenSizes(text: string): string {
  let t = (text ?? "").replace(/(\d),(\d)/g, "$1.$2");
  t = t.replace(/(?<=\d\s*)\b(?:erre|ere|r)\b(?=\s*\d)/gi, "R");
  t = t.replace(/(?<=\d)\s*\b(?:barra|sobre|slash)\b\s*(?=\d)/gi, "/");
  const rim = (r: string, half?: string) => (half && HALF_RIMS.has(r) ? `${r}.5` : r);
  // métrica: 295 80 22.5 · 295/80 R 22.5 · 295 / 80 22 5
  t = t.replace(new RegExp(String.raw`(?<![\d./])(\d{3})\s*(?:/\s*|,?\s)(\d{2})\s*(?:R\s*|,?\s)${RIM_RE}(?![\d/])`, "gi"), (all, w: string, a: string, r: string, half?: string) => {
    const rr = rim(r, half);
    const width = parseInt(w, 10);
    const aspect = parseInt(a, 10);
    if (width < 125 || width > 445 || aspect < 30 || aspect > 95 || !RIMS.has(rr)) return all;
    return `${w}/${a}R${rr}`;
  });
  // 7 50 R 16 -> 7.50R16
  t = t.replace(/(?<![\d./])(\d{1,2})\s+(\d{2})\s*R\s*(\d{2})(?![\d./])/gi, (all, w: string, d: string, r: string) => (RIMS.has(r) ? `${w}.${d}R${r}` : all));
  // 11 R 22.5 · 1000 R 20 · 12 R 22 5
  t = t.replace(new RegExp(String.raw`(?<![\d./])(\d{1,2}(?:\.\d{1,2})?|\d{3,4})\s*R\s*${RIM_RE}(?![\d/])`, "gi"), (all, w: string, r: string, half?: string) => {
    const rr = rim(r, half);
    return RIMS.has(rr) ? `${w}R${rr}` : all;
  });
  // 11 22.5 -> 11R22.5 (sin la R: solo anchos de camión y aros .5)
  t = t.replace(/(?<![\d./R])(\d{1,2})\s+(\d{2}\.5)(?![\d./])/gi, (all, w: string, r: string) => {
    const width = parseInt(w, 10);
    return width >= 7 && width <= 14 && RIMS.has(r) ? `${w}R${r}` : all;
  });
  return t;
}

// ── 3. el pedido dictado ──

/** Muletillas que no aportan al pedido. */
const FILLERS = /(?<![\p{L}\d])(?:e+h+|e+m+|m{2,}|este|o sea|bueno|pues|oye|mira|ya|okey|ok|gracias|por favor|porfa)(?![\p{L}\d])[,.]?/giu;
/** Palabra explícita de cotización al inicio (se quita: el texto ya va al cotizador). */
const QUOTE_HEAD = /^\s*(?:(?:hola|buenas?(?:\s+(?:tardes|d[ií]as|noches))?)[,\s]+)?(?:me\s+(?:puedes\s+|podr[ií]as\s+)?)?(?:c[oó]t[ií]za(?:me|nos|le)?|c[oó]t[ií]zo|cotizar|me\s+cotizas|(?:necesito|quiero|hazme|haz)\s+(?:una\s+)?cotizaci[oó]n|cotizaci[oó]n)\s*(?:de|para|por)?\s*[:,]?\s*/i;

const PCT = String.raw`(\d{1,2}(?:\.\d)?)\s*(?:%|por\s*ciento)?`;
const TERM_PATTERNS: { re: RegExp; out: (m: RegExpMatchArray) => string }[] = [
  { re: /(?:,\s*)?(?:\b(?:con\s+)?(?:un\s+)?(?:plazo|cr[eé]dito)\s+(?:de\s+|a\s+)?|\ba\s+)(\d{1,3})\s+d[ií]as(?:\s+de\s+(?:plazo|cr[eé]dito))?\b/i, out: (m) => `plazo: ${m[1]} días` },
  { re: /(?:,\s*)?\b(\d{1,3})\s+d[ií]as\s+de\s+(?:plazo|cr[eé]dito)\b/i, out: (m) => `plazo: ${m[1]} días` },
  { re: new RegExp(String.raw`(?:,\s*)?\b(?:con\s+)?(?:un\s+)?margen\s+(?:de\s+)?${PCT}`, "i"), out: (m) => `margen ${m[1]}%` },
  { re: /(?:,\s*)?\b(?:con\s+)?(?:un\s+)?(\d{1,2}(?:\.\d)?)\s*(?:%|por\s*ciento)\s+de\s+margen\b/i, out: (m) => `margen ${m[1]}%` },
  { re: new RegExp(String.raw`(?:,\s*)?\b(?:con\s+)?(?:un\s+)?(?:descuento|dscto|dcto)\s+(?:de\s+(?:un\s+)?)?${PCT}`, "i"), out: (m) => `dscto ${m[1]}%` },
  { re: /(?:,\s*)?\b(?:con\s+)?(?:un\s+)?(\d{1,2}(?:\.\d)?)\s*(?:%|por\s*ciento)\s+de\s+(?:descuento|dscto)\b/i, out: (m) => `dscto ${m[1]}%` },
  { re: /(?:,\s*)?\b(con|sin)\s+igv\b/i, out: (m) => `${m[1].toLowerCase()} igv` },
];

/** Precio dictado: "a 254", "precio 254", "a 254 dólares", "a US$ 254". `§n§` son medidas ya apartadas. */
const PRICE_RE = /(?:\b(?:a|en|precio(?:\s+de)?|a\s+precio\s+de|al\s+precio\s+de)\s+)(?:us\$|\$|s\/\.?|usd)?\s*(\d{2,6}(?:\.\d{1,2})?)(?:\s*(?:d[oó]lares|soles|usd))?(?![\d./§%]|\s*(?:d[ií]as|%|por\s*ciento))/i;
const QTY_RES = [/\bx\s*(\d{1,3})\b/i, /\b(\d{1,3})\s*(?:llantas?|neum[aá]ticos?|unidades|unidad|unid|und)\b/i, /^\s*(\d{1,3})\b(?!\s*(?:%|d[ií]as))/];
/** Cliente: "para ZBUSS", "cliente Transportes Beta" hasta una coma, "con …", "a N", "precio" o el final. */
const CUSTOMER_RE = /(?:^|[\s,])(?:para|cliente)\s+(?:la\s+empresa\s+|el\s+cliente\s+|la\s+)?(?!(?:direcci[oó]n|direccional|tracci[oó]n|posterior|delanter|mixt|el\s+eje)\b)([^,;\n]+?)(?=\s*(?:[,;.\n]|$|\bcon\b|\ba\s+\d|\bprecio\b|§))/i;

export interface DictatedQuote {
  /** El texto para el cotizador (líneas). */
  text: string;
  /** Medidas canónicas encontradas, en orden. */
  sizes: string[];
  /** Líneas de llanta (sin cliente ni condiciones). */
  items: string[];
  /** El cliente tal como se dictó ("" si no se dijo); en `text` va en su línea "para …". */
  customer: string;
  /** Marcas, diseños o medidas mal oídos corregidos contra el catálogo ("Fénix Suite" -> "Fenixway", "2 9 5 80 R 22.5" -> 295/80R22.5). */
  fixes: { from: string; to: string }[];
  /** Medidas dictadas que pueden ser varias del catálogo (se pregunta; en `text` va la primera opción). */
  sizeChoices: AmbiguousSize[];
  /** Zonas con forma de medida que no coinciden con ninguna del catálogo ("275 80 R 22"). */
  unheardSizes: string[];
}

export interface DictationCatalog {
  /** Diseños del catálogo con su marca (para "Flama 77" -> "Fenixway Flama 77" si la marca no se dijo y es única). */
  designs?: { brand: string; model: string }[];
  /** Marcas del catálogo (para corregir por parecido lo mal oído: voice/fuzzy.ts). */
  brands?: string[];
  /** Medidas canónicas del catálogo (para leer la medida dictada: voice/sizes.ts). Sin ellas, solo lo plausible. */
  sizes?: string[];
}

const clean = (s: string) => s.replace(/\s+/g, " ").replace(/\s+([,.;])/g, "$1").replace(/^[\s,.;:]+|[\s,.;:]+$/g, "");

/** La lectura de una zona de medida sin catálogo (para saber si la del catálogo cambió algo y decirlo). */
const plainRead = (zone: string) => findTyreSizes(normalizeSpokenSizes(zone)).map((s) => s.canonical);

/** normalizeSpoken con el detalle de las medidas (resueltas contra `catalogSizes`, ambiguas, sin coincidencia). */
export function normalizeSpokenDetailed(text: string, catalogSizes?: string[] | null): { text: string; sizes: SizeResolution } {
  const digits = spokenToDigits((text ?? "").replace(/[“”"']/g, "")).replace(FILLERS, " ");
  const sizes = resolveSpokenSizes(digits, catalogSizes, plainRead);
  // las medidas ya resueltas van apartadas (⟦n⟧): la lectura de siempre solo mira lo demás
  const out = normalizeSpokenSizes(sizes.marked).replace(/⟦(\d+)⟧/g, (_, k: string) => sizes.marks[parseInt(k, 10)] ?? "");
  return { text: clean(out), sizes };
}

/** Lo dictado, con números y medidas normalizados y sin muletillas (base de normalizeDictation y de las correcciones). */
export function normalizeSpoken(text: string, catalogSizes?: string[] | null): string {
  return normalizeSpokenDetailed(text, catalogSizes).text;
}

/** La marca de un diseño dicho sin marca, si en el catálogo es de una sola marca. */
function withBrand(desc: string, catalog: DictationCatalog): string {
  const designs = catalog.designs ?? [];
  if (!desc || !designs.length) return desc;
  const f = ` ${fold(desc)} `;
  if (designs.some((d) => f.includes(` ${fold(d.brand)} `))) return desc;
  // también sin espacios entre letras y cifras ("ADR 778" dictado = diseño "ADR778")
  const tight = (x: string) => fold(x).replace(/(?<=[a-z])\s+(?=\d)|(?<=\d)\s+(?=[a-z])/g, "");
  const ft = ` ${tight(desc)} `;
  const hits = new Set(designs.filter((d) => fold(d.model).length > 2 && (f.includes(` ${fold(d.model)} `) || ft.includes(` ${tight(d.model)} `))).map((d) => d.brand));
  return hits.size === 1 ? `${[...hits][0]} ${desc}` : desc;
}

/** "cotízame ocho Flama 77 en 295 80 22.5 a 254 para ZBUSS, a 45 días" -> líneas para el cotizador (ver la cabecera). */
export function normalizeDictation(transcript: string, catalog: DictationCatalog = {}): DictatedQuote {
  // marcas y diseños mal oídos, por parecido contra el catálogo (antes de normalizar: compara palabras como se dijeron)
  const fixed = catalog.designs?.length || catalog.brands?.length ? fixCatalogTerms(transcript, { brands: catalog.brands ?? [], designs: catalog.designs ?? [] }) : { text: transcript, changes: [] };
  const spoken = normalizeSpokenDetailed(fixed.text, catalog.sizes);
  let t = spoken.text.replace(QUOTE_HEAD, "");
  // condiciones
  const terms: string[] = [];
  for (const p of TERM_PATTERNS) {
    for (let guard = 0; guard < 3; guard++) {
      const m = t.match(p.re);
      if (!m) break;
      terms.push(p.out(m));
      t = `${t.slice(0, m.index)} ${t.slice((m.index ?? 0) + m[0].length)}`;
    }
  }
  // medidas apartadas (§n§) para que sus cifras no se lean como cantidad o precio
  const sizes: string[] = [];
  // findTyreSizes trabaja sobre el texto normalizado (mayúsculas, sin comillas, espacios simples): mismas posiciones que t
  const found = findTyreSizes(t);
  let marked = "";
  let last = 0;
  for (const s of found) {
    marked += t.slice(last, s.index) + ` §${sizes.length}§ `;
    sizes.push(s.canonical);
    last = s.index + s.length;
  }
  marked += t.slice(last);
  t = clean(marked);
  // cliente
  let customer = "";
  const cm = t.match(CUSTOMER_RE);
  if (cm) {
    customer = clean(cm[1].replace(/(?:\s+(?:y|e|con|a|de|al))+\s*$/i, ""));
    // el cotizador reconoce el cliente por la mayúscula inicial ("para zbuss" dictado -> "para Zbuss")
    if (customer === customer.toLowerCase()) customer = customer.replace(/(?<![\p{L}])\p{L}/gu, (c) => c.toUpperCase());
    t = `${t.slice(0, cm.index)} ${t.slice((cm.index ?? 0) + cm[0].length)}`;
  }
  // llantas: un trozo por medida (lo que no tiene medida se junta con la siguiente; lo que sobra al final, con la anterior)
  const chunks = clean(t)
    .split(/\s*(?:[,;]|\by\b|\bm[aá]s\b|\btambi[eé]n\b|\bademás\b|\botr[ao]s\b)\s*/i)
    .map(clean)
    .filter(Boolean);
  const groups: string[] = [];
  let carry = "";
  for (const c of chunks) {
    const joined = clean(`${carry} ${c}`);
    if (/§\d+§/.test(c)) {
      groups.push(joined);
      carry = "";
    } else carry = joined;
  }
  if (carry) {
    if (groups.length) groups[groups.length - 1] = clean(`${groups[groups.length - 1]} ${carry}`);
    else groups.push(carry);
  }
  const items = groups.map((g) => {
    let rest = g;
    let price: string | null = null;
    const pm = rest.match(PRICE_RE);
    if (pm) {
      price = pm[1];
      rest = `${rest.slice(0, pm.index)} ${rest.slice((pm.index ?? 0) + pm[0].length)}`;
    }
    let qty: string | null = null;
    for (const re of QTY_RES) {
      const qm = clean(rest).match(re);
      if (qm && parseInt(qm[1], 10) > 0) {
        qty = qm[1];
        const r2 = clean(rest);
        rest = `${r2.slice(0, qm.index)} ${r2.slice((qm.index ?? 0) + qm[0].length)}`;
        break;
      }
    }
    const marks = [...rest.matchAll(/§(\d+)§/g)].map((m) => sizes[parseInt(m[1], 10)]);
    rest = rest.replace(/§\d+§/g, " ").replace(/(?<![\p{L}\d])(?:en|de|del|la|las|el|los|medida|llantas?|neum[aá]ticos?|unidades|aro)(?![\p{L}\d])/giu, " ");
    const desc = withBrand(clean(rest), catalog);
    return clean([desc, marks.join(" "), qty ? `x${qty}` : "", price ? `precio ${price}` : ""].filter(Boolean).join(" "));
  });
  const lines = [...items.filter(Boolean), ...(customer ? [`para ${customer}`] : []), ...terms];
  const sizeFixes = spoken.sizes.resolved.filter((r) => !r.plain).map((r) => ({ from: r.from, to: displaySize(r.to) }));
  return {
    text: lines.join("\n"),
    sizes,
    items: items.filter(Boolean),
    customer,
    fixes: [...fixed.changes, ...sizeFixes],
    sizeChoices: spoken.sizes.ambiguous,
    unheardSizes: spoken.sizes.unmatched,
  };
}

// ── 4. correcciones dictadas ──

/** confirm: un "ok" dictado · text: el comando escrito equivalente · unknown: no es una corrección conocida (el texto normalizado). */
export type VoiceCorrection = { kind: "confirm" } | { kind: "text"; text: string } | { kind: "unknown"; text: string };

const CONFIRM_RE = /^(?:(?:ok|okey|si|dale|listo|confirmo|confirmar|correcto|esta bien|todo bien|armalo|arma|generalo|genera|enviar|envialo|envia|perfecto|ya|bueno)\s*)+$/;
const CORRECTION_HEAD = /^(?:no|nop|perd[oó]n|disculpa|corrijo|correcci[oó]n|mejor|me equivoqu[eé])\b[,.\s]*/i;

/** Una corrección dictada sobre la cotización a la vista -> el comando escrito equivalente (ver la cabecera). */
export function normalizeVoiceCorrection(transcript: string): VoiceCorrection {
  const base = normalizeSpoken(transcript).replace(/[.!?¡¿]+/g, " ").trim();
  // "ok", "sí, dale", "está bien, ármalo" (las muletillas ya se quitaron: "ok" y "ya" sueltos se miran en el original)
  if (CONFIRM_RE.test(fold(transcript ?? "")) || (base && CONFIRM_RE.test(fold(base)))) return { kind: "confirm" };
  let t = base;
  for (let i = 0; i < 3 && CORRECTION_HEAD.test(t); i++) t = t.replace(CORRECTION_HEAD, "").trim();
  const f = fold(t);
  if (CONFIRM_RE.test(f)) return { kind: "confirm" };
  let m: RegExpMatchArray | null;
  // cantidad: "eran doce", "son 12", "que sean 12", "cantidad 12", "12 llantas", "doce"
  if ((m = t.match(/^(?:eran|son|ser[ií]an|que\s+sean|sean|pon(?:le|me)?|cantidad(?:\s+de)?|cambia\s+la\s+cantidad\s+a)?\s*(\d{1,4})\s*(?:llantas?|unidades|unid|und)?$/i))) return { kind: "text", text: `cantidad ${m[1]}` };
  // precio: "precio 259", "a 259", "el precio es 259", "259 dólares"
  if ((m = t.match(/^(?:(?:el\s+)?precio(?:\s+(?:es|de|a))?|a(?:\s+precio\s+de)?|que\s+sea\s+a|c[aá]mbialo\s+a)\s*(?:us\$|\$)?\s*(\d{2,6}(?:\.\d{1,2})?)(?:\s*(?:d[oó]lares|usd))?$/i)) || (m = t.match(/^(\d{2,6}(?:\.\d{1,2})?)\s*(?:d[oó]lares|usd)$/i)))
    return { kind: "text", text: `precio ${m[1]}` };
  // margen / descuento / plazo
  if ((m = t.match(/^(?:con\s+)?(?:un\s+)?margen\s+(?:de\s+)?(\d{1,2}(?:\.\d)?)\s*(?:%|por\s*ciento)?$/i))) return { kind: "text", text: `margen ${m[1]}` };
  if ((m = t.match(/^(?:con\s+)?(?:un\s+)?(?:descuento|dscto|dcto)\s+(?:de\s+)?(\d{1,2}(?:\.\d)?)\s*(?:%|por\s*ciento)?$/i))) return { kind: "text", text: `dscto ${m[1]}` };
  if ((m = t.match(/^(?:(?:el\s+)?plazo\s+(?:es\s+)?(?:de\s+|a\s+)?|cr[eé]dito\s+(?:de\s+|a\s+)?|a\s+)(\d{1,3})\s+d[ií]as$/i))) return { kind: "text", text: `plazo: ${m[1]} días` };
  if ((m = t.match(/^(con|sin)\s+igv$/i))) return { kind: "text", text: `${m[1].toLowerCase()} igv` };
  // modelo: "cámbialo a Valor 99", "mejor la Valor 99", "que sea Valor 99", "pon Valor 99" (sin medida: con medida es un pedido)
  if ((m = t.match(/^(?:c[aá]mbia(?:lo|la|me)?|cambiar|que\s+sea(?:n)?|pon(?:le|me)?|ponlo)\s+(?:a\s+|por\s+)?(?:la\s+|el\s+|las\s+|los\s+)?(?:modelo\s+|dise[nñ]o\s+)?(.+)$/i)) && !findTyreSizes(m[1]).length && /\p{L}/u.test(m[1]))
    return { kind: "text", text: `modelo ${clean(m[1])}` };
  if (/^(?:la|el)\s+\S/i.test(t) && base !== t && !findTyreSizes(t).length && /\p{L}/u.test(t)) return { kind: "text", text: `modelo ${clean(t.replace(/^(?:la|el)\s+/i, ""))}` };
  return { kind: "unknown", text: t };
}

// ── 5. medidas contra el catálogo ──

export interface SizeCheck {
  size: string;
  /** Medidas del catálogo que pudo haber querido decir (máx. 3); vacío = ninguna parecida. */
  candidates: string[];
}

/** Las medidas que NO están en el catálogo, con sus candidatas. Catálogo vacío = no se valida (lista vacía). */
export function checkSizes(sizes: string[], catalogSizes: Iterable<string>): SizeCheck[] {
  const cat = new Set(catalogSizes);
  if (!cat.size) return [];
  const out: SizeCheck[] = [];
  for (const s of sizes) {
    if (cat.has(s)) continue;
    const p = parseTyreSize(s);
    const cands = new Set<string>();
    for (const c of cat) {
      if (sizeLoose(c) === sizeLoose(s)) cands.add(c);
    }
    if (p && Number.isInteger(p.rim)) {
      const half = s.replace(new RegExp(`${p.rim}$`), `${p.rim}.5`);
      if (cat.has(half)) cands.add(half);
    }
    if (p && p.kind === "metric" && p.aspect !== undefined) {
      for (const c of cat) {
        const q = parseTyreSize(c);
        if (q && q.kind === "metric" && q.aspect === p.aspect && q.rim === p.rim && (q.prefix ?? "") === (p.prefix ?? "") && Math.abs(q.width - p.width) <= 10 && q.width !== p.width) cands.add(c);
      }
    }
    out.push({ size: s, candidates: [...cands].sort().slice(0, 3) });
  }
  return out;
}

/** Forma de mostrar una medida canónica ("10R20" -> "10.00R20"). */
export function displaySize(canonical: string): string {
  return parseTyreSize(canonical)?.display ?? canonical;
}
