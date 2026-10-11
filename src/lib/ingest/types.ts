import type { Position } from "../tyre/attrs";

export type PriceSource = "excel" | "csv" | "pdf" | "html" | "whatsapp" | "manual" | "llm" | "odoo";

/**
 * own      – the company's own price list (list price, usually incl. IGV, with a max discount)
 * stock    – the company's inventory export (Odoo): quantities, usually no price
 * provider – an external supplier's list (cost, usually excl. IGV)
 */
export type RowKind = "own" | "stock" | "provider";

export interface PriceRow {
  /** Stable id (hash of provider|kind|code or provider|kind|size|brand|model). */
  id: string;
  provider: string;
  kind: RowKind;
  /** SKU / Odoo code / provider code, when the source has one. */
  code?: string;
  /** Full original description ("295/80R22.5 18PR FENIXWAY VALOR 87"). */
  description: string;
  /** Normalized brand ("Michelin"). May be "" when unknown. */
  brand: string;
  /** Model / design as written by the provider ("X Multi Z"). May be "". */
  model: string;
  /** Canonical size ("295/80R22.5", "11R22.5", "10R20"); "" for non-tyre items. */
  size: string;
  /** Conventional display ("10.00R20"). */
  sizeDisplay: string;
  sizeRaw: string;
  isTyre: boolean;
  loadIndex?: string;
  speedIndex?: string;
  ply?: number;
  position?: Position;
  tube?: "TL" | "TT";
  /** Unit price: provider cost, or the own list price. null for stock-only rows. */
  cost: number | null;
  /** Whether `cost` already includes IGV/VAT. */
  priceIncludesTax: boolean;
  /** Own list: maximum discount the salesman may apply. */
  maxDiscountPct?: number;
  currency: string;
  /** null = unknown */
  stock: number | null;
  /** ISO date (yyyy-mm-dd) the price was published / received. */
  priceDate: string;
  source: PriceSource;
  /** File name, Drive file id, or WhatsApp message id. */
  sourceRef: string;
  notes?: string;
  /** Product photo URL published by the provider (Steel's catalogue). */
  photoUrl?: string;
  /** Technical sheet image URL published by the provider. */
  sheetUrl?: string;
  /** Original text (cell/line/message fragment) for debugging. */
  raw?: string;
}

export type ColumnKey = "code" | "size" | "brand" | "model" | "price" | "stock" | "description" | "index" | "currency" | "position" | "ply" | "photo" | "sheet";

export interface IngestOptions {
  provider: string;
  sourceRef: string;
  kind?: RowKind;
  /** yyyy-mm-dd; defaults to today. */
  priceDate?: string;
  defaultCurrency?: string;
  priceIncludesTax?: boolean;
  maxDiscountPct?: number;
  /** Explicit column mapping for spreadsheets (header text or column letter; stock may be "G,H,I" to sum). */
  columns?: Partial<Record<ColumnKey, string>>;
  /** Treat all sheets as the same provider list (default true). */
  allSheets?: boolean;
  /** Keep rows that have no tyre size (rims, tubes, patches...). Default: true for own/stock, false for providers. */
  keepNonTyre?: boolean;
}

export interface IngestResult {
  rows: PriceRow[];
  warnings: string[];
  stats: {
    source: PriceSource;
    sourceRef: string;
    provider: string;
    rowsSeen: number;
    rowsParsed: number;
    rowsSkipped: number;
    method: string;
  };
  /** Facts found in the document itself (own list footer: "Precios incluyen IGV - Descuento máximo 20%"). */
  meta?: { priceIncludesTax?: boolean; maxDiscountPct?: number; priceDate?: string; title?: string };
}
