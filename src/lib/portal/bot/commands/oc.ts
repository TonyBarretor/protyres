/**
 * `oc <empresa> [n° de OC]` (bloque B5b): la orden de compra del cliente y el pedido para Patricia.
 *
 *  1. Guarda la OC (purchase_orders, status "recibida") con el PDF o la imagen si vino adjunta (leyenda `oc …`) o si llega
 *     en los 10 min siguientes al comando, durante las preguntas.
 *  2. Ítems: los de la cotización enlazada (la de la oportunidad abierta, o la última del vendedor a ese cliente) tras
 *     confirmar con *sí*; sin cotización (o si el vendedor escribe otros), con el formato de cotización
 *     (order/items.ts: parser y listas del cotizador). Máximo 7 (filas del formato).
 *  3. Preguntas una por una (order/questions.ts) con la memoria del cliente (company_order_profile) como defecto;
 *     también por voz (misma transcripción que los reportes). `cancelar` aborta (lo limpia routePortal).
 *  4. Excel "FORMATO PEDIDO ATC´S" sin leyenda + resumen con el recordatorio de reenviarlo a Patricia. Oportunidad a
 *     Cerrado ganado, actividad `oc` con la venta esperada en `data` (no se inserta en `sales`: eso llega del Excel de
 *     ventas), empresa como cliente, memoria del cliente y OC en "pedido_generado".
 *
 * Router (regla 9): en la fase de ítems el paso lleva `captureText` (los ítems tienen forma de pedido y no deben irse al
 * cotizador); en las demás, `keepText` (se queda con las respuestas, pero una medida de llanta es un pedido nuevo). En
 * todas, los comandos del cotizador (`ayuda`, `proveedores`...) van al cotizador. `acceptsMedia`: el adjunto sin leyenda
 * (o con leyenda `oc …`) dentro de los 10 min; una lista de precios o una `foto …` siguen al cotizador.
 *
 * Si el mensaje se va al cotizador (o llega otro comando del portal), el pedido NO se pierde ni se queda capturando: se
 * aparta (estado `parked`, 24 h) y se avisa "Dejé pendiente el pedido de la OC …; escribe *oc <RUC>* para retomarlo".
 * `oc` a la misma empresa (sin n° o con el mismo) lo retoma donde quedó, con la misma OC. Se eligió apartarlo y no
 * dejarlo pendiente porque un paso pendiente se quedaría con el siguiente "sí"/"gracias" tras la cotización. `cancelar`
 * durante el pedido marca la OC como "cancelada".
 *
 * Al empezar, si el cotizador está revisando una cotización ya guardada (`review_quote`, `need_email`), ese paso se cierra
 * como con `cancelar`: si no, las respuestas cortas ("sí", "igual") irían al cotizador. Con una cotización o lista a medio
 * armar (otros pasos, o un perfil esperando el pedido) no se toca nada y se le pide terminarla o cancelarla.
 *
 * Permisos: como `cita`, solo quien puede editar la empresa (dueño, supervisor o admin).
 */
import { XLSX_MIME } from "../../../quote/files";
import { fmtMoney, r2 } from "../../../quote/pricing";
import type { Quote } from "../../../quote/types";
import { loadSettings, type Settings } from "../../../settings";
import { getStore } from "../../../store";
import type { PriceStore } from "../../../store/types";
import { ORDER_ITEMS_EXAMPLE, parseOrderItems } from "../../order/items";
import { buildPedidoXlsx, formatPedidoFileName, pedidoDescription, pedidoFromQuote, pedidoTooManyItems, pedidoUnitPrice, plazoDiasFromTerm, PEDIDO_MAX_ITEMS, type PedidoData, type PedidoItem } from "../../order/pedido-xlsx";
import {
  agenciaText,
  applyOrderAnswer,
  entregaFromAnswers,
  fechaEntregaLabel,
  isDefaultAnswer,
  nextOrderQuestion,
  profileFromAnswers,
  type OrderAnswers,
  type OrderField,
  type OrderProfile,
  type QuestionContext,
} from "../../order/questions";
import { canEditCompany } from "../../auth/permissions";
import { ACT_QUOTE, setCompanyCreditTerms, shortQuoteNumber } from "../../quotes/link";
import { findTyreSizes } from "../../../tyre/spec";
import { stageLabel } from "../../stages";
import type { Company, Opportunity } from "../../store/types";
import { limaDateKey } from "../../ui/time";
import { findCompanies, resolveCompany, shortName } from "../companies";
import { registerCompanyAction, registerPendingDrop, registerPendingHandler, registerPortalCommand, type PortalContext } from "../registry";
import { downloader, transcribeVoice } from "../report";
import { clearPending, parkedOf, setParked, setPending, type PendingStep } from "../state";

export const OC_STEP = "oc_pedido";
export const ACT_OC = "oc";
/** El adjunto de la OC se acepta hasta 10 min después del comando. */
export const OC_MEDIA_WINDOW_MS = 10 * 60 * 1000;
export const OC_STATUS_RECEIVED = "recibida";
export const OC_STATUS_DONE = "pedido_generado";
export const OC_STATUS_CANCELLED = "cancelada";
export const PATRICIA_REMINDER = "📧 Reenvía este Excel por correo a Patricia para el pedido.";
export const OC_USAGE = "Escríbelo así: *oc zbuss 4500123* (empresa y n° de OC; puedes adjuntar el PDF o la foto de la OC con esa leyenda).";

// ── dependencias (tests y simulador; por defecto las del cotizador) ──

export interface OrderBotDeps {
  priceStore?: PriceStore;
  settings?: Settings;
}

let deps: OrderBotDeps = {};

/** Store de precios/cotizaciones y configuración del cotizador; null vuelve a las de producción (getStore, loadSettings). */
export function configureOrderBot(d: OrderBotDeps | null): void {
  deps = d ?? {};
}

const priceStore = async (): Promise<PriceStore> => deps.priceStore ?? getStore();
const settings = (): Settings => deps.settings ?? loadSettings();

// ── paso pendiente ──

type Phase = "quote" | "items" | "questions";

interface Media {
  id: string;
  mimeType: string;
  fileName?: string;
}

export interface OcStep extends PendingStep {
  kind: typeof OC_STEP;
  /** Solo en la fase de ítems (router, regla 9). */
  captureText: boolean;
  /** En las demás fases: se queda con las respuestas salvo comandos del cotizador y medidas de llanta. */
  keepText: boolean;
  acceptsMedia: true;
  orderId: number;
  companyId: number;
  opportunityId: number | null;
  numero: string | null;
  /** ISO: hasta cuándo se acepta el adjunto de la OC. */
  mediaUntil: string;
  hasFile: boolean;
  phase: Phase;
  /** Cotización propuesta (fase quote) o usada. */
  quoteNumber: string | null;
  quoteItems: PedidoItem[] | null;
  /** Plazo de la cotización ("30 días") si la hay. */
  quoteTerm: string | null;
  items: PedidoItem[] | null;
  currency: string;
  answers: OrderAnswers;
  qctx: QuestionContext | null;
  field: OrderField | null;
}

interface OcArgs {
  numero: string | null;
  media: Media | null;
}

/** "zbuss 4500123", "zbuss n° 4500123", "zbuss oc 4500123", "20602221505 4500123" -> empresa y número. */
export function parseOcArgs(args: string): { empresa: string; numero: string | null } {
  const t = args.trim().replace(/\s+/g, " ");
  const kw = t.match(/^(.+?)[\s,]+(?:oc|o\/c|orden(?: de compra)?|n[°ºo]\.?|nro\.?|n[uú]mero|#)\s*:?\s*#?([A-Za-z0-9][\w/-]*)$/i);
  if (kw && /\d/.test(kw[2])) return { empresa: kw[1].trim(), numero: kw[2] };
  const bare = splitTrailingNumber(t);
  if (bare && bare.numero.length >= 5) return bare;
  return { empresa: t, numero: null };
}

/** "roca 7788" -> empresa "roca", número "7788" (el comando lo usa solo si "roca 7788" no es una empresa). */
export function splitTrailingNumber(t: string): { empresa: string; numero: string } | null {
  const m = t.match(/^(.+?)[\s,]+#?([A-Za-z0-9][\w/-]*\d[\w/-]*)$/);
  return m ? { empresa: m[1].trim(), numero: m[2] } : null;
}

const mediaOf = (ctx: PortalContext): Media | null =>
  ctx.msg.media && ctx.msg.type !== "audio" ? { id: ctx.msg.media.id, mimeType: ctx.msg.media.mimeType, fileName: ctx.msg.media.fileName } : null;

const extOf = (mime: string) => (/pdf/.test(mime) ? ".pdf" : /png/.test(mime) ? ".png" : /jpe?g/.test(mime) ? ".jpg" : /webp/.test(mime) ? ".webp" : "");

/** Descarga el adjunto de la OC; null si falla (ya se avisó en el log, el pedido sigue sin archivo). */
async function downloadOc(ctx: PortalContext, media: Media, company: Company, numero: string | null): Promise<{ fileName: string; mimeType: string; data: string } | null> {
  try {
    const got = await downloader(ctx)(media.id);
    const mimeType = got.mimeType || media.mimeType;
    const fileName = media.fileName || got.fileName || `OC ${numero ?? ""} ${shortName(company.razonSocial)}`.replace(/\s+/g, " ").trim() + extOf(mimeType);
    return { fileName, mimeType, data: got.data.toString("base64") };
  } catch (err) {
    ctx.log(`portal: no pude descargar la OC ${media.id}: ${(err as Error).message}`);
    return null;
  }
}

/** Pasos del cotizador que se pueden cerrar al empezar una OC: la cotización ya está guardada. */
const CLOSABLE_QUOTER_STEPS = new Set(["review_quote", "need_email"]);
export const QUOTER_BUSY = "Tienes una cotización/lista a medio armar; termínala o escribe *cancelar* y vuelve a mandar *oc …*";

/** Lo que impide empezar la OC: una cotización o lista a medio armar en el cotizador (null = se puede). */
async function quoterBusy(ctx: PortalContext): Promise<string | null> {
  try {
    const st = await (await priceStore()).getConversation(ctx.from);
    if (!st) return null;
    if (st.step === "idle") {
      // perfil elegido esperando el pedido ("prosegur ayacucho 1830"): como pendingProfile del handler (vence a las 2 h)
      const fresh = Date.now() - Date.parse(st.updatedAt) < 2 * 3600_000;
      return st.profile && fresh ? QUOTER_BUSY : null;
    }
    return CLOSABLE_QUOTER_STEPS.has(st.step) ? null : QUOTER_BUSY;
  } catch (err) {
    ctx.log(`portal: no pude leer el estado del cotizador: ${(err as Error).message}`);
    return null;
  }
}

/** Cierra el paso del cotizador si está revisando una cotización ya guardada (como `cancelar`): las respuestas siguientes son del pedido. */
async function endQuoterFlow(ctx: PortalContext): Promise<void> {
  try {
    const ps = await priceStore();
    const st = await ps.getConversation(ctx.from);
    if (st && CLOSABLE_QUOTER_STEPS.has(st.step)) {
      await ps.setConversation(ctx.from, null);
      ctx.log(`portal: oc cierra el paso «${st.step}» del cotizador`);
    }
  } catch (err) {
    ctx.log(`portal: no pude leer el estado del cotizador: ${(err as Error).message}`);
  }
}

/** Cotización para la OC: la de la oportunidad abierta, la última enlazada a la empresa o la última del vendedor a ese cliente (sin usar en otra OC). */
async function findOrderQuote(ctx: PortalContext, company: Company, opp: Opportunity | null): Promise<Quote | null> {
  const ps = await priceStore();
  const used = new Set((await ctx.store.listPurchaseOrders({ companyId: company.id })).filter((o) => o.status === OC_STATUS_DONE && o.quoteNumber).map((o) => o.quoteNumber!));
  const tryQuote = async (num: string | null | undefined) => {
    if (!num || used.has(num)) return null;
    const q = await ps.getQuote(num).catch(() => null);
    return q && q.status !== "cancelled" && q.items.length ? q : null;
  };
  const fromOpp = await tryQuote(opp?.quoteNumber);
  if (fromOpp) return fromOpp;
  const acts = await ctx.store.listActivities({ companyId: company.id, userId: ctx.user.id, limit: 200 });
  for (const a of acts) {
    if (a.tipo !== ACT_QUOTE || typeof a.data?.quoteNumber !== "string") continue;
    const q = await tryQuote(a.data.quoteNumber);
    if (q) return q;
  }
  const name = shortName(company.razonSocial);
  if (name.length < 3) return null;
  const byName = await ps.listQuotes({ company: name, requestedBy: ctx.from, limit: 10 }).catch(() => []);
  for (const q of byName) if ((await tryQuote(q.number)) !== null) return q;
  return null;
}

// ── textos ──

const money = (n: number, cur: string) => fmtMoney(n, cur);

function itemsTotal(items: PedidoItem[]): number {
  return r2(items.reduce((s, it) => s + pedidoUnitPrice(it) * it.cantidad, 0));
}

function itemLines(items: PedidoItem[], cur: string): string {
  return items.map((it) => `• ${it.cantidad} × ${pedidoDescription(it)} — ${money(pedidoUnitPrice(it), cur)} c/u${it.terceros ? ` _(${it.terceros.proveedor})_` : ""}`).join("\n");
}

function shortItems(items: PedidoItem[]): string {
  const shown = items.slice(0, 3).map((it) => `${it.cantidad} × ${pedidoDescription(it)}`);
  if (items.length > 3) shown.push(`y ${items.length - 3} ítems más`);
  return shown.join("; ");
}

const itemsPrompt = () => `Escríbeme los ítems de la OC con el formato de cotización, uno por línea (máximo ${PEDIDO_MAX_ITEMS}):\n${ORDER_ITEMS_EXAMPLE}`;

function quotePrompt(s: Pick<OcStep, "quoteNumber" | "quoteItems" | "currency">): string {
  const items = s.quoteItems ?? [];
  return `Uso la cotización *${shortQuoteNumber(s.quoteNumber ?? "")}* (${shortItems(items)} · ${money(itemsTotal(items), s.currency)} inc. IGV) — responde *sí*, o *no* para escribir otros ítems.`;
}

/** La pregunta en curso (para repetirla). */
function currentPrompt(s: OcStep): string {
  if (s.phase === "quote") return quotePrompt(s);
  if (s.phase === "items") return itemsPrompt();
  return (s.qctx && nextOrderQuestion(s.answers, s.qctx)?.text) ?? "";
}

async function save(ctx: PortalContext, s: OcStep): Promise<void> {
  const { createdAt: _c, ...rest } = s;
  // las banderas del router siguen a la fase: solo los ítems capturan cualquier texto
  await setPending(ctx.store, ctx.from, { ...rest, captureText: s.phase === "items", keepText: s.phase !== "items", createdAt: ctx.now.toISOString() }, ctx.now);
}

const notYours = (c: Company) => `*${c.razonSocial}* no es tuya. Primero: *asignarme ${c.ruc}* (o pide al supervisor).`;

/** "Dejé pendiente el pedido de la OC 4500123 (ZBUSS); escribe *oc 20602221505* para retomarlo." */
export function parkedNotice(s: Pick<OcStep, "numero">, company: Pick<Company, "razonSocial" | "ruc">): string {
  return `⏸️ Dejé pendiente el pedido de la OC${s.numero ? ` ${s.numero}` : " sin n°"} (${shortName(company.razonSocial)}); escribe *oc ${company.ruc}* para retomarlo.`;
}

/** Al dejar el pedido: con `cancelar` la OC queda "cancelada"; si el mensaje fue a otra cosa, el pedido se aparta (24 h). */
registerPendingDrop(OC_STEP, async (dctx, step, reason) => {
  const s = step as OcStep;
  if (reason === "cancel") {
    await dctx.store.updatePurchaseOrder(s.orderId, { status: OC_STATUS_CANCELLED });
    await setParked(dctx.store, dctx.from, OC_STEP, null, dctx.now);
    return null;
  }
  await setParked(dctx.store, dctx.from, OC_STEP, s, dctx.now);
  const company = await dctx.store.getCompany(s.companyId);
  return company ? parkedNotice(s, company) : null;
});

/** El pedido apartado de esta empresa (y de este n° de OC si se escribió), si la OC sigue sin pedido. */
async function takeParked(ctx: PortalContext, company: Company, numero: string | null): Promise<OcStep | null> {
  const parked = parkedOf(await ctx.store.getPortalConversation(ctx.from), OC_STEP, ctx.now) as OcStep | null;
  if (!parked || parked.companyId !== company.id || (numero && parked.numero && numero !== parked.numero)) return null;
  const order = await ctx.store.getPurchaseOrder(parked.orderId);
  await setParked(ctx.store, ctx.from, OC_STEP, null, ctx.now);
  return order && order.status === OC_STATUS_RECEIVED ? parked : null;
}

// ── inicio ──

async function startOrder(ctx: PortalContext, company: Company, args: OcArgs): Promise<void> {
  const { store, user, now } = ctx;
  if (!canEditCompany(user, company)) {
    await ctx.reply(notYours(company));
    return;
  }
  const busy = await quoterBusy(ctx);
  if (busy) {
    await ctx.reply(busy);
    return;
  }
  await endQuoterFlow(ctx);
  const parked = await takeParked(ctx, company, args.numero);
  if (parked) {
    // retoma el pedido apartado donde quedó (misma OC); el adjunto se acepta otros 10 min
    const head = [`▶️ Retomo el pedido de la OC${parked.numero ? ` *${parked.numero}*` : ""} de *${shortName(company.razonSocial)}*.`];
    parked.mediaUntil = new Date(now.getTime() + OC_MEDIA_WINDOW_MS).toISOString();
    if (args.media) {
      const file = await downloadOc(ctx, args.media, company, parked.numero);
      if (file) {
        await store.updatePurchaseOrder(parked.orderId, { fileName: file.fileName, mimeType: file.mimeType, data: file.data });
        parked.hasFile = true;
        head.push(`📎 Guardé la OC (${file.fileName}).`);
      }
    }
    await save(ctx, parked);
    await ctx.reply(`${head.join("\n")}\n\n${currentPrompt(parked)}`);
    return;
  }
  const file = args.media ? await downloadOc(ctx, args.media, company, args.numero) : null;
  const opp = (await store.getOpenOpportunity(company.id, user.id)) ?? (await store.getOpenOpportunity(company.id));
  const quote = await findOrderQuote(ctx, company, opp);
  const order = await store.addPurchaseOrder({
    companyId: company.id,
    opportunityId: opp?.id ?? null,
    userId: user.id,
    numero: args.numero,
    quoteNumber: quote?.number ?? null,
    fileName: file?.fileName ?? null,
    mimeType: file?.mimeType ?? null,
    data: file?.data ?? null,
    status: OC_STATUS_RECEIVED,
    createdAt: now,
  });
  const who = shortName(company.razonSocial);
  const head = [`🧾 OC${args.numero ? ` *${args.numero}*` : ""} de *${who}* registrada${file ? ` con el adjunto (${file.fileName})` : ""}.`];
  if (args.media && !file) head.push("⚠️ No pude descargar el adjunto; envíamelo de nuevo en los próximos 10 min.");
  else if (!file) head.push("📎 Si tienes el PDF o la foto de la OC, envíamelo en los próximos 10 min.");

  const s: OcStep = {
    kind: OC_STEP,
    createdAt: now.toISOString(),
    captureText: true,
    keepText: false,
    acceptsMedia: true,
    orderId: order.id,
    companyId: company.id,
    opportunityId: opp?.id ?? null,
    numero: args.numero,
    mediaUntil: new Date(now.getTime() + OC_MEDIA_WINDOW_MS).toISOString(),
    hasFile: !!file,
    phase: "items",
    quoteNumber: null,
    quoteItems: null,
    quoteTerm: null,
    items: null,
    currency: settings().pricing.currency,
    answers: { cliente: {}, clienteListo: [] },
    qctx: null,
    field: null,
  };
  if (quote) {
    const items = pedidoFromQuote(quote).items;
    s.currency = quote.currency;
    s.quoteTerm = quote.paymentTerm || null;
    if (items.length > PEDIDO_MAX_ITEMS) {
      head.push(`La cotización *${shortQuoteNumber(quote.number)}* tiene ${items.length} ítems. ${pedidoTooManyItems(items.length)}`);
    } else {
      s.phase = "quote";
      s.quoteNumber = quote.number;
      s.quoteItems = items;
    }
  } else head.push(`No encontré una cotización tuya para *${who}*.`);
  await save(ctx, s);
  await ctx.reply(`${head.join("\n")}\n\n${currentPrompt(s)}`);
}

registerCompanyAction("oc", (ctx, company, args) => startOrder(ctx, company, args as unknown as OcArgs));

registerPortalCommand("oc", async (ctx, args) => {
  let p = parseOcArgs(args);
  if (!p.numero) {
    // número corto al final ("oc roca 7788"): es el n° de OC si el texto entero no es una empresa ("expreso 2000")
    const alt = splitTrailingNumber(p.empresa);
    if (alt && /^\D/.test(p.empresa) && (await findCompanies(ctx.store, p.empresa)).total === 0) p = alt;
  }
  if (!p.empresa) {
    await ctx.reply(OC_USAGE);
    return;
  }
  const busy = await quoterBusy(ctx);
  if (busy) {
    await ctx.reply(busy);
    return;
  }
  const a: OcArgs = { numero: p.numero, media: mediaOf(ctx) };
  const company = await resolveCompany(ctx, p.empresa, "oc", a as unknown as Record<string, unknown>);
  if (company) await startOrder(ctx, company, a);
});

// ── respuestas ──

/** Forma de pedido (no vale como observación): medida de llanta, cantidad ("x4", "8 llantas") o "cotiza…". */
export function orderShaped(text: string): boolean {
  return findTyreSizes(text).length > 0 || /\bx\s*\d{1,3}\b|\b\d{1,3}\s*(?:unidades|unds?|unid|llantas|neum[aá]ticos)\b|\bcot[ií]z/i.test(text);
}

const YES_QUOTE = /^(?:s[ií]|si+|ok|okey|dale|esa|usa(?:la)? esa|usala|correcto|claro|confirmo|igual|listo|de acuerdo)[.!]*$/i;

async function enterQuestions(ctx: PortalContext, s: OcStep, company: Company, items: PedidoItem[], prefix: string): Promise<void> {
  const prof = await ctx.store.getOrderProfile(company.id);
  const profile = (prof?.data ?? {}) as OrderProfile;
  const contacts = await ctx.store.listContacts(company.id);
  const c0 = contacts[0];
  const quoteDays = plazoDiasFromTerm(s.quoteNumber ? (s.quoteTerm ?? undefined) : undefined);
  let quoteAddress: string | undefined;
  if (s.quoteNumber) quoteAddress = (await (await priceStore()).getQuote(s.quoteNumber).catch(() => null))?.customer.address || undefined;
  const plazo =
    quoteDays !== undefined
      ? { dias: quoteDays, fuente: `según la cotización ${shortQuoteNumber(s.quoteNumber!)}` }
      : company.creditTermsDays !== null
        ? { dias: company.creditTermsDays, fuente: `de ${shortName(company.razonSocial)} en el portal` }
        : null;
  s.items = items;
  s.phase = "questions";
  s.qctx = {
    profile,
    terceros: items.some((it) => !!it.terceros),
    plazo,
    sugerencias: { direccionFiscal: quoteAddress, contacto: c0 ? [c0.nombre, c0.telefono ? `Cel. ${c0.telefono}` : ""].filter(Boolean).join(" - ") : undefined },
    cliente: shortName(company.razonSocial),
  };
  await askNext(ctx, s, company, prefix);
}

/** Siguiente pregunta, o el pedido si ya está todo. */
async function askNext(ctx: PortalContext, s: OcStep, company: Company, prefix = ""): Promise<void> {
  const q = nextOrderQuestion(s.answers, s.qctx!);
  if (!q) {
    await finishOrder(ctx, s, company, prefix);
    return;
  }
  s.field = q.field;
  await save(ctx, s);
  await ctx.reply(prefix ? `${prefix}\n\n${q.text}` : q.text);
}

async function attachLate(ctx: PortalContext, s: OcStep, media: Media, company: Company): Promise<void> {
  const prompt = currentPrompt(s);
  if (ctx.now.getTime() > Date.parse(s.mediaUntil)) {
    await ctx.reply(`Ese adjunto llegó más de 10 min después del comando *oc*: no lo guardé como OC.\n\n${prompt}`);
    return;
  }
  const file = await downloadOc(ctx, media, company, s.numero);
  if (!file) {
    await ctx.reply(`No pude descargar el adjunto; mándalo de nuevo.\n\n${prompt}`);
    return;
  }
  await ctx.store.updatePurchaseOrder(s.orderId, { fileName: file.fileName, mimeType: file.mimeType, data: file.data });
  s.hasFile = true;
  await save(ctx, s);
  await ctx.reply(`📎 Guardé la OC (${file.fileName}).\n\n${prompt}`);
}

registerPendingHandler(OC_STEP, async (ctx, step, rawText) => {
  const s = step as OcStep;
  const company = await ctx.store.getCompany(s.companyId);
  if (!company) {
    await clearPending(ctx.store, ctx.from);
    await ctx.reply("Esa empresa ya no está en el portal; dejé el pedido.");
    return true;
  }
  const media = mediaOf(ctx);
  if (media) {
    await attachLate(ctx, s, media, company);
    return true;
  }
  let text = rawText.trim();
  if (ctx.msg.type === "audio" && ctx.msg.media) {
    const t = await transcribeVoice(ctx, { id: ctx.msg.media.id, mimeType: ctx.msg.media.mimeType });
    if (t === null) return true; // ya se avisó; la pregunta sigue en pie
    text = t;
  }

  if (s.phase === "quote") {
    if (YES_QUOTE.test(text) || isDefaultAnswer(text)) {
      await enterQuestions(ctx, s, company, s.quoteItems ?? [], "");
      return true;
    }
    if (/^no[.!]*$/i.test(text)) {
      s.phase = "items";
      s.quoteNumber = null;
      s.quoteItems = null;
      await save(ctx, s);
      await ctx.reply(itemsPrompt());
      return true;
    }
    s.quoteNumber = null; // escribió los ítems: la cotización no se usa
    s.quoteItems = null;
    s.phase = "items";
  }

  if (s.phase === "items") {
    if (!text) {
      await ctx.reply(itemsPrompt());
      return true;
    }
    const res = await parseOrderItems(text, { priceStore: await priceStore(), settings: settings(), today: limaDateKey(ctx.now) });
    if (!res.ok) {
      await save(ctx, s);
      await ctx.reply(res.error);
      return true;
    }
    s.currency = res.currency;
    await enterQuestions(ctx, s, company, res.items, `Entendí:\n${itemLines(res.items, res.currency)}\nTotal: ${money(itemsTotal(res.items), res.currency)} inc. IGV`);
    return true;
  }

  // preguntas
  const q = nextOrderQuestion(s.answers, s.qctx!);
  if (!q) {
    await finishOrder(ctx, s, company, "");
    return true;
  }
  // un pedido no es una observación: el mensaje sigue al cotizador y el pedido se aparta (routePortal avisa)
  if (q.field === "observaciones" && orderShaped(text)) return false;
  const r = applyOrderAnswer(s.answers, q, text, s.qctx!, ctx.now);
  if (r.error) {
    await ctx.reply(`${r.error}\n\n${q.text}`);
    return true;
  }
  s.answers = r.answers;
  await askNext(ctx, s, company);
  return true;
});

// ── pedido ──

async function finishOrder(ctx: PortalContext, s: OcStep, company: Company, prefix: string): Promise<void> {
  const { store, user, now } = ctx;
  const a = s.answers;
  const items = s.items ?? [];
  const cur = s.currency;
  const data: PedidoData = {
    fecha: limaDateKey(now),
    atc: user.nombre,
    moneda: cur === "PEN" ? "PEN" : "USD",
    cliente: { razonSocial: company.razonSocial, ruc: company.ruc, ...a.cliente },
    plazoCreditoDias: a.plazoCreditoDias ?? null,
    items,
    entrega: entregaFromAnswers(a),
    observaciones: a.observaciones,
  };
  const xlsx = await buildPedidoXlsx(data);
  const fileName = formatPedidoFileName(data);
  await clearPending(store, ctx.from);
  if (prefix) await ctx.reply(prefix);
  await ctx.sendDocument(xlsx, fileName, undefined, XLSX_MIME);

  const total = itemsTotal(items);
  const taxPct = items[0]?.igvPct ?? 18;
  const totalSinIgv = r2(total / (1 + taxPct / 100));
  const unidades = items.reduce((n, it) => n + it.cantidad, 0);

  // oportunidad: la de la OC si sigue abierta, la abierta de la empresa, o una nueva; a Cerrado ganado
  let opp = s.opportunityId ? await store.getOpportunity(s.opportunityId) : null;
  if (!opp || opp.closedAt) opp = (await store.getOpenOpportunity(company.id, user.id)) ?? (await store.getOpenOpportunity(company.id));
  if (!opp) opp = await store.createOpportunity({ companyId: company.id, ownerUserId: company.ownerUserId ?? user.id, quoteNumber: s.quoteNumber, montoEstimado: total, createdBy: user.id, at: now });
  await store.updateOpportunity(opp.id, { montoEstimado: total, ...(s.quoteNumber && !opp.quoteNumber ? { quoteNumber: s.quoteNumber } : {}) });
  opp = (await store.moveStage(opp.id, "cerrado_ganado", user.id, now)) ?? opp;

  await store.addActivity({
    companyId: company.id,
    opportunityId: opp.id,
    userId: user.id,
    tipo: ACT_OC,
    texto: `OC ${s.numero ?? "s/n"} · ${money(total, cur)} inc. IGV · ${unidades} und. · pedido para Patricia`,
    canal: "whatsapp",
    data: {
      orderId: s.orderId,
      numero: s.numero,
      quoteNumber: s.quoteNumber,
      pedidoFile: fileName,
      ventaEsperada: {
        moneda: cur,
        total,
        totalSinIgv,
        unidades,
        items: items.map((it) => ({ cantidad: it.cantidad, descripcion: pedidoDescription(it), precioUnitarioConIgv: pedidoUnitPrice(it), ...(it.terceros ? { proveedor: it.terceros.proveedor } : {}) })),
      },
      entrega: data.entrega,
      plazoCreditoDias: data.plazoCreditoDias,
    },
    occurredAt: now,
  });
  if (!company.esCliente) await store.updateCompany(company.id, { esCliente: true });
  // el plazo escrito en la OC solo queda como el de la empresa si no tenía uno; si tenía otro, no se cambia (se dice)
  let plazoNote = "";
  if (a.plazoEscrito && a.plazoCreditoDias != null && a.plazoCreditoDias !== company.creditTermsDays) {
    if (company.creditTermsDays === null) await setCompanyCreditTerms(store, company.id, a.plazoCreditoDias);
    else plazoNote = `El plazo habitual sigue en ${company.creditTermsDays} días; cámbialo en el portal si corresponde.`;
  }
  await store.setOrderProfile(company.id, profileFromAnswers(s.qctx?.profile ?? {}, a) as Record<string, unknown>);
  await store.updatePurchaseOrder(s.orderId, { status: OC_STATUS_DONE, opportunityId: opp.id, quoteNumber: s.quoteNumber });

  const c = data.cliente;
  const lines = [
    `✅ Pedido de *${shortName(company.razonSocial)}* listo (${[s.numero ? `OC ${s.numero}` : "OC sin n°", s.quoteNumber ? `cotización ${shortQuoteNumber(s.quoteNumber)}` : ""].filter(Boolean).join(", ")}):`,
    itemLines(items, cur),
    `Total: *${money(total, cur)}* inc. IGV (${money(totalSinIgv, cur)} sin IGV)`,
    `Entrega: ${fechaEntregaLabel(a.fechaEntrega)} en ${c.direccionEntrega || "—"} · Contacto: ${c.contacto || "—"}`,
    `Enllante: ${a.enllante ?? "—"} · Marcado: ${a.marcado ?? "—"} · Flete: ${[a.flete, a.valorFlete].filter(Boolean).join(" ") || "—"} · ${data.plazoCreditoDias == null ? "Plazo: —" : data.plazoCreditoDias <= 0 ? "Contado" : `Crédito ${data.plazoCreditoDias} días`}`,
    ...(s.qctx?.terceros ? [`Proveedor: ${a.pagoProveedor || "—"} · Recojo: ${a.recojo || "—"}`] : []),
    ...(c.agencia ? [`Agencia: ${agenciaText(c)}`] : []),
    ...(a.observaciones ? [`Obs.: ${a.observaciones}`] : []),
    `Oportunidad → *${stageLabel(opp.etapa)}*.${s.hasFile ? "" : " _(OC sin adjunto)_"}`,
    ...(plazoNote ? [plazoNote] : []),
    "",
    PATRICIA_REMINDER,
  ];
  await ctx.reply(lines.join("\n"));
}
