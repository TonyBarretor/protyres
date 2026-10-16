import type { PriceRow, PriceSource } from "../ingest/types";
import type { Quote, QuoteItem } from "../quote/types";
import { fold, knownBrand } from "../tyre/brands";

/** Case / accent / punctuation-insensitive key: "J.CH." -> "jch", "Prosegur S.A." -> "prosegursa". */
export function foldKey(s: string | undefined | null): string {
  return fold(s ?? "").replace(/\s+/g, "");
}

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
  /** APLICACIÓN typed by the salesman for this line ("aplicación 2 MIXT DEL"). */
  application?: string;
  /** More options of the same line quoted as extra items ("opción a x2, opción b x8"). */
  extra?: { chosen: number; quantity: number }[];
}

/** Per-phone conversation state for the WhatsApp bot. */
export interface ConversationState {
  phone: string;
  /**
   * need_fields: a customer profile's required fields (unidad, ub, solicitante) are missing from the request.
   * need_application: a contract item has no APLICACIÓN yet; the bot asked for it (`askItem`) before building.
   */
  step: "idle" | "choose" | "need_provider" | "review_quote" | "need_email" | "need_fields" | "need_application";
  /** The salesman's original request text (on "idle": the unit / UB lines of a bare "prosegur ayacucho 1830"). */
  requestText?: string;
  /** need_application: id of the contract item asked about ("f77"). */
  askItem?: string;
  /** Contract items already asked about in this quote (answered or skipped with "ok"): never asked twice. */
  applicationAsked?: string[];
  /** need_application while items are added to the quote already presented ("4 v89" after the PDF): that message. */
  addText?: string;
  /** Customer profile of the request (config/customers.json id, e.g. "prosegur"); on "idle", the one the next request uses. */
  profile?: string;
  /**
   * "número 451" / "nombre: …" typed while choosing options; `confirmed` reuses a number that already exists,
   * `asked` = the bot warned about it after "ok" (so "número 451 confirmar" builds the quote right away).
   */
  numbering?: { counter?: number; name?: string; confirmed?: boolean; asked?: boolean };
  /** "archivo: …" / "archivo excel: …" typed while choosing options. */
  files?: { pdfName?: string; xlsxName?: string };
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
  /** base64 bytes of the technical sheet, when downloaded */
  sheetData?: string;
  source: "provider" | "whatsapp" | "web" | "manual";
  /** provider / site name ("JCH", "Steel") */
  origin?: string;
  /** provider SKU it was matched by */
  code?: string;
  addedBy?: string;
  createdAt: string;
}

/** Normalised brand+model key ("fenixway|valor87"); brand aliases ("GT Radial" → Giti) collapse to one key. */
export function photoKey(brand: string, model: string): string {
  brand = knownBrand(brand) ?? brand;
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

/** A document exactly as it was sent with a quote (the PDF, the customer's Excel format), for resending later. */
export interface QuoteFile {
  quoteNumber: string;
  /** "pdf" | "xlsx" */
  kind: string;
  fileName: string;
  mimeType: string;
  /** base64 bytes */
  data: string;
  createdAt?: string;
}

export interface ListQuotesOptions {
  /** Customer company containing this text (case / accent / punctuation-insensitive): "prosegur" finds "PROSEGUR SA". */
  company?: string;
  /** WhatsApp number of the salesman who made the quote. */
  requestedBy?: string;
  /** Default 50. */
  limit?: number;
}

/** Counter name of a salesman's own quote numbering ("quote:51955344340"). */
export function quoteCounterKey(phone: string): string {
  return `quote:${phone.replace(/\D/g, "")}`;
}

/**
 * A customer's contract item as stored in the database (table contract_prices, keyed by customer = profile id and
 * item id). It overrides the config/customers.json item with the same id field by field (fields left empty keep the
 * config's value); an id that is not in the config is an extra item. A change made from WhatsApp (price, APLICACIÓN)
 * only fills its own field, so the fields never changed keep following the config; an extra item has every field.
 */
export interface StoredContractItem {
  /** "v99" (lower case) */
  id: string;
  brand?: string;
  model?: string;
  /** "215/75R17.5" */
  size?: string;
  ply?: number;
  /** APLICACIÓN ("MIXT", "POST"); empty = the config's (null there = the bot asks once) */
  application?: string | null;
  /** Unit price net of IGV. */
  price?: number;
  currency?: string;
  aliases?: string[];
  /** WhatsApp number of whoever changed it. */
  updatedBy?: string;
  updatedAt?: string;
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
  /** Keys of every stored photo (to skip downloads already done). */
  photoKeys(): Promise<Set<string>>;
  /**
   * Most recent quote sent to this customer (by email, else by company name). With `unit`, only quotes for that unit of
   * the customer (case / accent-insensitive): Prosegur's requester and contact differ per unit.
   */
  findLastQuoteForCustomer(opts: { email?: string; company?: string; unit?: string }): Promise<Quote | null>;
  providers(): Promise<ProviderSummary[]>;
  /** Removes every price row of a provider (name matched case / accent-insensitively) and its Drive sync marks. */
  deleteProvider(name: string): Promise<{ rows: number; syncMarks: number }>;
  /**
   * Increments and returns a quote counter; `start` is used the first time (when the store has no counter yet).
   * `key` names a salesman's own counter (quoteCounterKey); a key with no counter yet takes the next global value.
   */
  nextQuoteCounter(start?: number, key?: string): Promise<number>;
  /** Sets a counter so the next nextQuoteCounter(…, key) returns value + 1. */
  setQuoteCounter(value: number, key?: string): Promise<void>;
  saveQuote(quote: Quote): Promise<void>;
  getQuote(number: string): Promise<Quote | null>;
  /** Removes a quote and its stored files (a draft renumbered by the salesman). */
  deleteQuote(number: string): Promise<void>;
  /** Newest first. A number is the limit (kept for older callers). */
  listQuotes(opts?: number | ListQuotesOptions): Promise<Quote[]>;
  /** Stores a sent document (replaces the one of the same quote and kind). */
  saveQuoteFile(file: QuoteFile): Promise<void>;
  /** The documents stored for a quote (PDF first). */
  getQuoteFiles(quoteNumber: string): Promise<QuoteFile[]>;
  /** Contract items stored for a customer profile (`customer` = profile id, e.g. "prosegur"), by id. */
  getContractItems(customer: string): Promise<StoredContractItem[]>;
  /** Creates or replaces one stored contract item. */
  setContractItem(customer: string, item: StoredContractItem): Promise<void>;
  /** Removes a stored contract item; false when there was none. */
  deleteContractItem(customer: string, itemId: string): Promise<boolean>;
  getConversation(phone: string): Promise<ConversationState | null>;
  setConversation(phone: string, state: ConversationState | null): Promise<void>;
  /** Returns false when this message id was already processed (webhook retries). */
  markProcessed(messageId: string): Promise<boolean>;
  /** Drive file id -> modifiedTime of the last successful ingest. */
  getSyncMarks(): Promise<Record<string, string>>;
  /** `provider` lets deleteProvider clear the marks of that provider's files. */
  setSyncMark(fileId: string, modifiedTime: string, provider?: string): Promise<void>;
  close(): Promise<void>;
}

export type { QuoteItem };
