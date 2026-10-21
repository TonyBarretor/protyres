/**
 * The bot's conversation logic. One salesman phone = one conversation state.
 *
 *   salesman  ->  "Fenixway 295/80R22.5 Valor 87 x4 para Transportes ABC, juan@abc.com, dscto 10%"
 *                 (or a forwarded customer message / RFQ email with several lines)
 *   bot       ->  per line: numbered options (stock, list price, discount, provider alternatives)
 *   salesman  ->  "ok"  /  "1b 3a"  /  "quitar 2"  /  "precio 3 4.50"  /  "dscto 15"  /  "margen 10"  /  "con igv"
 *   bot       ->  PDF quote + email preview
 *   salesman  ->  "enviar"  (or "correo x@y.com", "cancelar")
 *   bot       ->  "Enviado ✔"
 *
 *   forwarded provider message / PDF / Excel / photo of a price list  ->  "¿De qué proveedor?"  ->  name  ->  prices stored
 */
import { isAdmin } from "../admin";
import { ingestCsv, ingestExcel } from "../ingest/tabular";
import { ingestPdf } from "../ingest/pdf";
import { QUOTE_FILE_REFUSAL, detectQuoteDocument } from "../ingest/quote-detect";
import { ingestWhatsAppText, looksLikePriceMessage } from "../ingest/whatsapp-text";
import { loadProvidersConfig, resolveSourceOptions } from "../ingest/sources";
import { extractPricesWithLLM, llmAvailable } from "../llm/extract-prices";
import { parseRequestWithLLM } from "../llm/parse-request";
import type { IngestResult } from "../ingest/types";
import { fold, findBrandInText } from "../tyre/brands";
import { findTyreSizes, parseTyreSize } from "../tyre/spec";
import type { CustomerProfile, Settings } from "../settings";
import { foldKey, photoKey, quoteCounterKey, type ConversationState, type PendingLine, type PriceStore } from "../store/types";
import { buildQuote, displayTotal, displayUnit, formatQuoteNumber, itemFromCandidate, manualItem, quoteSerial } from "../quote/build";
import { contractItemLabel, contractQuoteItem, contractUnitPrice, findContractItem, onlyContractLines, parseContractRequest, parseContractRequestRegex, parseNewContractItem, resolveContract, startsWithContractAlias, toStored, type Contract } from "../quote/contract";
import { buildEmailDraft, sendQuoteEmail, type EmailAttachment, type SendResult } from "../quote/email";
import { PDF_MIME, XLSX_MIME, pdfFileName, withExtension } from "../quote/files";
import { findCandidates } from "../quote/match";
import { renderQuotePdf } from "../quote/pdf";
import { attachPhotos, findPhoto, itemsWithoutPhoto, loadImage, searchWebPhotos, webSearchAvailable } from "../quote/photos";
import { fmtMoney, r2 } from "../quote/pricing";
import { FIELD_LABEL, askRequired, detectProfile, findProfile, hasExcelFormat, leadingProfile, missingInQuote, missingRequired, profileGuide, profileHead, profileId, profileKey, profileRequestText, shortItemLabel, type RequiredField } from "../quote/profiles";
import { PROSEGUR_MAX_ITEMS, prosegurTooManyItems, renderProsegurXlsx } from "../quote/prosegur-xlsx";
import { describeLine, describeRequest, parseEmail, parseRequest, parseRequestRegex, stripMargin, unparsedHintInfo } from "../quote/request";
import type { Candidate, EmailDraft, LineCandidates, Quote, QuoteItem, QuoteRequest, RequestLine } from "../quote/types";
import type { WhatsAppClient } from "./client";
import type { InboundMessage } from "./webhook";

export interface HandlerDeps {
  client: WhatsAppClient;
  store: PriceStore;
  settings: Settings;
  /** Called with generated PDFs (the CLI simulator saves them to ./out). */
  onPdf?: (quote: Quote, pdf: Buffer) => Promise<void> | void;
  /** Sends the quote email (default: Resend, or a dry-run file without RESEND_API_KEY); tests capture it. */
  sendEmail?: (quote: Quote, attachments: EmailAttachment[], draft: EmailDraft) => Promise<SendResult>;
  log?: (msg: string) => void;
}

const HELP = [
  "*Cotizador Protyres* 🛞",
  "",
  "Escríbeme lo que pide el cliente, o reenvíame su mensaje / correo:",
  "_Fenixway 295/80R22.5 Valor 87 x4 para Transportes ABC, juan@abc.com, dscto 10%_",
  "",
  "Te muestro por cada ítem las opciones: stock propio (precio de lista menos descuento) y proveedores (Steel, JCH…).",
  "Respondes *ok* para aceptar las primeras opciones, o eliges: *1b 2a*, *quitar 3*, *precio 3 4.50*, *dscto 15*, *margen 10*, *con igv*.",
  "Luego revisas el PDF y escribes *enviar*.",
  "",
  "Prosegur: *prosegur ayacucho 1830* y debajo una línea por llanta (*2 v99*); *contrato prosegur* muestra sus precios. Va también su Excel «Formato Proveedores».",
  "Número y archivos: *número 451*, *nombre: …*, *archivo: Nombre*, *archivo excel: Nombre*.",
  "Historial: *cotizaciones*, *cotizaciones Prosegur*, *reenviar 451*.",
  "",
  "Para cargar precios: reenvíame la lista del proveedor (mensaje, PDF, Excel o foto) y te preguntaré de quién es (un proveedor nuevo lo registra el administrador con *proveedor nuevo: Nombre*). Las cotizaciones no se cargan como listas.",
  "",
  "Fotos: *foto 1b* te manda la foto de una opción; para guardar una foto nueva envíame la imagen con el texto *foto Fenixway Valor 87*.",
  "",
  "Comandos: *ayuda*, *cancelar*, *proveedores*, *precios 11R22.5*, *stock 295/80R22.5*",
].join("\n");

const LETTERS = "abcdefghij";

function norm(s: string | undefined): string {
  return fold(s ?? "");
}

function now(): string {
  return new Date().toISOString();
}

export interface Pick {
  line: number;
  option: number;
  quantity?: number;
}

/**
 * The salesman's choice of options, however he types it: "1b", "1b 2a", "a", "2" (single line = option b),
 * "opción a x 2 unds", "OPCION A X 2UNDS, OPCION B X 8 UNDS", "1 opción b x4, 2a". Returns null when the text is
 * not a choice (a new request, a command…).
 */
export function parsePicks(text: string, lines: number): Pick[] | null {
  const t = fold(text)
    .replace(/(\d)\s*(?:unds?|unid|unidades|uds?|u|llantas?)\b/g, "$1") // "2unds", "8 llantas"
    .replace(/\b(?:opcion|opciones|op|alternativa|item|items|la|el|las|los|de|del|con|y|e|unds?|unid|unidad|unidades|uds?|u|llantas?|neumaticos?|c\/u|cada\s+una)\b/g, " ")
    .replace(/[.,;:\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  // tokens: [line] letter [x qty]   ·   or a bare number: option index (single line) / line with option a (several)
  const picks: Pick[] = [];
  const re = /(?:(\d{1,2})\s*)?([a-j])(?:\s*(?:x|por|\*)\s*(\d{1,4}))?|(\d{1,2})(?:\s*(?:x|por|\*)\s*(\d{1,4}))?/g;
  let consumed = "";
  for (const m of t.matchAll(re)) {
    consumed += m[0] + " ";
    if (m[2]) {
      const letter = LETTERS.indexOf(m[2]);
      const line = m[1] ? parseInt(m[1], 10) - 1 : lines === 1 ? 0 : -1;
      if (line < 0 && lines > 1) return null; // "b" alone with several lines: ambiguous → not a choice
      picks.push({ line, option: letter, quantity: m[3] ? parseInt(m[3], 10) : undefined });
    } else if (m[4]) {
      const n = parseInt(m[4], 10);
      if (lines === 1) picks.push({ line: 0, option: n - 1, quantity: m[5] ? parseInt(m[5], 10) : undefined });
      else if (m[5]) return null; // "2 x 4" with several lines: not a choice
      else picks.push({ line: n - 1, option: 0 });
    }
  }
  // everything in the text must have been understood as a pick
  if (consumed.replace(/\s+/g, " ").trim() !== t) return null;
  return picks.length ? picks : null;
}

function looksLikeRequest(text: string): boolean {
  return /\bx\s*\d{1,3}\b|\b\d{1,3}\s*(?:unidades|und|unid|llantas)\b|\b(?:para|cliente|cotiza|cotizar|cotización|cotizacion|necesito|pide|piden|me cotizas|und\b)\b|@|\bdscto\b|\bdescuento\b|\bmargen\b|\bu\.?\s?b\.?\s*:?\s*\d{3,5}\b|\b(?:unidad|solicitante)\s*:/i.test(text);
}

function fmtDateShort(iso: string): string {
  return iso.split("-").reverse().slice(0, 2).join("/");
}

function fmtDate(iso: string): string {
  return iso.split("-").reverse().join("/");
}

/** A line that sets one of the quote's boxes: "unidad: Ayacucho", "ub 1830", "solicitante: …", "pago: letras", "validez 5 días". */
const TERM_LINE = /^(atenci[oó]n|atn|att|direcci[oó]n|dir|tipo de pago|pago|plazo de entrega|plazo de pago|plazo|entrega|validez|tipo de cambio|tc|unidad atendida|unidad|sede|ub|u\.b\.|solicitante)(?:\s+(?:a|al|de|del)(?=\s*:))?\s*(?::\s*|\s+)(\S.*)$/i;

/**
 * "⚠️ No entendí: «…» — …": one line per segment of the request the parser could not place (at most four), with how
 * to write it when the segment says what it was. Chat only: never on the quote.
 */
function unparsedWarning(segments: string[]): string {
  const MAX = 4;
  const lines = segments.slice(0, MAX).map((seg) => {
    const h = unparsedHintInfo(seg);
    const how = !h
      ? "lo dejé fuera; si hace falta, reenvíalo como *clave: valor* o como línea de llanta"
      : h.field === "size"
        ? `si es una llanta, escribe la medida como ${h.example}`
        : `si es ${h.label} escribe ${h.example}`;
    return `⚠️ No entendí: «${seg}» — ${how}`;
  });
  if (segments.length > MAX) lines.push(`…y ${segments.length - MAX} más`);
  return lines.join("\n");
}

/** Every line of the message is a field line → those lines as "clave: valor"; otherwise null. */
function termLines(text: string): string[] | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines.every((l) => TERM_LINE.test(l))) return null;
  return lines.map((l) => {
    const m = l.match(TERM_LINE)!;
    return `${m[1]}: ${m[2].trim()}`;
  });
}

/** "número 451", "numero 451 confirmar", "nro 451", "n° 451". */
function parseNumberCommand(text: string): { counter: number; confirmed: boolean } | null {
  const m = text.trim().match(/^(?:n[uú]mero|nro\.?|n[°º]\.?)\s*:?\s*(\d{1,6})(\s+confirmar)?$/i);
  return m ? { counter: parseInt(m[1], 10), confirmed: !!m[2] } : null;
}

/** "nombre: TEXTO LIBRE" (the quote's number written verbatim), optionally ending in "confirmar". */
function parseNameCommand(text: string): { name: string; confirmed: boolean } | null {
  const m = text.trim().match(/^nombre\s*:\s*(\S.*?)(\s+confirmar)?$/i);
  return m ? { name: m[1].trim(), confirmed: !!m[2] } : null;
}

/** "archivo: Nombre" (PDF) / "archivo excel: Nombre". */
function parseFileCommand(text: string): { pdfName?: string; xlsxName?: string } | null {
  const x = text.trim().match(/^archivo\s+(?:excel|xlsx)\s*:?\s*(\S.*)$/i);
  if (x) return { xlsxName: x[1].trim() };
  const p = text.trim().match(/^archivo(?:\s+pdf)?\s*:\s*(\S.*)$/i);
  return p ? { pdfName: p[1].trim() } : null;
}

const STATUS_LABEL: Record<Quote["status"], string> = { draft: "borrador", sent: "enviada", cancelled: "anulada" };

/** A profile chosen with a bare "prosegur" (or "prosegur ayacucho 1830": its unit / UB lines too) applies to the next request (for two hours). */
function pendingProfile(state: ConversationState): { profile: string; header?: string } | undefined {
  if (state.step !== "idle" || !state.profile) return undefined;
  return Date.now() - Date.parse(state.updatedAt) < 2 * 3600_000 ? { profile: state.profile, header: state.requestText } : undefined;
}

/** "unidad: …" / "ub: …" / "solicitante: …": the line that sets a profile's required field. */
const FIELD_KEY: Record<RequiredField, string> = { unit: "unidad", ub: "ub", requester: "solicitante" };

/** Words that are commands, never a bare answer (a requester's name, a unit, an APLICACIÓN). */
const COMMAND_WORD = /^(?:enviar|send|ayuda|help|hola|menu|inicio|gracias|listo|dale|si|no|ok|cancelar|seguir|continuar|cotizar|confirmar|proveedores|listas|cotizaciones|contrato|contratos|fotos?|precios?|stock|cantidad|cant|quitar|quita|eliminar|aplicacion|archivo|nombre|numero|nro|reenviar|reenvia|archivos|pdf|correo|email|borrar|proveedor|dscto|descuento|margen)\b/;

/** The question for a contract item without APLICACIÓN yet ("Flama 77"). */
function askApplication(name: string): string {
  return `¿Qué aplicación lleva la ${name}? (MIXT, POST, DEL…)`;
}

export class BotHandler {
  constructor(private deps: HandlerDeps) {}

  private get client() {
    return this.deps.client;
  }
  private get store() {
    return this.deps.store;
  }
  private get settings() {
    return this.deps.settings;
  }
  private get cur() {
    return this.settings.pricing.currency;
  }
  private log(msg: string) {
    this.deps.log?.(msg);
  }

  async handle(msg: InboundMessage): Promise<void> {
    const from = msg.from;
    const text = (msg.text ?? "").trim();
    const cmd = norm(text);
    const state: ConversationState = (await this.store.getConversation(from)) ?? { phone: from, step: "idle", updatedAt: now() };

    try {
      if (["ayuda", "help", "?", "hola", "menu", "inicio"].includes(cmd)) return this.reply(from, HELP);
      if (["cancelar", "cancel", "salir", "reset"].includes(cmd)) {
        await this.store.setConversation(from, null);
        if (state.step === "need_provider") return this.reply(from, "Cancelado. No guardé esa lista.");
        return this.reply(from, "Listo, cancelado. ¿Qué cotizamos?");
      }
      if (cmd === "proveedores" || cmd === "listas") return this.replyProviders(from);
      if (state.step !== "review_quote" && /^(precios?|stock)\s+/.test(cmd) && findTyreSizes(text).length > 0) return this.replyPrices(from, text.replace(/^(precios?|stock)\s+/i, ""));
      // history and contract commands work in any state and leave the conversation as it is
      if (!msg.media && (await this.handleHistoryCommand(from, text))) return;
      if (!msg.media && (await this.handleContractCommand(from, text))) return;

      // 0) Product photos: an image captioned "foto <marca> <modelo>" is stored; "foto 1b" / "foto ok" / "foto no" are commands
      const photoCaption = (msg.media?.caption ?? "").match(/^foto\s+(.+)$/i);
      if (msg.media && msg.type === "image" && photoCaption) return this.savePhotoFromMedia(from, msg, photoCaption[1]);
      if (/^fotos?\b/.test(cmd)) return this.handlePhotoCommand(from, state, text);

      // 1) Provider price lists (files, photos, forwarded messages)
      if (msg.media && msg.type !== "audio" && msg.type !== "video") {
        if (await this.mediaIsCustomerRequest(msg)) return this.startRequestFromMedia(from, msg);
        return this.startIngest(from, state, { media: msg.media, caption: msg.media.caption });
      }
      if (msg.type === "audio" || msg.type === "video") return this.reply(from, "Por ahora no leo audios ni videos. Reenvíame el texto, PDF, Excel o una foto.");
      if (state.step === "need_provider") return this.answerProvider(from, state, text);
      const profileNext = pendingProfile(state);
      if ((msg.forwarded || state.step === "idle") && looksLikePriceMessage(text) && !looksLikeRequest(text) && !profileNext && !leadingProfile(this.settings, text)) {
        return this.startIngest(from, state, { text });
      }

      // 2) Quote flow
      if (state.step === "need_application" && state.askItem) {
        const handled = await this.handleApplicationAnswer(from, state, text);
        if (handled) return;
      }
      if (state.step === "need_fields" && state.requestText) {
        const handled = await this.handleNeedFields(from, state, text);
        if (handled) return;
      }
      if (state.step === "choose" && state.pending) {
        const handled = await this.handleChoice(from, state, text);
        if (handled) return;
      }
      if (state.step === "review_quote" || state.step === "need_email") {
        // number / name / file names of the quote already presented
        const num = parseNumberCommand(text);
        if (num) return this.renumberQuote(from, state, num);
        const name = parseNameCommand(text);
        if (name) return this.renumberQuote(from, state, name);
        const files = parseFileCommand(text);
        if (files) return this.renameFiles(from, state, files);
      }
      if (state.step === "review_quote") {
        if (["enviar", "send", "ok", "si", "sí", "dale", "listo"].includes(cmd)) return this.sendQuote(from, state);
        const mail = text.match(/^(?:correo|email|mail|enviar a)\s*:?\s*(\S+@\S+)/i);
        if (mail) return this.rebuildQuote(from, state, { email: mail[1] });
        const price = text.match(/^(?:precio|price|unitario)\s*:?\s+(?:(\d{1,2})\s+)?([\d.,]+)\s*$/i);
        if (price) return this.rebuildQuote(from, state, { lineIndex: price[1] ? parseInt(price[1], 10) - 1 : 0, unitPrice: parseFloat(price[2].replace(",", ".")) });
        // a contract quote skips the options step: quantities and lines are corrected here
        const qty = text.match(/^(?:cantidad|cant|qty)\s+(\d{1,2})\s+(\d{1,4})\s*$/i);
        if (qty) return this.rebuildQuote(from, state, { lineIndex: parseInt(qty[1], 10) - 1, quantity: parseInt(qty[2], 10) });
        const remove = text.match(/^(?:quitar|quita|eliminar)\s+(\d{1,2})\s*$/i);
        if (remove) return this.rebuildQuote(from, state, { lineIndex: parseInt(remove[1], 10) - 1, remove: true });
        if (/^(con|sin)\s+igv$/.test(cmd)) return this.rebuildQuote(from, state, { pricesIncludeTax: cmd.startsWith("con") });
        const app = text.match(/^(?:aplicaci[oó]n|aplic|app|uso)\s+(\d{1,2})\s+(\S.*)$/i);
        if (app) return this.rebuildQuote(from, state, { lineIndex: parseInt(app[1], 10) - 1, application: app[2].trim().toUpperCase() });
        const terms = termLines(text);
        if (terms) return this.rebuildQuote(from, state, { extraText: terms.join("\n") });
        if (TERM_LINE.test(text.split("\n")[0].trim())) return this.rebuildQuote(from, state, { extraText: text });
      }
      if (state.step === "need_email") {
        const email = parseEmail(text);
        if (email) return this.rebuildQuote(from, state, { email });
        if (["enviar", "send", "ok", "si", "sí", "dale", "listo"].includes(cmd)) return this.reply(from, "Me falta el correo del cliente: escríbelo (p.ej. *compras@empresa.com*) o *cancelar*.");
      }
      // items sent as messages of their own ("2 v99", then "4 v89"): contract lines go into the quote just presented
      if ((state.step === "review_quote" || state.step === "need_email") && (await this.addToQuote(from, state, text))) return;
      if (!text) return this.reply(from, "No entendí el mensaje. Escribe *ayuda* para ver cómo funciona.");
      return this.startRequest(from, text, undefined, { profile: profileNext?.profile, header: profileNext?.header });
    } catch (err) {
      this.log(`error handling ${msg.id}: ${(err as Error).stack ?? err}`);
      await this.reply(from, `Ocurrió un error: ${(err as Error).message}. Intenta de nuevo o escribe *cancelar*.`);
    }
  }

  private async reply(to: string, body: string): Promise<void> {
    await this.client.sendText(to, body);
  }

  // ---------- price list ingestion ----------

  /** A forwarded photo/screenshot with a caption that reads like a customer request is a request, not a price list. */
  private async mediaIsCustomerRequest(msg: InboundMessage): Promise<boolean> {
    const caption = msg.media?.caption ?? "";
    if (!caption) return false;
    return looksLikeRequest(caption) && !/\b(lista|precios? de hoy|proveedor)\b/i.test(caption);
  }

  private async startRequestFromMedia(from: string, msg: InboundMessage): Promise<void> {
    const caption = msg.media?.caption ?? "";
    if (!llmAvailable()) {
      return this.startRequest(from, caption, "(No puedo leer la imagen sin el LLM configurado; usé solo el texto.)");
    }
    const { data, mimeType } = await this.client.downloadMedia(msg.media!.id);
    const mt = (mimeType || msg.media!.mimeType).toLowerCase();
    const block = mt.includes("pdf")
      ? ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") } } as const)
      : ({ type: "image", source: { type: "base64", media_type: mt as "image/jpeg", data: data.toString("base64") } } as const);
    const llm = await parseRequestWithLLM(caption, [block]);
    const extra = (llm?.lines ?? [])
      .map((l) => [l.quantity ? `${l.quantity}` : "", l.brand ?? "", l.size ?? "", l.model ?? "", l.description ?? ""].filter(Boolean).join(" "))
      .filter(Boolean)
      .join("\n");
    return this.startRequest(from, [caption, extra].filter(Boolean).join("\n"));
  }

  /**
   * Providers a list can be loaded for: the ones in the store and the ones in config/providers.json (with their
   * aliases). New providers are only created by an admin ("proveedor nuevo: NOMBRE"), never from free text.
   */
  private async knownProviders(): Promise<{ name: string; aliases: string[] }[]> {
    const out: { name: string; aliases: string[] }[] = [];
    const add = (name: string | undefined, aliases: string[] = []) => {
      if (!name?.trim()) return;
      const hit = out.find((p) => foldKey(p.name) === foldKey(name));
      if (hit) hit.aliases.push(...aliases);
      else out.push({ name, aliases: [...aliases] });
    };
    for (const p of await this.store.providers()) add(p.provider);
    const cfg = loadProvidersConfig();
    for (const [name, d] of Object.entries(cfg.providers ?? {})) add(name, d.aliases ?? []);
    for (const s of cfg.sources ?? []) add(s.provider);
    return out;
  }

  private static matchProvider(known: { name: string; aliases: string[] }[], text: string): string | undefined {
    const k = foldKey(text);
    return k ? known.find((p) => [p.name, ...p.aliases].some((n) => foldKey(n) === k))?.name : undefined;
  }

  private askProvider(known: { name: string }[], from: string, prefix = ""): string {
    const names = known.map((p) => p.name).join(", ");
    return `${prefix}*¿De qué proveedor es?* Responde con uno de estos: ${names || "—"}${isAdmin(from) ? " (o *proveedor nuevo: Nombre*)" : ""} — o *cancelar*.`;
  }

  private onlyAdminAddsProviders(known: { name: string }[]): string {
    return `Solo el administrador puede registrar proveedores nuevos. Responde con uno conocido (${known.map((p) => p.name).join(", ")}) o *cancelar*.`;
  }

  /** Our names and RUC: a quotation addressed to us is a provider's offer, not one of our quotes. */
  private ownNames(): string[] {
    const c = this.settings.company;
    return [c.name, c.tradeName, c.signatureName, c.taxId.replace(/\D/g, "")].filter(Boolean);
  }

  private async startIngest(from: string, state: ConversationState, pending: { text?: string; media?: InboundMessage["media"]; caption?: string }): Promise<void> {
    // a quote (ours, or the customer's quote format) is never a price list: refused before asking anything
    let file: { data: Buffer; mimeType: string; fileName?: string } | undefined;
    const m = pending.media;
    if (m && (/pdf|spreadsheet|excel|html/i.test(m.mimeType) || /\.(pdf|xlsx?)$/i.test(m.fileName ?? ""))) {
      file = await this.client.downloadMedia(m.id);
      if (await detectQuoteDocument(file.data, { fileName: file.fileName ?? m.fileName, mimeType: file.mimeType || m.mimeType, ownNames: this.ownNames() })) return this.reply(from, QUOTE_FILE_REFUSAL);
    }
    const source = pending.text ?? pending.caption ?? "";
    const known = await this.knownProviders();
    // "proveedor: J.CH. Comercial, precios de hoy" -> "J.CH" (the name ends at a comma, a line end or a sentence end)
    const nameAfter = (re: RegExp) => source.match(re)?.[1].split(/\.\s/)[0].replace(/\.+$/, "").trim() || undefined;
    const nuevo = nameAfter(/proveedor\s+nuevo\s*:\s*([^\n,;]+)/i);
    const explicit = nameAfter(/proveedor\s*:\s*([^\n,;]+)/i);
    const mentioned = known.find((p) => source && fold(source).includes(fold(p.name)))?.name;
    const fromFile = m?.fileName ? resolveSourceOptions(m.fileName).provider : undefined;
    const next: ConversationState = { ...state, step: "need_provider", pendingPriceText: pending.text, pendingMedia: m ? { id: m.id, mimeType: m.mimeType, fileName: m.fileName } : undefined, updatedAt: now() };
    if (nuevo) {
      if (isAdmin(from)) return this.finishIngest(from, next, nuevo, file);
      await this.store.setConversation(from, next);
      return this.reply(from, this.onlyAdminAddsProviders(known));
    }
    const providerName = (explicit ? BotHandler.matchProvider(known, explicit) : undefined) ?? mentioned ?? fromFile;
    if (providerName) return this.finishIngest(from, next, providerName, file);
    await this.store.setConversation(from, next);
    await this.reply(from, this.askProvider(known, from, explicit ? `No conozco el proveedor *${explicit}*. Recibí una lista de precios. ` : "Recibí una lista de precios. "));
  }

  /** The answer to "¿De qué proveedor es?": a known provider (name or alias), or "proveedor nuevo: X" from an admin. */
  private async answerProvider(from: string, state: ConversationState, text: string): Promise<void> {
    // another price list instead of an answer: it replaces the pending one (same rules)
    if (looksLikePriceMessage(text)) return this.startIngest(from, state, { text });
    const known = await this.knownProviders();
    const nuevo = text.match(/^proveedor\s+nuevo\s*:?\s*(\S.*)$/i);
    if (nuevo) {
      if (!isAdmin(from)) return this.reply(from, this.onlyAdminAddsProviders(known));
      return this.finishIngest(from, state, nuevo[1].trim());
    }
    const hit = BotHandler.matchProvider(known, text.replace(/^proveedor\s*:\s*/i, ""));
    if (hit) return this.finishIngest(from, state, hit);
    await this.reply(from, this.askProvider(known, from, "No conozco ese proveedor. "));
  }

  private async finishIngest(from: string, state: ConversationState, providerName: string, prefetched?: { data: Buffer; mimeType: string; fileName?: string }): Promise<void> {
    const provider = providerName.trim().replace(/^proveedor\s*:\s*/i, "");
    if (!provider) return this.reply(from, "Necesito el nombre del proveedor.");
    const providers = await this.store.providers();
    const canonical = providers.find((p) => fold(p.provider) === fold(provider))?.provider ?? provider;
    let result: IngestResult | null = null;
    const sourceRef = `wa-${Date.now()}`;

    if (state.pendingMedia) {
      const { data, mimeType, fileName } = prefetched ?? (await this.client.downloadMedia(state.pendingMedia.id));
      const name = fileName ?? state.pendingMedia.fileName ?? "";
      const mt = (mimeType || state.pendingMedia.mimeType || "").toLowerCase();
      const cfg = resolveSourceOptions(name, canonical);
      const common = { ...cfg, provider: canonical, sourceRef: name || sourceRef };
      if (mt.includes("spreadsheet") || mt.includes("excel") || mt.includes("html") || /\.xlsx?$/i.test(name)) result = await ingestExcel(data, common);
      else if (mt.includes("csv") || /\.csv$/i.test(name)) result = ingestCsv(data.toString("utf8"), common);
      else if (mt.includes("pdf") || /\.pdf$/i.test(name)) result = await ingestPdf(data, common);
      else if (mt.startsWith("image/")) {
        if (!llmAvailable()) {
          await this.store.setConversation(from, null);
          return this.reply(from, "Para leer fotos de listas necesito el LLM configurado (ANTHROPIC_API_KEY). Por ahora envíame el texto, PDF o Excel.");
        }
        const r = await extractPricesWithLLM({ image: { data, mediaType: mt as "image/jpeg" } }, { ...common, source: "whatsapp" });
        result = { rows: r.rows, warnings: r.warnings, stats: { source: "whatsapp", sourceRef: common.sourceRef, provider: canonical, rowsSeen: r.rowsSeen, rowsParsed: r.rows.length, rowsSkipped: 0, method: "llm-image" } };
      } else {
        await this.store.setConversation(from, null);
        return this.reply(from, `No sé leer archivos ${mt || name}. Envíame PDF, Excel, CSV o una foto.`);
      }
    } else if (state.pendingPriceText) {
      const cfg = resolveSourceOptions("", canonical);
      result = await ingestWhatsAppText(state.pendingPriceText, { ...cfg, provider: canonical, sourceRef });
    }

    await this.store.setConversation(from, null);
    if (!result || result.rows.length === 0) {
      const why = result?.warnings.length ? `\n${result.warnings.map((w) => `• ${w}`).join("\n")}` : "";
      return this.reply(from, `No pude sacar precios de esa lista 😕${why}\nSi es una foto o un PDF escaneado, prueba con el Excel o el texto.`);
    }
    const kind = result.rows[0].kind;
    await this.store.upsertRows(result.rows, state.pendingMedia?.fileName ? { replace: { provider: canonical, sourceRef: state.pendingMedia.fileName, kind } } : undefined);
    const preview = result.rows
      .slice(0, 8)
      .map((r) => `• ${[r.brand, r.model].filter(Boolean).join(" ")} ${r.sizeDisplay || r.description.slice(0, 30)}${r.cost !== null ? ` → ${fmtMoney(r.cost, r.currency)}` : ""}${r.stock !== null ? ` (stock ${r.stock})` : ""}`)
      .join("\n");
    const more = result.rows.length > 8 ? `\n… y ${result.rows.length - 8} más` : "";
    const warn = result.warnings.length ? `\n⚠️ ${result.warnings[0]}` : "";
    const what = kind === "stock" ? "stock" : kind === "own" ? "precios de lista" : "precios";
    await this.reply(from, `Guardé *${result.rows.length} ${what}* de *${canonical}*:\n${preview}${more}${warn}`);
  }

  // ---------- quote flow ----------

  private optionLine(letter: string, c: Candidate): string {
    const r = c.row;
    const name = [r.brand, r.model].filter(Boolean).join(" ") || r.description.slice(0, 40);
    const size = r.sizeDisplay ? ` ${r.sizeDisplay}${r.ply ? ` ${r.ply}PR` : ""}` : "";
    const stock = c.available === null ? "" : c.available === 0 ? " · sin stock" : ` · stock ${c.available}`;
    let price: string;
    if (r.kind === "own") {
      const disc = c.discountPct > 0 ? ` (lista ${fmtMoney(c.listNet!, this.cur)} −${c.discountPct}%)` : ` (lista${c.row.maxDiscountPct !== undefined ? `, máx. dscto ${c.row.maxDiscountPct}%` : ""})`;
      price = `*${fmtMoney(c.unitNet, this.cur)}*${disc}`;
    } else {
      price = `*${fmtMoney(c.unitNet, this.cur)}* (costo ${fmtMoney(c.costNet!, this.cur)} ${r.provider}, ${fmtDateShort(r.priceDate)})`;
    }
    const tag = `${r.kind === "own" ? "🏭 STOCK" : `🚚 ${r.provider}`}${r.photoUrl ? " 📷" : ""}`;
    const notes = c.reasons.filter((x) => !/^(sin stock|solo \d+ en stock)$/.test(x)).join(", ");
    return `  *${letter})* ${tag}${stock} · ${name}${size}\n      ${price}${notes ? `\n      ⚠️ ${notes}` : ""}`;
  }

  private renderOptions(req: QuoteRequest, lcs: LineCandidates[], pending: PendingLine[]): string {
    const blocks = lcs.map((lc, i) => {
      const p = pending[i];
      const head = `*${i + 1}.* ${describeLine(p.application ? { ...lc.line, application: p.application } : lc.line)}${p.removed ? " _(quitado)_" : ""}`;
      if (p.removed) return head;
      if (lc.line.contract) {
        // the customer's contract price: nothing to choose
        const price = p.unitPriceOverride !== undefined ? `precio manual ${fmtMoney(p.unitPriceOverride, this.cur)}` : fmtMoney(contractUnitPrice(lc.line.contract, this.settings.pricing), this.cur);
        return `${head}\n  📑 contrato · ${price}`;
      }
      if (lc.candidates.length === 0) {
        const manual = p.unitPriceOverride !== undefined ? `precio manual ${fmtMoney(p.unitPriceOverride, this.cur)}` : `sin precio en las listas → escribe *precio ${i + 1} 123.45* o *quitar ${i + 1}*`;
        return `${head}\n  ❌ ${manual}`;
      }
      const opts = lc.candidates.map((c, j) => this.optionLine(LETTERS[j], c)).join("\n");
      const chosen = p.chosen !== null ? ` → elegido *${LETTERS[p.chosen]}*${p.extra?.length ? ` ×${p.quantity}, ${p.extra.map((x) => `*${LETTERS[x.chosen]}* ×${x.quantity}`).join(", ")}` : ""}` : "";
      return `${head}${chosen}\n${opts}`;
    });
    const extras = [req.customerCompany ?? req.customerName ?? "", req.customerEmail ?? "", req.discountPct !== undefined ? `dscto ${req.discountPct}%` : "", req.marginPct !== undefined ? `margen ${req.marginPct}%` : "", req.showPricesWithTax === true ? "con IGV" : req.showPricesWithTax === false ? "sin IGV" : ""].filter(Boolean);
    const unparsed = this.unparsedOf(req);
    return `${blocks.join("\n\n")}${extras.length ? `\n\n${extras.join(" · ")}` : ""}${unparsed.length ? `\n\n${unparsedWarning(unparsed)}` : ""}\n\nResponde *ok* para cotizar con las opciones *a*, o elige: *1b* (ítem 1, opción b), *b x4* (opción b, 4 unidades), *a x2, b x8* (dos opciones del mismo ítem). También: *quitar 2*, *precio 3 4.50*, *aplicación 2 MIXT DEL*, *dscto 15*, *margen 10*, *con igv*, *cancelar*.`;
  }

  /** The request's segments the parser did not understand, without those naming a customer profile ("coti para prosegur"). */
  private unparsedOf(req: QuoteRequest): string[] {
    return (req.unparsed ?? []).filter((seg) => !detectProfile(this.settings, seg, { raw: seg, lines: [], parsedBy: "regex" }));
  }

  private async startRequest(from: string, text: string, note?: string, opts: { profile?: string; header?: string } = {}): Promise<void> {
    // customer profile (Prosegur…): the message starts with its alias, says "para prosegur", names it as the customer,
    // or the salesman asked for it with a bare "prosegur" (or "prosegur ayacucho 1830") just before
    let profile = findProfile(this.settings, opts.profile) ?? detectProfile(this.settings, text, parseRequestRegex(text)) ?? undefined;
    let contract = await this.contractFor(profile);
    if (profile) {
      const applied = this.applyProfile(text, profile, contract, opts.header);
      if (applied.bare) {
        // "prosegur": the guide; "prosegur ayacucho 1830": its unit / UB wait for the items
        await this.store.setConversation(from, { phone: from, step: "idle", profile: profileId(profile), requestText: applied.header.join("\n") || undefined, updatedAt: now() });
        if (!applied.header.length) return this.reply(from, profileGuide(profile, contract?.items.map((i) => i.id)));
        const ids = contract?.items.map((i) => i.id) ?? [];
        const example = ids.length ? `*2 ${ids[0]}*${ids[1] ? `, *4 ${ids[1]}*` : ""}` : "_215/75R17.5 Fenixway Valor 99 x2_";
        return this.reply(from, `${profileHead(profile, parseRequestRegex(applied.text))}\nAhora las llantas, una por línea: ${example}`);
      }
      text = applied.text;
    }
    let req = await this.parseFor(text, contract);
    if (!profile) {
      // a customer only the LLM recognised
      const late = detectProfile(this.settings, text, req);
      if (late) {
        profile = late;
        contract = await this.contractFor(late);
        text = this.applyProfile(text, late, contract).text;
        req = await this.parseFor(text, contract);
      }
    }
    if (req.lines.length === 0) {
      // contract codes without the customer ("2 v99" with no "prosegur …" first): how to start, rather than guess the unit
      for (const p of profile ? [] : this.settings.customers) {
        if (this.moreContractLines(await this.contractFor(p), text)) return this.reply(from, `¿Es para ${p.name}? Escribe primero el cliente y la unidad, p.ej. *${profileKey(p)} ayacucho 1830*, y debajo las llantas (*${text.trim().split(/\r?\n/)[0]}*).`);
      }
      return this.reply(from, `${note ? note + "\n" : ""}No encontré ninguna medida ni producto en el pedido. Escríbela como *11R22.5*, *295/80R22.5* o *1000R20*.\nEjemplo: _Fenixway 295/80R22.5 Valor 87 x4 para Transportes ABC, juan@abc.com_`);
    }
    // customer memory: reuse contact / address / terms from the last quote to the same customer (per unit for a profile)
    const remembered = await this.rememberCustomer(req, profile);
    if (remembered.lines.length) {
      text = `${text}\n${remembered.lines.join("\n")}`;
      req = await this.parseFor(text, contract);
      note = `${note ? note + "\n" : ""}📒 Datos de la última cotización a ${remembered.who}: ${remembered.summary.join(" · ")} _(cámbialos con *atención: …*, *pago: …*, *dirección: …*${profile?.required.length ? `, ${profile.required.map((f) => `*${FIELD_LABEL[f]}: …*`).join(", ")}` : ""})_`;
    }
    return this.showOptions(from, text, req, profile, { note });
  }

  /**
   * The request without the profile's leading alias, its header's unit / UB as lines ("prosegur ayacucho 1830"), plus
   * the profile's lines for the fields the salesman did not write.
   */
  private applyProfile(text: string, profile: CustomerProfile, contract: Contract | null, pending?: string): { text: string; bare: boolean; header: string[] } {
    return profileRequestText(this.settings, profile, text, { pending, startsItem: contract?.items.length ? (rest) => startsWithContractAlias(rest, contract.items) : undefined });
  }

  /** The profile's effective contract: config/customers.json with the contract_prices rows applied (null: none). */
  private async contractFor(profile: CustomerProfile | undefined): Promise<Contract | null> {
    return profile ? resolveContract(profile, await this.store.getContractItems(profileId(profile))) : null;
  }

  /** The request parsed for its customer: with a contract, "2 v99" lines are contract items. */
  private parseFor(text: string, contract: Contract | null): Promise<QuoteRequest> {
    return contract?.items.length ? parseContractRequest(text, contract.items) : parseRequest(text);
  }

  /**
   * More items in the middle of a quote ("4 v89"): a message made only of contract lines, with a digit, so a bare
   * "post" or "mixta" (an APLICACIÓN, a name) is never taken for an item. Null for anything else.
   */
  private moreContractLines(contract: Contract | null, text: string): RequestLine[] | null {
    return contract?.items.length && /\d/.test(text) && !leadingProfile(this.settings, text) ? onlyContractLines(text, contract.items) : null;
  }

  /** The same, without the LLM (to check what is still missing). */
  private parseForRegex(text: string, contract: Contract | null): QuoteRequest {
    return contract?.items.length ? parseContractRequestRegex(text, contract.items) : parseRequestRegex(text);
  }

  /** "Prosegur · Ayacucho · UB 1830" and one line per item with its contract price: the short form of a contract request. */
  private contractSummary(profile: CustomerProfile, req: QuoteRequest): string {
    const lines = req.lines.map((l, i) => {
      const label = shortItemLabel({ size: l.size?.canonical ?? "", sizeDisplay: l.size?.display ?? "", ply: l.ply, brand: l.brand ?? "", model: l.model ?? "", description: l.text ?? l.raw, application: l.application, plate: l.plate, ub: l.ub, quantity: l.quantity }, req.ub);
      return `${i + 1}. ${label}${l.contract ? ` · ${fmtMoney(contractUnitPrice(l.contract, this.settings.pricing), this.cur)}` : ""}`;
    });
    return [profileHead(profile, req), ...lines].join("\n");
  }

  /** Price-list candidates of every line; a contract line has none (its price is the contract's). */
  private async lineCandidates(req: QuoteRequest, limit?: number): Promise<LineCandidates[]> {
    const lcs = await findCandidates(this.store, req, this.settings.pricing, limit ? { limit } : {});
    return lcs.map((lc) => (lc.line.contract ? { ...lc, candidates: [] } : lc));
  }

  /**
   * The profile's required fields first (unidad, ub, solicitante), then the options of every line. A request made only
   * of contract items has nothing to choose: the quote is built right away.
   */
  private async showOptions(from: string, text: string, req: QuoteRequest, profile: CustomerProfile | undefined, opts: { note?: string; skipRequired?: boolean } = {}): Promise<void> {
    const allContract = req.lines.length > 0 && req.lines.every((l) => l.contract);
    // the short contract texts leave out the memory note: the summary shows what was reused (correo, solicitante)
    const note = opts.note && !allContract ? `${opts.note}\n` : "";
    const id = profile ? profileId(profile) : undefined;
    const missingFields = profile && !opts.skipRequired ? missingRequired(profile, req) : [];
    if (profile && missingFields.length) {
      await this.store.setConversation(from, { phone: from, step: "need_fields", requestText: text, profile: id, updatedAt: now() });
      const unparsed = this.unparsedOf(req);
      const understood = `${allContract ? this.contractSummary(profile, req) : `Entendí:\n${describeRequest(req)}\n`}${unparsed.length ? `\n${unparsedWarning(unparsed)}\n` : ""}`;
      return this.reply(from, `${note}${understood}\n${askRequired(profile, missingFields)}`);
    }
    const lcs = await this.lineCandidates(req);
    const pending: PendingLine[] = lcs.map((lc) => ({ candidateIds: lc.candidates.map((c) => c.row.id), chosen: lc.candidates.length ? 0 : null, quantity: lc.line.quantity }));
    const state: ConversationState = { phone: from, step: "choose", requestText: text, pending, profile: id, updatedAt: now() };
    await this.store.setConversation(from, state);
    if (allContract) {
      await this.finishChoice(from, state);
      return;
    }
    const missing = lcs.filter((lc) => !lc.line.contract && lc.candidates.length === 0).length;
    const intro = `${note}Entendí:\n${describeRequest(req)}\n${missing ? `\n⚠️ ${missing} ítem(s) sin precio en las listas.\n` : ""}`;
    await this.reply(from, `${intro}\n${this.renderOptions(req, lcs, pending)}`);
  }

  /**
   * Waiting for a profile's required fields: field lines are added to the request; "ok" goes on without them. When only
   * one field is missing, a bare answer is that field ("Johann Castañeda" for the solicitante, "Ayacucho", "1830").
   */
  private async handleNeedFields(from: string, state: ConversationState, text: string): Promise<boolean> {
    const profile = findProfile(this.settings, state.profile);
    if (!profile) return false;
    const contract = await this.contractFor(profile);
    const cmd = norm(text);
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // more items may come with the answer or instead of it ("4 v89"): they are added to the request
    const itemLine = (l: string) => !!this.moreContractLines(contract, l);
    let fieldLines = lines.length > 0 && lines.every((l) => TERM_LINE.test(l) || parseNumberCommand(l) || /^(?:correo|email|mail)\s*:?\s*\S+@\S+$/i.test(l) || itemLine(l));
    let requestText = state.requestText ?? "";
    if (fieldLines) {
      for (const l of lines) {
        const term = l.match(TERM_LINE);
        const mail = l.match(/^(?:correo|email|mail)\s*:?\s*(\S+@\S+)$/i);
        if (term) requestText += `\n${term[1]}: ${term[2].trim()}`;
        else if (mail) requestText = `${requestText.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, " ")}\ncorreo ${mail[1]}`;
        else requestText += `\n${l}`; // número 451, or more items
      }
    } else if (!["ok", "seguir", "continuar", "listo", "si", "sí", "dale"].includes(cmd)) {
      if (findTyreSizes(text).length > 0 || leadingProfile(this.settings, text)) return false; // a new request
      const missing = missingRequired(profile, this.parseForRegex(requestText, contract));
      const value = text.trim();
      const only = missing.length === 1 ? missing[0] : undefined;
      const bare = !!only && lines.length === 1 && !COMMAND_WORD.test(cmd) && (only === "ub" ? /^\d{3,5}$/.test(value) : /^[\p{L}][\p{L} .'-]{1,59}$/u.test(value));
      if (!bare) {
        await this.reply(from, askRequired(profile, missing));
        return true;
      }
      requestText += `\n${FIELD_KEY[only!]}: ${value}`;
      fieldLines = true;
    }
    const req = await this.parseFor(requestText, contract);
    await this.showOptions(from, requestText, req, profile, { skipRequired: !fieldLines });
    return true;
  }

  /**
   * The answer to "¿Qué aplicación lleva la Flama 77?": saved on the contract item (never asked again), then the quote
   * is built, or the items waiting in `addText` go into the quote already presented. "ok" goes on without it (asked
   * again next time); more contract lines ("4 v89") join the others and the question stands. Returns false when the
   * text is something else (a new request).
   */
  private async handleApplicationAnswer(from: string, state: ConversationState, text: string): Promise<boolean> {
    const profile = findProfile(this.settings, state.profile);
    const contract = await this.contractFor(profile);
    const item = contract?.items.find((i) => i.id === state.askItem);
    if (!profile || !contract || !item) return false;
    const asked = [...(state.applicationAsked ?? []), item.id];
    const goOn = async (): Promise<void> => {
      if (state.addText === undefined) {
        await this.finishChoice(from, { ...state, step: "choose", askItem: undefined, applicationAsked: asked, updatedAt: now() });
        return;
      }
      const back: ConversationState = { phone: from, step: "review_quote", quoteNumber: state.quoteNumber, applicationAsked: asked, updatedAt: now() };
      if (!(await this.addToQuote(from, back, state.addText))) await this.reply(from, "No encuentro la cotización; escribe el pedido de nuevo.");
    };
    const cmd = norm(text);
    if (["ok", "no se", "no", "ninguna", "ninguno", "sin aplicacion", "seguir"].includes(cmd)) {
      await goOn();
      return true;
    }
    if (leadingProfile(this.settings, text)) return false; // a new request
    if (this.moreContractLines(contract, text)) {
      if (state.addText !== undefined) {
        await this.store.setConversation(from, { ...state, addText: `${state.addText}\n${text}`, updatedAt: now() });
        await this.reply(from, askApplication(item.model || item.id));
      } else {
        const requestText = `${state.requestText ?? ""}\n${text}`;
        await this.showOptions(from, requestText, await this.parseFor(requestText, contract), profile, { skipRequired: true });
      }
      return true;
    }
    if (text.includes("\n") || findTyreSizes(text).length > 0) return false; // a new request
    const answer = text.trim().replace(/^(?:aplicaci[oó]n|aplic|app|uso)\s*:?\s*/i, "").trim();
    if (COMMAND_WORD.test(norm(answer)) || !/^[\p{L}][\p{L}\s/.-]{0,29}$/u.test(answer)) {
      await this.reply(from, `${askApplication(item.model || item.id)} — o *ok* para seguir sin ella.`);
      return true;
    }
    const application = answer.toUpperCase().replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ");
    await this.saveContractChange(profile, item.id, { application }, from);
    await this.reply(from, `✅ ${item.model || item.id}: aplicación *${application}*, guardada para las próximas cotizaciones.`);
    await goOn();
    return true;
  }

  /** "ok", "1b 2a", "quitar 2", "precio 3 4.50", "dscto 15", "margen 10", "con igv", "2" (single line). Returns false when the text is a new request. */
  private async handleChoice(from: string, state: ConversationState, text: string): Promise<boolean> {
    const cmd = norm(text);
    const pending = state.pending!;
    let requestText = state.requestText ?? "";
    let touched = false;

    if (["ok", "si", "sí", "dale", "listo", "cotizar", "confirmar"].includes(cmd)) return this.finishChoice(from, state);

    // number / name / file names of the quote about to be built
    const num = parseNumberCommand(text);
    if (num) return this.setNumbering(from, state, num);
    const name = parseNameCommand(text);
    if (name) return this.setNumbering(from, state, name);
    const files = parseFileCommand(text);
    if (files) {
      if (files.xlsxName && !hasExcelFormat(findProfile(this.settings, state.profile))) {
        await this.reply(from, "Esta cotización no lleva Excel; *archivo: Nombre* cambia el nombre del PDF.");
        return true;
      }
      await this.store.setConversation(from, { ...state, files: { ...state.files, ...files }, updatedAt: now() });
      await this.reply(from, files.xlsxName ? `📎 El Excel se llamará *${withExtension(files.xlsxName, ".xlsx")}*.` : `📎 El PDF se llamará *${withExtension(files.pdfName ?? "", ".pdf")}*.`);
      return true;
    }

    const picks = parsePicks(text, pending.length);
    if (picks) {
      const seen = new Set<number>();
      for (const p of picks) {
        if (p.line < 0 || p.line >= pending.length) {
          await this.reply(from, pending.length === 1 ? `Solo hay 1 ítem: responde con la letra de la opción (*a*, *b*, *c*…) o *ok*.` : `No existe el ítem ${p.line + 1}; hay ${pending.length}.`);
          return true;
        }
        if (p.option < 0 || p.option >= pending[p.line].candidateIds.length) {
          await this.reply(from, `El ítem ${p.line + 1} no tiene opción *${LETTERS[p.option] ?? "?"}*.`);
          return true;
        }
        const pl = pending[p.line];
        if (!seen.has(p.line)) {
          // first pick for the line: the choice itself
          seen.add(p.line);
          pl.chosen = p.option;
          pl.removed = false;
          pl.extra = [];
          if (p.quantity) pl.quantity = p.quantity;
        } else {
          // another option of the same line ("opción a x2, opción b x8") → an extra item
          pl.extra!.push({ chosen: p.option, quantity: p.quantity ?? pl.quantity });
        }
        touched = true;
      }
      if (touched) return this.finishChoice(from, { ...state, pending });
    }
    const lineRef = text.match(/^(?:quitar|quita|eliminar|sin|precio|price|cantidad|cant|qty)\s+(\d{1,2})\b/i);
    if (lineRef && !pending[parseInt(lineRef[1], 10) - 1]) {
      await this.reply(from, `No existe el ítem ${lineRef[1]}; hay ${pending.length}.`);
      return true;
    }
    const remove = text.match(/^(?:quitar|quita|eliminar|sin)\s+(\d{1,2})/i);
    if (remove) {
      const li = parseInt(remove[1], 10) - 1;
      if (pending[li]) {
        pending[li].removed = true;
        return this.reshow(from, { ...state, pending }, requestText);
      }
    }
    const price = text.match(/^(?:precio|price)\s+(\d{1,2})\s+([\d.,]+)/i);
    if (price) {
      const li = parseInt(price[1], 10) - 1;
      if (pending[li]) {
        pending[li].unitPriceOverride = parseFloat(price[2].replace(",", "."));
        pending[li].removed = false;
        return this.reshow(from, { ...state, pending }, requestText);
      }
    }
    const app = text.match(/^(?:aplicaci[oó]n|aplic|app|uso)\s+(\d{1,2})\s+(\S.*)$/i);
    if (app) {
      const li = parseInt(app[1], 10) - 1;
      if (!pending[li]) {
        await this.reply(from, `No existe el ítem ${app[1]}; hay ${pending.length}.`);
        return true;
      }
      pending[li].application = app[2].trim().toUpperCase();
      return this.reshow(from, { ...state, pending }, requestText);
    }
    const qty = text.match(/^(?:cantidad|cant|qty)\s+(\d{1,2})\s+(\d{1,4})/i);
    if (qty) {
      const li = parseInt(qty[1], 10) - 1;
      if (pending[li]) {
        pending[li].quantity = parseInt(qty[2], 10);
        return this.reshow(from, { ...state, pending }, requestText);
      }
    }
    const disc = text.match(/^(?:dscto|dcto|descuento|desc)\s*:?\s*(\d{1,2}(?:[.,]\d)?)\s*%?$/i);
    if (disc) {
      requestText = `${requestText.replace(/\b(?:dscto|dcto|descuento|desc)\.?\s*:?\s*\d{1,2}(?:[.,]\d)?\s*%?/gi, " ")}\ndscto ${disc[1]}%`;
      return this.reshow(from, { ...state, requestText }, requestText);
    }
    const margin = text.match(/^(?:margen|mg)\s*:?\s*(?:de\s+)?(\d{1,2}(?:[.,]\d)?)\s*%?$/i);
    if (margin) {
      requestText = `${stripMargin(requestText)}\nmargen ${margin[1]}%`;
      return this.reshow(from, { ...state, requestText }, requestText);
    }
    if (/^(con|sin)\s+igv$/.test(cmd)) {
      requestText = `${requestText.replace(/\b(con|sin)\s+igv\b/gi, " ")}\n${cmd}`;
      return this.reshow(from, { ...state, requestText }, requestText);
    }
    const mail = text.match(/^(?:correo|email|mail)\s*:?\s*(\S+@\S+)/i);
    if (mail) {
      requestText = `${requestText.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, " ")}\ncorreo ${mail[1]}`;
      return this.reshow(from, { ...state, requestText }, requestText);
    }
    const terms = termLines(text);
    if (terms) {
      requestText = `${requestText}\n${terms.join("\n")}`;
      return this.reshow(from, { ...state, requestText }, requestText);
    }
    return false; // not a choice: treat as a new request
  }

  /** "número 451" / "nombre: …" while choosing: used when the quote is built; a number already taken asks first. */
  private async setNumbering(from: string, state: ConversationState, target: { counter?: number; name?: string; confirmed: boolean }): Promise<boolean> {
    const today = new Date().toISOString().slice(0, 10);
    const number = target.name ?? formatQuoteNumber(this.settings.quote.numberFormat, target.counter!, today);
    const prev = state.numbering;
    const same = !!prev && (prev.name ?? prev.counter) === (target.name ?? target.counter);
    const numbering = { counter: target.counter, name: target.name, confirmed: target.confirmed };
    if (target.confirmed && same && prev?.asked) return this.finishChoice(from, { ...state, numbering }); // "ok" was already given
    const taken = target.confirmed ? null : await this.store.getQuote(number);
    await this.store.setConversation(from, { ...state, numbering, updatedAt: now() });
    if (taken) await this.reply(from, this.numberTaken(taken, target));
    else await this.reply(from, `📄 Esta cotización será la *${number}*. Responde *ok* para armarla (o sigue eligiendo opciones).`);
    return true;
  }

  private numberTaken(q: Quote, target: { counter?: number; name?: string }): string {
    const again = target.name ? `nombre: ${target.name} confirmar` : `número ${target.counter} confirmar`;
    return `⚠️ Ya existe la cotización *${q.number}* (${STATUS_LABEL[q.status]}, ${q.customer.company || q.customer.name || "sin cliente"}, ${fmtDate(q.date)}). Responde *${again}* para usar ese número igual (reemplaza la anterior) o elige otro.`;
  }

  /** Next number of the salesman's own counter, skipping numbers already used (by another salesman, or set by hand). */
  private async nextQuoteNumber(from: string, today: string): Promise<string> {
    const key = quoteCounterKey(from);
    for (let i = 0; i < 100; i++) {
      const n = await this.store.nextQuoteCounter(this.settings.quote.counterStart, key);
      const number = formatQuoteNumber(this.settings.quote.numberFormat, n, today);
      if (!(await this.store.getQuote(number))) return number;
    }
    throw new Error("no encuentro un número de cotización libre");
  }

  /** Re-rank (discount / tax may have changed) and show the options again, keeping choices. */
  private async reshow(from: string, state: ConversationState, requestText: string): Promise<boolean> {
    const req = await this.parseFor(requestText, await this.contractFor(findProfile(this.settings, state.profile)));
    const lcs = await this.lineCandidates(req);
    const pending: PendingLine[] = lcs.map((lc, i) => {
      const prev = state.pending?.[i];
      const ids = lc.candidates.map((c) => c.row.id);
      const keep = prev?.chosen !== null && prev?.chosen !== undefined && prev.candidateIds[prev.chosen] ? ids.indexOf(prev.candidateIds[prev.chosen]) : -1;
      const extra = (prev?.extra ?? []).map((x) => ({ chosen: ids.indexOf(prev!.candidateIds[x.chosen]), quantity: x.quantity })).filter((x) => x.chosen >= 0);
      return { candidateIds: ids, chosen: keep >= 0 ? keep : ids.length ? 0 : null, quantity: prev?.quantity ?? lc.line.quantity, unitPriceOverride: prev?.unitPriceOverride, removed: prev?.removed, application: prev?.application, extra: extra.length ? extra : undefined };
    });
    await this.store.setConversation(from, { ...state, step: "choose", requestText, pending, updatedAt: now() });
    await this.reply(from, this.renderOptions(req, lcs, pending));
    return true;
  }

  private async finishChoice(from: string, state: ConversationState): Promise<boolean> {
    const profile = findProfile(this.settings, state.profile);
    const req = await this.parseFor(state.requestText ?? "", await this.contractFor(profile));
    const lcs = await this.lineCandidates(req, 50);
    // a contract item without APLICACIÓN yet ("application": null): asked once, the answer is saved for every quote
    const unknown = (state.pending ?? [])
      .map((p, i) => ({ p, line: lcs[i]?.line }))
      .find(({ p, line }) => !p.removed && !p.application && line?.contract && !line.application && !(state.applicationAsked ?? []).includes(line.contract.id));
    if (unknown?.line?.contract) {
      await this.store.setConversation(from, { ...state, step: "need_application", askItem: unknown.line.contract.id, updatedAt: now() });
      await this.reply(from, askApplication(unknown.line.model || unknown.line.contract.id));
      return true;
    }
    const items: QuoteItem[] = [];
    const unpriced: number[] = [];
    (state.pending ?? []).forEach((p, i) => {
      if (p.removed) return;
      const lc = lcs[i];
      if (!lc) return;
      const quantity = p.quantity;
      const line = p.application ? { ...lc.line, application: p.application } : lc.line; // "aplicación 2 MIXT DEL"
      if (line.contract) {
        items.push(contractQuoteItem(line, quantity, this.settings, p.unitPriceOverride));
        return;
      }
      if (p.chosen !== null && p.candidateIds[p.chosen]) {
        const cand = lc.candidates.find((c) => c.row.id === p.candidateIds[p.chosen!]);
        if (cand) {
          items.push(itemFromCandidate(cand, quantity, this.settings, p.unitPriceOverride, line));
          for (const x of p.extra ?? []) {
            const more = lc.candidates.find((c) => c.row.id === p.candidateIds[x.chosen]);
            if (more) items.push(itemFromCandidate(more, x.quantity, this.settings, undefined, line));
          }
          return;
        }
      }
      if (p.unitPriceOverride !== undefined) {
        items.push(manualItem({ ...line, quantity }, p.unitPriceOverride, undefined, this.settings));
        return;
      }
      unpriced.push(i + 1);
    });
    if (unpriced.length) {
      await this.reply(from, `Falta precio en el ítem ${unpriced.join(", ")}. Escribe *precio ${unpriced[0]} 123.45* o *quitar ${unpriced[0]}*.`);
      return true;
    }
    if (items.length === 0) {
      await this.store.setConversation(from, null);
      await this.reply(from, "No quedó ningún ítem para cotizar. Escribe el pedido de nuevo.");
      return true;
    }
    if (hasExcelFormat(profile) && items.length > PROSEGUR_MAX_ITEMS) {
      await this.reply(from, prosegurTooManyItems(items.length));
      return true;
    }
    const today = new Date().toISOString().slice(0, 10);
    // "número 451" (typed while choosing, or a line of the request) / "nombre: …"; else the salesman's next number
    const target = state.numbering ?? (req.quoteNumber ? { counter: req.quoteNumber } : undefined);
    let number: string;
    if (target?.name || target?.counter) {
      number = target.name ?? formatQuoteNumber(this.settings.quote.numberFormat, target.counter!, today);
      const taken = await this.store.getQuote(number);
      if (taken && !target.confirmed) {
        await this.store.setConversation(from, { ...state, numbering: { ...target, asked: true }, updatedAt: now() });
        await this.reply(from, this.numberTaken(taken, target));
        return true;
      }
      if (taken) await this.store.deleteQuote(number); // confirmed: the new quote replaces it (and its stored files)
      if (target.counter && !target.name) await this.store.setQuoteCounter(target.counter, quoteCounterKey(from)); // the next one is 452
    } else number = await this.nextQuoteNumber(from, today);
    const quote = buildQuote({ number, request: req, items, settings: this.settings, requestedBy: from, today, customerProfile: profile ? profileId(profile) : undefined, files: state.files });
    await this.presentQuote(from, quote);
    return true;
  }

  private async presentQuote(from: string, quote: Quote): Promise<void> {
    const profile = findProfile(this.settings, quote.customerProfile);
    quote.emailDraft = buildEmailDraft(quote, this.settings);
    await attachPhotos(quote, this.store);
    // the customer's own format first: when it cannot be filled (too many items) nothing is saved or sent
    const xlsx = hasExcelFormat(profile) ? await renderProsegurXlsx(quote, this.settings, profile) : null;
    await this.store.saveQuote(quote);
    const pdf = await renderQuotePdf(quote, this.settings, { photos: !process.env.PHOTOS_DISABLED });
    await this.deps.onPdf?.(quote, pdf);
    const summary = quote.items.length === 1 ? `${quote.items[0].description} x${quote.items[0].quantity}` : `${quote.items.length} ítems`;
    const taxNote = quote.pricesIncludeTax ? `inc. ${quote.taxLabel}` : `sin ${quote.taxLabel}`;
    const noPhoto = itemsWithoutPhoto(quote);
    const photoNote =
      quote.items.length - noPhoto.length > 0 || noPhoto.length > 0
        ? `\n📷 Fotos: ${quote.items.length - noPhoto.length}/${quote.items.length}${noPhoto.length ? ` · sin foto: ${noPhoto.map((it) => [it.brand, it.model].filter(Boolean).join(" ") || it.description).join(", ")} → mándame la imagen con el texto *foto ${[noPhoto[0].brand, noPhoto[0].model].filter(Boolean).join(" ")}*${webSearchAvailable() ? ` o escribe *foto buscar ${quote.items.indexOf(noPhoto[0]) + 1}*` : ""}` : ""}`
        : "";
    // a profile's quote keeps its texts short (the salesman found them too long): no photo hints in the caption
    await this.client.sendDocument(from, pdf, pdfFileName(quote, this.settings), `Cotización ${quote.number} · ${summary} · Total ${fmtMoney(displayTotal(quote), quote.currency)} (${taxNote})${profile ? "" : photoNote}`, PDF_MIME);
    if (xlsx && profile) await this.client.sendDocument(from, xlsx.buffer, xlsx.fileName, `Formato ${profile.name} · ${xlsx.fileName}`, XLSX_MIME);
    if (!quote.customer.email) {
      await this.store.setConversation(from, { phone: from, step: "need_email", quoteNumber: quote.number, updatedAt: now() });
      return this.reply(from, `El pedido no tiene correo del cliente. *¿A qué correo lo envío?* (o *cancelar*)`);
    }
    await this.store.setConversation(from, { phone: from, step: "review_quote", quoteNumber: quote.number, updatedAt: now() });
    const d = quote.emailDraft;
    const excelMissing = xlsx && profile ? missingInQuote(profile, quote) : [];
    if (profile) return this.reply(from, this.profileReview(quote, profile, d.to, excelMissing));
    const missing: string[] = [];
    if (!quote.customer.attention && !quote.customer.name) missing.push("*atención: Sr. Pérez*");
    if (!quote.customer.address) missing.push("*dirección: Av. … , Lima*");
    const terms = `Pago: ${quote.paymentType || "—"} · Plazo: ${quote.paymentTerm || "—"} · Entrega: ${quote.deliveryTerm || "—"} · Validez: ${quote.validityDays} días`;
    const check = [
      missing.length ? `⚠️ Falta en el PDF: ${missing.join(", ")}` : "",
      excelMissing.length ? `⚠️ Falta en el Excel: ${excelMissing.map((f) => `*${FIELD_LABEL[f]}: …*`).join(", ")}` : "",
      `📋 ${terms} _(cambia con *pago: letras*, *plazo: 45 días*, *entrega: inmediata*)_`,
      xlsx ? `📎 Al *enviar* van los dos archivos adjuntos: *${pdfFileName(quote, this.settings)}* y *${xlsx.fileName}*.` : "",
    ]
      .filter(Boolean)
      .join("\n");
    await this.reply(from, `📧 *Para:* ${d.to}\n*Asunto:* ${d.subject}\n\n${d.body}\n\n${check}\n\n—\nResponde *enviar* para mandarlo, *precio 2 480* para cambiar un unitario, *aplicación 2 POST ON/OFF* para la columna aplicación, *correo x@y.com* para cambiar el destinatario, *con igv* / *sin igv*, *número 452* o *nombre: …* para el número, *archivo: Nombre* para el nombre del PDF, *foto 1* para ver la foto de un ítem, o *cancelar*.`);
  }

  /**
   * Summary + review of a profile's quote in about six lines:
   *   Prosegur · Ayacucho · UB 1830 · solicitante Johann Castañeda
   *   1. 215/75R17.5 18PR Fenixway Valor 99 MIXT x2 · US$ 123.17
   *   Total US$ 752.02 sin IGV · OCTUBRE 2026 - 452 · correo: compras@prosegur.com
   *   Responde *enviar*, o corrige: *precio 2 130*, *cantidad 1 3*, …
   */
  private profileReview(quote: Quote, profile: CustomerProfile, to: string, excelMissing: RequiredField[]): string {
    const k = Math.min(2, quote.items.length);
    const serial = quoteSerial(quote.number, this.settings.quote.numberFormat);
    return [
      profileHead(profile, quote),
      ...quote.items.map((it, i) => `${i + 1}. ${shortItemLabel(it, quote.ub)} · ${fmtMoney(displayUnit(it, quote), quote.currency)}`),
      `Total ${fmtMoney(displayTotal(quote), quote.currency)} ${quote.pricesIncludeTax ? "con" : "sin"} ${quote.taxLabel} · ${quote.number} · correo: ${to}`,
      excelMissing.length ? `⚠️ Falta para el Excel: ${excelMissing.map((f) => `*${FIELD_LABEL[f]}: …*`).join(", ")}` : "",
      `Responde *enviar*, o corrige: *precio ${k} 130*, *cantidad 1 3*, *aplicación ${k} MIXT*, *atención: …*${serial !== undefined ? `, *número ${serial + 1}*` : ""}, *cancelar*`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** "número 451" / "nombre: …" on a presented draft: saved under the new number, the old draft removed, presented again. */
  private async renumberQuote(from: string, state: ConversationState, target: { counter?: number; name?: string; confirmed: boolean }): Promise<void> {
    const quote = state.quoteNumber ? await this.store.getQuote(state.quoteNumber) : null;
    if (!quote) return this.reply(from, "No encuentro la cotización; escribe el pedido de nuevo.");
    if (quote.status !== "draft") return this.reply(from, `La cotización ${quote.number} ya fue enviada; su número no cambia. Para otra, escribe el pedido de nuevo.`);
    const number = target.name ?? formatQuoteNumber(this.settings.quote.numberFormat, target.counter!, quote.date);
    if (number === quote.number) return this.reply(from, `Ya es la cotización *${number}*.`);
    const taken = await this.store.getQuote(number);
    if (taken && !target.confirmed) return this.reply(from, this.numberTaken(taken, target));
    if (taken) await this.store.deleteQuote(number); // confirmed: replaced, with its stored files
    if (target.counter && !target.name) await this.store.setQuoteCounter(target.counter, quoteCounterKey(quote.requestedBy ?? from));
    const old = quote.number;
    await this.presentQuote(from, { ...quote, number, emailDraft: undefined });
    await this.store.deleteQuote(old);
  }

  /** "archivo: Nombre" / "archivo excel: Nombre" on a presented draft: kept on the quote (a resend uses them too). */
  private async renameFiles(from: string, state: ConversationState, files: { pdfName?: string; xlsxName?: string }): Promise<void> {
    const quote = state.quoteNumber ? await this.store.getQuote(state.quoteNumber) : null;
    if (!quote) return this.reply(from, "No encuentro la cotización; escribe el pedido de nuevo.");
    if (files.xlsxName && !hasExcelFormat(findProfile(this.settings, quote.customerProfile))) return this.reply(from, "Esta cotización no lleva Excel; *archivo: Nombre* cambia el nombre del PDF.");
    await this.presentQuote(from, { ...quote, files: { ...quote.files, ...files } });
  }

  /**
   * Contact, address and terms from the last quote to the same customer (email, else company), unless the request
   * already sets them. A profile's units have their own requester and contact (Prosegur): when the request names a
   * unit, the last quote of that unit; if the unit has none yet, only the customer's email is reused.
   */
  private async rememberCustomer(req: QuoteRequest, profile?: CustomerProfile): Promise<{ lines: string[]; summary: string[]; who: string }> {
    const out = { lines: [] as string[], summary: [] as string[], who: "" };
    if (!req.customerEmail && !req.customerCompany) return out;
    const who = { email: req.customerEmail, company: req.customerCompany };
    const perUnit = !!profile && !!req.unit;
    const last = await this.store.findLastQuoteForCustomer(perUnit ? { ...who, unit: req.unit } : who);
    if (!last) {
      const any = perUnit && !req.customerEmail ? await this.store.findLastQuoteForCustomer(who) : null;
      if (any?.customer.email) {
        out.who = any.customer.company || any.customer.name || any.customer.email;
        out.lines.push(`correo ${any.customer.email}`);
        out.summary.push(`correo ${any.customer.email}`);
      }
      return out;
    }
    out.who = [last.customer.company || last.customer.name || last.customer.email || "", perUnit ? last.unit : ""].filter(Boolean).join(" · ");
    const add = (key: string, label: string, value: string | undefined, already: unknown) => {
      if (!value || already) return;
      out.lines.push(`${key}: ${value}`);
      out.summary.push(`${label} ${value}`);
    };
    // the attention goes with its requester: not carried over when it only repeated the requester, nor to a new requester
    const sameRequester = !req.requester || foldKey(req.requester) === foldKey(last.requester);
    add("atención", "atención", last.customer.attention !== last.requester && sameRequester ? last.customer.attention : undefined, req.attention);
    add("dirección", "dirección", last.customer.address, req.address);
    // they vary per unit of the customer, but are worth prefilling (the salesman overrides them with "unidad: …")
    add("unidad", "unidad", last.unit, req.unit);
    add("ub", "UB", last.ub, req.ub || req.lines.every((l) => l.ub));
    add("solicitante", "solicitante", last.requester, req.requester);
    const defaults = this.settings.quote;
    add("pago", "pago", last.paymentType !== defaults.paymentType ? last.paymentType : undefined, req.paymentType);
    add("plazo", "plazo", last.paymentTerm !== defaults.paymentTerm ? last.paymentTerm : undefined, req.paymentTerm);
    add("entrega", "entrega", last.deliveryTerm !== defaults.deliveryTerm ? last.deliveryTerm : undefined, req.deliveryTerm);
    if (!req.customerEmail && last.customer.email) {
      out.lines.push(`correo ${last.customer.email}`);
      out.summary.push(`correo ${last.customer.email}`);
    }
    return out;
  }

  // ---------- product photos ----------

  /** Image sent with the caption "foto <marca> <modelo>": stored for every future quote of that brand+model. */
  private async savePhotoFromMedia(from: string, msg: InboundMessage, what: string): Promise<void> {
    const { brand, model } = this.splitBrandModel(what);
    if (!brand || !model) return this.reply(from, `Dime marca y modelo en el texto de la foto, p.ej. *foto Fenixway Valor 87*.`);
    const { data, mimeType } = await this.client.downloadMedia(msg.media!.id);
    if (data.length > 2_500_000) return this.reply(from, "La imagen es muy grande (máx. 2.5 MB). Envíala como foto normal, no como documento.");
    await this.store.setPhoto({ key: photoKey(brand, model), brand, model, data: data.toString("base64"), mimeType: mimeType || msg.media!.mimeType, source: "whatsapp", addedBy: from, createdAt: now() });
    await this.reply(from, `📷 Guardé la foto de *${brand} ${model}*. Se incluirá en las próximas cotizaciones de ese modelo.`);
  }

  private splitBrandModel(text: string): { brand: string; model: string } {
    const clean = text.replace(/\s+/g, " ").trim();
    const b = findBrandInText(clean);
    if (b) {
      const model = clean.replace(new RegExp(b.alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "").replace(/\s+/g, " ").trim();
      return { brand: b.brand, model };
    }
    const [brand, ...rest] = clean.split(" ");
    return { brand: brand ?? "", model: rest.join(" ") };
  }

  /** "foto 1b" (option), "foto 2" (quote item), "foto Fenixway Valor 87", "foto buscar 2", "foto ok" / "foto no" / "foto otra". */
  private async handlePhotoCommand(from: string, state: ConversationState, text: string): Promise<void> {
    const arg = text.replace(/^fotos?\s*/i, "").trim();
    const cmd = norm(arg);

    // answers to a web candidate
    if (state.pendingPhoto && ["ok", "si", "sí", "guardar", "guarda"].includes(cmd)) {
      const p = state.pendingPhoto;
      await this.store.setPhoto({ key: photoKey(p.brand, p.model), brand: p.brand, model: p.model, url: p.url, source: "web", addedBy: from, createdAt: now() });
      await this.store.setConversation(from, { ...state, pendingPhoto: undefined, updatedAt: now() });
      return this.reply(from, `📷 Guardada la foto de *${p.brand} ${p.model}*. Si la cotización ya está armada, escribe *ok* o repite el pedido para que la incluya.`);
    }
    if (state.pendingPhoto && ["no", "otra", "siguiente", "next"].includes(cmd)) {
      const p = state.pendingPhoto;
      const next = p.index + 1;
      if (cmd === "no" || next >= p.candidates.length) {
        await this.store.setConversation(from, { ...state, pendingPhoto: undefined, updatedAt: now() });
        return this.reply(from, `Ok, descartada. Si tienes la foto correcta, envíamela con el texto *foto ${p.brand} ${p.model}*.`);
      }
      const url = p.candidates[next];
      await this.store.setConversation(from, { ...state, pendingPhoto: { ...p, url, index: next }, updatedAt: now() });
      return this.proposePhoto(from, p.brand, p.model, url, next, p.candidates.length);
    }

    // "foto buscar 2" / "foto buscar Fenixway Valor 87"
    const search = arg.match(/^(?:buscar|busca|web)\s+(.+)$/i);
    if (search) {
      const target = await this.photoTarget(state, search[1]);
      if (!target) return this.reply(from, "No sé de qué ítem. Escribe *foto buscar 2* (ítem de la cotización) o *foto buscar Marca Modelo*.");
      return this.searchPhoto(from, state, target.brand, target.model);
    }

    const target = await this.photoTarget(state, arg);
    if (!target) return this.reply(from, "Escribe *foto 1b* (opción), *foto 2* (ítem de la cotización) o *foto Marca Modelo*.");
    const found = target.url ? { url: target.url, sheetUrl: target.sheetUrl, source: target.source ?? "" } : await findPhoto(this.store, target.brand, target.model);
    if (!found) {
      const hint = webSearchAvailable() ? ` Puedo buscarla en internet: *foto buscar ${arg}*.` : "";
      return this.reply(from, `No tengo foto de *${target.brand} ${target.model}*. Envíamela con el texto *foto ${target.brand} ${target.model}*.${hint}`);
    }
    const caption = `${target.brand} ${target.model}${found.source ? ` · foto: ${found.source}` : ""}`;
    if (found.data) await this.client.sendImage(from, { data: found.data, mimeType: found.mimeType }, caption);
    else if (found.url) {
      const img = await loadImage(found.url);
      if (img) await this.client.sendImage(from, { data: img.data, mimeType: img.mimeType }, caption);
      else await this.client.sendImage(from, { link: found.url }, caption);
    }
    if (found.sheetUrl) {
      const sheet = await loadImage(found.sheetUrl);
      if (sheet) await this.client.sendImage(from, { data: sheet.data, mimeType: sheet.mimeType }, `Ficha técnica ${target.brand} ${target.model}`);
    }
  }

  /** Resolve "1b" (pending option), "2" (quote item) or "Marca Modelo" to a brand+model (+ the row's own photo when it has one). */
  private async photoTarget(state: ConversationState, ref: string): Promise<{ brand: string; model: string; url?: string; sheetUrl?: string; source?: string } | null> {
    const m = ref.match(/^(\d{1,2})\s*([a-j])?$/i);
    if (m) {
      const li = parseInt(m[1], 10) - 1;
      if (state.step === "choose" && state.pending) {
        const p = state.pending[li];
        if (!p) return null;
        const idx = m[2] ? LETTERS.indexOf(m[2].toLowerCase()) : (p.chosen ?? 0);
        const [row] = await this.store.getRows([p.candidateIds[idx]].filter(Boolean));
        return row ? { brand: row.brand, model: row.model, url: row.photoUrl, sheetUrl: row.sheetUrl, source: row.photoUrl ? row.provider : undefined } : null;
      }
      if (state.quoteNumber) {
        const quote = await this.store.getQuote(state.quoteNumber);
        const it = quote?.items[li];
        return it ? { brand: it.brand, model: it.model, url: it.photoUrl, sheetUrl: it.sheetUrl, source: it.photoSource } : null;
      }
      return null;
    }
    const { brand, model } = this.splitBrandModel(ref);
    return brand && model ? { brand, model } : null;
  }

  private async searchPhoto(from: string, state: ConversationState, brand: string, model: string): Promise<void> {
    if (!webSearchAvailable()) return this.reply(from, "La búsqueda de fotos en internet no está configurada (GOOGLE_CSE_KEY / GOOGLE_CSE_ID).");
    const candidates = await searchWebPhotos(brand, model);
    if (candidates.length === 0) return this.reply(from, `No encontré fotos de *${brand} ${model}* en internet. Envíamela con el texto *foto ${brand} ${model}*.`);
    await this.store.setConversation(from, { ...state, pendingPhoto: { brand, model, url: candidates[0], candidates, index: 0 }, updatedAt: now() });
    return this.proposePhoto(from, brand, model, candidates[0], 0, candidates.length);
  }

  private async proposePhoto(from: string, brand: string, model: string, url: string, index: number, total: number): Promise<void> {
    const img = await loadImage(url);
    if (img) await this.client.sendImage(from, { data: img.data, mimeType: img.mimeType }, `${brand} ${model} (internet, ${index + 1}/${total})`);
    else await this.client.sendImage(from, { link: url }, `${brand} ${model} (internet, ${index + 1}/${total})`);
    await this.reply(from, `¿Es la foto correcta de *${brand} ${model}*? Responde *foto ok* para guardarla, *foto otra* para ver la siguiente o *foto no* para descartar.`);
  }

  /**
   * Items sent in a message of their own after the quote was presented ("2 v99", then "4 v89"): a message made only of
   * contract lines of the quote's customer adds them to the draft, which is presented again. An item without APLICACIÓN
   * is asked about first. Returns false for anything else.
   */
  private async addToQuote(from: string, state: ConversationState, text: string): Promise<boolean> {
    const quote = state.quoteNumber ? await this.store.getQuote(state.quoteNumber) : null;
    const profile = findProfile(this.settings, quote?.customerProfile);
    if (!quote || quote.status !== "draft" || !profile) return false;
    const lines = this.moreContractLines(await this.contractFor(profile), text);
    if (!lines) return false;
    const unknown = lines.find((l) => l.contract && !l.application && !(state.applicationAsked ?? []).includes(l.contract.id));
    if (unknown?.contract) {
      await this.store.setConversation(from, { ...state, step: "need_application", profile: profileId(profile), askItem: unknown.contract.id, addText: text, updatedAt: now() });
      await this.reply(from, askApplication(unknown.model || unknown.contract.id));
      return true;
    }
    await this.rebuildQuote(from, state, { add: lines, addText: text });
    return true;
  }

  private async rebuildQuote(from: string, state: ConversationState, change: { unitPrice?: number; lineIndex?: number; email?: string; pricesIncludeTax?: boolean; extraText?: string; application?: string; quantity?: number; remove?: boolean; add?: RequestLine[]; addText?: string }): Promise<void> {
    const quote = state.quoteNumber ? await this.store.getQuote(state.quoteNumber) : null;
    if (!quote) return this.reply(from, "No encuentro la cotización; escribe el pedido de nuevo.");
    const at = change.lineIndex ?? 0;
    const perItem = change.unitPrice !== undefined || change.application !== undefined || change.quantity !== undefined || change.remove;
    if (perItem && !quote.items[at]) return this.reply(from, `No existe el ítem ${at + 1}; hay ${quote.items.length}.`);
    // terms typed after the quote ("pago: letras 30 días") are appended to the request text so they persist
    // ("pago letras 30 días" gets its colon; text already written as "clave: valor" is kept as it is); so are added items
    const extra = change.extraText && !/^[^\n:]*:/.test(change.extraText) ? change.extraText.replace(/^(\w[\w ]*?)\s+(?=\S)/, (m, k) => (/:$/.test(m.trim()) ? m : `${k}: `)) : change.extraText;
    const requestText = [quote.requestText, extra, change.addText].filter(Boolean).join("\n");
    const profile = findProfile(this.settings, quote.customerProfile);
    const req = await this.parseFor(requestText, await this.contractFor(profile));
    req.customerEmail = change.email ?? quote.customer.email;
    let items = quote.items.map((it, i) => {
      if (i !== at) return it;
      if (change.application !== undefined) return { ...it, application: change.application };
      if (change.quantity !== undefined) return { ...it, quantity: change.quantity, total: r2(it.unitPrice * change.quantity) };
      if (change.unitPrice === undefined) return it;
      const unitPrice = change.unitPrice;
      if (it.origin === "contract") return { ...it, unitPrice, discountPct: 0, total: r2(unitPrice * it.quantity) }; // a price below the contract's is not a "discount"
      const discountPct = it.listPrice ? Math.round((1 - unitPrice / it.listPrice) * 10000) / 100 : it.discountPct;
      return { ...it, unitPrice, discountPct: Math.max(0, discountPct), total: Math.round(unitPrice * it.quantity * 100) / 100, origin: it.listPrice ? it.origin : ("manual" as const) };
    });
    if (change.remove) items = items.filter((_, i) => i !== at);
    // contract items sent after the quote was presented: the same item, UB and plate adds to its quantity
    const ubOf = (ub: string | undefined) => ub ?? req.ub ?? "";
    for (const line of change.add ?? []) {
      const k = items.findIndex((it) => it.origin === "contract" && it.code === line.contract?.id && ubOf(it.ub) === ubOf(line.ub) && (it.plate ?? "") === (line.plate ?? ""));
      if (k < 0) items.push(contractQuoteItem(line, line.quantity, this.settings));
      else items[k] = { ...items[k], application: items[k].application ?? line.application, quantity: items[k].quantity + line.quantity, total: r2(items[k].unitPrice * (items[k].quantity + line.quantity)) };
    }
    if (change.add?.length && hasExcelFormat(profile) && items.length > PROSEGUR_MAX_ITEMS) return this.reply(from, prosegurTooManyItems(items.length));
    if (!items.length) {
      await this.store.setConversation(from, null);
      return this.reply(from, "No quedó ningún ítem para cotizar. Escribe el pedido de nuevo.");
    }
    const rebuilt = buildQuote({ number: quote.number, request: req, items, settings: this.settings, today: quote.date, requestedBy: quote.requestedBy ?? from, pricesIncludeTax: change.pricesIncludeTax ?? quote.pricesIncludeTax, customerProfile: quote.customerProfile, files: quote.files });
    rebuilt.createdAt = quote.createdAt;
    await this.presentQuote(from, rebuilt);
  }

  /** The documents of a quote: its PDF, plus the customer's Excel format when its profile has one. */
  private async renderQuoteFiles(quote: Quote, opts: { photos?: boolean } = {}): Promise<EmailAttachment[]> {
    const files: EmailAttachment[] = [{ filename: pdfFileName(quote, this.settings), content: await renderQuotePdf(quote, this.settings, opts.photos === false ? { photos: false } : {}), contentType: PDF_MIME }];
    const profile = findProfile(this.settings, quote.customerProfile);
    if (hasExcelFormat(profile)) {
      const x = await renderProsegurXlsx(quote, this.settings, profile);
      files.push({ filename: x.fileName, content: x.buffer, contentType: XLSX_MIME });
    }
    return files;
  }

  private async sendQuote(from: string, state: ConversationState): Promise<void> {
    const quote = state.quoteNumber ? await this.store.getQuote(state.quoteNumber) : null;
    if (!quote || !quote.emailDraft) return this.reply(from, "No encuentro la cotización; escribe el pedido de nuevo.");
    let res: SendResult;
    let files: EmailAttachment[] = [];
    try {
      files = await this.renderQuoteFiles(quote);
      res = await (this.deps.sendEmail ?? sendQuoteEmail)(quote, files, quote.emailDraft);
    } catch (err) {
      res = { sent: false, error: (err as Error).message };
    }
    if (res.sent || res.dryRunPath) {
      quote.status = "sent";
      quote.sentAt = now();
      await this.store.saveQuote(quote);
      await this.storeSentFiles(quote, files);
      await this.store.setConversation(from, null);
      const what = files.length > 1 ? ` (${files.map((f) => (f.contentType === XLSX_MIME ? "Excel" : "PDF")).join(" + ")})` : "";
      if (res.sent) return this.reply(from, `Enviado ✔ Cotización ${quote.number} a ${quote.emailDraft.to}${what}.`);
      return this.reply(from, `(Modo prueba, sin RESEND_API_KEY) El correo se guardó en ${res.dryRunPath} en vez de enviarse. Cotización ${quote.number} marcada como enviada${what}.`);
    }
    await this.reply(from, `No pude enviar el correo: ${res.error}. Prueba *correo otro@dominio.com* o *cancelar*.`);
  }

  /** The exact documents sent (replacing those of an earlier send), for "reenviar 451". Never blocks the send. */
  private async storeSentFiles(quote: Quote, files: EmailAttachment[]): Promise<void> {
    for (const f of files) {
      try {
        await this.store.saveQuoteFile({ quoteNumber: quote.number, kind: f.contentType === XLSX_MIME ? "xlsx" : "pdf", fileName: f.filename, mimeType: f.contentType ?? PDF_MIME, data: f.content.toString("base64") });
      } catch (err) {
        this.log(`no pude guardar ${f.filename} de ${quote.number}: ${(err as Error).message}`);
      }
    }
  }

  // ---------- history ----------

  /**
   * "cotizaciones", "cotizaciones Prosegur", "reenviar 451" / "archivos 451" / "pdf 451", and the admin's
   * "borrar proveedor NOMBRE" (any state). Returns false when it is none of them.
   */
  private async handleHistoryCommand(from: string, text: string): Promise<boolean> {
    if (!text || text.includes("\n") || text.length > 80) return false;
    const del = text.match(/^(?:borrar|eliminar)\s+proveedor\s*:?\s+(\S.*)$/i);
    if (del) {
      await this.deleteProvider(from, del[1].trim());
      return true;
    }
    const list = text.match(/^cotizaciones(?:\s+(?:de\s+)?(.+))?$/i);
    if (list && !findTyreSizes(text).length) {
      await this.replyQuoteList(from, list[1]?.trim());
      return true;
    }
    const again = text.match(/^(?:reenviar|reenv[ií]a|reenvia|archivos|pdf)\s+(?:la\s+)?(?:cotizaci[oó]n\s+)?(\S.*)$/i);
    if (again && !findTyreSizes(again[1]).length) {
      await this.resendQuote(from, again[1].trim());
      return true;
    }
    return false;
  }

  // ---------- contracts ----------

  /**
   * "contrato prosegur" (anyone): the effective contract items. Admins only: "contrato prosegur v99 125.50" (price),
   * "contrato prosegur f77 aplicación POST", "contrato prosegur nuevo: f66 = Fenixway Flama 66 215/75R17.5 18PR POST
   * 118.00", "contrato prosegur borrar f66". Changes go to contract_prices and apply to the next quotes.
   */
  private async handleContractCommand(from: string, text: string): Promise<boolean> {
    if (!text || text.includes("\n")) return false;
    const m = text.trim().match(/^contratos?(?:\s+(?:de\s+)?(\S.*))?$/i);
    if (!m) return false;
    if (!m[1]) {
      const lists: string[] = [];
      for (const p of this.settings.customers) {
        const c = await this.contractFor(p);
        if (c?.items.length) lists.push(this.contractListing(p, c, from));
      }
      await this.reply(from, lists.length ? lists.join("\n\n") : "No hay clientes con contrato.");
      return true;
    }
    const lead = leadingProfile(this.settings, m[1]);
    if (!lead) {
      const withContract = this.settings.customers.filter((p) => p.contract).map((p) => p.name);
      await this.reply(from, `No conozco el cliente *${m[1].trim()}*.${withContract.length ? ` Clientes con contrato: ${withContract.join(", ")}.` : ""}`);
      return true;
    }
    const profile = lead.profile;
    const contract = await this.contractFor(profile);
    const rest = lead.rest.trim();
    if (!rest) {
      await this.reply(from, this.contractListing(profile, contract, from));
      return true;
    }
    if (!isAdmin(from)) {
      await this.reply(from, "Solo el administrador cambia los precios de contrato.");
      return true;
    }
    await this.reply(from, await this.changeContract(from, profile, contract, rest));
    return true;
  }

  /** "*Contrato Prosegur 2 años · precios sin IGV*" and one line per item (plus the edit commands, for admins). */
  private contractListing(profile: CustomerProfile, contract: Contract | null, from: string): string {
    const key = profileKey(profile);
    const example = `*contrato ${key} nuevo: f66 = Fenixway Flama 66 215/75R17.5 18PR POST 118.00*`;
    if (!contract?.items.length) return `${profile.name} no tiene contrato cargado.${isAdmin(from) ? ` Agrega ítems con ${example}.` : ""}`;
    const a = contract.items[0];
    const b = contract.items.find((i) => !i.application) ?? contract.items[contract.items.length - 1];
    const admin = isAdmin(from) ? `\nCambiar: *contrato ${key} ${a.id} 125.50* · *contrato ${key} ${b.id} aplicación POST* · ${example} · *contrato ${key} borrar f66*` : "";
    return `*${contract.note || `Contrato ${profile.name}`}*\n${contract.items.map(contractItemLabel).join("\n")}${admin}`;
  }

  /** An admin's change to a contract; returns the reply. */
  private async changeContract(from: string, profile: CustomerProfile, contract: Contract | null, rest: string): Promise<string> {
    const cid = profileId(profile);
    const key = profileKey(profile);
    const notFound = (ref: string) => `No hay ningún ítem *${ref.trim()}* en el contrato de ${profile.name}${contract?.items.length ? ` (ítems: ${contract.items.map((i) => i.id).join(", ")})` : ""}.`;
    const nuevo = rest.match(/^nuevo\s*:?\s*(\S.*)$/i);
    if (nuevo) {
      const item = parseNewContractItem(nuevo[1], contract);
      if (typeof item === "string") return item;
      const existed = contract?.items.some((i) => i.id === item.id);
      await this.store.setContractItem(cid, { ...toStored(item), updatedBy: from });
      return `✅ ${existed ? "Reemplacé" : "Agregué"} en el contrato de ${profile.name}: ${contractItemLabel(item)}`;
    }
    const del = rest.match(/^(?:borrar|eliminar|quitar)\s+(\S.*)$/i);
    if (del) {
      const item = contract ? findContractItem(contract, del[1]) : undefined;
      if (!item) return notFound(del[1]);
      const removed = await this.store.deleteContractItem(cid, item.id);
      if (!item.inConfig) return `🗑️ Quité *${item.id}* del contrato de ${profile.name}.`;
      const back = resolveContract(profile, await this.store.getContractItems(cid))?.items.find((i) => i.id === item.id);
      return removed && back ? `↩️ *${item.id}* vuelve a lo de config/customers.json: ${contractItemLabel(back)}` : `*${item.id}* está en config/customers.json: para quitarlo del contrato hay que editar ese archivo.`;
    }
    const app = rest.match(/^(.+?)\s+(?:aplicaci[oó]n|aplic|app)\s*:?\s*(\S.*)$/i);
    if (app) {
      const item = contract ? findContractItem(contract, app[1]) : undefined;
      if (!item) return notFound(app[1]);
      const application = app[2].trim().toUpperCase().replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ");
      await this.saveContractChange(profile, item.id, { application }, from);
      return `✅ ${contractItemLabel({ ...item, application })}`;
    }
    const price = rest.match(/^(.+?)\s+(?:precio\s*:?\s*)?(?:us\$|\$|usd)?\s*(\d+(?:[.,]\d{1,2})?)\s*$/i);
    if (price) {
      const item = contract ? findContractItem(contract, price[1]) : undefined;
      if (!item) return notFound(price[1]);
      const value = parseFloat(price[2].replace(",", "."));
      await this.saveContractChange(profile, item.id, { price: value }, from);
      return `✅ ${contractItemLabel({ ...item, price: value })} (antes ${fmtMoney(item.price, item.currency)}). Vale para las próximas cotizaciones.`;
    }
    return `No entendí. Ejemplos: *contrato ${key} v99 125.50* (precio sin IGV), *contrato ${key} f77 aplicación POST*, *contrato ${key} nuevo: f66 = Fenixway Flama 66 215/75R17.5 18PR POST 118.00*, *contrato ${key} borrar f66*.`;
  }

  /**
   * One change to a contract item from WhatsApp (its price or APLICACIÓN), written to its contract_prices row on top of
   * what the row already had: fields never changed stay empty, so they keep following config/customers.json.
   */
  private async saveContractChange(profile: CustomerProfile, id: string, change: { price?: number; application?: string }, from: string): Promise<void> {
    const cid = profileId(profile);
    const row = (await this.store.getContractItems(cid)).find((r) => r.id === id);
    await this.store.setContractItem(cid, { ...(row ?? { id }), ...change, updatedBy: from, updatedAt: undefined });
  }

  private async replyQuoteList(from: string, company?: string): Promise<void> {
    const quotes = await this.store.listQuotes(company ? { company, limit: 10 } : { requestedBy: from, limit: 10 });
    if (!quotes.length) return this.reply(from, company ? `No encuentro cotizaciones para *${company}*.` : "Todavía no tienes cotizaciones guardadas.");
    const lines = quotes.map((q) =>
      [`• *${q.number}*`, fmtDate(q.date), company ? "" : q.customer.company || q.customer.name || "—", fmtMoney(displayTotal(q), q.currency), STATUS_LABEL[q.status], `${q.items.length} ítem${q.items.length === 1 ? "" : "s"}`].filter(Boolean).join(" · "),
    );
    const head = company ? `*Últimas cotizaciones de ${company}:*` : `*Tus últimas cotizaciones:*`;
    const serial = quoteSerial(quotes[0].number, this.settings.quote.numberFormat);
    await this.reply(from, `${head}\n${lines.join("\n")}\n\nEscribe *reenviar ${serial ?? quotes[0].number}* para recibir de nuevo sus archivos.`);
  }

  /** "451" (this salesman's, else anyone's) or the full number "OCTUBRE 2026 - 451". */
  private async findQuoteByRef(from: string, ref: string): Promise<Quote | null> {
    const exact = await this.store.getQuote(ref);
    if (exact) return exact;
    const serial = /^\d{1,6}$/.test(ref) ? parseInt(ref, 10) : undefined;
    const key = foldKey(ref);
    const matches = (q: Quote) => (serial !== undefined ? quoteSerial(q.number, this.settings.quote.numberFormat) === serial : foldKey(q.number) === key);
    return (await this.store.listQuotes({ requestedBy: from, limit: 200 })).find(matches) ?? (await this.store.listQuotes({ limit: 500 })).find(matches) ?? null;
  }

  /** Sends the stored documents again (or regenerates them from the quote when none were stored). */
  private async resendQuote(from: string, ref: string): Promise<void> {
    const quote = await this.findQuoteByRef(from, ref);
    if (!quote) return this.reply(from, `No encuentro la cotización *${ref}*. Escribe *cotizaciones* para ver las últimas.`);
    const stored = await this.store.getQuoteFiles(quote.number).catch(() => []);
    const files: EmailAttachment[] = stored.length
      ? stored.map((f) => ({ filename: f.fileName, content: Buffer.from(f.data, "base64"), contentType: f.mimeType }))
      : await this.renderQuoteFiles(quote, { photos: !process.env.PHOTOS_DISABLED });
    const profile = findProfile(this.settings, quote.customerProfile);
    for (const f of files) {
      const caption = f.contentType === XLSX_MIME ? `Formato ${profile?.name ?? "Excel"} · ${f.filename}` : `Cotización ${quote.number} · ${STATUS_LABEL[quote.status]}${stored.length ? "" : " (regenerada)"}`;
      await this.client.sendDocument(from, f.content, f.filename, caption, f.contentType ?? PDF_MIME);
    }
    if (!stored.length) await this.reply(from, `No tenía guardados los archivos de *${quote.number}* (se guardan al enviarla); los generé de nuevo con sus datos.`);
  }

  /** "borrar proveedor NOMBRE" (admins): every price row of that provider, and its Drive sync marks. */
  private async deleteProvider(from: string, name: string): Promise<void> {
    if (!isAdmin(from)) return this.reply(from, "Solo el administrador puede borrar proveedores.");
    const hit = (await this.store.providers()).find((p) => foldKey(p.provider) === foldKey(name));
    if (!hit) return this.reply(from, `No hay ninguna lista del proveedor *${name}*. Escribe *proveedores* para ver las cargadas.`);
    const { rows, syncMarks } = await this.store.deleteProvider(hit.provider);
    await this.reply(from, `🗑️ Borré *${rows} filas* de *${hit.provider}*${syncMarks ? ` y ${syncMarks} marca(s) de Drive (sus archivos se vuelven a leer en la próxima sincronización)` : ""}.`);
  }

  // ---------- info commands ----------

  private async replyProviders(from: string): Promise<void> {
    const p = await this.store.providers();
    if (p.length === 0) return this.reply(from, "Todavía no hay listas cargadas. Reenvíame un mensaje, PDF o Excel de un proveedor.");
    const label = (k: string) => (k === "own" ? "lista propia" : k === "stock" ? "stock Odoo" : "proveedor");
    await this.reply(from, `*Listas cargadas:*\n${p.map((x) => `• ${x.provider} (${label(x.kind)}): ${x.rows} filas, último ${x.lastPriceDate}`).join("\n")}`);
  }

  private async replyPrices(from: string, sizeText: string): Promise<void> {
    const size = parseTyreSize(sizeText);
    if (!size) return this.reply(from, "Indica la medida, p.ej. *precios 11R22.5*.");
    const brand = findBrandInText(sizeText)?.brand;
    const req: QuoteRequest = { raw: sizeText, lines: [{ raw: sizeText, size, brand, quantity: 1 }], parsedBy: "regex" };
    const [lc] = await findCandidates(this.store, req, this.settings.pricing, { limit: 15 });
    if (!lc || lc.candidates.length === 0) return this.reply(from, `Sin precios para ${size.display}.`);
    const lines = lc.candidates.map((c, j) => this.optionLine(LETTERS[j] ?? String(j + 1), c));
    await this.reply(from, `*${size.display}*\n${lines.join("\n")}`);
  }
}
