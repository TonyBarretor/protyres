import type { PriceRow, PriceSource } from "../ingest/types";
import type { Quote, QuoteItem } from "../quote/types";

export interface ProviderSummary {
  provider: string;
  kind: string;
  rows: number;
  sources: string[];
  lastPriceDate: string;
}

/** One line of a quote in progress: which candidate was chosen (index into candidateIds), or a manual price. */
export interface PendingLine {
  candidateIds: string[];
  chosen: number | null;
  unitPriceOverride?: number;
  quantity: number;
  removed?: boolean;
}

/** Per-phone conversation state for the WhatsApp bot. */
export interface ConversationState {
  phone: string;
  step: "idle" | "choose" | "need_provider" | "review_quote" | "need_email";
  /** The salesman's original request text. */
  requestText?: string;
  /** Lines being quoted (same order as the parsed request). */
  pending?: PendingLine[];
  /** Quote number waiting for "enviar". */
  quoteNumber?: string;
  /** Pending provider price text waiting for a provider name. */
  pendingPriceText?: string;
  /** A web photo candidate waiting for "foto ok" / "foto no". */
  pendingPhoto?: { brand: string; model: string; url: string; candidates: string[]; index: number };
  pendingMedia?: { id: string; mimeType: string; fileName?: string };
  updatedAt: string;
}

/** A product photo (and optional technical sheet) for a brand+model. */
export interface ProductPhoto {
  /** photoKey(brand, model) */
  key: string;
  brand: string;
  model: string;
  url?: string;
  /** base64 bytes when uploaded through WhatsApp */
  data?: string;
  mimeType?: string;
  sheetUrl?: string;
  source: "provider" | "whatsapp" | "web" | "manual";
  addedBy?: string;
  createdAt: string;
}

/** Normalised brand+model key ("fenixway|valor87"). */
export function photoKey(brand: string, model: string): string {
  const f = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  return `${f(brand)}|${f(model)}`;
}

export interface ReplaceScope {
  provider: string;
  sourceRef?: string;
  source?: PriceSource;
  kind?: PriceRow["kind"];
}

export interface PriceStore {
  upsertRows(rows: PriceRow[], opts?: { replace?: ReplaceScope }): Promise<{ inserted: number; removed: number }>;
  allRows(): Promise<PriceRow[]>;
  /** Rows whose canonical size equals one of the given canonicals. */
  findBySize(canonicals: string[]): Promise<PriceRow[]>;
  getRows(ids: string[]): Promise<PriceRow[]>;
  /** Price rows (any provider) of this brand+model that carry a photo URL. */
  rowsWithPhoto(brand: string, model: string): Promise<PriceRow[]>;
  getPhoto(brand: string, model: string): Promise<ProductPhoto | null>;
  setPhoto(photo: ProductPhoto): Promise<void>;
  /** Most recent quote sent to this customer (by email, else by company name). */
  findLastQuoteForCustomer(opts: { email?: string; company?: string }): Promise<Quote | null>;
  providers(): Promise<ProviderSummary[]>;
  /** Increments and returns the quote counter; `start` is used the first time (when the store has no counter yet). */
  nextQuoteCounter(start?: number): Promise<number>;
  saveQuote(quote: Quote): Promise<void>;
  getQuote(number: string): Promise<Quote | null>;
  listQuotes(limit?: number): Promise<Quote[]>;
  getConversation(phone: string): Promise<ConversationState | null>;
  setConversation(phone: string, state: ConversationState | null): Promise<void>;
  /** Returns false when this message id was already processed (webhook retries). */
  markProcessed(messageId: string): Promise<boolean>;
  /** Drive file id -> modifiedTime of the last successful ingest. */
  getSyncMarks(): Promise<Record<string, string>>;
  setSyncMark(fileId: string, modifiedTime: string): Promise<void>;
  close(): Promise<void>;
}

export type { QuoteItem };
