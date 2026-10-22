/**
 * For each request line, find what can be quoted:
 *   1. own-list items (joined with Odoo stock by code / brand+model+size) – priced as list minus discount
 *   2. provider items (Steel, JCH, forwarded WhatsApp prices)            – priced as cost plus margin
 * Non-tyre lines (patches, rims) are matched by description similarity against own list + stock.
 */
import type { PriceRow } from "../ingest/types";
import { fold } from "../tyre/brands";
import { sizeCore, sizeLoose } from "../tyre/spec";
import type { PricingSettings } from "../settings";
import type { PriceStore } from "../store/types";
import { priceOwnItem, priceProviderItem, r2, rowNetPrice, taxFactor } from "./pricing";
import type { Candidate, LineCandidates, QuoteRequest, RequestLine } from "./types";

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Dice similarity on compact (no-space) bigrams, plus a bonus for containment. */
export function modelSimilarity(a: string, b: string): number {
  const fa = fold(a).replace(/\s+/g, "");
  const fb = fold(b).replace(/\s+/g, "");
  if (!fa || !fb) return 0;
  if (fa === fb) return 1;
  if (fa.includes(fb) || fb.includes(fa)) return 0.9;
  const A = bigrams(fa);
  const B = bigrams(fb);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** Token overlap for free-text items ("PARCHE RS-35 VIPAL" vs "PARCHE VIPAL RS-35 (CAJA)"). */
export function textSimilarity(a: string, b: string): number {
  const ta = new Set(fold(a).split(" ").filter((t) => t.length > 1));
  const tb = new Set(fold(b).split(" ").filter((t) => t.length > 1));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size) + 0.5 * modelSimilarity(a, b);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** Keep one row per provider+kind+brand+model+size: the most recent price (ties: cheapest). */
export function latestPerTyre(rows: PriceRow[]): PriceRow[] {
  const map = new Map<string, PriceRow>();
  for (const r of rows) {
    const key = [fold(r.provider), r.kind, r.code ? `c:${fold(r.code)}` : "", fold(r.brand), fold(r.model), r.size || fold(r.description)].join("|");
    const prev = map.get(key);
    if (!prev || r.priceDate > prev.priceDate || (r.priceDate === prev.priceDate && (r.cost ?? Infinity) < (prev.cost ?? Infinity))) map.set(key, r);
  }
  return [...map.values()];
}

/** Join an own-list row with its inventory row (same Odoo code, else same brand+model+size). */
export function findStockRow(own: PriceRow, stockRows: PriceRow[]): PriceRow | undefined {
  if (own.code) {
    const byCode = stockRows.find((s) => s.code && fold(s.code) === fold(own.code!));
    if (byCode) return byCode;
  }
  return stockRows.find((s) => s.size === own.size && fold(s.brand) === fold(own.brand) && (fold(s.model) === fold(own.model) || modelSimilarity(s.model, own.model) >= 0.8));
}

export interface MatchOptions {
  limit?: number;
  today?: string;
}

interface Scored {
  c: Candidate;
  group: number; // 0 own in stock, 1 own without stock info / short, 2 provider
}

function candidateFor(row: PriceRow, stockRow: PriceRow | undefined, line: RequestLine, req: QuoteRequest, pricing: PricingSettings, today: string, relaxed: boolean): Candidate | null {
  const net = rowNetPrice(row, pricing);
  if (!net) return null;
  const reasons: string[] = [];
  const ageDays = daysBetween(row.priceDate, today);
  const wantBrand = line.brand ? fold(line.brand) : null;
  const brandMismatch = !!wantBrand && fold(row.brand) !== wantBrand;
  const modelScore = line.model ? modelSimilarity(line.model, row.model || row.description) : 1;
  const positionMismatch = !!line.position && !!row.position && line.position !== row.position && !(line.position === "TRAC" && row.position === "MIX") && !(line.position === "DEL" && row.position === "MIX");

  let unitNet: number;
  let listNet: number | undefined;
  let costNet: number | undefined;
  let discountPct = 0;
  if (row.kind === "own") {
    listNet = net.net;
    const maxDisc = row.maxDiscountPct ?? pricing.own.maxDiscountPct;
    const priced = priceOwnItem(listNet, req.discountPct, maxDisc, pricing);
    unitNet = priced.unitNet;
    discountPct = priced.discountPct;
    if (priced.clamped) reasons.push(`descuento máximo ${maxDisc}%`);
  } else {
    costNet = net.net;
    unitNet = priceProviderItem(costNet, pricing, req.marginPct);
  }
  const available = stockRow ? stockRow.stock : row.kind === "own" ? null : row.stock;
  const stockByWarehouse = !stockRow && row.kind !== "own" ? row.stockByWarehouse : undefined;
  if (relaxed) reasons.push(`medida similar (${row.sizeDisplay})`);
  if (brandMismatch) reasons.push(`marca ${row.brand || "sin marca"}`);
  if (line.model && modelScore < 0.6) reasons.push(`modelo ${row.model || "distinto"}`);
  if (positionMismatch) reasons.push(`posición ${row.position}`);
  if (!net.ok) reasons.push(`sin tipo de cambio ${row.currency}->${pricing.currency}`);
  if (net.converted) reasons.push(`convertido de ${row.currency}`);
  const stale = row.kind !== "own" && ageDays > pricing.stalePriceDays; // the own list is valid until the manager replaces it
  if (stale) reasons.push(`precio de hace ${ageDays} días`);
  if (available !== null && available < line.quantity) reasons.push(available === 0 ? "sin stock" : `solo ${available} en stock`);
  return {
    row,
    stockRow,
    available,
    ...(stockByWarehouse ? { stockByWarehouse } : {}),
    listNet,
    discountPct,
    costNet,
    unitNet,
    unitWithTax: r2(unitNet * taxFactor(pricing)),
    ageDays,
    stale,
    relaxedSize: relaxed,
    brandMismatch,
    positionMismatch,
    modelScore,
    converted: net.converted,
    reasons,
  };
}

export function rankLine(rows: PriceRow[], line: RequestLine, req: QuoteRequest, pricing: PricingSettings, opts: MatchOptions = {}): Candidate[] {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const stockRows = rows.filter((r) => r.kind === "stock");
  const priced = rows.filter((r) => r.kind !== "stock" && r.cost !== null);

  let pool: PriceRow[];
  let relaxed = false;
  if (line.size) {
    const canonical = line.size.canonical;
    pool = priced.filter((r) => r.size === canonical);
    if (pool.length === 0) {
      const core = sizeCore(canonical);
      pool = priced.filter((r) => r.size && sizeCore(r.size) === core);
      if (pool.length === 0) {
        const loose = sizeLoose(canonical);
        pool = priced.filter((r) => r.size && sizeLoose(r.size) === loose);
      }
      relaxed = pool.length > 0;
    }
  } else {
    // free-text item: description similarity against own list and inventory
    const q = line.text ?? line.raw;
    const scored = priced
      .filter((r) => !r.isTyre || line.text === undefined)
      .map((r) => ({ r, s: textSimilarity(q, r.description) }))
      .filter((x) => x.s >= 0.5)
      .sort((a, b) => b.s - a.s);
    pool = scored.map((x) => x.r);
  }
  pool = latestPerTyre(pool);

  const scored: Scored[] = [];
  for (const row of pool) {
    const stockRow = row.kind === "own" ? findStockRow(row, stockRows) : undefined;
    const c = candidateFor(row, stockRow, line, req, pricing, today, relaxed);
    if (!c) continue;
    const group = row.kind === "own" ? (c.available !== null && c.available >= line.quantity ? 0 : 1) : 2;
    scored.push({ c, group });
  }
  // brand requested and available among candidates -> hide other brands unless nothing else
  const wantBrand = line.brand ? fold(line.brand) : null;
  const brandHits = wantBrand ? scored.filter((s) => !s.c.brandMismatch) : scored;
  const considered = wantBrand && brandHits.length > 0 ? brandHits : scored;

  considered.sort((a, b) => {
    // the model the customer asked for comes first (even with short stock), then own stock, own list, providers
    const tier = (x: Scored) => (!line.model ? 0 : x.c.modelScore >= 0.95 ? 2 : x.c.modelScore >= 0.6 ? 1 : 0);
    if (tier(a) !== tier(b)) return tier(b) - tier(a);
    if (a.group !== b.group) return a.group - b.group;
    if (a.c.positionMismatch !== b.c.positionMismatch) return a.c.positionMismatch ? 1 : -1;
    const aIn = a.c.available === null ? 0 : a.c.available >= line.quantity ? 1 : a.c.available > 0 ? 0 : -1;
    const bIn = b.c.available === null ? 0 : b.c.available >= line.quantity ? 1 : b.c.available > 0 ? 0 : -1;
    if (aIn !== bIn) return bIn - aIn;
    if (a.c.unitNet !== b.c.unitNet) return a.c.unitNet - b.c.unitNet;
    return b.c.modelScore - a.c.modelScore;
  });
  return considered.slice(0, opts.limit ?? 5).map((s) => s.c);
}

export function rankRequest(rows: PriceRow[], req: QuoteRequest, pricing: PricingSettings, opts: MatchOptions = {}): LineCandidates[] {
  return req.lines.map((line) => ({ line, candidates: rankLine(rows, line, req, pricing, opts) }));
}

/** Convenience: load the rows from the store and rank every line of the request. */
export async function findCandidates(store: PriceStore, req: QuoteRequest, pricing: PricingSettings, opts: MatchOptions = {}): Promise<LineCandidates[]> {
  const all = await store.allRows();
  return rankRequest(all, req, pricing, opts);
}
