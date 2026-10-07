import { createHash } from "node:crypto";
import type { PriceRow, PriceSource, RowKind } from "./types";
import { fold, normalizeBrand } from "../tyre/brands";
import { extractLoadIndex, extractPly, extractPosition, extractTube, type Position } from "../tyre/attrs";
import { parseTyreSize, type TyreSize } from "../tyre/spec";

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "10/04/2026" or "2026-04-10" or "06-10-2026" -> "2026-04-10". Returns undefined when unparseable. */
export function parseDateLoose(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  let m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = t.match(/\b(\d{2})(\d{2})(\d{4})\b/); // 05102026 in file names
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return undefined;
}

/**
 * Parse a price written by a human: "$ 410.00", "US$ 1,250.50", "S/. 1.250,00", "410", "1.250", "185.56$".
 * Returns { value, currency } or null.
 */
export function parseMoney(input: string | number | null | undefined): { value: number; currency?: string } | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) ? { value: input } : null;
  const s = input.trim();
  if (!s) return null;
  let currency: string | undefined;
  if (/s\/\.?|pen|soles/i.test(s)) currency = "PEN";
  else if (/us\$|usd|u\$s|\$|d[oó]lares/i.test(s)) currency = "USD";
  else if (/€|eur/i.test(s)) currency = "EUR";

  const m = s.replace(/\s/g, "").match(/-?\d[\d.,]*\d|\d/);
  if (!m) return null;
  let num = m[0].replace(/[.,]+$/, "");
  const hasDot = num.includes(".");
  const hasComma = num.includes(",");
  if (hasDot && hasComma) {
    // the last separator is the decimal one: "1,250.50" or "1.250,50"
    const lastDot = num.lastIndexOf(".");
    const lastComma = num.lastIndexOf(",");
    num = lastComma > lastDot ? num.replace(/\./g, "").replace(",", ".") : num.replace(/,/g, "");
  } else if (hasComma) {
    num = resolveSingleSeparator(num, ",");
  } else if (hasDot) {
    num = resolveSingleSeparator(num, ".");
  }
  const value = parseFloat(num);
  if (!Number.isFinite(value)) return null;
  return { value, currency };
}

/**
 * "410,00" -> 410.00 (decimal) ; "1,250" -> 1250 (thousands) ; "1,250,000" -> 1250000 ;
 * "410.5" -> 410.5 ; "1.250" -> 1250. Groups of exactly three digits after the separator mean thousands.
 */
function resolveSingleSeparator(num: string, sep: "," | "."): string {
  const parts = num.split(sep);
  const tail = parts.slice(1);
  const allThousands = tail.length > 0 && tail.every((p) => p.length === 3);
  if (allThousands) return parts.join("");
  return parts.slice(0, -1).join("") + "." + parts[parts.length - 1];
}

/** Looks like a tyre price (not a year, index, phone, quantity...). */
export function plausiblePrice(v: number, isTyre = true): boolean {
  return isTyre ? v >= 15 && v <= 20000 : v >= 0.5 && v <= 20000;
}

export function parseStock(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) ? Math.round(input) : null;
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^(si|sí|yes|ok|disp|disponible|hay|stock)$/.test(s)) return 1;
  if (/^(no|agotado|sin stock|0)$/.test(s)) return 0;
  const m = s.match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

export function rowId(parts: { provider: string; kind: RowKind; code?: string; size: string; brand: string; model: string; description?: string }): string {
  const key = parts.code
    ? [parts.provider, parts.kind, "code", parts.code].map((p) => fold(p)).join("|")
    : [parts.provider, parts.kind, parts.size, parts.brand, parts.model, parts.size ? "" : parts.description ?? ""].map((p) => fold(p)).join("|");
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

export interface RowDraft {
  provider: string;
  kind?: RowKind;
  code?: string | null;
  description?: string | null;
  brand?: string | null;
  model?: string | null;
  size?: TyreSize | string | null;
  cost: number | string | null | undefined;
  priceIncludesTax?: boolean;
  maxDiscountPct?: number;
  currency?: string | null;
  stock?: number | string | null;
  priceDate?: string;
  source: PriceSource;
  sourceRef: string;
  notes?: string;
  raw?: string;
  defaultCurrency?: string;
  position?: Position | null;
  ply?: number | null;
  /** Keep the row when no size is found (non-tyre item). */
  keepNonTyre?: boolean;
  /** Allow rows without a price (stock exports). */
  allowNoPrice?: boolean;
}

/**
 * Build a normalized PriceRow from loosely-typed parts.
 * Returns null when the row is unusable (no size and non-tyre rows not kept, or no price when one is required).
 */
export function buildRow(d: RowDraft): PriceRow | null {
  const kind = d.kind ?? "provider";
  const descriptionSrc = (d.description ?? "").replace(/\s+/g, " ").trim();
  const sizeInput = d.size ?? (descriptionSrc || null);
  const size = sizeInput ? (typeof sizeInput === "string" ? parseTyreSize(sizeInput) : sizeInput) : null;
  const isTyre = !!size;
  if (!isTyre && !d.keepNonTyre) return null;
  if (!isTyre && !descriptionSrc) return null;

  const money = parseMoney(d.cost);
  const cost = money && plausiblePrice(money.value, isTyre) ? Math.round(money.value * 100) / 100 : null;
  if (cost === null && !d.allowNoPrice) return null;

  const brand = normalizeBrand(d.brand ?? "");
  let model = (d.model ?? "").replace(/\s+/g, " ").trim();
  // drop brand repeated at the start of the model ("MICHELIN X MULTI Z" -> "X MULTI Z")
  if (brand && fold(model).startsWith(fold(brand))) model = model.slice(brand.length).replace(/^[\s\-–:]+/, "").trim();
  const currency = (d.currency || money?.currency || d.defaultCurrency || "USD").toUpperCase();
  const attrText = [descriptionSrc, typeof d.size === "string" ? d.size : d.size?.raw ?? "", d.raw ?? ""].join(" ");
  const li = size?.loadIndex ? { loadIndex: size.loadIndex, speedIndex: size.speedIndex } : extractLoadIndex(attrText);
  const description = descriptionSrc || [brand, model, size?.display].filter(Boolean).join(" ");
  const code = d.code ? String(d.code).trim() : undefined;

  return {
    id: rowId({ provider: d.provider, kind, code, size: size?.canonical ?? "", brand, model, description }),
    provider: d.provider.trim(),
    kind,
    code: code || undefined,
    description,
    brand,
    model,
    size: size?.canonical ?? "",
    sizeDisplay: size?.display ?? "",
    sizeRaw: size?.raw ?? "",
    isTyre,
    loadIndex: li?.loadIndex,
    speedIndex: li?.speedIndex,
    ply: d.ply ?? extractPly(attrText),
    position: d.position ?? extractPosition(descriptionSrc || model),
    tube: extractTube(attrText),
    cost,
    priceIncludesTax: d.priceIncludesTax ?? false,
    maxDiscountPct: d.maxDiscountPct,
    currency,
    stock: parseStock(d.stock),
    priceDate: d.priceDate ?? todayIso(),
    source: d.source,
    sourceRef: d.sourceRef,
    notes: d.notes,
    raw: d.raw,
  };
}

const STOPWORDS = new Set(
  `precio precios price prices costo costos cost a al c/u cu unidad unidades und unid uds pcs pzas piezas por llanta llantas neumatico neumaticos ntco
   tyre tyres tire tires stock disp disponible disponibles hay quedan queda tengo tenemos vendo ofrezco ofrecemos usd us pen soles dolares dolar
   cada una uno un de del la el las los en y e o con sin igv inc incl incluye incluido mas oferta promo promocion contado credito efectivo
   hola buen buenos dia dias tarde tardes noches saludos gracias lista listas hoy actualizada actualizado nuevo nuevos nueva nuevas
   precio-lista camion camiones bus buses camioneta auto autos radial medida medidas marca modelo diseno
   the of for each per unit units pc pcs available only solo solamente tambien aro rin tl tt tcf set`
    .split(/\s+/)
    .filter(Boolean),
);

function isStop(token: string): boolean {
  return STOPWORDS.has(fold(token).replace(/\s+/g, ""));
}

/**
 * Remove the parts of a text that are the size / brand / price / filler, leaving what is probably the model.
 * When too many words remain, keep the ones closest to the size.
 */
export function stripToModel(text: string, opts: { sizeRaw?: string; brandAlias?: string; priceText?: string }): string {
  let t = ` ${text} `;
  const blank = (s: string, from: number, len: number) => s.slice(0, from) + " ".repeat(len) + s.slice(from + len);
  let sizePos = -1;
  if (opts.sizeRaw) {
    sizePos = t.toUpperCase().indexOf(opts.sizeRaw.toUpperCase());
    if (sizePos >= 0) t = blank(t, sizePos, opts.sizeRaw.length);
  }
  if (opts.priceText) {
    const p = t.indexOf(opts.priceText);
    if (p >= 0) t = blank(t, p, opts.priceText.length);
  }
  let brandPos = -1;
  if (opts.brandAlias) {
    const m = t.match(new RegExp(`(^|[\\s(])${escapeRe(opts.brandAlias)}(?=[\\s),.;:]|$)`, "i"));
    if (m && m.index !== undefined) {
      brandPos = m.index;
      t = blank(t, m.index, m[0].length);
    }
  }
  // Preamble: "Buen día Carlos, precios de hoy: Michelin X Multi Z 295/80R22.5 ..." -> drop everything before the
  // last ":" that precedes the size, and before the last "," that precedes the brand.
  const anchor = sizePos >= 0 ? sizePos : t.length;
  const colon = t.lastIndexOf(":", anchor);
  if (colon >= 0) t = " ".repeat(colon + 1) + t.slice(colon + 1);
  if (brandPos >= 0) {
    const comma = t.lastIndexOf(",", brandPos);
    if (comma >= 0) t = " ".repeat(comma + 1) + t.slice(comma + 1);
  }
  t = t
    .replace(/(?:US\$|USD|S\/\.?|PEN|\$|€)\s*-?\d[\d.,]*/gi, (m) => " ".repeat(m.length)) // other prices
    .replace(/\b(?:stock|disp(?:onible)?|hay|quedan?|exist\w*)\s*:?\s*\d{1,4}\b/gi, (m) => " ".repeat(m.length))
    .replace(/\b\d{2,3}(?:\/\d{2,3})?\s?[A-Z]\b/g, (m) => " ".repeat(m.length)) // load/speed index
    .replace(/\b\d{1,2}\s?(?:PR|PLY|LONAS)\b/gi, (m) => " ".repeat(m.length)) // ply rating
    .replace(/\b(?:T\.?D\.?|BANDA|PESO)\s*:?\s*[\d.,]+\s*(?:MM|KG)?\.?/gi, (m) => " ".repeat(m.length)) // JCH tread depth / weight specs
    .replace(/\([^)]*\)/g, (m) => " ".repeat(m.length)) // parenthesised remarks
    .replace(/\bx\s*(?=\d)|(?<=\d)\s*x\b/gi, " ") // "x4", "4x"
    .replace(/\$|\bS\/\.?/g, " ");

  // tokenize keeping positions
  const tokens: { text: string; pos: number }[] = [];
  let prevWord: { text: string; end: number } | null = null;
  for (const m of t.matchAll(/[^\s,;:|()\[\]\-–]+/g)) {
    const tok = m[0].replace(/^[.,;:]+|[.,;:]+$/g, "");
    const pos = m.index ?? 0;
    if (!tok) continue;
    if (/^\d+([.,]\d+)?$/.test(tok)) {
      // bare numbers are not a model, except a 2-3 digit number glued to a model word: "VALOR 87", "ASPRO 333"
      const glued = prevWord && /^[A-Za-z]{3,}$/.test(prevWord.text) && pos - prevWord.end <= 1 && /^\d{2,3}$/.test(tok) && !isStop(prevWord.text);
      if (glued) tokens.push({ text: tok, pos });
      prevWord = null;
      continue;
    }
    if (isStop(tok) || /^[^A-Za-z0-9]+$/.test(tok)) {
      prevWord = null;
      continue;
    }
    tokens.push({ text: tok, pos });
    prevWord = { text: tok, end: pos + m[0].length };
  }
  let chosen = tokens;
  if (tokens.length > 4 && sizePos >= 0) {
    // keep the 4 tokens nearest to the size
    chosen = [...tokens]
      .sort((a, b) => Math.abs(a.pos - sizePos) - Math.abs(b.pos - sizePos))
      .slice(0, 4)
      .sort((a, b) => a.pos - b.pos);
  }
  return chosen.map((x) => x.text).join(" ").trim();
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
