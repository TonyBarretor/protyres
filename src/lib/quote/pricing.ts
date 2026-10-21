import type { PricingSettings } from "../settings";
import type { PriceRow } from "../ingest/types";

export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function roundTo(value: number, step: number): number {
  if (!step || step <= 0) return r2(value);
  // toFixed guards against 410 * 1.15 = 471.49999999999994 rounding down
  return r2(Math.round(Number((value / step).toFixed(8))) * step);
}

/** Convert an amount in `from` currency into the quote currency using settings.exchangeRates. */
export function convertCurrency(amount: number, from: string, p: PricingSettings): { value: number; converted: boolean; ok: boolean } {
  const target = p.currency.toUpperCase();
  const src = (from || target).toUpperCase();
  if (src === target) return { value: amount, converted: false, ok: true };
  const rate = p.exchangeRates[src];
  if (rate) return { value: amount / rate, converted: true, ok: true }; // e.g. PEN 1150 / 3.75 = USD 306.67
  return { value: amount, converted: false, ok: false };
}

export const taxFactor = (p: PricingSettings) => 1 + p.taxPct / 100;

/** Net (without tax) value of a row's price, in the quote currency. */
export function rowNetPrice(row: PriceRow, p: PricingSettings): { net: number; converted: boolean; ok: boolean } | null {
  if (row.cost === null) return null;
  const conv = convertCurrency(row.cost, row.currency, p);
  const net = row.priceIncludesTax ? conv.value / taxFactor(p) : conv.value;
  return { net: r2(net), converted: conv.converted, ok: conv.ok };
}

export interface OwnPricing {
  listNet: number;
  discountPct: number;
  clamped: boolean;
  unitNet: number;
}

/** Own-list item: list price minus the salesman's discount (capped at the list's maximum). */
export function priceOwnItem(listNet: number, requestedDiscountPct: number | undefined, maxDiscountPct: number, p: PricingSettings): OwnPricing {
  const wanted = requestedDiscountPct ?? p.own.defaultDiscountPct;
  const discountPct = Math.max(0, Math.min(wanted, maxDiscountPct));
  return { listNet, discountPct, clamped: wanted > maxDiscountPct, unitNet: roundTo(listNet * (1 - discountPct / 100), p.roundTo) };
}

/**
 * Provider item: cost plus margin (the quote's "margen N%" when given, else pricing.provider.marginPct).
 * marginBase "cost": cost × (1 + m/100) (markup) · "price": cost / (1 − m/100) (the margin is m% of the sale price).
 */
export function priceProviderItem(costNet: number, p: PricingSettings, marginPct?: number): number {
  const m = marginPct ?? p.provider.marginPct;
  const base = p.provider.marginBase ?? "cost";
  const unit = base === "price" && m < 100 ? costNet / (1 - m / 100) : costNet * (1 + m / 100);
  return roundTo(unit, p.roundTo);
}

export function totals(items: { quantity: number; unitPrice: number }[], p: PricingSettings): { subtotal: number; tax: number; total: number } {
  const subtotal = r2(items.reduce((s, i) => s + i.quantity * i.unitPrice, 0));
  const tax = r2(subtotal * (p.taxPct / 100));
  return { subtotal, tax, total: r2(subtotal + tax) };
}

export function fmtMoney(n: number, currency: string): string {
  const sym = currency === "USD" ? "US$ " : currency === "PEN" ? "S/ " : `${currency} `;
  return sym + n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
