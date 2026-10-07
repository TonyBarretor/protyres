/**
 * Heuristic line parser shared by the PDF (text) and WhatsApp (regex fallback) adapters.
 * One tyre per line/segment: size + a price-looking number (+ optional brand / model / stock).
 */
import { findBrandInText, knownBrand } from "../tyre/brands";
import { findTyreSizes, normalizeSizeText } from "../tyre/spec";
import { headerKey } from "./tabular";
import type { IngestOptions, PriceRow, PriceSource } from "./types";
import { buildRow, parseMoney, plausiblePrice, stripToModel, todayIso } from "./util";

/**
 * Looks for a table header line ("MARCA DISEÑO MEDIDA IC/IV PRECIO STOCK") in extracted PDF text and
 * tells whether a stock column comes after the price column.
 */
export function detectTextHeader(text: string): { stockAfterPrice: boolean } | null {
  for (const line of text.split(/\r?\n/).slice(0, 60)) {
    if (findTyreSizes(line).length) continue;
    const words = line.split(/\s{1,}|\t/).filter(Boolean);
    if (words.length > 12) continue;
    let priceAt = -1;
    let stockAt = -1;
    let hasSize = false;
    let hits = 0;
    words.forEach((w, i) => {
      const k = headerKey(w);
      if (!k) return;
      hits++;
      if (k === "price" && priceAt < 0) priceAt = i;
      if (k === "stock" && stockAt < 0) stockAt = i;
      if (k === "size" || k === "description") hasSize = true;
    });
    if (hits >= 3 && hasSize && priceAt >= 0) return { stockAfterPrice: stockAt > priceAt };
  }
  return null;
}

interface NumToken {
  text: string;
  value: number;
  index: number;
  hasCurrency: boolean;
  hasDecimals: boolean;
}

function numberTokens(segment: string, exclude: { index: number; length: number }[]): NumToken[] {
  const out: NumToken[] = [];
  // a number must not be glued to letters: "CB972", "R268", "HN355" are model codes, not prices
  const re = /(?<![A-Z0-9/.,])(?:US\$|USD|S\/\.?|PEN|\$|€)?\s*-?\d[\d.,]*\d(?![A-Z0-9])|(?<![A-Z0-9/.,])\d(?![A-Z0-9])/g;
  for (const m of segment.matchAll(re)) {
    const idx = m.index ?? 0;
    if (exclude.some((e) => idx < e.index + e.length && e.index < idx + m[0].length)) continue;
    // skip load/speed index tokens like "152/148M" or "91V" or ply "16PR"
    const after = segment.slice(idx + m[0].length, idx + m[0].length + 3);
    if (/^\s*\/?\d{2,3}[A-Z]\b/.test(after) || /^[A-Z]\b/.test(after) || /^PR\b/i.test(after) || /^\s*\/\s*\d/.test(after)) continue;
    const money = parseMoney(m[0]);
    if (!money) continue;
    out.push({
      text: m[0],
      value: money.value,
      index: idx,
      hasCurrency: !!money.currency || /[$€]|S\//.test(m[0]),
      hasDecimals: /[.,]\d{2}$/.test(m[0].trim()),
    });
  }
  return out;
}

/** Choose the number that most likely is the unit price. */
export function pickPrice(tokens: NumToken[], sizeEnd: number): NumToken | null {
  const plausible = tokens.filter((t) => plausiblePrice(t.value));
  if (plausible.length === 0) return null;
  const score = (t: NumToken) =>
    (t.hasCurrency ? 100 : 0) + (t.hasDecimals ? 50 : 0) + (t.index >= sizeEnd ? 10 : 0) + Math.min(t.value, 5000) / 5000;
  return plausible.sort((a, b) => score(b) - score(a))[0];
}

export interface LineParseOptions extends IngestOptions {
  source: PriceSource;
  /** Brand to assume when a line has none (e.g. the whole message is about one brand). */
  defaultBrand?: string;
}

/** Split free text into segments that each hold at most one tyre. */
export function segmentText(text: string): string[] {
  const lines = text.split(/\r?\n+/);
  const segments: string[] = [];
  for (const line of lines) {
    const norm = normalizeSizeText(line);
    const sizes = findTyreSizes(norm);
    if (sizes.length <= 1) {
      segments.push(line);
      continue;
    }
    // several tyres in one line: cut between consecutive sizes, at the LAST strong separator before the next size
    // ("..., HN355 295/80R22.5 ..." keeps "HN355" with its size); without a separator, cut after the last number.
    let last = 0;
    const normLine = norm;
    sizes.forEach((s, i) => {
      if (i === 0) return;
      const prevEnd = sizes[i - 1].index + sizes[i - 1].length;
      const between = normLine.slice(prevEnd, s.index);
      let cutRel = -1;
      for (const m of between.matchAll(/[,;|•]|\s+Y\s+|\s+E\s+|\s{2,}|\n/g)) cutRel = (m.index ?? 0) + m[0].length;
      if (cutRel < 0) {
        for (const m of between.matchAll(/\d[\d.,]*\)?/g)) cutRel = (m.index ?? 0) + m[0].length;
      }
      const cut = cutRel >= 0 ? prevEnd + cutRel : s.index;
      segments.push(normLine.slice(last, cut));
      last = cut;
    });
    segments.push(normLine.slice(last));
  }
  return segments.map((s) => s.trim()).filter(Boolean);
}

export function parsePriceLines(text: string, opts: LineParseOptions): { rows: PriceRow[]; seen: number; warnings: string[] } {
  const rows: PriceRow[] = [];
  const warnings: string[] = [];
  // If the whole text names exactly one brand, lines without a brand belong to it.
  const brandsInText = new Set<string>();
  for (const line of text.split(/\r?\n+/)) {
    const b = findBrandInText(line);
    if (b) brandsInText.add(b.brand);
  }
  const messageBrand = brandsInText.size === 1 ? [...brandsInText][0] : null;
  let currentBrand: string | null = opts.defaultBrand ?? messageBrand ?? null;
  const priceDate = opts.priceDate ?? todayIso();
  let seen = 0;
  const header = detectTextHeader(text);
  const segments = segmentText(text);
  for (const seg of segments) {
    const norm = normalizeSizeText(seg);
    const sizes = findTyreSizes(norm);
    if (sizes.length === 0) {
      // a short line that names a brand ("MICHELIN", "lista Aeolus actualizada:") sets the brand for following lines
      const b = knownBrand(seg) ?? (seg.split(/\s+/).length <= 8 ? findBrandInText(seg)?.brand : null);
      if (b) currentBrand = b;
      continue;
    }
    seen++;
    const size = sizes[0];
    const tokens = numberTokens(norm, [{ index: size.index, length: size.length }]);
    const price = pickPrice(tokens, size.index + size.length);
    if (!price) continue;
    const brandHit = findBrandInText(norm);
    const brand = brandHit?.brand ?? currentBrand ?? "";
    const model = stripToModel(norm, { sizeRaw: norm.slice(size.index, size.index + size.length), brandAlias: brandHit?.alias, priceText: price.text.trim() });
    // stock: "stock 20", "20 und", "quedan 8", or (table layout) the integer right after the price column
    let stock: number | null = null;
    const stockMatch =
      norm.match(/(?:STOCK|DISP(?:ONIBLE)?|HAY|QUEDAN?|EXIST\w*)\s*:?\s*(\d{1,4})\b/) ?? norm.match(/\b(\d{1,4})\s*(?:UND|UNID|UNIDADES|PCS|PZAS|PIEZAS)\b/);
    if (stockMatch) stock = parseInt(stockMatch[1], 10);
    else if (header?.stockAfterPrice) {
      const after = tokens.filter((t) => t.index > price.index && Number.isInteger(t.value) && !t.hasCurrency && !t.hasDecimals);
      if (after.length === 1 && after[0].value < 10000) stock = after[0].value;
    }
    const row = buildRow({
      provider: opts.provider,
      kind: opts.kind,
      priceIncludesTax: opts.priceIncludesTax,
      maxDiscountPct: opts.maxDiscountPct,
      brand,
      model,
      size,
      cost: price.text,
      stock,
      priceDate,
      source: opts.source,
      sourceRef: opts.sourceRef,
      raw: seg,
      defaultCurrency: opts.defaultCurrency,
    });
    if (row) rows.push(row);
  }
  return { rows, seen, warnings };
}
