/**
 * Parsers for the two PDFs the client exports from Excel/Odoo:
 *
 *  own list  – "COD ODOO | Medida | Marca | Modelo | Tipo | Precio Lista", footer "Precios Incluyen IGV- Descuento maximo 20%"
 *  stock     – "CÓDIGO | MEDIDA | MARCA | MODELO | Cantidad disponible para uso | RESERVA"
 *
 * Both are read from the PDF text (one line per row). Column boundaries are recovered by finding the brand
 * column (last brand mention on the line) and the trailing number(s).
 */
import { findBrandInText, fold, KNOWN_BRANDS } from "../tyre/brands";
import { findTyreSizes } from "../tyre/spec";
import { extractPosition, type Position } from "../tyre/attrs";
import type { IngestOptions, IngestResult, PriceRow } from "./types";
import { buildRow, parseDateLoose, parseMoney, todayIso } from "./util";
import { dedupeRows } from "./tabular";

export type PdfLayout = "own-list" | "odoo-stock" | "generic";

export function detectPdfLayout(text: string): PdfLayout {
  const head = text.slice(0, 2000).toUpperCase();
  if (/COD\.?\s*ODOO/.test(head) && /PRECIO/.test(head)) return "own-list";
  if (/C[ÓO]DIGO/.test(head) && /CANTIDAD\s+DISPONIBLE/.test(head)) return "odoo-stock";
  return "generic";
}

const BRAND_ALIASES: { alias: string; brand: string }[] = [];
for (const b of KNOWN_BRANDS) BRAND_ALIASES.push({ alias: fold(b), brand: b });

/**
 * Split "<description> <BRAND> <model...>" at the LAST brand mention (the brand column), so that a brand name
 * inside the description ("... FENIXWAY VALOR 99 MIX Fenix Way Valor 99 ...") does not confuse the split.
 */
function splitAtBrandColumn(body: string): { description: string; brand: string; rest: string } | null {
  const foldedTokens = body.split(/\s+/);
  let best: { start: number; end: number; brand: string } | null = null;
  // try every token window of 1..3 words, remember the last window that is a known brand alias
  for (let i = 0; i < foldedTokens.length; i++) {
    for (let len = 3; len >= 1; len--) {
      if (i + len > foldedTokens.length) continue;
      const phrase = fold(foldedTokens.slice(i, i + len).join(" "));
      const hit = findBrandInText(phrase);
      if (hit && hit.alias === phrase) {
        // later, non-overlapping mention wins (the brand column comes after the description)
        if (!best || i >= best.end) best = { start: i, end: i + len, brand: hit.brand };
        break;
      }
    }
  }
  if (!best) return null;
  // the brand column is the last mention, but only if something (model) or nothing follows; the description is before it
  return { description: foldedTokens.slice(0, best.start).join(" "), brand: best.brand, rest: foldedTokens.slice(best.end).join(" ") };
}

const TYPE_PHRASES = [
  "mixta all position",
  "tracc serv mixto",
  "tracc serv regional",
  "tracc mix service",
  "tracc off the road",
  "delantera regional",
  "super at / rt",
  "all position",
  "delantera",
  "traccion",
  "mixta",
  "posterior",
  "regional",
  "mt",
  "at",
  "ht",
  "rt",
];

/** "Valor 99 Mixta All Position" -> { model: "Valor 99", type: "Mixta All Position" } */
function splitModelType(rest: string): { model: string; type: string; position?: Position } {
  for (const phrase of TYPE_PHRASES) {
    const words = phrase.split(/[\s/]+/).filter(Boolean);
    const re = new RegExp(`(?:^|\\s)${words.join("[\\s/]+")}\\s*$`, "i");
    const m = rest.match(re);
    if (m && m.index !== undefined) {
      const model = rest.slice(0, m.index).trim().replace(/[\s/-]+$/, "");
      const type = rest.slice(m.index).trim();
      const short = /^(mt|at|ht|rt|super at \/ rt)$/.test(phrase);
      return { model, type, position: extractPosition(type) ?? (short ? "MIX" : undefined) };
    }
  }
  return { model: rest.trim(), type: "", position: undefined };
}

export function parseOwnListText(text: string, opts: IngestOptions): IngestResult {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const warnings: string[] = [];
  const rows: PriceRow[] = [];
  const meta: NonNullable<IngestResult["meta"]> = {};
  let seen = 0;

  for (const line of lines) {
    const up = line.toUpperCase();
    if (/^LISTA DE PRECIOS/.test(up)) meta.title = line;
    const tax = up.match(/PRECIOS?\s+(INCLUYEN?|CON)\s+IGV/);
    if (tax) meta.priceIncludesTax = true;
    if (/PRECIOS?\s+(NO\s+INCLUYEN?|SIN)\s+IGV/.test(up)) meta.priceIncludesTax = false;
    const disc = up.match(/DESCUENTO\s+M[ÁA]XIMO\s+(\d{1,2})\s*%?/);
    if (disc) meta.maxDiscountPct = parseInt(disc[1], 10);
    const date = up.match(/^FECHA\s+(.+)$/);
    if (date) meta.priceDate = parseDateLoose(date[1]) ?? meta.priceDate;
  }
  const priceIncludesTax = opts.priceIncludesTax ?? meta.priceIncludesTax ?? true;
  const maxDiscountPct = opts.maxDiscountPct ?? meta.maxDiscountPct;
  const priceDate = opts.priceDate ?? meta.priceDate ?? todayIso();

  for (const line of lines) {
    // a data row ends with a price: "... 185.56$" or "... $ 185.56"
    const m = line.match(/^(?:(?<code>[A-Z]{1,4}\d{2,6}[A-Z]?)\s+)?(?<body>.+?)\s*(?<price>\$\s*[\d.,]+|[\d.,]+\s*\$|[\d]+[.,]\d{2})\s*$/);
    if (!m || !m.groups) continue;
    const { code, body, price } = m.groups;
    if (/^(COD|LISTA|PRECIOS|FECHA)/i.test(body)) continue;
    seen++;
    const money = parseMoney(price);
    if (!money) continue;
    const split = splitAtBrandColumn(body);
    let description = body;
    let brand = "";
    let model = "";
    let type = "";
    let position: Position | undefined;
    if (split) {
      description = split.description;
      brand = split.brand;
      const mt = splitModelType(split.rest);
      model = mt.model;
      type = mt.type;
      position = mt.position;
    } else {
      warnings.push(`no brand recognised in: "${line}"`);
    }
    const row = buildRow({
      provider: opts.provider,
      kind: "own",
      code: code ?? undefined,
      description,
      brand,
      model,
      cost: money.value,
      priceIncludesTax,
      maxDiscountPct,
      currency: money.currency ?? opts.defaultCurrency ?? "USD",
      priceDate,
      source: "pdf",
      sourceRef: opts.sourceRef,
      notes: type || undefined,
      raw: line,
      position: position ?? extractPosition(description) ?? null,
      keepNonTyre: true,
    });
    if (row) rows.push(row);
  }
  const deduped = dedupeRows(rows);
  return {
    rows: deduped,
    warnings,
    meta,
    stats: { source: "pdf", sourceRef: opts.sourceRef, provider: opts.provider, rowsSeen: seen, rowsParsed: deduped.length, rowsSkipped: seen - deduped.length, method: "own-list-pdf" },
  };
}

export function parseOdooStockText(text: string, opts: IngestOptions): IngestResult {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const warnings: string[] = [];
  const rows: PriceRow[] = [];
  let seen = 0;
  const priceDate = opts.priceDate ?? parseDateLoose(opts.sourceRef) ?? todayIso();

  for (const line of lines) {
    // CODE  <description> [BRAND] [MODEL]  QTY  [RESERVA]
    const m = line.match(/^(?<code>[A-Z]{1,5}\d{2,6}[A-Z]?)\s+(?<body>.+?)\s+(?<qty>\d{1,5})(?:\s+(?<reserva>[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ. ]{1,30}))?$/);
    if (!m || !m.groups) continue;
    const { code, body, qty, reserva } = m.groups;
    seen++;
    const split = splitAtBrandColumn(body);
    const description = split ? split.description || body : body;
    const brand = split?.brand ?? "";
    const model = split?.rest ?? "";
    const row = buildRow({
      provider: opts.provider,
      kind: "stock",
      code,
      description,
      brand,
      model,
      size: findTyreSizes(body)[0] ?? null,
      cost: null,
      allowNoPrice: true,
      currency: opts.defaultCurrency ?? "USD",
      stock: parseInt(qty, 10),
      priceDate,
      source: "odoo",
      sourceRef: opts.sourceRef,
      notes: reserva ? `reservado: ${reserva.trim()}` : undefined,
      raw: line,
      keepNonTyre: true,
    });
    if (row) rows.push(row);
  }
  const deduped = dedupeRows(rows);
  return {
    rows: deduped,
    warnings,
    stats: { source: "odoo", sourceRef: opts.sourceRef, provider: opts.provider, rowsSeen: seen, rowsParsed: deduped.length, rowsSkipped: seen - deduped.length, method: "odoo-stock-pdf" },
  };
}
