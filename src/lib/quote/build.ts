import { salespersonFor, type Settings } from "../settings";
import { fold } from "../tyre/brands";
import { POSITION_LABEL } from "../tyre/attrs";
import type { PriceRow } from "../ingest/types";
import { r2, taxFactor, totals } from "./pricing";
import type { Candidate, Quote, QuoteItem, QuoteRequest, RequestLine } from "./types";

const MONTHS_ES = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SETIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "{MES} {YYYY} - {NNN}" + 16 + 2026-10-07 -> "OCTUBRE 2026 - 016" */
export function formatQuoteNumber(format: string, counter: number, dateIso: string): string {
  const [y, m] = dateIso.split("-");
  const month = MONTHS_ES[parseInt(m, 10) - 1] ?? m;
  return format
    .replace("{MES}", month)
    .replace("{Mes}", month[0] + month.slice(1).toLowerCase())
    .replace("{MM}", m)
    .replace("{YYYY}", y)
    .replace("{YY}", y.slice(2))
    .replace("{NNNN}", String(counter).padStart(4, "0"))
    .replace("{NNN}", String(counter).padStart(3, "0"))
    .replace("{N}", String(counter));
}

/**
 * The counter inside a quote number: "OCTUBRE 2026 - 451" -> 451 (read through the number format; for numbers that
 * do not follow it, e.g. a free "nombre: …", the last group of digits). undefined when there are no digits.
 */
export function quoteSerial(number: string, format = "{MES} {YYYY} - {NNN}"): number | undefined {
  const parts = format.split(/(\{(?:MES|Mes|MM|YYYY|YY|NNNN|NNN|N)\})/);
  if (parts.some((p) => /^\{N+\}$/.test(p))) {
    const re = parts
      .map((p) => (/^\{N+\}$/.test(p) ? "(\\d+)" : /^\{(?:MES|Mes)\}$/.test(p) ? "\\p{L}+" : /^\{(?:MM|YYYY|YY)\}$/.test(p) ? "\\d+" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("");
    const m = number.trim().match(new RegExp(`^${re}$`, "iu"));
    if (m) return parseInt(m[1], 10);
  }
  const last = number.match(/(\d+)\D*$/);
  return last ? parseInt(last[1], 10) : undefined;
}

const ORIGIN_HINTS: [RegExp, string][] = [
  [/\b(INDIA)\b/, "INDIA"],
  [/\b(KOREA|COREA)\b/, "KOREA"],
  [/\b(JAPAN|JAP[OÓ]N|JP)\b/, "JAPÓN"],
  [/\b(THA|THAILAND|TAILANDIA)\b/, "TAILANDIA"],
  [/\b(VIETNAM)\b/, "VIETNAM"],
  [/\b(INDONESIA)\b/, "INDONESIA"],
  [/\b(TURQU[IÍ]A|TURKEY)\b/, "TURQUÍA"],
  [/\b(USA|U\.S\.A\.?|EEUU)\b/, "USA"],
  [/\b(BRASIL|BRAZIL)\b/, "BRASIL"],
  [/\b(CHINA)\b/, "CHINA"],
  [/\b(EC\.|ECUADOR)\b/, "ECUADOR"],
  [/\b(S\.A\.|SUDAFRICA|SUD[AÁ]FRICA)\b/, "SUDÁFRICA"],
];

export function countryOfOrigin(row: PriceRow, settings: Settings): string | undefined {
  const text = `${row.description} ${row.raw ?? ""}`.toUpperCase();
  for (const [re, label] of ORIGIN_HINTS) if (re.test(text)) return label;
  const map = settings.quote.brandOrigin;
  const key = Object.keys(map).find((k) => fold(k) === fold(row.brand));
  return key ? map[key] : undefined;
}

/** The client's own short forms for the APLICACIÓN column (as on their quotes: MIXT, DEL, POST ON/OFF). */
const APPLICATION_SHORT: Record<string, string> = { DEL: "DEL", TRAC: "POST", MIX: "MIXT", OTR: "OFF ROAD", TRL: "TRAILER" };

/** APLICACIÓN column from the price row: position words plus the tyre family. */
export function applicationLabel(row: PriceRow): string | undefined {
  const size = row.size;
  if (/^\d{3}-\d{1,2}$/.test(size)) return "MONTACARGAS";
  if (row.position) return APPLICATION_SHORT[row.position] ?? POSITION_LABEL[row.position];
  if (/L-|\/\d{2}-\d{2}$/.test(size) || /^\d{2}\.\d-\d{2}$/.test(size)) return "AGRÍCOLA";
  return undefined;
}

/** What the salesman wrote wins; else what the list says about the tyre; else the position word of the request. */
function applicationFor(row: PriceRow | undefined, line?: RequestLine): string | undefined {
  if (line?.application) return line.application;
  if (row) {
    const fromRow = applicationLabel(row);
    if (fromRow) return fromRow;
  }
  return line?.position ? APPLICATION_SHORT[line.position] : undefined;
}

export function itemFromCandidate(c: Candidate, quantity: number, settings: Settings, unitPriceOverride?: number, line?: RequestLine): QuoteItem {
  const r = c.row;
  const inDesc = (x: string) => !!x && fold(r.description).includes(fold(x));
  const descParts =
    r.kind === "own" || r.kind === "stock"
      ? [r.isTyre ? "Llanta" : "", r.description, inDesc(r.brand) ? "" : r.brand, inDesc(r.model) ? "" : r.model]
      : [r.isTyre ? "Llanta" : "", r.brand, r.model, r.sizeDisplay, r.loadIndex ? `${r.loadIndex}${r.speedIndex ?? ""}` : "", r.ply ? `${r.ply}PR` : ""];
  const unitPrice = unitPriceOverride ?? c.unitNet;
  return {
    description: descParts.filter(Boolean).join(" ").replace(/\s+/g, " "),
    code: r.code,
    brand: r.brand,
    model: r.model,
    size: r.size,
    sizeDisplay: r.sizeDisplay,
    loadIndex: r.loadIndex,
    speedIndex: r.speedIndex,
    ply: r.ply,
    quantity,
    unitPrice,
    listPrice: c.listNet,
    discountPct: unitPriceOverride !== undefined && c.listNet ? r2((1 - unitPriceOverride / c.listNet) * 100) : c.discountPct,
    total: r2(unitPrice * quantity),
    origin: unitPriceOverride !== undefined && !c.listNet ? "manual" : r.kind === "own" ? "own" : "provider",
    application: applicationFor(r, line),
    plate: line?.plate,
    ub: line?.ub,
    countryOfOrigin: countryOfOrigin(r, settings),
    photoUrl: r.photoUrl,
    sheetUrl: r.sheetUrl,
    photoSource: r.photoUrl ? r.provider : undefined,
    provider: r.provider,
    unitCost: c.costNet,
    priceDate: r.priceDate,
    rowId: r.id,
    available: c.available,
  };
}

/** A line the salesman priced by hand (no match in any list). */
export function manualItem(line: RequestLine, unitPrice: number, description?: string, settings?: Settings): QuoteItem {
  const brand = line.brand ?? "";
  const originKey = settings ? Object.keys(settings.quote.brandOrigin).find((k) => fold(k) === fold(brand)) : undefined;
  return {
    countryOfOrigin: originKey ? settings!.quote.brandOrigin[originKey] : undefined,
    description: description ?? (line.size ? ["Llanta", line.brand, line.model, line.size.display, line.ply ? `${line.ply}PR` : ""].filter(Boolean).join(" ") : line.text ?? line.raw),
    brand: line.brand ?? "",
    model: line.model ?? "",
    size: line.size?.canonical ?? "",
    sizeDisplay: line.size?.display ?? "",
    ply: line.ply,
    quantity: line.quantity,
    unitPrice,
    discountPct: 0,
    total: r2(unitPrice * line.quantity),
    origin: "manual",
    application: applicationFor(undefined, line),
    plate: line.plate,
    ub: line.ub,
    provider: "manual",
    priceDate: new Date().toISOString().slice(0, 10),
    available: null,
  };
}

export function buildQuote(params: {
  number: string;
  request: QuoteRequest;
  items: QuoteItem[];
  settings: Settings;
  today?: string;
  requestedBy?: string;
  pricesIncludeTax?: boolean;
  /** Customer profile id (config/customers.json), e.g. "prosegur". */
  customerProfile?: string;
  files?: Quote["files"];
}): Quote {
  const { settings: s, request: req } = params;
  const date = params.today ?? new Date().toISOString().slice(0, 10);
  const t = totals(params.items, s.pricing);
  const validityDays = req.validityDays ?? s.quote.validityDays;
  const notes = [s.quote.notes, params.items.some((i) => i.origin === "provider") ? s.quote.providerItemNote : ""].filter(Boolean).join(" ");
  const sp = salespersonFor(s, params.requestedBy);
  return {
    number: params.number,
    date,
    validUntil: addDays(date, validityDays),
    validityDays,
    currency: s.pricing.currency,
    customer: {
      name: req.customerName,
      company: req.customerCompany,
      email: req.customerEmail,
      ref: req.customerRef,
      // without "atención:", the contact named next to the company, else the requester ("solicitante:", Prosegur)
      attention: req.attention ?? (req.customerCompany && req.customerName ? req.customerName : undefined) ?? req.requester,
      address: req.address,
    },
    items: params.items,
    subtotal: t.subtotal,
    taxPct: s.pricing.taxPct,
    taxLabel: s.pricing.taxLabel,
    tax: t.tax,
    total: t.total,
    pricesIncludeTax: params.pricesIncludeTax ?? req.showPricesWithTax ?? s.pricing.showPricesWithTax,
    notes,
    paymentType: req.paymentType ?? s.quote.paymentType,
    paymentTerm: req.paymentTerm ?? s.quote.paymentTerm,
    deliveryTerm: req.deliveryTerm ?? s.quote.deliveryTerm,
    exchangeRate: req.exchangeRate ?? s.quote.exchangeRate,
    unit: req.unit,
    ub: req.ub,
    requester: req.requester,
    customerProfile: params.customerProfile,
    files: params.files,
    salesperson: { name: sp.name, title: sp.title, address: sp.address, email: sp.email, phone: sp.phone },
    status: "draft",
    requestText: req.raw,
    requestedBy: params.requestedBy,
    createdAt: new Date().toISOString(),
  };
}

/** Unit price as it should be printed (with or without tax, per the quote's setting). */
export function displayUnit(item: QuoteItem, quote: Quote): number {
  return quote.pricesIncludeTax ? r2(item.unitPrice * taxFactor({ taxPct: quote.taxPct } as never)) : item.unitPrice;
}

/** Total as printed: sum of displayed line totals (with tax when prices include it, net otherwise). */
export function displayTotal(quote: Quote): number {
  return r2(quote.items.reduce((s, i) => s + displayUnit(i, quote) * i.quantity, 0));
}
