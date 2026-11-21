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
import { fixCatalogTerms, jaroWinkler, matchSpokenName } from "./fuzzy";
import { extractSpokenPlates, groupItems, joinUbDigits, markUbs, placePlateMarks, readSpokenPlate, splitPly, unglueNumbers } from "./items";
import { normalizePlate } from "../../quote/line-refs";
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
  // "dos mil cinco" -> 2005, "dos mil doscientos uno" -> 2201 (corrida H: UBs dictadas)
  if (used && value === 0 && small > 0 && small < 1000) {
    const n = nextIdx(toks, end);
    if (n >= 0 && toks[n].w === "mil") {
      const r = readWords(toks, n);
      if (r) return { value: small * 1000 + (r.value - 1000), end: r.end };
    }
  }
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
    // "uno" entre cifras dictadas una por una ("UB uno dos tres uno", "dos dos cero uno") es 1
    if (t.kind === "word" && t.w === "uno") {
      const n = nextIdx(toks, i);
      const prevNum = /\d\s*$/.test(out.join(""));
      const nextNum = n >= 0 && (toks[n].kind === "num" || UNITS[toks[n].w] !== undefined);
      if (prevNum || nextNum) {
        out.push("1");
        i++;
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
// corrida H: la palabra entera ("cotiza" ya no se come el inicio de "cotización": quedaba "ción" en la llanta) y "hazme la cotización"
// corrida I: el "para" que sigue se queda ("Cotizar para ZBUSS, …": sin él, el cliente quedaba pegado a la llanta)
const QUOTE_HEAD = /^\s*(?:(?:hola|buenas?(?:\s+(?:tardes|d[ií]as|noches))?)[,\s]+)?(?:me\s+(?:puedes\s+|podr[ií]as\s+)?)?(?:c[oó]t[ií]za(?:me|nos|le)?|c[oó]t[ií]zo|cotizar|me\s+cotizas|(?:necesito|quiero|hazme|haz|dame|mándame|mandame)\s+(?:una\s+|la\s+)?cotizaci[oó]n|cotizaci[oó]n)(?![\p{L}])\s*[:,]?\s*(?:de|por)?(?![\p{L}])\s*[:,]?\s*/iu;

const PCT = String.raw`(\d{1,2}(?:\.\d)?)\s*(?:%|por\s*ciento)?`;
/** IGV dicho u oído ("IGV", "IGB", "IPV", "i g v") o "impuestos". */
const IGV_WORD = String.raw`(?:i\.?\s?[gpbvj]\.?\s?[vb]\.?|impuestos?)(?![\p{L}])`;
/** "… 18 %", "… del 18 por ciento" detrás del IGV. */
const IGV_PCT = String.raw`(?:\s*,?\s*(?:del?\s+)?(?:i\.?\s?[gpbvj]\.?\s?[vb]\.?\s+)?18(?:\s*%|\s+por\s*ciento)?)?`;

/**
 * Corrida I: el dictado en forma de ficha ("cliente Fenixway, modelo valor 96, 11 R 22.5 18 PR, por 4 unidades. Precio,
 * 298 dólares") -> lo que el resto ya lee: "por 4 unidades"/"cantidad 4" -> "x4"; "precio, 298"/"el precio es 298" ->
 * "precio 298"; "298 dólares" -> "precio 298"; las etiquetas "modelo", "marca", "medida", "diseño" se quitan. La moneda
 * dicha (soles o dólares) se devuelve para avisar si no es la de la cotización.
 */
export function fichaWords(text: string): { text: string; currency: "PEN" | "USD" | null } {
  const currency = /(?<![\p{L}])(?:nuevos\s+)?soles(?![\p{L}])|(?<![\p{L}])s\/\.?\s*\d/iu.test(text) ? "PEN" : /(?<![\p{L}])(?:d[oó]lares|usd)(?![\p{L}])|us\$|\$\s*\d/iu.test(text) ? "USD" : null;
  const t = text
    .replace(/(?<![\p{L}])(?:por|cantidad(?:\s+de)?)\s*[:,]?\s*(\d{1,3})(?:\s+(?:unidades|unidad|llantas?|neum[aá]ticos?|unid|und))?(?![\d.,]?\d|\s*(?:d[ií]as|%|por\s*ciento))(?![\p{L}])/giu, " x$1 ")
    .replace(/(?<![\p{L}])(?:el\s+)?precio(?:\s+unitario)?(?:\s+(?:es|de))?\s*[,:.]?\s*(?=(?:us\$|\$|s\/\.?|usd)?\s*\d)/giu, "precio ")
    .replace(/(?<![\p{L}\d.,])(?<!(?:precio|a|en|al|de)\s)(\d{2,6}(?:[.,]\d{1,2})?)\s*(?:d[oó]lares|nuevos\s+soles|soles|usd)(?![\p{L}])/giu, "precio $1")
    // la etiqueta deja una pausa: "para ZBUSS marca Fenixway" -> "para ZBUSS, Fenixway" (el cliente termina ahí)
    .replace(/(?<![\p{L}])(?:(?:el|la)\s+)?(?:modelo|marca|medida|dise[nñ]o)\s*[:,.]?\s*(?=[\p{L}\d§])/giu, ", ");
  return { text: t, currency };
}
const TERM_PATTERNS: { re: RegExp; out: (m: RegExpMatchArray) => string }[] = [
  { re: /(?:,\s*)?(?:\b(?:con\s+)?(?:un\s+)?(?:plazo|cr[eé]dito)\s+(?:de\s+|a\s+)?|\ba\s+)(\d{1,3})\s+d[ií]as(?:\s+de\s+(?:plazo|cr[eé]dito))?\b/i, out: (m) => `plazo: ${m[1]} días` },
  { re: /(?:,\s*)?\b(\d{1,3})\s+d[ií]as\s+de\s+(?:plazo|cr[eé]dito)\b/i, out: (m) => `plazo: ${m[1]} días` },
  // "para ZVA 30 días" (Deepgram se comió la "a" de "a 30 días")
  { re: /(?:,\s*)?(?<![\d.])\b(\d{1,3})\s+d[ií]as\b(?!\s+de\s+(?:entrega|validez))/i, out: (m) => `plazo: ${m[1]} días` },
  { re: new RegExp(String.raw`(?:,\s*)?\b(?:con\s+)?(?:un\s+)?margen\s+(?:de\s+)?${PCT}`, "i"), out: (m) => `margen ${m[1]}%` },
  { re: /(?:,\s*)?\b(?:con\s+)?(?:un\s+)?(\d{1,2}(?:\.\d)?)\s*(?:%|por\s*ciento)\s+de\s+margen\b/i, out: (m) => `margen ${m[1]}%` },
  { re: new RegExp(String.raw`(?:,\s*)?\b(?:con\s+)?(?:un\s+)?(?:descuento|dscto|dcto)\s+(?:del?\s+(?:un\s+)?)?${PCT}`, "i"), out: (m) => `dscto ${m[1]}%` },
  { re: /(?:,\s*)?\b(?:con\s+)?(?:un\s+)?(\d{1,2}(?:\.\d)?)\s*(?:%|por\s*ciento)\s+de\s+(?:descuento|dscto)\b/i, out: (m) => `dscto ${m[1]}%` },
  // "sin IPV" (Deepgram, 2026-11-16): IGV con la consonante del medio mal oída. Corrida I: "incluido impuestos", "IGV
  // incluido", "más IGV", "IGB 18 por 100" (Deepgram, producción 17/11) y variantes: la opción de IGV del cotizador
  { re: new RegExp(String.raw`(?:,\s*)?(?<![\p{L}\d])(?:incluid[oa]s?|incluye(?:ndo)?|inclu[ií]do|con|inc\.?)\s+(?:el\s+|los\s+)?${IGV_WORD}${IGV_PCT}`, "iu"), out: () => "con igv" },
  { re: new RegExp(String.raw`(?:,\s*)?(?<![\p{L}\d])${IGV_WORD}${IGV_PCT}\s+incluid[oa]s?(?![\p{L}])`, "iu"), out: () => "con igv" },
  { re: new RegExp(String.raw`(?:,\s*)?(?<![\p{L}\d])(?:sin|m[aá]s|\+|no\s+incluye|aparte\s+(?:el\s+)?)\s*(?:el\s+|los\s+)?${IGV_WORD}${IGV_PCT}`, "iu"), out: () => "sin igv" },
  { re: new RegExp(String.raw`(?:,\s*)?(?<![\p{L}\d])${IGV_WORD}${IGV_PCT}\s+aparte(?![\p{L}])`, "iu"), out: () => "sin igv" },
];
/** El IGV dicho sin decir si va incluido ("IGV 18 %", "impuestos"): se quita del pedido y se avisa. */
const IGV_BARE = new RegExp(String.raw`(?:,\s*)?(?<![\p{L}\d])${IGV_WORD}${IGV_PCT}(?![\p{L}])`, "giu");

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
  /**
   * Corrida H, punto 6: el cliente es uno con perfil (config/customers.json: Prosegur), nombrado al inicio o con "para …"
   * aunque Deepgram lo oiga mal ("Prosegul", "proseguir"). En `text` va su cabecera ("prosegur Juliaca") como primera
   * línea, que el cotizador lee como cliente + sucursal (la sucursal va como dirección) y aplica sus precios de contrato.
   */
  profile?: { key: string; name: string; branch?: string; heard: string };
  /** UB de cada llanta (índice de `items`), ya de 4 cifras; las que no tienen 4 cifras van en `ubIssues`. */
  ubs: (string | undefined)[];
  /** Llantas con la UB mal oída (no son 4 cifras) o sin UB cuando el cliente la pide: se pregunta antes de cotizar. */
  ubIssues: { item: number; heard?: string }[];
  /**
   * Corrida J: la placa dicha de cada llanta que la trae (índice de `items`). `plate` solo si tiene la forma de una placa
   * peruana (va en la línea: "placa ABC-123"); `heard`, lo que se entendió (se muestra siempre: las letras dictadas son
   * poco fiables); `from`, lo dicho. Una llanta sin placa no hereda la de la anterior.
   */
  plates: { item: number; plate?: string; heard: string; from: string }[];
  /** Llantas sin medida que heredan la de la anterior (corrida H, punto 6): se dice. */
  inherited: { item: number; size: string }[];
  /** Lo que no se pudo separar con seguridad (corrida H, punto 5): se muestra lo entendido y se pregunta. */
  doubts: string[];
  /**
   * Corrida I: se juntó en UNA llanta algo que podía ser otra (dos productos, dos cantidades, dos precios tras una coma).
   * `why`: por qué; `alt`: el texto separando por cada coma (la lectura de la corrida H), para el botón "Son varias" ("" si
   * esa lectura no da más llantas: entonces "Son varias" pide dictarlas de nuevo).
   */
  single?: { why: string[]; alt: string };
  /** Corrida I: lo dicho como "cliente …" es una marca del catálogo ("cliente Fenixway"): va como marca y se pregunta el cliente. */
  brandAsCustomer?: string;
  /** Corrida I: la moneda dicha ("soles", "dólares"); null si no se dijo. Se avisa si no es la de la cotización. */
  currency: "PEN" | "USD" | null;
  /** Corrida I: el IGV dicho sin decir si va incluido ("IGV 18 %"): se avisa. */
  taxMention?: string;
  /** Corrida I: lonas dichas que no están en el catálogo para esa medida (no van en la línea; se avisa con las que hay). */
  plyIssues: { item: number; ply: number; size: string; available: number[] }[];
}

export interface DictationCatalog {
  /** Diseños del catálogo con su marca (para "Flama 77" -> "Fenixway Flama 77" si la marca no se dijo y es única). */
  designs?: { brand: string; model: string }[];
  /** Marcas del catálogo (para corregir por parecido lo mal oído: voice/fuzzy.ts). */
  brands?: string[];
  /** Medidas canónicas del catálogo (para leer la medida dictada: voice/sizes.ts). Sin ellas, solo lo plausible. */
  sizes?: string[];
  /** Clientes con perfil (config/customers.json) y sus sucursales conocidas (corrida H, punto 6). */
  profiles?: DictationProfile[];
  /** Qué formas de decir la UB se leen sin un cliente que la pida (voice/items.ts markUbs); por defecto 1 ("UB", "u be" mal oída). */
  ubLevel?: 0 | 1;
  /** Lonas (PR) de cada medida en el catálogo (corrida I): las dictadas se validan contra estas. */
  plies?: Record<string, number[]>;
}

/** Un cliente con perfil, para reconocerlo en lo dictado. */
export interface DictationProfile {
  /** Cómo lo escribe el vendedor ("prosegur"): la cabecera del texto para el cotizador. */
  key: string;
  /** "Prosegur" (para mostrarlo). */
  name: string;
  /** Alias, nombre y razón social. */
  names: string[];
  /** Sucursales de sus cotizaciones anteriores ("Juliaca", "Ayacucho"): la dictada se compara por parecido. */
  units?: string[];
  /** Pide UB en cada línea (Prosegur). */
  ub?: boolean;
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

/** Palabras que cortan la sucursal dictada tras el cliente ("Prosegur Juliaca: …", "Prosegur Juliaca, 4 valor 99"). */
const BRANCH_STOP = /^(?:ub|u|v|para|con|sin|cotiza\w*|precio|unidad|en|de|la|el|las|los|y|a|al|que)$/i;
const titleCase = (s: string) => s.toLocaleLowerCase("es").replace(/(?<![\p{L}])\p{L}/gu, (c) => c.toLocaleUpperCase("es"));

/** El cliente con perfil que empieza `words` (por parecido, palabra por palabra: "Prosegul" = Prosegur), con lo que sobra. */
function profileAt(words: string, profiles: DictationProfile[]): { profile: DictationProfile; heard: string; rest: string } | null {
  const toks = words.trim().split(/\s+/);
  let best: { profile: DictationProfile; heard: string; rest: string; score: number } | null = null;
  for (const p of profiles) {
    for (const n of p.names) {
      const nw = fold(n).split(" ").filter(Boolean);
      if (!nw.length || toks.length < nw.length) continue;
      const said = toks.slice(0, nw.length).map((w) => fold(w));
      if (said.some((w) => !w)) continue;
      // misma inicial y parecido alto en cada palabra ("proseguir", "Prosegure", "Proceur" ≈ prosegur; "asegurar" no)
      const scores = nw.map((w, i) => (said[i][0] === w[0] ? jaroWinkler(said[i], w) : 0));
      const score = Math.min(...scores);
      if (score >= 0.88 && (!best || score > best.score)) best = { profile: p, heard: toks.slice(0, nw.length).join(" "), rest: toks.slice(nw.length).join(" "), score };
    }
  }
  return best ? { profile: best.profile, heard: best.heard, rest: best.rest } : null;
}

/**
 * ¿La nota empieza nombrando a un cliente con perfil ("Prosegur Juliaca: cuatro Valor 99 unidad 1231…", sin "cotízame")
 * y trae llantas con cantidad? Como "prosegur ayacucho …" escrito, es una cotización (bot/index.ts, voz sin paso).
 */
export function dictatedProfileQuote(transcript: string, catalog: DictationCatalog): boolean {
  const profiles = catalog.profiles ?? [];
  if (!profiles.length) return false;
  const first = spokenToDigits(transcript ?? "").replace(/[¡!¿?]/g, " ").trim().split(/[:,.;]|\s(?=\d)/)[0] ?? "";
  if (!profileAt(first, profiles)) return false;
  const d = normalizeDictation(transcript, catalog);
  return !!d.profile && d.items.some((l) => /\bx\d+\b/.test(l));
}

/** La sucursal dicha (palabras hasta una pausa, cifra o palabra de pedido), comparada con las conocidas del cliente. */
function branchOf(text: string, p: DictationProfile, catalog: DictationCatalog): string | undefined {
  const words: string[] = [];
  for (const w of text.trim().split(/\s+/)) {
    const clean = w.replace(/[:.,;]+$/, "");
    if (!/^\p{L}[\p{L}'-]*$/u.test(clean) || BRANCH_STOP.test(fold(clean))) break;
    // una marca o un diseño no es la sucursal ("Prosegur, valor 99 …")
    if ((catalog.brands ?? []).some((b) => fold(b) === fold(clean)) || (catalog.designs ?? []).some((d) => fold(d.model).split(" ")[0] === fold(clean))) break;
    words.push(clean);
    if (/[:.,;]$/.test(w) || words.length >= 3) break;
  }
  if (!words.length) return undefined;
  const said = words.join(" ");
  const known = (p.units ?? []).map((u) => ({ id: u, name: u }));
  const m = known.length ? matchSpokenName(said, known) : null;
  return m?.kind === "clear" && m.best ? m.best.name : titleCase(said);
}

const QUOTE_VERBS = ["cotizame", "cotiza", "cotizo", "cotizanos", "cotizale"];
/** ¿La palabra es "cotízame" mal oída? (misma inicial "co", parecido ≥ 0,85: "Cotícame", "Contícame", "Cotita"). */
function isQuoteVerb(word: string): boolean {
  const w = fold(word);
  return w.length >= 5 && w.startsWith("co") && QUOTE_VERBS.some((v) => jaroWinkler(w, v) >= 0.85);
}

/** "Cotita 8, valor 99 …" -> "Cotiza 8, valor 99 …": el verbo de cotizar mal oído al inicio (para la precedencia del router). */
export function fixQuoteVerb(text: string): string {
  return (text ?? "").replace(/^(\s*)(\p{L}+)(?=[\s,:])/u, (all, sp: string, w: string) => (isQuoteVerb(w) && !QUOTE_VERBS.includes(fold(w)) ? `${sp}Cotiza` : all));
}

/** "TRD 0 2" -> "TRD02": un diseño de letras y cifras del catálogo con sus cifras dictadas una a una (corrida I, "TRD cero dos"). */
export function joinDesignCodes(text: string, designs: { model: string }[]): string {
  let t = text;
  for (const m of new Set(designs.map((d) => d.model.trim()).filter((x) => /^[A-Za-z]{2,}\d{2,}$/.test(x)))) {
    // solo cifras separadas ("TRD 0 2"); "CM 958" (letras y cifras aparte) ya lo lee withBrand y se deja como se dijo
    const letters = m.match(/^[A-Za-z]+/)![0];
    const digits = m.slice(letters.length);
    const spaced = new RegExp(String.raw`(?<![\p{L}\d])${letters}\s?${[...digits].join(String.raw`[\s-]?`)}(?![\p{L}\d])`, "giu");
    t = t.replace(spaced, (all) => (/\d[\s-]+\d/.test(all) ? m : all));
  }
  return t;
}

/** "cotízame ocho Flama 77 en 295 80 22.5 a 254 para ZBUSS, a 45 días" -> líneas para el cotizador (ver la cabecera). */
export function normalizeDictation(transcript: string, catalog: DictationCatalog = {}, opts: { legacy?: boolean } = {}): DictatedQuote {
  // marcas y diseños mal oídos, por parecido contra el catálogo (antes de normalizar: compara palabras como se dijeron)
  const fixed = catalog.designs?.length || catalog.brands?.length ? fixCatalogTerms(transcript, { brands: catalog.brands ?? [], designs: catalog.designs ?? [] }) : { text: transcript, changes: [] };
  // números que Deepgram pegó ("17.54 valor 89", "valor 99295, 80"): después de pasar las palabras a cifras
  // corrida J: las placas dictadas ("para la placa a be ce uno dos tres") se apartan antes de leer medidas y cliente
  const spokenPlates = extractSpokenPlates(spokenToDigits(fixed.text.replace(/[“”"']/g, "")));
  const spoken = normalizeSpokenDetailed(joinUbDigits(unglueNumbers(splitPly(spokenPlates.text), catalog.designs)), catalog.sizes);
  // "Cotícame", "Contícame", "Cotita" (Deepgram, 2026-11-16): el verbo de cotizar al inicio, por parecido
  let t = spoken.text.replace(QUOTE_HEAD, "").replace(/^\s*(\p{L}+)[\s,:]+/u, (all, w: string) => (isQuoteVerb(w) ? "" : all));
  // un punto pegado a la cifra ("… 22.5. Otra, …"): findTyreSizes no lee la medida si le sigue un punto
  t = t.replace(/(\d)\.(?=\s|$)/g, "$1 .");
  // cliente con perfil al inicio ("Prosegur Juliaca: …", tras "cotízame para")
  const profiles = catalog.profiles ?? [];
  let profile: DictatedQuote["profile"];
  let prof: DictationProfile | undefined;
  const lead = profiles.length ? profileAt(t.replace(/^\s*para\s+/i, "").split(/[:,.;]|\s(?=\d)/)[0] ?? "", profiles) : null;
  if (lead) {
    prof = lead.profile;
    const after = t.trim().slice(t.trim().toLowerCase().indexOf(lead.heard.toLowerCase()) + lead.heard.length);
    const branch = branchOf(after, prof, catalog);
    profile = { key: prof.key, name: prof.name, branch, heard: clean(`${lead.heard} ${branch ? after.trim().split(/\s+/).slice(0, branch.split(" ").length).join(" ") : ""}`) };
    let cut = after;
    if (branch) {
      const n = branch.split(" ").length;
      cut = after.trim().split(/\s+/).slice(n).join(" ");
    }
    t = cut.replace(/^[\s:,.;]+/, "");
  }
  const known = (w: string) => (catalog.brands ?? []).some((b) => fold(b) === w) || (catalog.designs ?? []).some((d) => fold(d.model).split(" ")[0] === w);
  // condiciones
  const terms: string[] = [];
  for (const p of TERM_PATTERNS) {
    for (let guard = 0; guard < 3; guard++) {
      const m = t.match(p.re);
      if (!m) break;
      if (!terms.includes(p.out(m))) terms.push(p.out(m));
      t = `${t.slice(0, m.index)} ${t.slice((m.index ?? 0) + m[0].length)}`;
    }
  }
  // "IGV 18 %" sin decir si va incluido: se quita (no es parte de la llanta) y, si no se dijo con/sin, se avisa
  let taxMention: string | undefined;
  t = t.replace(IGV_BARE, (all) => {
    if (!terms.some((x) => /igv/.test(x))) taxMention ??= clean(all);
    return " ";
  });
  // códigos de diseño dictados letra por letra o cifra por cifra ("TRD 0 2" = TRD02, "LL F02" = LLF02): el del catálogo
  t = joinDesignCodes(t, catalog.designs ?? []);
  // la ficha: "por 4 unidades" -> x4, "precio, 298 dólares" -> precio 298, sin "modelo"/"marca"/"medida"
  const ficha = fichaWords(t);
  // un solo espacio: las posiciones de findTyreSizes (texto normalizado) son las de t
  t = ficha.text.replace(/\s+/g, " ").replace(/(?:\s*[,.;:]\s*){2,}/g, (m) => (/[.]/.test(m) ? ". " : ", ")).replace(/^[\s,]+/, "").trim();
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
  // "… para Prosegur Juliaca" más adelante: el cliente con perfil se sabe antes de leer las UBs
  if (!prof && profiles.length) {
    for (const m of t.matchAll(/(?:^|[\s,])(?:para|cliente)\s+(\p{L}+(?:\s+\p{L}+){0,2})/giu)) {
      const hit = profileAt(m[1], profiles);
      if (hit) {
        prof = hit.profile;
        break;
      }
    }
  }
  // UBs apartadas (¤n¤): con un cliente que la pide, también un número suelto de 4 cifras
  const ub = markUbs(t, prof?.ub ? 2 : (catalog.ubLevel ?? 1));
  t = clean(ub.text);
  // corrida J: las placas, como marcas ¤n¤ junto a las UBs (cada una va con su llanta). Un cliente con UB (Prosegur) no
  // lleva placa: lo dicho no se entiende y se pregunta
  const refusedPlates = prof?.ub ? spokenPlates.plates.map((p) => p.from) : [];
  t = clean(placePlateMarks(t, spokenPlates.plates, ub.ubs, !prof?.ub));
  // "cliente Fenixway": una marca del catálogo dicha como cliente va como marca (y se pregunta el cliente)
  let brandAsCustomer: string | undefined;
  t = t.replace(/(^|[\s,])(?:cliente|para)\s+(?:la\s+empresa\s+|el\s+cliente\s+)?(\p{L}[\p{L}\d-]*(?:\s+\p{L}[\p{L}\d-]*)?)/iu, (all, pre: string, name: string) => {
    const words = name.split(/\s+/);
    for (const n of [words.join(" "), words[0]]) {
      const b = (catalog.brands ?? []).find((x) => fold(x) === fold(n));
      if (b) {
        brandAsCustomer = b;
        return `${pre}${name}`;
      }
    }
    return all;
  });
  // cliente
  let customer = "";
  const cm = t.match(CUSTOMER_RE);
  if (cm && !/^[§¤]/.test(cm[1])) {
    // el cliente nunca se lleva una llanta: se corta antes de "y 2 Valor 99", de una medida o de una UB
    const own = cm[1].split(/\s+(?:y\s+)?(?=\d{1,3}\s+\p{L})|\s*[§¤]/u)[0];
    customer = clean(own.replace(/(?:\s+(?:y|e|con|a|de|al))+\s*$/i, ""));
    // el cotizador reconoce el cliente por la mayúscula inicial ("para zbuss" dictado -> "para Zbuss")
    if (customer === customer.toLowerCase()) customer = customer.replace(/(?<![\p{L}])\p{L}/gu, (c) => c.toUpperCase());
    const used = cm[0].length - (cm[1].length - own.length);
    t = `${t.slice(0, cm.index)} ${t.slice((cm.index ?? 0) + used)}`;
    // "… para Prosegur Juliaca" al final: el cliente con perfil y su sucursal
    const named = !profile && profiles.length ? profileAt(customer, profiles) : null;
    if (named) {
      prof = named.profile;
      const branch = branchOf(named.rest, prof, catalog);
      profile = { key: prof.key, name: prof.name, branch, heard: customer };
      customer = "";
    } else if (prof && profileAt(customer, [prof])) customer = "";
  }
  // sin sucursal tras el nombre ("para proseguir, Juliaka. 4 …"): la palabra suelta que sigue
  if (prof && profile && !profile.branch) {
    const m = t.match(/^\s*[,.:;]?\s*(\p{L}[\p{L}'-]*(?:\s+\p{L}[\p{L}'-]*){0,2})\s*[.,:;](?=\s)/u);
    const branch = m ? branchOf(`${m[1]}.`, prof, catalog) : undefined;
    if (m && branch && branch.split(" ").length === m[1].split(/\s+/).length) {
      profile = { ...profile, branch, heard: clean(`${profile.heard} ${m[1]}`) };
      t = t.slice((m.index ?? 0) + m[0].length);
    }
  }
  // llantas: una por grupo (voice/items.ts)
  const first = (x: string) => fold(x).split(" ")[0];
  const productOf = (w: string) => {
    if ((catalog.brands ?? []).some((b) => first(b) === w)) return { kind: "brand" as const, brands: [w] };
    const ds = (catalog.designs ?? []).filter((d) => first(d.model) === w);
    return ds.length ? { kind: "design" as const, brands: [...new Set(ds.map((d) => first(d.brand)))] } : null;
  };
  const grouping = groupItems(t, known, { legacy: opts.legacy, sizeOf: (k) => sizes[k] ?? String(k), productOf });
  const plyIssues: DictatedQuote["plyIssues"] = [];
  const ubs: (string | undefined)[] = [];
  const ubIssues: { item: number; heard?: string }[] = [];
  const inherited: { item: number; size: string }[] = [];
  const plates: DictatedQuote["plates"] = [];
  const display = (g: string) => clean(g.replace(/§(\d+)§/g, (_, k: string) => displaySize(sizes[parseInt(k, 10)])).replace(/¤(\d+)¤/g, (_, k: string) => `${ub.ubs[parseInt(k, 10)].kind === "plate" ? "placa" : "UB"} ${ub.ubs[parseInt(k, 10)].value}`));
  const doubts = grouping.doubts.map(display);
  let prevSize: string | null = null;
  const meta: { desc: string; qty: boolean; ownSize: boolean; other: boolean }[] = [];
  const items = grouping.groups.map((g, i) => {
    let rest = g;
    let price: string | null = null;
    const pm = rest.match(PRICE_RE);
    if (pm) {
      price = pm[1];
      rest = `${rest.slice(0, pm.index)} ${rest.slice((pm.index ?? 0) + pm[0].length)}`;
    }
    // UB y placa de la línea (cada una la suya: una llanta sin placa no hereda la de la anterior)
    const lineRefs = [...rest.matchAll(/¤(\d+)¤/g)].map((m) => ub.ubs[parseInt(m[1], 10)]);
    const lineUbs = lineRefs.filter((r) => r.kind !== "plate");
    const linePlates = lineRefs.filter((r) => r.kind === "plate");
    rest = rest.replace(/¤\d+¤/g, " ");
    if (lineUbs.length > 1) doubts.push(`la llanta ${i + 1} («${display(g)}») tiene dos UB`);
    if (linePlates.length > 1) doubts.push(`la llanta ${i + 1} («${display(g)}») tiene dos placas`);
    const pl = linePlates[0];
    if (pl) plates.push({ item: i, plate: pl.valid ? pl.value : undefined, heard: pl.value, from: pl.from });
    const u = lineUbs[0];
    ubs.push(u?.valid ? u.value : undefined);
    if (u && !u.valid) ubIssues.push({ item: i, heard: u.value });
    else if (!u && prof?.ub) ubIssues.push({ item: i });
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
    // lonas ("18PR", ya juntas por splitPly): aparte, para no leerlas como una cifra suelta ni como parte del diseño
    let ply: number | null = null;
    const plm = rest.match(/(?<![\d.])(\d{1,2})PR(?![\p{L}\d])/iu);
    if (plm) {
      ply = parseInt(plm[1], 10);
      rest = `${rest.slice(0, plm.index)} ${rest.slice((plm.index ?? 0) + plm[0].length)}`;
    }
    // otra cantidad en la misma llanta ("por 4 unidades, precio 298, por 6 unidades"): no va a la descripción (se pregunta)
    rest = rest.replace(/(?<![\p{L}])x\s*\d{1,3}(?![\d.])/giu, " ");
    let marks = [...rest.matchAll(/§(\d+)§/g)].map((m) => sizes[parseInt(m[1], 10)]);
    if (marks.length > 1) doubts.push(`la llanta ${i + 1} («${display(g)}») tiene dos medidas`);
    rest = rest.replace(/§\d+§/g, " ").replace(/(?<![\p{L}\d])(?:en|de|del|la|las|el|los|medida|llantas?|neum[aá]ticos?|unidades|aro|para)(?![\p{L}\d])/giu, " ");
    // un número que no es cantidad, precio, medida ni UB, y no va detrás de una palabra (no es "Valor 99"): de quién es, no se sabe
    const stray = [...clean(rest).matchAll(/(?<![\p{L}][\p{L}\d-]*\s?)(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])/gu)].map((m) => m[1]);
    if (stray.length) doubts.push(`no sé qué es «${stray.join(" ")}» en la llanta ${i + 1} («${display(g)}»)`);
    const ownSize = marks.length > 0;
    if (!marks.length && prevSize && grouping.groups.length > 1) {
      marks = [prevSize];
      inherited.push({ item: i, size: prevSize });
    }
    if (marks.length) prevSize = marks[marks.length - 1];
    // las lonas contra las del catálogo para esa medida (si el catálogo las trae): si no existen, no van y se avisa
    const avail = ply && marks.length ? catalog.plies?.[marks[0]] : undefined;
    if (ply && avail?.length && !avail.includes(ply)) {
      plyIssues.push({ item: i, ply, size: marks[0], available: [...avail].sort((a, b) => a - b) });
      ply = null;
    }
    const desc = withBrand(clean(rest), catalog);
    meta.push({ desc: clean(rest), qty: !!qty, ownSize, other: !!(price || u || pl) });
    return clean([desc, marks.join(" "), ply ? `${ply}PR` : "", qty ? `x${qty}` : "", price ? `precio ${price}` : "", u?.valid ? `ub ${u.value}` : "", pl?.valid ? `placa ${pl.value}` : ""].filter(Boolean).join(" "));
  });
  // varias llantas y alguna sin cantidad cuando las otras la dicen: Deepgram suele comerse el número ("…a 198, Westlake AZ670")
  if (meta.length > 1 && meta.some((m) => m.qty)) meta.forEach((m, i) => !m.qty && (m.ownSize || m.desc) && doubts.push(`la llanta ${i + 1} («${clean(items[i])}») no dice cantidad`));
  meta.forEach((m, i) => {
    // una "llanta" que es solo palabras sin cantidad, medida, precio ni UB, y ninguna es del catálogo: no se descarta, se pregunta
    if (grouping.groups.length > 1 && !m.qty && !m.ownSize && !m.other && !fold(m.desc).split(" ").some((w) => w && known(w))) doubts.push(`no entendí «${m.desc}»`);
    // "Westlake CM 990, y 3 en 315/80R22.5": ¿la medida (con su cantidad) es de la anterior o es otra llanta?
    const next = meta[i + 1];
    if (!m.ownSize && m.desc && next && next.ownSize && !next.desc && !prof) doubts.push(`no sé si «${display(grouping.groups[i + 1])}» es otra llanta o la medida de la llanta ${i + 1}`);
  });
  // la primera llanta sin medida cuando otras sí la dicen: no se adivina (con contrato vale la del contrato)
  if (!prof && grouping.groups.length > 1) {
    const first = items.findIndex((l) => !findTyreSizes(l).length);
    if (first >= 0) doubts.push(`la llanta ${first + 1} («${clean(items[first])}») no tiene medida`);
  }
  for (const f of refusedPlates) doubts.push(`no entendí «${f}»: en ${prof!.name} cada llanta lleva UB, no placa`);
  const header = profile ? [`${profile.key}${profile.branch ? ` ${profile.branch}` : ""}`] : [];
  const lines = [...header, ...items.filter(Boolean), ...(customer ? [`para ${customer}`] : []), ...terms];
  const sizeFixes = spoken.sizes.resolved.filter((r) => !r.plain).map((r) => ({ from: r.from, to: displaySize(r.to) }));
  // juntado en una llanta con duda: la alternativa separando por cada coma (solo si de verdad da más de una llanta)
  let single: DictatedQuote["single"];
  if (!opts.legacy && grouping.single?.length) {
    const alt = normalizeDictation(transcript, catalog, { legacy: true });
    single = { why: grouping.single, alt: alt.items.length > items.filter(Boolean).length ? alt.text : "" };
  }
  return {
    text: lines.join("\n"),
    sizes,
    items: items.filter(Boolean),
    customer,
    fixes: [...fixed.changes, ...sizeFixes],
    sizeChoices: spoken.sizes.ambiguous,
    unheardSizes: spoken.sizes.unmatched,
    ...(profile ? { profile } : {}),
    ubs,
    ubIssues,
    plates,
    inherited,
    doubts,
    ...(single ? { single } : {}),
    ...(brandAsCustomer && !customer && !profile ? { brandAsCustomer } : {}),
    currency: ficha.currency,
    ...(taxMention ? { taxMention } : {}),
    plyIssues,
  };
}

// ── 4. correcciones dictadas ──

/** confirm: un "ok" dictado · text: el comando escrito equivalente · unknown: no es una corrección conocida (el texto normalizado). */
export type VoiceCorrection = { kind: "confirm" } | { kind: "text"; text: string } | { kind: "unknown"; text: string };

const CONFIRM_RE = /^(?:(?:ok|okey|si|dale|listo|confirmo|confirmar|correcto|esta bien|todo bien|armalo|arma|generalo|genera|enviar|envialo|envia|perfecto|ya|bueno)\s*)+$/;
const CORRECTION_HEAD = /^(?:no|nop|perd[oó]n|disculpa|corrijo|correcci[oó]n|mejor|me equivoqu[eé])\b[,.\s]*/i;

const ORDINALS: Record<string, number> = { primer: 1, primero: 1, primera: 1, segundo: 2, segunda: 2, tercer: 3, tercero: 3, tercera: 3, cuarto: 4, cuarta: 4, quinto: 5, quinta: 5, sexto: 6, sexta: 6 };
const LINE_REF = String.raw`(?:(?:del?|al|a\s+la|para|en)\s+)?(?:(?:el|la)\s+)?(?:l[ií]nea\s+|[ií]tem\s+|llanta\s+)?(primer[oa]?|segund[oa]|tercer[oa]?|cuart[oa]|quint[oa]|sext[oa]|\d{1,2})`;
const lineNumber = (s: string | undefined) => (!s ? null : /^\d+$/.test(s) ? parseInt(s, 10) : (ORDINALS[fold(s)] ?? null));

/**
 * Corrida J: la placa dictada con la cotización a la vista -> el comando escrito. "la placa del segundo es a be ce uno dos
 * tres" -> "placa 2 ABC-123"; "placa a be ce 1 2 3" -> "placa ABC-123" (una sola llanta); "sin placa el segundo" -> "sin
 * placa 2". Lo que no tiene forma de placa va tal cual ("placa 2 BC12"): el cotizador pide escribirla. Null si no es esto.
 */
export function plateCorrection(t: string): string | null {
  const off = t.match(new RegExp(String.raw`^(?:qu[ií]ta(?:le)?\s+la\s+|sin\s+)placa(?:\s+${LINE_REF})?$`, "iu"));
  if (off) {
    const n = lineNumber(off[1]);
    return n ? `sin placa ${n}` : "sin placa";
  }
  const m = t.match(new RegExp(String.raw`^(?:(?:p[oó]n(?:le|me)?|c[aá]mbia(?:le)?|la)\s+)*(?:la\s+)?placa(?:\s+${LINE_REF})?\s+(?:es\s+|ser[ií]a\s+|era\s+)?[:,]?\s*(\S.*)$`, "iu"));
  if (!m) return null;
  const n = lineNumber(m[1]);
  const { chars, used } = readSpokenPlate(m[2]);
  if (!chars || m[2].slice(used).trim()) return null;
  return `placa ${n ? `${n} ` : ""}${normalizePlate(chars) ?? chars}`;
}

/** Una corrección dictada sobre la cotización a la vista -> el comando escrito equivalente (ver la cabecera). */
export function normalizeVoiceCorrection(transcript: string): VoiceCorrection {
  const base = normalizeSpoken(transcript).replace(/[.!?¡¿]+/g, " ").trim();
  // "ok", "sí, dale", "está bien, ármalo" (las muletillas ya se quitaron: "ok" y "ya" sueltos se miran en el original)
  if (CONFIRM_RE.test(fold(transcript ?? "")) || (base && CONFIRM_RE.test(fold(base)))) return { kind: "confirm" };
  let t = base;
  for (let i = 0; i < 3 && CORRECTION_HEAD.test(t); i++) t = t.replace(CORRECTION_HEAD, "").trim();
  const f = fold(t);
  if (CONFIRM_RE.test(f)) return { kind: "confirm" };
  // corrida J: "la placa del segundo es a be ce uno dos tres" -> "placa 2 ABC-123"; "sin placa el segundo" -> "sin placa 2"
  const plate = plateCorrection(t);
  if (plate) return { kind: "text", text: plate };
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
