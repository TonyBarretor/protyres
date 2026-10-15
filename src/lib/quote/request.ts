/**
 * Turn the salesman's message (or a customer's email / forwarded WhatsApp) into structured request lines.
 *
 *   "Michelin 11R22.5 X Multi Z x4 para Transportes ABC, juan@abc.com, dscto 10%"
 *   "02 llantas delanteras 7.50-16 16PR"
 *   "LLANTA 12.5/80 X 18 - 12 PLY R4   UND 2\nPARCHE PARA LLANTA RS-35 VIPAL   UND 25\n..."
 *
 * Regex first (always works); the LLM, when configured, refines brand/model/customer and reads messy text.
 */
import { findBrandInText, fold } from "../tyre/brands";
import { extractPly, extractPosition } from "../tyre/attrs";
import { findTyreSizes, normalizeSizeText, parseTyreSize } from "../tyre/spec";
import { stripToModel } from "../ingest/util";
import { llmAvailable } from "../llm/client";
import { parseRequestWithLLM } from "../llm/parse-request";
import type { QuoteRequest, RequestLine } from "./types";

const NUMBER_WORDS: Record<string, number> = {
  una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, doce: 12, veinte: 20,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, ten: 10, twelve: 12,
};

const UNIT_WORDS = "unidades|unidad|und|unid|uds|u|pcs|piezas|pzas|llantas|llanta|neum[aá]ticos|neum[aá]tico|tires|tyres|juegos|juego|pares|par|aros|aro|parches|c[aá]maras";

/** Explicit quantity markers: "x4", "4 unidades", "02 llantas", "cantidad: 10", "cuatro llantas". */
export function parseQuantity(text: string): number | null {
  const t = text.toLowerCase();
  const patterns = [
    /\bx(\d{1,4})\b(?![\d.]|\s*(?:pr|ply|r\d|[-/]))/, // "x4"
    /(?<![\d.]\s?)\bx\s(\d{1,4})\b(?![\d.]|\s*(?:pr|ply|r\d|[-/]))/, // "x 4" but not "80 x 18" (a size)
    /\b(\d{1,4})\s*x(?!\s*r?\d)\b/, // "4x" but not "215/75 x R17.5"
    new RegExp(`\\b0*(\\d{1,4})\\s*(?:${UNIT_WORDS})\\b`),
    /\b(?:cantidad|cant|qty|quantity)\s*:?\s*(\d{1,4})\b/,
    /\b(\d{1,4})\s+(?:de\s+)?(?:del|delanteras?|delanteros?|direccional(?:es)?|mixtas?|mixtos?|posterior(?:es)?|tracci[oó]n(?:es)?|trac)\b/, // "8 de tracción"
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) return parseInt(m[1], 10);
  }
  const w = t.match(new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\s+(?:${UNIT_WORDS})\\b`));
  if (w) return NUMBER_WORDS[w[1]] ?? null;
  return null;
}

/**
 * Quantity for a table-like line without explicit markers: the first standalone small integer after the size
 * that is not a ply rating, load index, year or part of "x R17.5".  "... 12 PLY R4 UND 2" -> 2.
 */
export function parseTrailingQuantity(line: string, sizeEnd: number): number | null {
  const tail = line.slice(sizeEnd);
  for (const m of tail.matchAll(/(?<![\w./,-])(\d{1,4})(?![\w./,-])/g)) {
    const n = parseInt(m[1], 10);
    const idx = m.index ?? 0;
    const after = tail.slice(idx + m[0].length, idx + m[0].length + 6);
    if (/^\s*(PR|PLY|LONAS|%|TL|TT|TCF|SET)\b/i.test(after)) continue;
    if (/^\s?[A-Z]\b/i.test(after) && n >= 60) continue; // load index 108S
    if (idx <= 2 && n % 2 === 0 && n >= 6 && n <= 24) continue; // "11x22.5 16" = 16 ply written without PR
    if (n > 500 || n === 0) continue;
    return n;
  }
  return null;
}

export function parseEmail(text: string): string | undefined {
  const m = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  return m ? m[0] : undefined;
}

export function parseDiscount(text: string): number | undefined {
  const t = text.toLowerCase();
  const m =
    t.match(/\b(?:dscto|dcto|descuento|desc|disc|discount)\.?\s*(?:de\s+)?:?\s*(\d{1,2}(?:[.,]\d)?)\s*%?/) ??
    t.match(/\b(\d{1,2}(?:[.,]\d)?)\s*%\s*(?:de\s+)?(?:dscto|dcto|descuento|desc|disc|discount)\b/);
  return m ? parseFloat(m[1].replace(",", ".")) : undefined;
}

export function parseTaxMode(text: string): boolean | undefined {
  const t = text.toLowerCase();
  if (/\b(con|inc(?:luye|luido|l)?\.?)\s+igv\b|\bigv\s+incluido\b/.test(t)) return true;
  if (/\b(sin|no\s+incluye|mas|m[aá]s|\+)\s+igv\b|\bigv\s+aparte\b/.test(t)) return false;
  return undefined;
}

/** "UB 1830" / "ub: 1830" / "u.b. 1830": the customer's UB code (3–5 digits) written next to an item. */
const UB = /(?<![\w.])u\.?\s?b\.?\s*:?\s*(\d{3,5})(?![\d.,/])/i;
export function extractUb(text: string): string | undefined {
  return text.match(UB)?.[1];
}

/** The line with its UB blanked out (same length), so "UB 1830" is never a quantity, a size or part of the model. */
function withoutUb(line: string): string {
  return line.replace(new RegExp(UB.source, "gi"), (m) => " ".repeat(m.length));
}

/** A standalone "ub: 1830" / "ub 1830" segment (own line, or between commas): the UB for items without their own. */
const QUOTE_UB = /(?:^|[,;\n])[^\S\n]*(?:ub|u\.\s?b\.?)[^\S\n]*:?[^\S\n]*(\d{3,5})(?=[^\S\n]*(?:[,;\n]|$))/gi;

/** "número 451" / "numero 451" / "nro 451" / "n° 451" as its own segment: the quote's counter. */
export const QUOTE_NUMBER = /(?:^|[,;\n])[^\S\n]*(?:n[uú]mero|nro\.?|n[°º]\.?)[^\S\n]*:?[^\S\n]*(\d{1,6})(?:[^\S\n]+confirmar)?(?=[^\S\n]*(?:[,;\n]|$))/gi;

/** Keys of the "clave: valor" fields (parseTerms); their segments are neither items nor customer names. */
const TERM_KEYS = String.raw`atenci[oó]n|atn|att|contacto|direcci[oó]n|dir|lugar de entrega|tipo de pago|pago|forma de pago|plazo de pago|plazo|cr[eé]dito|plazo de entrega|entrega|validez|vigencia|tipo de cambio|tc|unidad atendida|unidad|sede|solicitante`;

/** The last match of a global regex (fields typed later in the conversation override earlier ones). */
function lastMatch(text: string, re: RegExp): RegExpMatchArray | undefined {
  let last: RegExpMatchArray | undefined;
  for (const m of text.matchAll(re)) last = m;
  return last;
}

/**
 * Per-quote fields written as "clave: valor" (or "clave valor"), anywhere in the message:
 *   atención: Sra. Karen Ordoñez · dirección: Lima · pago: factura crédito · plazo: 45 días · entrega: 48 hrs post OC
 *   validez: 5 días · tc 3.4 / tipo de cambio 3.40 · unidad: Ayacucho · ub: 1830 · solicitante: Johann Castañeda
 * When a key appears more than once the last value wins (corrections are appended to the request text).
 */
export function parseTerms(text: string): Pick<QuoteRequest, "attention" | "address" | "paymentType" | "paymentTerm" | "deliveryTerm" | "validityDays" | "exchangeRate" | "unit" | "ub" | "requester"> {
  const out: ReturnType<typeof parseTerms> = {};
  // a value runs to the end of the line / ";" — or to a comma that starts another field ("key:", an email, "x4", "dscto", "con igv", "ub 1830", "número 451")
  const STOP = String.raw`(?=\s*(?:[;\n]|$|,\s*(?:[\w.+-]+@|[\wáéíóú][\wáéíóú ]{0,24}:|x\s*\d|dscto\b|descuento\b|con igv\b|sin igv\b|u\.?\s?b\.?\s*\d|n[uú]mero\s*\d|nro\.?\s*\d)))`;
  const grab = (keys: string): string | undefined => {
    const m = lastMatch(text, new RegExp(`(?:^|[,;\\n]|\\s{2,})\\s*(?:${keys})\\s*:\\s*([^;\\n]+?)${STOP}`, "gi"));
    return m ? m[1].trim().replace(/,\s*$/, "") : undefined;
  };
  out.attention = grab("atenci[oó]n|atn|att|contacto");
  out.address = grab("direcci[oó]n|dir|lugar de entrega");
  out.paymentType = grab("tipo de pago|pago|forma de pago");
  out.paymentTerm = grab("plazo de pago|plazo|cr[eé]dito");
  out.deliveryTerm = grab("plazo de entrega|entrega");
  out.unit = grab("unidad atendida|unidad|sede");
  out.requester = grab("solicitante");
  out.ub = lastMatch(text, QUOTE_UB)?.[1];
  const validity = lastMatch(text, /\b(?:validez|v[aá]lidez|vigencia)\s*:?\s*(\d{1,3})\s*d[ií]as?\b/gi);
  if (validity) out.validityDays = parseInt(validity[1], 10);
  const tc = lastMatch(text, /\b(?:tc|t\.c\.|tipo de cambio)\s*:?\s*(?:s\/\.?\s*)?(\d(?:[.,]\d{1,3})?)\b/gi);
  if (tc) out.exchangeRate = parseFloat(tc[1].replace(",", "."));
  for (const k of Object.keys(out) as (keyof typeof out)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** "número 451" written as a segment of the request (the last one wins). */
export function parseQuoteNumber(text: string): number | undefined {
  const m = lastMatch(text, QUOTE_NUMBER);
  return m ? parseInt(m[1], 10) : undefined;
}

function parseCustomer(text: string): { name?: string; company?: string; ref?: string } {
  // a customer name ends with its line (lines appended later, like "para PROSEGUR SA\nunidad: …", stay apart)
  const t = text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, " ").replace(/[^\S\n]+/g, " ");
  const out: { name?: string; company?: string; ref?: string } = {};
  // "para X" needs a capitalised name (so "para invitarle", "para llanta" are not customers); "cliente: x" does not
  const m =
    t.match(/\b(?:cliente|client|empresa|company|customer|sr\.?|sra\.?|se[ñn]ores|atn|att)\b\s*:?\s+([^,;\n]+?)(?=\s*(?:,|;|$|\bx\s*\d|\bcantidad|\bemail|\bcorreo|\btel|\bdscto|\bdescuento|\bcon igv|\bsin igv))/im) ??
    t.match(/\bpara\s+(?=[A-ZÁÉÍÓÚÑ])(?!(?:LLANTAS?|NEUM[AÁ]TICOS?|CAMI[OÓ]N|CAMIONETA|BUS|TRACTOR|AUTO|CARRO|MOTO|AROS?|COTIZAR|LA|EL|SU|LOS|LAS)\b)([^,;\n]+?)(?=\s*(?:,|;|$|\bx\s*\d|\bcantidad|\bemail|\bcorreo|\btel|\bdscto|\bdescuento|\bcon igv|\bsin igv|\bref\b))/m);
  if (m) {
    const who = m[1].trim().replace(/\s+(?:x\s*\d+|\d+\s*(?:und|unidades|llantas))$/i, "");
    if (who) {
      const companyish = /\b(s\.?a\.?a?\.?c?\.?|e\.?i\.?r\.?l\.?|s\.?r\.?l\.?|ltda|inc|llc|transportes?|servicios|grupo|corporaci[oó]n|empresa|minera|constructora|log[ií]stica|express|cargo|agr[ií]cola|azucarera|gas|per[uú])\b/i.test(who);
      if (companyish) out.company = who;
      else out.name = who;
    }
  }
  const ref = t.match(/\b(?:ref|referencia|cotizaci[oó]n|solicitud|pedido|orden)\s*:?\s*#?\s*([A-Z]{2,5}\d{4,12}|[A-Z0-9-]{6,20})\b/i);
  if (ref) out.ref = ref[1];
  return out;
}

const NON_TYRE_ITEM = /\b(parche|parches|c[aá]mara|camaras|c[aá]maras|guardac[aá]mara|aro|aros|v[aá]lvula|valvulas|protector|reencauche|sika|servicio|serv\.|kit|balanceo|alineamiento|enllante)\b/i;
const SKIP_LINE = /^(?:material|descripci[oó]n|descripcion|um\b|cantidad|placa|medida de llanta|planta|ubicaci[oó]n|marcado|estimado|la presente|fecha|hora|buen d[ií]a|buenos d[ií]as|hola|gracias|saludos|atentamente|por favor|favor|cotizar|cotizaci[oó]n|re:|fwd?:|de:|para:|asunto:|atenci[oó]n\s*:|atn\s*:|att\s*:|direcci[oó]n\s*:|pago\s*:|tipo de pago|plazo|entrega\s*:|validez|vigencia|tipo de cambio|tc\s*:?\s*\d)/i;

const POSITION_WORD = /\b(?:del|delanteras?|delanteros?|direccional(?:es)?|direcci[oó]n|mix|mixtas?|mixtos?|post|posterior(?:es)?|tracc|tracci[oó]n(?:es)?|trac|trailer|remolque|otr)\b/i;
const QTY_MARKER = new RegExp(String.raw`\bx\s?\d{1,4}\b|\b\d{1,4}\s?x\b|\b\d{1,4}\s*(?:${UNIT_WORDS})\b|\b\d{1,4}\s+(?:de\s+)?(?=${POSITION_WORD.source.slice(2)})`, "i");

/**
 * One size, several positions with their own quantities, all in one line:
 *   "Fenixway 295/80R22.5 Valor 18PR mixta x2 y tracción x8"  ·  "295/80R22.5 2 mixtas, 8 de tracción"
 * -> one line per group, each repeating the common head ("Fenixway 295/80R22.5 Valor 18PR").
 */
function splitPositionGroups(line: string): string[] {
  // a UB written once on the line belongs to every group of it
  const ub = extractUb(line);
  if (ub) {
    const groups = splitPositionGroups(withoutUb(line).replace(/\s+/g, " ").trim());
    return groups.length > 1 ? groups.map((g) => `${g} UB ${ub}`) : [line];
  }
  const size = findTyreSizes(normalizeSizeText(withoutRefs(line)))[0];
  if (!size) return [line];
  const segs = line.split(/\s*(?:,|;|\+|\s+y\s+|\s+e\s+|\s+and\s+)\s*/i).filter(Boolean);
  if (segs.length < 2) return [line];
  const isGroup = (s: string) => !/@|:/.test(s) && (QTY_MARKER.test(s) || POSITION_WORD.test(s)) && findTyreSizes(normalizeSizeText(s)).length === 0;
  const TAIL = /\s*\b(?:para|cliente|client|empresa|correo|email)\b.*$/i;
  // the first segment holds the size; its own group starts at the first position word / quantity after the size
  const first = segs[0];
  const sizeEnd = (() => {
    const n = normalizeSizeText(first);
    const s = findTyreSizes(n)[0];
    return s ? Math.min(first.length, s.index + s.length) : 0;
  })();
  const tail = first.slice(sizeEnd);
  const starts = [tail.search(POSITION_WORD), tail.search(QTY_MARKER)].filter((i) => i >= 0);
  const cut = starts.length ? sizeEnd + Math.min(...starts) : first.length;
  const head = first.slice(0, cut).trim();
  const groups = [first.slice(cut).trim()].filter(Boolean);
  let i = 1;
  let rest = "";
  for (; i < segs.length; i++) {
    const seg = segs[i];
    const tailAt = seg.search(TAIL);
    const groupPart = tailAt >= 0 ? seg.slice(0, tailAt) : seg;
    if (!groupPart.trim() || !isGroup(groupPart)) break;
    groups.push(groupPart.trim());
    if (tailAt >= 0) {
      rest = seg.slice(tailAt).trim();
      i++;
      break;
    }
  }
  rest = [rest, ...segs.slice(i)].filter(Boolean).join(", ");
  // only a real split: at least two groups, each with a quantity or a position, and different positions / quantities
  if (groups.length < 2 || !groups.every((g) => QTY_MARKER.test(g) || POSITION_WORD.test(g))) return [line];
  const positions = groups.map((g) => extractPosition(g) ?? "");
  if (new Set(positions).size < 2 && !groups.every((g) => QTY_MARKER.test(g))) return [line];
  return groups.map((g, k) => `${head} ${g}${k === groups.length - 1 && rest ? `, ${rest}` : ""}`.trim());
}

/** Lines of the message that could each be one item. Table rows and bullet lines stay separate. */
function candidateLines(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n+|;/)) {
    const line = rawLine.replace(/^[\s•\-–*·]+/, "").replace(/\s+/g, " ").trim();
    if (!line || SKIP_LINE.test(line)) continue;
    // several sizes in one line separated by ; or "y" -> split
    const sizes = findTyreSizes(withoutRefs(line));
    if (sizes.length > 1) {
      let last = 0;
      sizes.forEach((s, i) => {
        if (i === 0) return;
        const between = line.slice(sizes[i - 1].index + sizes[i - 1].length, s.index);
        let cut = -1;
        for (const m of between.matchAll(/[,;|•]|\s+y\s+|\s+e\s+|\s{2,}/gi)) cut = (m.index ?? 0) + m[0].length;
        const abs = cut >= 0 ? sizes[i - 1].index + sizes[i - 1].length + cut : s.index;
        out.push(line.slice(last, abs));
        last = abs;
      });
      out.push(line.slice(last));
    } else out.push(...splitPositionGroups(line));
  }
  return out.map((l) => l.trim()).filter(Boolean);
}

/** Peruvian vehicle plate written next to an item ("BLM-923", "A1B-234", "placa BVV704"). */
const PLATE = /(?:\bplaca\s*:?\s*)?\b((?:[A-Z]{3}|[A-Z]\d[A-Z])-?\d{3})\b(?![\w/.-])/i;
export function extractPlate(text: string): string | undefined {
  const m = text.match(PLATE);
  if (!m) return undefined;
  if (!/placa/i.test(m[0]) && !m[1].includes("-")) return undefined; // without a hyphen only "placa BVV704" counts (models look alike: AT557)
  return m[1].toUpperCase().replace(/^([A-Z0-9]{3})(\d{3})$/, "$1-$2");
}

/** The line with its plate blanked out (same length), so "BVV704 x8" is never read as a tyre size. */
function withoutPlate(line: string): string {
  if (!extractPlate(line)) return line;
  return line.replace(PLATE, (m) => " ".repeat(m.length));
}

/** Plate and UB blanked out (same length): references the customer writes next to an item, never part of its size. */
function withoutRefs(line: string): string {
  return withoutUb(withoutPlate(line));
}

/**
 * APLICACIÓN as the salesman writes it: the run of application words in the line ("MIXT DEL", "POST ON/OFF",
 * "mixta", "tracción", "montacargas"), kept in his own words (upper case).
 */
const APP_WORD = String.raw`(?:mixt[ao]?s?|mix|super\s?mixta|del(?:anter[ao]s?)?|direccional(?:es)?|post(?:erior(?:es)?)?|tracc?(?:i[oó]n(?:es)?)?|trac|on\s?/\s?off|off\s?road|otr|trailer|remolque|miner[ao]|agr[ií]cola|montacargas?|all\s?position|regional|urbano|carretera)`;
const APP_RUN = new RegExp(String.raw`(?<![\w/-])${APP_WORD}(?:[\s/]+${APP_WORD})*(?![\w/-])`, "gi");
export function extractApplication(text: string): string | undefined {
  let best = "";
  for (const m of text.matchAll(APP_RUN)) if (m[0].length > best.length) best = m[0];
  return best ? best.toUpperCase().replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ").trim() : undefined;
}

function lineFromText(line: string, explicitQty: number | null): RequestLine | null {
  const norm = normalizeSizeText(withoutPlate(line));
  const size = findTyreSizes(norm)[0];
  const brandHit = findBrandInText(line);
  const position = extractPosition(line) ?? undefined;
  const plate = extractPlate(line);
  const application = extractApplication(line);
  const isRim = /^\s*aros?\b/i.test(line);
  if (size && !isRim) {
    const sizeRaw = norm.slice(size.index, size.index + size.length);
    // plate, "placa", the application words and the LT prefix are not part of the model
    let cleaned = norm.replace(/\bplaca\b\s*:?/gi, " ").replace(/\bLT(?=\d)/g, "  ");
    if (plate) cleaned = cleaned.replace(new RegExp(`\\b${plate.replace("-", "[-\\s]?")}\\b`, "gi"), (m) => " ".repeat(m.length));
    if (application) cleaned = cleaned.replace(new RegExp(`(?<![\\w/-])${application.replace(/[/ ]/g, "[\\s/]*")}(?![\\w/-])`, "gi"), (m) => " ".repeat(m.length));
    let model = stripToModel(cleaned, { sizeRaw, brandAlias: brandHit?.alias });
    model = model
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\b(MOD|MODELO|MARCA|LLANTA|LLANTAS|NEUMATICO|NEUMATICOS|UND|UN|U|DE|LT|DEL|DELANTERA|DELANTERAS|DELANTERO|DELANTEROS|POST|POSTERIOR|POSTERIORES|TRACC|TRACCION|TRACCIONES|MIX|MIXT|MIXTA|MIXTAS|MIXTO|MIXTOS|DIRECCIONAL|DIRECCIONALES|DIRECCION|ON\/OFF|OTR|PLACA|SET|TL|TT|TCF|PR|PLY)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const quantity = explicitQty ?? parseTrailingQuantity(norm, size.index + size.length) ?? 1;
    const { index: _i, length: _l, ...sizeOnly } = size;
    return { raw: line, size: sizeOnly, brand: brandHit?.brand, model: model || undefined, quantity, position, ply: extractPly(line), application, plate };
  }
  if (isRim) {
    // "ARO 8.25x22.5 BFX-904 KUMA ACERO EJE EUROP 10H x1": a rim, kept as free text (the size is the rim's, not a tyre's)
    const text = line
      .replace(/\b(?:und|unidades|unidad|cant|cantidad|x)\s*\d{1,4}\b/gi, " ")
      .replace(/\b\d{1,4}\s*(?:und|unidades|unidad|uds?|u)\b/gi, " ")
      .replace(/\bplaca\s*:?\s*[A-Z0-9-]+/i, " ")
      .replace(plate ? new RegExp(`\\b${plate.replace("-", "-?")}\\b`, "i") : /$^/, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { raw: line, quantity: explicitQty ?? 1, text, brand: brandHit?.brand, application: "ARO", plate };
  }
  const item = line.match(NON_TYRE_ITEM);
  if (item && item.index !== undefined) {
    // "... y dos aros" / "PARCHE PARA LLANTA RS-35 VIPAL UND 25": the item phrase starts at the keyword
    const before = line.slice(0, item.index);
    const wordQty = before.match(new RegExp(`(?:^|\\s)0*(\\d{1,4}|${Object.keys(NUMBER_WORDS).join("|")})\\s*$`, "i"));
    const qty = wordQty ? (NUMBER_WORDS[wordQty[1].toLowerCase()] ?? parseInt(wordQty[1], 10)) : explicitQty ?? parseTrailingQuantity(line, item.index) ?? 1;
    const text = line
      .slice(item.index)
      .replace(/\b(und|unidades|unidad|cant|cantidad|x)\s*\d{1,4}\b/gi, " ")
      .replace(/\b\d{5,}\b/g, " ") // material codes
      .replace(/(?<![\w-])\d{1,4}(?![\w-])/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(/[,;.]| y /)[0]
      .trim();
    return { raw: line, quantity: qty, text, brand: brandHit?.brand, position, application, plate };
  }
  return null;
}

/** Regex-only parse (deterministic, no network). */
export function parseRequestRegex(text: string): QuoteRequest {
  const terms = parseTerms(text);
  const quoteNumber = parseQuoteNumber(text);
  // "clave: valor" segments, a standalone "ub 1830" and "número 451" are not items nor customer names
  const keep = (m: string) => (m.startsWith("\n") ? "\n" : " ");
  const stripped = text
    .replace(new RegExp(String.raw`(?:^|[,;\n]|\s{2,})\s*(?:${TERM_KEYS})\s*:\s*[^,;\n]+`, "gi"), keep)
    .replace(QUOTE_UB, keep)
    .replace(QUOTE_NUMBER, keep);
  const customer = parseCustomer(stripped);
  const customerEmail = parseEmail(text);
  const discountPct = parseDiscount(text);
  const showPricesWithTax = parseTaxMode(text);
  const lines: RequestLine[] = [];

  for (const line of candidateLines(stripped)) {
    // strip the customer/discount/tax tail from the item text
    const head = line
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, " ")
      .replace(/\b(?:dscto|dcto|descuento|desc)\.?\s*(?:de\s+)?:?\s*\d{1,2}(?:[.,]\d)?\s*%?/gi, " ")
      .replace(/\b\d{1,2}(?:[.,]\d)?\s*%\s*(?:de\s+)?(?:dscto|dcto|descuento|desc)\b/gi, " ")
      .replace(/\b(con|sin|mas|m[aá]s|inc\w*)\s+igv\b/gi, " ")
      .replace(/\b(?:cotizar|cotizaci[oó]n|cotiza|cotizas|me cotizas|precio de|necesito|quiero|quiere|piden?|pedido|busco|me pide|requiere|requerimos|solicito|solicitamos)\b/gi, " ");
    const cut = head.search(/\b(?:para|cliente|client|empresa|customer|correo|email|tel|atn|att)\b(?!\s+(?:llantas?|neum[aá]ticos?|cami[oó]n|camioneta|bus|tractor|auto|carro|moto|aro))\s*:?\s+[A-Z]/i);
    const item = (cut > 0 ? head.slice(0, cut) : head).trim();
    // "UB 1830" is the line's UB: blanked before reading quantity / size / model
    const ub = extractUb(item);
    const itemText = ub ? withoutUb(item).replace(/\s+/g, " ").trim() : item;
    const parsed = lineFromText(itemText, parseQuantity(itemText));
    if (parsed) lines.push(ub ? { ...parsed, raw: item, ub } : parsed);
  }

  // merge identical lines ("215/75R17.5 Posterior" x4 rows -> quantity 4)
  const merged: RequestLine[] = [];
  for (const l of lines) {
    const keyOf = (x: RequestLine) => [x.size?.canonical ?? fold(x.text ?? ""), fold(x.brand ?? ""), fold(x.model ?? ""), x.position ?? "", x.application ?? "", x.plate ?? "", x.ub ?? ""].join("|");
    const key = keyOf(l);
    const prev = merged.find((m) => keyOf(m) === key);
    if (prev) prev.quantity += l.quantity;
    else merged.push({ ...l });
  }

  return {
    raw: text,
    lines: merged,
    customerName: customer.name,
    customerCompany: customer.company,
    customerEmail,
    customerRef: customer.ref,
    ...terms,
    quoteNumber,
    discountPct,
    showPricesWithTax,
    parsedBy: "regex",
  };
}

/** Regex parse, refined by the LLM when available (brand/model/customer/quantities read from messy text). */
export async function parseRequest(text: string): Promise<QuoteRequest> {
  const base = parseRequestRegex(text);
  if (!llmAvailable()) return base;
  const llm = await parseRequestWithLLM(text);
  if (!llm) return base;
  const lines: RequestLine[] = [];
  for (const l of llm.lines ?? []) {
    const size = l.size ? parseTyreSize(l.size) ?? undefined : undefined;
    if (!size && !l.description) continue;
    lines.push({
      raw: l.raw ?? l.description ?? l.size ?? "",
      size,
      brand: l.brand ? findBrandInText(l.brand)?.brand ?? l.brand : undefined,
      model: l.model ?? undefined,
      quantity: l.quantity ?? 1,
      position: (l.position as RequestLine["position"]) ?? undefined,
      ply: l.ply ?? undefined,
      text: size ? undefined : l.description ?? undefined,
      application: l.application?.trim().toUpperCase() || undefined,
      plate: l.plate ? extractPlate(`placa ${l.plate}`) ?? l.plate.toUpperCase() : undefined,
      ub: (l.raw ? extractUb(l.raw) : undefined) ?? (l.ub ? extractUb(`UB ${l.ub}`) : undefined),
    });
  }
  return {
    ...base,
    // keyed fields typed by the salesman ("unidad: …") are read exactly by the regex; corrections appended later win
    unit: base.unit ?? llm.unit ?? undefined,
    ub: base.ub ?? (llm.ub ? extractUb(`UB ${llm.ub}`) : undefined),
    requester: base.requester ?? llm.requester ?? undefined,
    lines: lines.length ? lines : base.lines,
    customerName: llm.customer_name ?? base.customerName,
    customerCompany: llm.customer_company ?? base.customerCompany,
    customerEmail: llm.customer_email ?? base.customerEmail,
    attention: llm.attention ?? base.attention,
    address: llm.address ?? base.address,
    discountPct: llm.discount_pct ?? base.discountPct,
    showPricesWithTax: llm.prices_include_tax ?? base.showPricesWithTax,
    paymentType: llm.payment_type ?? base.paymentType,
    paymentTerm: llm.payment_term ?? base.paymentTerm,
    deliveryTerm: llm.delivery_term ?? base.deliveryTerm,
    validityDays: llm.validity_days ?? base.validityDays,
    notes: llm.notes ?? undefined,
    parsedBy: "llm+regex",
  };
}

export function describeLine(l: RequestLine): string {
  if (l.size) {
    const app = l.application ? l.application : l.position === "DEL" ? "delantera" : l.position === "TRAC" ? "tracción/posterior" : l.position === "MIX" ? "mixta" : "";
    return [l.brand ?? "", l.size.display, l.model ?? "", l.ply ? `${l.ply}PR` : "", app, l.plate ? `placa ${l.plate}` : "", l.ub ? `UB ${l.ub}` : "", `x${l.quantity}`]
      .filter(Boolean)
      .join(" ");
  }
  return `${l.text ?? l.raw}${l.plate ? ` placa ${l.plate}` : ""}${l.ub ? ` UB ${l.ub}` : ""} x${l.quantity}`;
}

/** Human-readable summary of what was understood (sent back to the salesman). */
export function describeRequest(r: QuoteRequest): string {
  const who = r.customerCompany ?? r.customerName;
  const extras = [
    who,
    r.attention ? `atn. ${r.attention}` : "",
    r.customerEmail,
    r.discountPct !== undefined ? `dscto ${r.discountPct}%` : "",
    r.showPricesWithTax === true ? "con IGV" : r.showPricesWithTax === false ? "sin IGV" : "",
    r.paymentType ? `pago: ${r.paymentType}` : "",
    r.paymentTerm ? `plazo: ${r.paymentTerm}` : "",
    r.deliveryTerm ? `entrega: ${r.deliveryTerm}` : "",
    r.validityDays ? `validez ${r.validityDays} días` : "",
    r.exchangeRate ? `tc ${r.exchangeRate}` : "",
    r.unit ? `unidad ${r.unit}` : "",
    r.ub ? `UB ${r.ub}` : "",
    r.requester ? `solicitante ${r.requester}` : "",
    r.quoteNumber ? `número ${r.quoteNumber}` : "",
  ].filter(Boolean);
  const items = r.lines.map((l, i) => (r.lines.length > 1 ? `${i + 1}. ${describeLine(l)}` : describeLine(l)));
  return `${items.join(r.lines.length > 1 ? "\n" : " ")}${extras.length ? `${r.lines.length > 1 ? "\n" : " · "}${extras.join(" · ")}` : ""}`;
}
