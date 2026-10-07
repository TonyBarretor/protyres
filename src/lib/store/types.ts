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
  pendingMedia?: { id: string; mimeType: string; fileName?: string };
  updatedAt: string;
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
