/**
 * The bot's conversation logic. One salesman phone = one conversation state.
 *
 *   salesman  ->  "Fenixway 295/80R22.5 Valor 87 x4 para Transportes ABC, juan@abc.com, dscto 10%"
 *                 (or a forwarded customer message / RFQ email with several lines)
 *   bot       ->  per line: numbered options (stock, list price, discount, provider alternatives)
 *   salesman  ->  "ok"  /  "1b 3a"  /  "quitar 2"  /  "precio 3 4.50"  /  "dscto 15"  /  "con igv"
 *   bot       ->  PDF quote + email preview
 *   salesman  ->  "enviar"  (or "correo x@y.com", "cancelar")
 *   bot       ->  "Enviado ✔"
 *
 *   forwarded provider message / PDF / Excel / photo of a price list  ->  "¿De qué proveedor?"  ->  name  ->  prices stored
 */
import { ingestCsv, ingestExcel } from "../ingest/tabular";
import { ingestPdf } from "../ingest/pdf";
import { ingestWhatsAppText, looksLikePriceMessage } from "../ingest/whatsapp-text";
import { resolveSourceOptions } from "../ingest/sources";
import { extractPricesWithLLM, llmAvailable } from "../llm/extract-prices";
import { parseRequestWithLLM } from "../llm/parse-request";
import type { IngestResult } from "../ingest/types";
import { fold, findBrandInText } from "../tyre/brands";
import { findTyreSizes, parseTyreSize } from "../tyre/spec";
import type { Settings } from "../settings";
import type { ConversationState, PendingLine, PriceStore } from "../store/types";
import { buildQuote, displayTotal, formatQuoteNumber, itemFromCandidate, manualItem } from "../quote/build";
import { buildEmailDraft, safeName, sendQuoteEmail } from "../quote/email";
import { findCandidates } from "../quote/match";
import { renderQuotePdf } from "../quote/pdf";
import { fmtMoney } from "../quote/pricing";
import { describeLine, describeRequest, parseEmail, parseRequest } from "../quote/request";
import type { Candidate, LineCandidates, Quote, QuoteItem, QuoteRequest } from "../quote/types";
import type { WhatsAppClient } from "./client";
import type { InboundMessage } from "./webhook";

export interface HandlerDeps {
  client: WhatsAppClient;
  store: PriceStore;
  settings: Settings;
  /** Called with generated PDFs (the CLI simulator saves them to ./out). */
  onPdf?: (quote: Quote, pdf: Buffer) => Promise<void> | void;
  log?: (msg: string) => void;
}

const HELP = [
  "*Cotizador Protyres* 🛞",
  "",
  "Escríbeme lo que pide el cliente, o reenvíame su mensaje / correo:",
  "_Fenixway 295/80R22.5 Valor 87 x4 para Transportes ABC, juan@abc.com, dscto 10%_",
  "",
  "Te muestro por cada ítem las opciones: stock propio (precio de lista menos descuento) y proveedores (Steel, JCH…).",
  "Respondes *ok* para aceptar las primeras opciones, o eliges: *1b 2a*, *quitar 3*, *precio 3 4.50*, *dscto 15*, *con igv*.",
  "Luego revisas el PDF y escribes *enviar*.",
  "",
  "Para cargar precios: reenvíame la lista del proveedor (mensaje, PDF, Excel o foto) y te preguntaré de quién es.",
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

function looksLikeRequest(text: string): boolean {
  return /\bx\s*\d{1,3}\b|\b\d{1,3}\s*(?:unidades|und|unid|llantas)\b|\b(?:para|cliente|cotiza|cotizar|cotización|cotizacion|necesito|pide|piden|me cotizas|und\b)\b|@|\bdscto\b|\bdescuento\b/i.test(text);
}

function fmtDateShort(iso: string): string {
  return iso.split("-").reverse().slice(0, 2).join("/");
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
        return this.reply(from, "Listo, cancelado. ¿Qué cotizamos?");
      }
      if (cmd === "proveedores" || cmd === "listas") return this.replyProviders(from);
      if (state.step !== "review_quote" && /^(precios?|stock)\s+/.test(cmd) && findTyreSizes(text).length > 0) return this.replyPrices(from, text.replace(/^(precios?|stock)\s+/i, ""));

      // 1) Provider price lists (files, photos, forwarded messages)
      if (msg.media && msg.type !== "audio" && msg.type !== "video") {
        if (await this.mediaIsCustomerRequest(msg)) return this.startRequestFromMedia(from, msg);
        return this.startIngest(from, state, { media: msg.media, caption: msg.media.caption });
      }
      if (msg.type === "audio" || msg.type === "video") return this.reply(from, "Por ahora no leo audios ni videos. Reenvíame el texto, PDF, Excel o una foto.");
      if (state.step === "need_provider") return this.finishIngest(from, state, text);
      if ((msg.forwarded || state.step === "idle") && looksLikePriceMessage(text) && !looksLikeRequest(text)) {
        return this.startIngest(from, state, { text });
      }

      // 2) Quote flow
      if (state.step === "choose" && state.pending) {
        const handled = await this.handleChoice(from, state, text);
        if (handled) return;
      }
      if (state.step === "review_quote") {
        if (["enviar", "send", "ok", "si", "sí", "dale", "listo"].includes(cmd)) return this.sendQuote(from, state);
        const mail = text.match(/^(?:correo|email|mail|enviar a)\s*:?\s*(\S+@\S+)/i);
        if (mail) return this.rebuildQuote(from, state, { email: mail[1] });
        const price = text.match(/^(?:precio|price|unitario)\s*:?\s+(?:(\d{1,2})\s+)?([\d.,]+)\s*$/i);
        if (price) return this.rebuildQuote(from, state, { lineIndex: price[1] ? parseInt(price[1], 10) - 1 : 0, unitPrice: parseFloat(price[2].replace(",", ".")) });
        if (/^(con|sin)\s+igv$/.test(cmd)) return this.rebuildQuote(from, state, { pricesIncludeTax: cmd.startsWith("con") });
        if (/^(atenci[oó]n|atn|att|direcci[oó]n|dir|pago|tipo de pago|plazo|entrega|validez|tc|tipo de cambio)\s*:?\s+\S/i.test(text)) return this.rebuildQuote(from, state, { extraText: text });
      }
      if (state.step === "need_email") {
        const email = parseEmail(text);
        if (email) return this.rebuildQuote(from, state, { email });
      }
      if (!text) return this.reply(from, "No entendí el mensaje. Escribe *ayuda* para ver cómo funciona.");
      return this.startRequest(from, text);
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

  private async startIngest(from: string, state: ConversationState, pending: { text?: string; media?: InboundMessage["media"]; caption?: string }): Promise<void> {
    const source = pending.text ?? pending.caption ?? "";
    const explicit = source.match(/proveedor\s*:\s*([^\n,.;]+)/i);
    const providers = await this.store.providers();
    const mentioned = providers.find((p) => source && fold(source).includes(fold(p.provider)));
    const fromFile = pending.media?.fileName ? resolveSourceOptions(pending.media.fileName).provider : undefined;
    const providerName = explicit?.[1]?.trim() ?? mentioned?.provider ?? fromFile;
    const next: ConversationState = { ...state, step: "need_provider", pendingPriceText: pending.text, pendingMedia: pending.media ? { id: pending.media.id, mimeType: pending.media.mimeType, fileName: pending.media.fileName } : undefined, updatedAt: now() };
    if (providerName) return this.finishIngest(from, next, providerName);
    await this.store.setConversation(from, next);
    const names = [...new Set(providers.map((p) => p.provider))];
    const known = names.length ? `\nProveedores conocidos: ${names.join(", ")}` : "";
    await this.reply(from, `Recibí una lista de precios. *¿De qué proveedor es?* Responde con el nombre.${known}`);
  }

  private async finishIngest(from: string, state: ConversationState, providerName: string): Promise<void> {
    const provider = providerName.trim().replace(/^proveedor\s*:\s*/i, "");
    if (!provider) return this.reply(from, "Necesito el nombre del proveedor.");
    const providers = await this.store.providers();
    const canonical = providers.find((p) => fold(p.provider) === fold(provider))?.provider ?? provider;
    let result: IngestResult | null = null;
    const sourceRef = `wa-${Date.now()}`;

    if (state.pendingMedia) {
      const { data, mimeType, fileName } = await this.client.downloadMedia(state.pendingMedia.id);
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
    const tag = r.kind === "own" ? "🏭 STOCK" : `🚚 ${r.provider}`;
    const notes = c.reasons.filter((x) => !/^(sin stock|solo \d+ en stock)$/.test(x)).join(", ");
    return `  *${letter})* ${tag}${stock} · ${name}${size}\n      ${price}${notes ? `\n      ⚠️ ${notes}` : ""}`;
  }

  private renderOptions(req: QuoteRequest, lcs: LineCandidates[], pending: PendingLine[]): string {
    const blocks = lcs.map((lc, i) => {
      const p = pending[i];
      const head = `*${i + 1}.* ${describeLine(lc.line)}${p.removed ? " _(quitado)_" : ""}`;
      if (p.removed) return head;
      if (lc.candidates.length === 0) {
        const manual = p.unitPriceOverride !== undefined ? `precio manual ${fmtMoney(p.unitPriceOverride, this.cur)}` : `sin precio en las listas → escribe *precio ${i + 1} 123.45* o *quitar ${i + 1}*`;
        return `${head}\n  ❌ ${manual}`;
      }
      const opts = lc.candidates.map((c, j) => this.optionLine(LETTERS[j], c)).join("\n");
      const chosen = p.chosen !== null ? ` → elegido *${LETTERS[p.chosen]}*` : "";
      return `${head}${chosen}\n${opts}`;
    });
    const extras = [req.customerCompany ?? req.customerName ?? "", req.customerEmail ?? "", req.discountPct !== undefined ? `dscto ${req.discountPct}%` : "", req.showPricesWithTax === true ? "con IGV" : req.showPricesWithTax === false ? "sin IGV" : ""].filter(Boolean);
    return `${blocks.join("\n\n")}${extras.length ? `\n\n${extras.join(" · ")}` : ""}\n\nResponde *ok* para cotizar con las opciones *a*, o ajusta: *1b*, *quitar 2*, *precio 3 4.50*, *dscto 15*, *con igv*, *cancelar*.`;
  }

  private async startRequest(from: string, text: string, note?: string): Promise<void> {
    const req = await parseRequest(text);
    if (req.lines.length === 0) {
      return this.reply(from, `${note ? note + "\n" : ""}No encontré ninguna medida ni producto en el pedido. Escríbela como *11R22.5*, *295/80R22.5* o *1000R20*.\nEjemplo: _Fenixway 295/80R22.5 Valor 87 x4 para Transportes ABC, juan@abc.com_`);
    }
    const lcs = await findCandidates(this.store, req, this.settings.pricing);
    const pending: PendingLine[] = lcs.map((lc) => ({ candidateIds: lc.candidates.map((c) => c.row.id), chosen: lc.candidates.length ? 0 : null, quantity: lc.line.quantity }));
    await this.store.setConversation(from, { phone: from, step: "choose", requestText: text, pending, updatedAt: now() });
    const missing = lcs.filter((lc) => lc.candidates.length === 0).length;
    const intro = `${note ? note + "\n" : ""}Entendí:\n${describeRequest(req)}\n${missing ? `\n⚠️ ${missing} ítem(s) sin precio en las listas.\n` : ""}`;
    await this.reply(from, `${intro}\n${this.renderOptions(req, lcs, pending)}`);
  }

  /** "ok", "1b 2a", "quitar 2", "precio 3 4.50", "dscto 15", "con igv", "2" (single line). Returns false when the text is a new request. */
  private async handleChoice(from: string, state: ConversationState, text: string): Promise<boolean> {
    const cmd = norm(text);
    const pending = state.pending!;
    let requestText = state.requestText ?? "";
    let touched = false;

    if (["ok", "si", "sí", "dale", "listo", "cotizar", "confirmar"].includes(cmd)) return this.finishChoice(from, state);

    const pick = /^\s*(\d{1,2})\s*([a-j])?(?:\s*[, ]\s*\d{1,2}\s*[a-j]?)*\s*$/i;
    if (pick.test(text)) {
      for (const m of text.matchAll(/(\d{1,2})\s*([a-j])?/gi)) {
        let li = parseInt(m[1], 10) - 1;
        let letter = m[2]?.toLowerCase();
        if (!letter && pending.length === 1) {
          // "2" on a single-line quote = option b
          letter = LETTERS[li];
          li = 0;
        }
        if (li < 0 || li >= pending.length) {
          await this.reply(from, pending.length === 1 ? `Solo hay 1 ítem: responde con la letra de la opción (*a*, *b*, *c*…) o *ok*.` : `No existe el ítem ${li + 1}; hay ${pending.length}.`);
          return true;
        }
        const idx = letter ? LETTERS.indexOf(letter) : 0;
        if (idx < 0 || idx >= pending[li].candidateIds.length) {
          await this.reply(from, `El ítem ${li + 1} no tiene opción *${letter}*.`);
          return true;
        }
        pending[li].chosen = idx;
        pending[li].removed = false;
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
    if (/^(con|sin)\s+igv$/.test(cmd)) {
      requestText = `${requestText.replace(/\b(con|sin)\s+igv\b/gi, " ")}\n${cmd}`;
      return this.reshow(from, { ...state, requestText }, requestText);
    }
    const mail = text.match(/^(?:correo|email|mail)\s*:?\s*(\S+@\S+)/i);
    if (mail) {
      requestText = `${requestText.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, " ")}\ncorreo ${mail[1]}`;
      return this.reshow(from, { ...state, requestText }, requestText);
    }
    const term = text.match(/^(atenci[oó]n|atn|att|direcci[oó]n|dir|pago|tipo de pago|plazo|entrega|validez|tc|tipo de cambio)\s*:?\s+(\S.*)$/i);
    if (term) {
      requestText = `${requestText}\n${term[1]}: ${term[2]}`;
      return this.reshow(from, { ...state, requestText }, requestText);
    }
    return false; // not a choice: treat as a new request
  }

  /** Re-rank (discount / tax may have changed) and show the options again, keeping choices. */
  private async reshow(from: string, state: ConversationState, requestText: string): Promise<boolean> {
    const req = await parseRequest(requestText);
    const lcs = await findCandidates(this.store, req, this.settings.pricing);
    const pending: PendingLine[] = lcs.map((lc, i) => {
      const prev = state.pending?.[i];
      const ids = lc.candidates.map((c) => c.row.id);
      const keep = prev?.chosen !== null && prev?.chosen !== undefined && prev.candidateIds[prev.chosen] ? ids.indexOf(prev.candidateIds[prev.chosen]) : -1;
      return { candidateIds: ids, chosen: keep >= 0 ? keep : ids.length ? 0 : null, quantity: prev?.quantity ?? lc.line.quantity, unitPriceOverride: prev?.unitPriceOverride, removed: prev?.removed };
    });
    await this.store.setConversation(from, { ...state, step: "choose", requestText, pending, updatedAt: now() });
    await this.reply(from, this.renderOptions(req, lcs, pending));
    return true;
  }

  private async finishChoice(from: string, state: ConversationState): Promise<boolean> {
    const req = await parseRequest(state.requestText ?? "");
    const lcs = await findCandidates(this.store, req, this.settings.pricing, { limit: 50 });
    const items: QuoteItem[] = [];
    const unpriced: number[] = [];
    (state.pending ?? []).forEach((p, i) => {
      if (p.removed) return;
      const lc = lcs[i];
      if (!lc) return;
      const quantity = p.quantity;
      if (p.chosen !== null && p.candidateIds[p.chosen]) {
        const cand = lc.candidates.find((c) => c.row.id === p.candidateIds[p.chosen!]);
        if (cand) {
          items.push(itemFromCandidate(cand, quantity, this.settings, p.unitPriceOverride));
          return;
        }
      }
      if (p.unitPriceOverride !== undefined) {
        items.push(manualItem({ ...lc.line, quantity }, p.unitPriceOverride, undefined, this.settings));
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
    const today = new Date().toISOString().slice(0, 10);
    const number = formatQuoteNumber(this.settings.quote.numberFormat, await this.store.nextQuoteCounter(this.settings.quote.counterStart), today);
    const quote = buildQuote({ number, request: req, items, settings: this.settings, requestedBy: from, today });
    await this.presentQuote(from, quote);
    return true;
  }

  private async presentQuote(from: string, quote: Quote): Promise<void> {
    quote.emailDraft = buildEmailDraft(quote, this.settings);
    await this.store.saveQuote(quote);
    const pdf = await renderQuotePdf(quote, this.settings);
    await this.deps.onPdf?.(quote, pdf);
    const summary = quote.items.length === 1 ? `${quote.items[0].description} x${quote.items[0].quantity}` : `${quote.items.length} ítems`;
    const taxNote = quote.pricesIncludeTax ? `inc. ${quote.taxLabel}` : `sin ${quote.taxLabel}`;
    await this.client.sendDocument(from, pdf, `Cotizacion ${safeName(quote.number)}.pdf`, `Cotización ${quote.number} · ${summary} · Total ${fmtMoney(displayTotal(quote), quote.currency)} (${taxNote})`);
    if (!quote.customer.email) {
      await this.store.setConversation(from, { phone: from, step: "need_email", quoteNumber: quote.number, updatedAt: now() });
      return this.reply(from, `El pedido no tiene correo del cliente. *¿A qué correo lo envío?* (o *cancelar*)`);
    }
    await this.store.setConversation(from, { phone: from, step: "review_quote", quoteNumber: quote.number, updatedAt: now() });
    const d = quote.emailDraft;
    await this.reply(from, `📧 *Para:* ${d.to}\n*Asunto:* ${d.subject}\n\n${d.body}\n\n—\nResponde *enviar* para mandarlo, *precio 2 480* para cambiar un unitario, *correo x@y.com* para cambiar el destinatario, *con igv* / *sin igv*, *pago: letras 30 días*, *entrega: 48 hrs*, *atención: Sr. X*, o *cancelar*.`);
  }

  private async rebuildQuote(from: string, state: ConversationState, change: { unitPrice?: number; lineIndex?: number; email?: string; pricesIncludeTax?: boolean; extraText?: string }): Promise<void> {
    const quote = state.quoteNumber ? await this.store.getQuote(state.quoteNumber) : null;
    if (!quote) return this.reply(from, "No encuentro la cotización; escribe el pedido de nuevo.");
    // terms typed after the quote ("pago: letras 30 días") are appended to the request text so they persist
    const requestText = change.extraText ? `${quote.requestText}\n${change.extraText.replace(/^(\w[\w ]*?)\s+(?=\S)/, (m, k) => (/:$/.test(m.trim()) ? m : `${k}: `))}` : quote.requestText;
    const req = await parseRequest(requestText);
    req.customerEmail = change.email ?? quote.customer.email;
    const items = quote.items.map((it, i) => {
      if (change.unitPrice === undefined || i !== (change.lineIndex ?? 0)) return it;
      const unitPrice = change.unitPrice;
      const discountPct = it.listPrice ? Math.round((1 - unitPrice / it.listPrice) * 10000) / 100 : it.discountPct;
      return { ...it, unitPrice, discountPct: Math.max(0, discountPct), total: Math.round(unitPrice * it.quantity * 100) / 100, origin: it.listPrice ? it.origin : ("manual" as const) };
    });
    const rebuilt = buildQuote({ number: quote.number, request: req, items, settings: this.settings, today: quote.date, requestedBy: quote.requestedBy ?? from, pricesIncludeTax: change.pricesIncludeTax ?? quote.pricesIncludeTax });
    rebuilt.createdAt = quote.createdAt;
    await this.presentQuote(from, rebuilt);
  }

  private async sendQuote(from: string, state: ConversationState): Promise<void> {
    const quote = state.quoteNumber ? await this.store.getQuote(state.quoteNumber) : null;
    if (!quote || !quote.emailDraft) return this.reply(from, "No encuentro la cotización; escribe el pedido de nuevo.");
    const pdf = await renderQuotePdf(quote, this.settings);
    const res = await sendQuoteEmail(quote, pdf, quote.emailDraft);
    if (res.sent || res.dryRunPath) {
      quote.status = "sent";
      quote.sentAt = now();
      await this.store.saveQuote(quote);
      await this.store.setConversation(from, null);
      if (res.sent) return this.reply(from, `Enviado ✔ Cotización ${quote.number} a ${quote.emailDraft.to}.`);
      return this.reply(from, `(Modo prueba, sin RESEND_API_KEY) El correo se guardó en ${res.dryRunPath} en vez de enviarse. Cotización ${quote.number} marcada como enviada.`);
    }
    await this.reply(from, `No pude enviar el correo: ${res.error}. Prueba *correo otro@dominio.com* o *cancelar*.`);
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
