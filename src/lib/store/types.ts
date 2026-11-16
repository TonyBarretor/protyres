import type { PriceRow, PriceSource } from "../ingest/types";
import type { Quote, QuoteItem } from "../quote/types";
import type { QuoteShadowEntry, QuoteShadowRow } from "../quote/shadow";
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
   * confirm_new: a new request arrived while a quote of the same customer was open; the bot asked whether it is a
   * *cambio*, a tyre to *agregar* or a *nueva* quote (`confirmText` waits, `resume` is the open quote's state).
   */
  step: "idle" | "choose" | "need_provider" | "review_quote" | "need_email" | "need_fields" | "need_application" | "confirm_new";
  /** The salesman's original request text (on "idle": the unit / UB lines of a bare "prosegur ayacucho 1830"). */
  requestText?: string;
  /** need_application: id of the contract item asked about ("f77"). */
  askItem?: string;
  /** Contract items already asked about in this quote (answered or skipped with "ok"): never asked twice. */
  applicationAsked?: string[];
  /** need_application while items are added to the quote already presented ("4 v89" after the PDF): that message. */
  addText?: string;
  /** confirm_new: the request waiting for the answer. */
  confirmText?: string;
  /** confirm_new: the state of the quote that was open (restored for *cambiar* / *agregar*). */
  resume?: ConversationState;
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
  /** Cotización pedida por nota de voz (portal): el PDF solo se arma con *ok* (elegir *1b* no lo arma). */
  voice?: boolean;
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

/** One WhatsApp message in or out of the bot (never media bytes: only the file name). */
export interface MessageLogEntry {
  /** The salesman's WhatsApp number. */
  phone: string;
  /** "in" = from the salesman, "out" = the bot's reply. */
  direction: "in" | "out";
  /** "text" | "document" | "image" | "audio" | "video" | … */
  kind: string;
  /** Text, caption, or a short description of the media. */
  body: string;
  fileName?: string;
  /** The quote the message belongs to, when known. */
  quoteNumber?: string;
  /**
   * Portal (corrida D): which router rule decided this message (kind "route" rows, one per message of a portal user):
   * "1_palabra", "2_medida", "3_respuesta", "4_ambiguo", "5_no_entendido", "comando", "reanudar"… (bot/router.ts).
   */
  routeRule?: string;
}

export interface LoggedMessage extends MessageLogEntry {
  id: number;
  /** ISO timestamp */
  createdAt: string;
}

/**
 * Uso medido de un servicio pagado (corrida E): una llamada al modelo (tokens) o una transcripción de voz (segundos).
 * `phone` = quien la provocó (solo dígitos) o "sistema" (sincronización de Drive, CLI).
 */
export interface UsageEntry {
  phone: string;
  /** "reporte" | "cotizador_pedido" | "cotizador_imagen" | "lista_precios" | "voz" | … */
  purpose: string;
  /** Modelo de lenguaje ("claude-haiku-4-5-…") o de voz ("nova-3"). */
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Segundos de audio (solo voz). */
  audioSeconds?: number;
  /** Costo estimado en USD (precios de config/portal.json, limits.prices). */
  costUsd: number;
  /** Por defecto ahora. */
  at?: Date;
}

/** Suma del uso desde una fecha, por usuario y propósito. */
export interface UsageSummaryRow {
  phone: string;
  purpose: string;
  /** Llamadas al modelo (las de voz no cuentan aquí). */
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Transcripciones de voz. */
  audioCalls: number;
  audioSeconds: number;
  costUsd: number;
}

/** Mensaje que la puerta del bot no procesó (corrida E): solo número, tipo y motivo; nunca el cuerpo. */
export interface BlockedInbound {
  phone: string;
  /** Tipo de mensaje de WhatsApp ("text", "audio", "document"…). */
  kind: string;
  /** "no_registrado" | "rafaga" | "viejo" */
  reason: string;
  at?: Date;
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
  /** A saved photo by its key ("brand|model", see photoKey). */
  getPhotoByKey(key: string): Promise<ProductPhoto | null>;
  setPhoto(photo: ProductPhoto): Promise<void>;
  /** Keys of every stored photo (to skip downloads already done). */
  photoKeys(): Promise<Set<string>>;
  /**
   * Most recent quote made for this customer (by email, else by company name compared with foldKey). With `unit`, only quotes for that unit of
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
  /** Appends a message to the log (table messages). */
  logMessage(entry: MessageLogEntry): Promise<void>;
  /** The last `limit` messages of a phone (digits compared), oldest first (newest last). */
  listMessages(phone: string, limit?: number): Promise<LoggedMessage[]>;
  getConversation(phone: string): Promise<ConversationState | null>;
  setConversation(phone: string, state: ConversationState | null): Promise<void>;
  /**
   * Returns false when this message id was already processed (webhook retries). Also used for "once" marks of the
   * guard (corrida E): keys "guard:<what>:<day>" (one fixed reply per unknown number per day, one admin notice per cap).
   */
  markProcessed(messageId: string): Promise<boolean>;
  /** Records one metered call (tables llm_usage / audio_usage). */
  recordUsage(entry: UsageEntry): Promise<void>;
  /** Usage since `since` (inclusive), grouped by phone and purpose. */
  usageSummary(since: Date): Promise<UsageSummaryRow[]>;
  /** Minimal log of a message the guard dropped (table blocked_inbound). */
  logBlocked(entry: BlockedInbound): Promise<void>;
  /** Blocked messages since `since`, by reason (for llm:usage). */
  blockedSummary(since: Date): Promise<{ reason: string; phones: number; messages: number }[]>;
  /** QUOTE_LLM_MODE=shadow: one comparison rules vs model (table quote_shadow; the text is customer data: database only). */
  logQuoteShadow(entry: QuoteShadowEntry): Promise<void>;
  /** Shadow comparisons, newest first (`since` inclusive, at most `limit`, default 1000). */
  listQuoteShadow(opts?: { since?: Date; limit?: number }): Promise<QuoteShadowRow[]>;
  /** Drive file id -> modifiedTime of the last successful ingest. */
  getSyncMarks(): Promise<Record<string, string>>;
  /** `provider` lets deleteProvider clear the marks of that provider's files. */
  setSyncMark(fileId: string, modifiedTime: string, provider?: string): Promise<void>;
  /** Corrida H, 3b: proveedores de la lista de contactos (tabla suppliers), por nombre. */
  listSuppliers(): Promise<Supplier[]>;
  /** Crea o actualiza por `key`; conserva las últimas condiciones (lastPayment / lastDelivery) que ya tenía. */
  upsertSuppliers(list: Supplier[]): Promise<{ inserted: number; updated: number }>;
  /** Recuerda las condiciones de pago y entrega usadas con un proveedor en un pedido (solo los campos dados). */
  setSupplierTerms(key: string, terms: { payment?: string; delivery?: string }): Promise<void>;
  /**
   * Corrida H, punto 4: descuentos de stock de un pedido. Libera los activos del mismo `orderKey` (un pedido nunca
   * descuenta dos veces: rehacerlo reemplaza) y guarda los nuevos con la hora de la última carga de su origen.
   */
  setStockDeductions(orderKey: string, label: string, entries: StockDeductionInput[], at?: Date): Promise<void>;
  /** Devuelve lo descontado por un pedido (anulado o rehecho); cuántos descuentos liberó. */
  releaseStockDeductions(orderKey: string, at?: Date): Promise<number>;
  /** Descuentos activos: sin liberar y hechos sobre la última carga de su origen (una carga nueva los deja sin efecto). */
  listStockDeductions(): Promise<StockDeduction[]>;
  close(): Promise<void>;
}

/** Proveedor de la lista de contactos (corrida H, 3b): a quién se le compra lo que no está en stock propio. */
export interface Supplier {
  /** supplierKey(name): clave estable entre importaciones. */
  key: string;
  /** "JCH LLANTAS" */
  name: string;
  contact?: string;
  phone?: string;
  email?: string;
  /** Marcas o rubros tal como vienen ("WEST LAKE", "CHINAS", "AROS"). */
  brands: string[];
  /** Proveedor del cotizador que le corresponde ("JCH", "Steel"), si hay. */
  provider?: string;
  /** Últimas condiciones de pago y entrega usadas en un pedido ("LETRAS 90", "ALMACEN LURIN"). */
  lastPayment?: string;
  lastDelivery?: string;
  updatedAt?: string;
}

export function supplierKey(name: string): string {
  return foldKey(name);
}

/** Origen de una carga de stock: proveedor y tipo de lista ("protyres|stock"). Una carga nueva del mismo origen reinicia el contador. */
export function stockOriginKey(provider: string, kind: string): string {
  return `${foldKey(provider)}|${kind}`;
}

/** Unidades de stock propio comprometidas por un pedido, por producto (fila de stock) y almacén. */
export interface StockDeductionInput {
  /** Id de la fila de stock (kind "stock"): estable entre cargas. */
  rowId: string;
  /** stockOriginKey de la fila. */
  origin: string;
  warehouse: string;
  quantity: number;
  /** "215/75R17.5 18PR FENIXWAY VALOR 99" */
  description: string;
}

export interface StockDeduction extends StockDeductionInput {
  id: number;
  /** "oc:<empresa>:<n° de OC>": un pedido, aunque se rehaga. */
  orderKey: string;
  /** "OC 4500123 · ZBUSS" */
  label: string;
  /** ISO */
  createdAt: string;
}

export type { QuoteItem };
