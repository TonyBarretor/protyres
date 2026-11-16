/**
 * `oc <empresa> [n° de OC]` (bloque B5b): la orden de compra del cliente y el pedido para Patricia.
 *
 *  1. Guarda la OC (purchase_orders, status "recibida") con el PDF o la imagen si vino adjunta (leyenda `oc …`) o si llega
 *     en los 10 min siguientes al comando, durante las preguntas.
 *  2. Ítems: los de la cotización enlazada (la de la oportunidad abierta, o la última del vendedor a ese cliente) tras
 *     confirmar con *sí*; sin cotización (o si el vendedor escribe otros), con el formato de cotización
 *     (order/items.ts: parser y listas del cotizador). Máximo 7 (filas del formato).
 *  3. Preguntas una por una (order/questions.ts) con la memoria del cliente (company_order_profile) como defecto;
 *     también por voz (misma transcripción que los reportes). `cancelar` aborta (lo limpia routePortal). Las preguntas
 *     con valor por defecto o sí/no llevan botones (questionButtons; *Sí* y *No* para usar la cotización): cada id es la
 *     respuesta escrita equivalente ("igual", "sí", "no", "ninguna", "la misma"...).
 *  4. Excel "FORMATO PEDIDO ATC´S" sin leyenda + resumen con el recordatorio de reenviarlo a Patricia. Oportunidad a
 *     Cerrado ganado, actividad `oc` con la venta esperada en `data` (no se inserta en `sales`: eso llega del Excel de
 *     ventas), empresa como cliente, memoria del cliente y OC en "pedido_generado".
 *
 * Router (regla 9): en la fase de ítems el paso lleva `captureText` (los ítems tienen forma de pedido y no deben irse al
 * cotizador); en las demás, `keepText` (se queda con las respuestas, pero una medida de llanta es un pedido nuevo). En
 * todas, los comandos del cotizador (`ayuda`, `proveedores`...) van al cotizador. `acceptsMedia`: el adjunto sin leyenda
 * (o con leyenda `oc …`) dentro de los 10 min; una lista de precios o una `foto …` siguen al cotizador.
 *
 * Si el mensaje se va al cotizador (o llega otro comando del portal), el pedido NO se pierde ni se queda capturando: pasa
 * a pausa (bot/pause.ts, corrida D: reemplaza al `parked` de 24 h) y, al final de la respuesta, "⏸ Dejaste pendiente:
 * pedido de ZBUSS (falta fecha de entrega)." con *Continuar* / *Descartar*. *Continuar* (o `oc` a la misma empresa, sin n°
 * o con el mismo) lo retoma donde quedó, con la misma OC y las respuestas dadas. No se deja pendiente porque un paso
 * pendiente se quedaría con el siguiente "sí"/"gracias" tras la cotización. `cancelar` durante el pedido, *Descartar* o
 * la caducidad de la pausa (48 h) marcan la OC como "cancelada".
 *
 * Al empezar, si el cotizador está revisando una cotización ya guardada (`review_quote`, `need_email`), ese paso se cierra
 * como con `cancelar`: si no, las respuestas cortas ("sí", "igual") irían al cotizador. Con una cotización o lista a medio
 * armar (otros pasos, o un perfil esperando el pedido) no se toca nada y se le pide terminarla o cancelarla.
 *
 * Permisos: como `cita`, solo quien puede editar la empresa (dueño, supervisor o admin).
 *
 * Corrida H (puntos 3, 4 y 6), entre los ítems y las preguntas:
 *  - Contraste: si los ítems se escribieron habiendo una cotización, o la OC llegó como Excel (formato Prosegur y
 *    parecidos), se comparan con la cotización (producto, cantidad total, precio y UB); si no coinciden, se muestra y se
 *    pregunta (fase `check`).
 *  - Origen de cada producto (order/origin.ts): stock propio o proveedor (lista de proveedores); el que no se identifica
 *    se pregunta (fase `origin`), con sugerencias por marca.
 *  - Stock propio frente al disponible (cargado − pedidos desde esa carga): si se pide más, se avisa y se sigue solo con
 *    *sí* (fase `stock`). Al generar el pedido se descuenta (orderStockKey: la misma OC rehecha reemplaza lo anterior;
 *    `anular oc …` lo devuelve).
 *  - Pedidos por sucursal (cotizaciones de Prosegur con unidad): un Excel por sucursal, con su memoria (entrega, agencia,
 *    contacto con DNI, flete, enllante, marcado, observaciones), el número de venta y el nombre
 *    "<Mes><aa>- Prosegur - Venta <NNN> <Sucursal> UBs <ub>-<ub>.xlsx"; varias cotizaciones (*471 475*) = varias sucursales.
 */
import type { PriceRow } from "../../../ingest/types";
import { cleanFileName, XLSX_MIME } from "../../../quote/files";
import { fmtMoney, r2 } from "../../../quote/pricing";
import type { Quote } from "../../../quote/types";
import { loadSettings, type Settings } from "../../../settings";
import { getStore } from "../../../store";
import type { PriceStore } from "../../../store/types";
import ExcelJS from "exceljs";
import { foldKey, supplierKey, type Supplier } from "../../../store/types";
import { loadPortalConfig } from "../../config";
import { crossCheck, linesFromSheet, type CheckLine } from "../../order/crosscheck";
import { ORDER_ITEMS_EXAMPLE, parseOrderItems, type ModelChoice } from "../../order/items";
import { applyOrderEdit, orderItemsFromVoice } from "../../order/voice-items";
import { spokenToDigits } from "../../voice/dictation";
import { parseVoiceEdit, type VoiceEdit } from "../../voice/items";
import { availableText, committedMap, deductionsFor, orderStockKey, resolveOrigins, stockChecks, stockRowFor, unknownOrigins } from "../../order/origin";
import {
  buildPedidoXlsx,
  formatPedidoFileName,
  groupPedidoItems,
  pedidoDescription,
  pedidoFromQuote,
  pedidoTooManyItems,
  pedidoUnitPrice,
  plazoDiasFromTerm,
  PEDIDO_MAX_ITEMS,
  type PedidoData,
  type PedidoItem,
} from "../../order/pedido-xlsx";
import { findSupplier, suggestSuppliers, supplierForProvider, supplierLabel } from "../../order/suppliers";
import {
  agenciaText,
  applyOrderAnswer,
  branchProfile,
  entregaFromAnswers,
  fechaEntregaLabel,
  isDefaultAnswer,
  nextOrderQuestion,
  nextVenta,
  profileFromAnswers,
  questionButtons,
  titleWords,
  withBranchProfile,
  type QuickAnswer,
  type OrderAnswers,
  type OrderField,
  type OrderProfile,
  type QuestionContext,
} from "../../order/questions";
import { canEditCompany } from "../../auth/permissions";
import { ACT_QUOTE, quoteNumberMatches, setCompanyCreditTerms, shortQuoteNumber } from "../../quotes/link";
import { brandsInText, fold } from "../../../tyre/brands";
import { findTyreSizes } from "../../../tyre/spec";
import { stageLabel } from "../../stages";
import type { Company, Opportunity } from "../../store/types";
import { limaDateKey } from "../../ui/time";
import { findCompanies, resolveCompany, shortName, splitCompany, unusedNote } from "../companies";
import { companyProgressLine } from "../progress";
import { registerCompanyAction, registerPausable, registerPendingDrop, registerPendingHandler, registerPortalCommand, replyButtons, type PortalContext } from "../registry";
import { downloader, transcribeVoice } from "../report";
import { clearLegacyParked, clearPending, parkedOf, pausedOf, removePaused, setPending, type PendingStep } from "../state";
import { creditWarning } from "../../credit/warning";

export const OC_STEP = "oc_pedido";
export const ACT_OC = "oc";
/** El adjunto de la OC se acepta hasta 10 min después del comando. */
export const OC_MEDIA_WINDOW_MS = 10 * 60 * 1000;
export const OC_STATUS_RECEIVED = "recibida";
export const OC_STATUS_DONE = "pedido_generado";
export const OC_STATUS_CANCELLED = "cancelada";
/** Corrida H: pedido ya generado que el vendedor anuló (`anular oc …`): su stock se devolvió. */
export const OC_STATUS_VOIDED = "anulada";
export const PATRICIA_REMINDER = "📧 Reenvía este Excel por correo a Patricia para el pedido.";
/** Corrida H, punto 6: con varias sucursales, un Excel por sucursal y un correo por Excel. */
export const PATRICIA_REMINDER_BRANCHES = "📧 Cada Excel va en un correo aparte a Patricia (uno por sucursal).";
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

type Phase = "quote" | "items" | "model" | "check" | "origin" | "stock" | "questions";

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
  /**
   * Fase `model` (corrida F, punto 7): los ítems escritos, los que piden un modelo que no existe en esa medida (se
   * pregunta el primero) y lo ya elegido (índice de línea -> id de la fila, o "manual" = tal como se escribió).
   */
  itemsText?: string | null;
  choices?: ModelChoice[] | null;
  picks?: Record<number, string> | null;
  /** Corrida H: cotizaciones usadas (varias = una por sucursal). */
  quoteNumbers?: string[] | null;
  /** Cotización propuesta cuyos ítems el vendedor reemplazó escribiendo otros (para el contraste). */
  comparedQuote?: string | null;
  /** Fase check: diferencias con la cotización / la OC, ya mostradas. */
  checkDiffs?: string[] | null;
  /** Ya se pasó el contraste y el control de stock (no se vuelven a preguntar). */
  checked?: boolean;
  stockOk?: boolean;
  /** Fase origin: ítems sin origen identificable (se pregunta el primero). */
  origins?: number[] | null;
  /** Fase stock: avisos de stock insuficiente. */
  stockWarn?: string[] | null;
  /** Pedido por sucursal: sucursales en orden, la actual y las respuestas de las anteriores. */
  branches?: string[] | null;
  branchIdx?: number;
  branchAnswers?: OrderAnswers[] | null;
  /** Fase origin: proveedores sugeridos para la marca (texto y nombres para los botones). */
  suggestions?: string[] | null;
  suggestionNames?: string[] | null;
  /** Nombre del cliente para el archivo por sucursal ("Prosegur", del perfil de cliente de la cotización). */
  clientLabel?: string | null;
}

interface OcArgs {
  numero: string | null;
  media: Media | null;
  /** "No usé: «…»." (texto de más en el comando), en la cabecera de la respuesta. */
  note?: string;
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

const OC_KEYWORD = /^(?:oc|o\/c|n[°ºo]\.?|nro\.?|n[uú]mero|#)$/i;

/**
 * Texto de más (corrida D): el n° de OC en cualquier parte ("zbuss 4500123 y responde las preguntas", "4500123 de zbuss",
 * "la empresa 20602221505 n° 4501000 urgente"). Número = token con 5 o más dígitos (o cualquiera con dígitos tras
 * `oc` / `n°` / `nro` / `#`), sin contar un RUC de 11 dígitos. Lo de antes es la empresa (o lo de después, si el número
 * va primero) y lo de después sobra (`rest`); sin número, todo es la empresa.
 */
export function parseOcLoose(args: string): { empresa: string; numero: string | null; rest: string } {
  const toks = args.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i].replace(/[,;.:]+$/, "").replace(/^#/, "");
    if (/^\d{11}$/.test(tok) || !/^[A-Za-z0-9][\w/-]*$/.test(tok)) continue;
    const afterKw = i > 0 && OC_KEYWORD.test(toks[i - 1]);
    const nd = (tok.match(/\d/g) ?? []).length;
    if (!(nd >= 5 || (afterKw && nd >= 1)) || OC_KEYWORD.test(tok)) continue;
    const before = toks
      .slice(0, afterKw ? i - 1 : i)
      .join(" ")
      .replace(/[\s,;]*(?:(?:la\s+)?orden(?:\s+de\s+compra)?|oc)\s*$/i, "")
      .trim();
    const after = toks.slice(i + 1).join(" ");
    if (!before) return { empresa: after.replace(/^(?:de|del|para|a|al)\s+/i, ""), numero: tok, rest: "" };
    return { empresa: before, numero: tok, rest: after };
  }
  return { empresa: args.trim(), numero: null, rest: "" };
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

/**
 * Antes de retomar un proceso en pausa (corrida D): con el cotizador revisando una cotización ya guardada, ese paso se
 * cierra (como al empezar `oc`) y se puede seguir; con una cotización o lista a medio armar, no (null = se puede).
 */
export async function quoterBlocksResume(ctx: PortalContext, quoteStep: string): Promise<string | null> {
  if (quoteStep === "idle") return null;
  if (!CLOSABLE_QUOTER_STEPS.has(quoteStep)) return "Tienes una cotización/lista a medio armar; termínala (p. ej. *ok*) o escribe *cancelar*, y luego *continuar*.";
  await endQuoterFlow(ctx);
  return null;
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

/** Disponible de cada fila de stock propio (cargado y comprometido por otros pedidos), para mostrarlo con los ítems. */
type Avail = Record<string, { cargadas: number; enPedidos: number }>;

function itemLines(items: PedidoItem[], cur: string, avail?: Avail): string {
  return items
    .map((it) => {
      const a = it.stock?.rowId ? avail?.[it.stock.rowId] : undefined;
      const origin = it.terceros ? ` _(${it.terceros.proveedor})_` : a ? ` _(${availableText({ ...a, disponible: a.cargadas - a.enPedidos })})_` : "";
      const ubs = it.ubs?.length ? ` · UB ${it.ubs.join(", ")}` : "";
      return `• ${it.cantidad} × ${pedidoDescription(it)} — ${money(pedidoUnitPrice(it), cur)} c/u${origin}${ubs}`;
    })
    .join("\n");
}

function shortItems(items: PedidoItem[]): string {
  const shown = items.slice(0, 3).map((it) => `${it.cantidad} × ${pedidoDescription(it)}`);
  if (items.length > 3) shown.push(`y ${items.length - 3} ítems más`);
  return shown.join("; ");
}

const itemsPrompt = () => `Escríbeme los ítems de la OC con el formato de cotización, uno por línea (máximo ${PEDIDO_MAX_ITEMS}):\n${ORDER_ITEMS_EXAMPLE}`;

function quotePrompt(s: Pick<OcStep, "quoteNumber" | "quoteItems" | "currency">): string {
  const items = s.quoteItems ?? [];
  const branch = items.find((it) => it.sucursal)?.sucursal;
  const several = branch ? ` Si la OC cubre varias sucursales, escribe los números de sus cotizaciones (p. ej. *${shortQuoteNumber(s.quoteNumber ?? "")} 475*).` : "";
  return `Uso la cotización *${shortQuoteNumber(s.quoteNumber ?? "")}*${branch ? ` de *${titleWords(branch)}*` : ""} (${shortItems(items)} · ${money(itemsTotal(items), s.currency)} inc. IGV) — responde *sí*, o *no* para escribir otros ítems.${several}`;
}

// ── modelo que no existe en esa medida (corrida F, punto 7) ──

const clip20 = (t: string) => (t.length > 20 ? `${t.slice(0, 19).trimEnd()}…` : t);
export const MODEL_KEEP_ID = "tal cual";

/** "¿Cuál va en el pedido?" para el primer ítem sin su modelo: lo pedido, las opciones con precio y qué responder. */
export function modelPrompt(s: Pick<OcStep, "choices" | "currency">): string {
  const c = s.choices?.[0];
  if (!c) return "";
  const opts = c.options.map((o, i) => `${i + 1}. ${o.label} — ${money(o.unitWithTax, s.currency)} c/u inc. IGV`);
  const keep = c.canKeep ? `\nO *Dejar como escribí*: ${c.model} con tu precio, como ítem manual.` : "";
  const price = c.canKeep ? " Si eliges otro modelo, se mantiene el precio que escribiste." : "";
  return `⚠️ No tengo *${c.model}* en esa medida (${c.asked}). No lo cambio sin preguntarte; los más cercanos:\n${opts.join("\n")}${keep}\n¿Cuál va en el pedido?${price} (O escríbeme los ítems de nuevo.)`;
}

function modelButtons(c: ModelChoice): QuickAnswer[] {
  const b = c.options.map((o, i) => ({ id: `modelo ${i + 1}`, title: clip20(o.short || o.label) }));
  if (c.canKeep) b.push({ id: MODEL_KEEP_ID, title: "Dejar como escribí" });
  return b;
}

/** La respuesta a "¿cuál va en el pedido?": id de la fila, "manual" o null (no es respuesta). */
export function modelAnswer(text: string, c: ModelChoice): string | null {
  const t = fold(text).replace(/^(?:el|la|modelo|opcion|usa|usar)\s+/, "").trim();
  if (!t) return null;
  if (c.canKeep && /^(?:tal cual|dejar(?: como escribi| asi| tal cual)?|como (?:lo )?escribi|manual|el mio|el que escribi)$/.test(t)) return "manual";
  const n = /^(\d)$/.exec(t);
  if (n) return c.options[parseInt(n[1], 10) - 1]?.id ?? null;
  const hit = c.options.filter((o) => fold(o.short || o.label) === t || fold(o.label) === t || fold(o.label).endsWith(` ${t}`));
  return hit.length === 1 ? hit[0].id : null;
}

/** Botones de la pregunta en curso: *Sí* y *No* para usar la cotización; los de order/questions.ts en las preguntas. */
function currentButtons(s: OcStep): QuickAnswer[] {
  if (s.phase === "quote" || s.phase === "check" || s.phase === "stock") return [{ id: "sí", title: "Sí" }, { id: "no", title: "No" }];
  if (s.phase === "origin") return originButtons(s);
  if (s.phase === "model" && s.choices?.[0]) return modelButtons(s.choices[0]);
  if (s.phase === "questions" && s.qctx) {
    const q = nextOrderQuestion(s.answers, s.qctx);
    return q ? questionButtons(q) : [];
  }
  return [];
}

/** Responde `body` (que termina en la pregunta en curso) con sus botones si los tiene; en texto, el mismo body. */
async function ask(ctx: PortalContext, s: OcStep, body: string): Promise<void> {
  const buttons = currentButtons(s);
  if (buttons.length) await replyButtons(ctx, body, buttons, { fallback: body });
  else await ctx.reply(body);
}

/** La pregunta en curso (para repetirla). */
function currentPrompt(s: OcStep): string {
  if (s.phase === "quote") return quotePrompt(s);
  if (s.phase === "items") return itemsPrompt();
  if (s.phase === "model") return modelPrompt(s);
  if (s.phase === "check") return checkPrompt(s);
  if (s.phase === "origin") return originPrompt(s);
  if (s.phase === "stock") return stockPrompt(s);
  return (s.qctx && nextOrderQuestion(s.answers, s.qctx)?.text) ?? "";
}

async function save(ctx: PortalContext, s: OcStep): Promise<void> {
  const { createdAt: _c, ...rest } = s;
  // las banderas del router siguen a la fase: solo los ítems capturan cualquier texto
  await setPending(ctx.store, ctx.from, { ...rest, captureText: s.phase === "items" || s.phase === "model", keepText: s.phase !== "items" && s.phase !== "model", createdAt: ctx.now.toISOString() }, ctx.now);
}

const notYours = (c: Company) => `*${c.razonSocial}* no es tuya. Primero: *asignarme ${c.ruc}* (o pide al supervisor).`;

/** Qué falta en el pedido, para el recordatorio de la pausa ("falta fecha de entrega"). */
const FIELD_MISSING: Record<OrderField, string> = {
  cliente: "faltan los datos del cliente",
  direccionFiscal: "falta la dirección fiscal",
  direccionEntrega: "falta la dirección de entrega",
  contacto: "falta el contacto",
  agencia: "falta la agencia",
  fechaEntrega: "falta fecha de entrega",
  enllante: "falta si va enllantado",
  marcado: "falta si va marcado",
  flete: "falta el flete",
  plazoCredito: "falta el plazo de crédito",
  proveedor: "faltan las condiciones del proveedor",
  observaciones: "faltan las observaciones",
  observacionesTerceros: "faltan las observaciones del despacho",
  venta: "falta el número de venta",
};

export function orderMissing(s: OcStep): string {
  if (s.phase === "quote") return "falta confirmar la cotización";
  if (s.phase === "items") return "faltan los ítems";
  if (s.phase === "model") return "falta elegir el modelo";
  if (s.phase === "check") return "falta confirmar las diferencias con la cotización";
  if (s.phase === "origin") return "falta de dónde sale un producto";
  if (s.phase === "stock") return "falta confirmar el stock";
  const q = s.qctx ? nextOrderQuestion(s.answers, s.qctx) : null;
  return q ? FIELD_MISSING[q.field] : "falta generar el pedido";
}

/** Con `cancelar` (o *Descartar* / caducidad de la pausa) la OC queda "cancelada"; dejarlo por otra cosa lo pone en pausa (routePortal). */
registerPendingDrop(OC_STEP, async (dctx, step, reason) => {
  const s = step as OcStep;
  if (reason === "cancel") {
    const order = await dctx.store.getPurchaseOrder(s.orderId);
    if (order && order.status === OC_STATUS_RECEIVED) await dctx.store.updatePurchaseOrder(s.orderId, { status: OC_STATUS_CANCELLED });
    await clearLegacyParked(dctx.store, dctx.from, OC_STEP);
  }
  return null;
});

/** En pausa: "pedido de ZBUSS (falta fecha de entrega)"; *Continuar* lo retoma donde quedó (misma OC). */
registerPausable(OC_STEP, {
  async describe(ctx, step) {
    const s = step as OcStep;
    const company = await ctx.store.getCompany(s.companyId).catch(() => null);
    return { companyId: s.companyId, label: `pedido de ${s.numero ? `la OC ${s.numero} de ` : ""}${company ? shortName(company.razonSocial) : "la empresa"}`, missing: orderMissing(s) };
  },
  async resume(ctx, step, prefix) {
    const s = step as OcStep;
    const company = await ctx.store.getCompany(s.companyId);
    if (!company) {
      await ctx.reply("Esa empresa ya no está en el portal; dejé el pedido.");
      return;
    }
    await resumeOrder(ctx, s, company, null, prefix);
  },
});

/** El pedido en pausa de esta empresa (y de este n° de OC si se escribió), si la OC sigue sin pedido; lo saca de la pausa. */
async function takeParked(ctx: PortalContext, company: Company, numero: string | null): Promise<OcStep | null> {
  const conv = await ctx.store.getPortalConversation(ctx.from);
  const parked = parkedOf(conv, OC_STEP, ctx.now) as OcStep | null;
  if (!parked || parked.companyId !== company.id || (numero && parked.numero && numero !== parked.numero)) return null;
  const order = await ctx.store.getPurchaseOrder(parked.orderId);
  const hit = pausedOf(conv).find((p) => p.step.kind === OC_STEP && (p.step as OcStep).orderId === parked.orderId);
  if (hit) await removePaused(ctx.store, ctx.from, hit.ref);
  await clearLegacyParked(ctx.store, ctx.from, OC_STEP);
  return order && order.status === OC_STATUS_RECEIVED ? parked : null;
}

/** Retoma el pedido donde quedó (misma OC; el adjunto se acepta otros 10 min). */
async function resumeOrder(ctx: PortalContext, parked: OcStep, company: Company, media: Media | null, prefix = ""): Promise<void> {
  const order = await ctx.store.getPurchaseOrder(parked.orderId);
  if (!order || order.status !== OC_STATUS_RECEIVED) {
    await ctx.reply(`Esa OC ya no está pendiente (${order ? order.status : "no existe"}); escribe *oc ${company.ruc}* para registrar otra.`);
    return;
  }
  const head = [prefix || `▶️ Retomo el pedido de la OC${parked.numero ? ` *${parked.numero}*` : ""} de *${shortName(company.razonSocial)}*.`];
  parked.mediaUntil = new Date(ctx.now.getTime() + OC_MEDIA_WINDOW_MS).toISOString();
  if (media) {
    const file = await downloadOc(ctx, media, company, parked.numero);
    if (file) {
      await ctx.store.updatePurchaseOrder(parked.orderId, { fileName: file.fileName, mimeType: file.mimeType, data: file.data });
      parked.hasFile = true;
      head.push(`📎 Guardé la OC (${file.fileName}).`);
    }
  }
  await save(ctx, parked);
  await ask(ctx, parked, `${head.join("\n")}\n\n${currentPrompt(parked)}`);
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
    await resumeOrder(ctx, parked, company, args.media);
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
  if (args.note) head.push(args.note);
  if (args.media && !file) head.push("⚠️ No pude descargar el adjunto; envíamelo de nuevo en los próximos 10 min.");
  else if (!file) head.push("📎 Si tienes el PDF o la foto de la OC, envíamelo en los próximos 10 min.");
  const credit = await creditWarning(ctx.store, company); // aviso (C4), no bloquea la OC
  if (credit) head.push(credit);

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
  await ask(ctx, s, `${head.join("\n")}\n\n${currentPrompt(s)}`);
}

registerCompanyAction("oc", (ctx, company, args) => startOrder(ctx, company, args as unknown as OcArgs));

registerPortalCommand("oc", async (ctx, args) => {
  let p = parseOcArgs(args);
  if (!p.numero) {
    // número corto al final ("oc roca 7788"): es el n° de OC si el texto entero no es una empresa ("expreso 2000")
    const alt = splitTrailingNumber(p.empresa);
    if (alt && /^\D/.test(p.empresa) && (await findCompanies(ctx.store, p.empresa)).total === 0) p = alt;
  }
  let note = "";
  if (p.empresa && (await findCompanies(ctx.store, p.empresa)).total === 0) {
    // texto de más: número en cualquier parte y empresa al inicio de lo que queda; lo que sobra se dice en una línea
    const loose = parseOcLoose(args);
    const split = await splitCompany(ctx.store, loose.empresa);
    if (split) {
      p = { empresa: split.query, numero: loose.numero ?? p.numero };
      note = unusedNote([split.rest, loose.rest].filter(Boolean).join(" "));
    }
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
  const a: OcArgs = { numero: p.numero, media: mediaOf(ctx), ...(note ? { note } : {}) };
  const company = await resolveCompany(ctx, p.empresa, "oc", a as unknown as Record<string, unknown>, { note });
  if (company) await startOrder(ctx, company, a);
});

// ── respuestas ──

/** Forma de pedido (no vale como observación): medida de llanta, cantidad ("x4", "8 llantas") o "cotiza…". */
export function orderShaped(text: string): boolean {
  return findTyreSizes(text).length > 0 || /\bx\s*\d{1,3}\b|\b\d{1,3}\s*(?:unidades|unds?|unid|llantas|neum[aá]ticos)\b|\bcot[ií]z/i.test(text);
}

const YES_QUOTE = /^(?:s[ií]|si+|ok|okey|dale|esa|usa(?:la)? esa|usala|correcto|claro|confirmo|igual|listo|de acuerdo)[.!]*$/i;
const NO_ANSWER = /^no[.!]*$/i;

// ── corrida H: varias cotizaciones, contraste, origen y stock ──

/** "471 475", "471 y 475", "cotizaciones 471, 475" -> los números (null si el texto no es solo eso). */
export function quoteNumbersIn(text: string): string[] | null {
  const t = fold(text).replace(/^(?:usa\s+)?(?:las?\s+)?(?:cotizaciones|cotizacion|cot)\s*/, "").trim();
  if (!/^\d{1,6}(?:\s*(?:,|y|e|\+|\s)\s*\d{1,6})*$/.test(t)) return null;
  return t.match(/\d{1,6}/g) ?? null;
}

/** Cotizaciones de la empresa por sus números cortos (las del vendedor primero); las que no encuentra, en `missing`. */
async function quotesByNumbers(ctx: PortalContext, company: Company, nums: string[]): Promise<{ quotes: Quote[]; missing: string[] }> {
  const ps = await priceStore();
  const name = shortName(company.razonSocial);
  const mine = await ps.listQuotes({ company: name, requestedBy: ctx.from, limit: 100 }).catch(() => [] as Quote[]);
  const all = mine.length ? mine : await ps.listQuotes({ company: name, limit: 100 }).catch(() => [] as Quote[]);
  const quotes: Quote[] = [];
  const missing: string[] = [];
  for (const n of nums) {
    const q = all.find((x) => quoteNumberMatches(x.number, n) && x.status !== "cancelled" && x.items.length);
    if (q && !quotes.includes(q)) quotes.push(q);
    else if (!q) missing.push(n);
  }
  return { quotes, missing };
}

/** Líneas de los ítems del pedido para el contraste (antes de agrupar: una por línea de cotización, con su UB). */
const checkLinesOfItems = (items: PedidoItem[]): CheckLine[] => items.map((it) => ({ producto: pedidoDescription(it), cantidad: it.cantidad, precio: it.precioUnitarioSinIgv, ub: it.ubs?.[0] }));

/** "Prosegur": el nombre del perfil de cliente de la cotización (config/customers.json), si lo tiene. */
function clientLabelOf(q: Quote | null | undefined): string | null {
  const id = q?.customerProfile;
  if (!id) return null;
  const p = settings().customers.find((c) => fold(c.name) === fold(id) || (c as { format?: string }).format === id);
  return p?.name ?? null;
}

/** Líneas de la cotización (una por línea, con su UB) para el contraste. */
function checkLinesOfQuote(q: Quote): CheckLine[] {
  return pedidoFromQuote(q).items.map((it) => ({ producto: pedidoDescription(it), cantidad: it.cantidad, precio: it.precioUnitarioSinIgv, ub: it.ubs?.[0] }));
}

/** Líneas de la OC si llegó como Excel (formato de Prosegur y parecidos); [] si no hay Excel o no tiene esa forma. */
async function ocSheetLines(ctx: PortalContext, s: OcStep): Promise<CheckLine[]> {
  if (!s.hasFile) return [];
  const order = await ctx.store.getPurchaseOrder(s.orderId).catch(() => null);
  if (!order?.data || !/sheet|excel|xlsx/i.test(`${order.mimeType ?? ""} ${order.fileName ?? ""}`)) return [];
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(order.data, "base64") as unknown as ArrayBuffer);
    for (const ws of wb.worksheets) {
      const lines = linesFromSheet(ws);
      if (lines.length) return lines;
    }
  } catch (err) {
    ctx.log(`portal: no pude leer la OC en Excel: ${(err as Error).message}`);
  }
  return [];
}

/** Diferencias entre lo que se va a pedir y la cotización enlazada (ítems escritos u OC en Excel). */
async function orderDiffs(ctx: PortalContext, s: OcStep, items: PedidoItem[]): Promise<string[]> {
  const ps = await priceStore();
  const nums = s.quoteNumbers?.length ? s.quoteNumbers : s.comparedQuote ? [s.comparedQuote] : [];
  const quotes = (await Promise.all(nums.map((n) => ps.getQuote(n).catch(() => null)))).filter((q): q is Quote => !!q);
  const quoteLines = quotes.flatMap(checkLinesOfQuote);
  const label = quotes.length ? `la cotización ${quotes.map((q) => shortQuoteNumber(q.number)).join(" y ")}` : "el pedido";
  const out: string[] = [];
  if (s.comparedQuote && quoteLines.length) out.push(...crossCheck(checkLinesOfItems(items), quoteLines, { a: "lo que escribiste", b: label }));
  const oc = await ocSheetLines(ctx, s);
  if (oc.length) out.push(...crossCheck(oc, quoteLines.length ? quoteLines : checkLinesOfItems(items), { a: "la OC", b: label }));
  return out;
}

function checkPrompt(s: Pick<OcStep, "checkDiffs">): string {
  return `⚠️ Antes de armar el pedido, esto no coincide:\n${(s.checkDiffs ?? []).map((d) => `• ${d}`).join("\n")}\n¿Sigo con el pedido así? *sí*, o *no* para escribir los ítems.`;
}

function originPrompt(s: Pick<OcStep, "origins" | "items" | "suggestions">): string {
  const it = s.items?.[s.origins?.[0] ?? -1];
  if (!it) return "";
  const sug = s.suggestions?.length ? `\nPara ${it.marca ? `*${it.marca.toUpperCase()}*` : "esa marca"} puedes pedir a: ${s.suggestions.join(" · ")}` : "";
  return `❓ ¿De dónde sale *${pedidoDescription(it)}* (${it.cantidad} und.)? No está en el stock ni en la lista de un solo proveedor.\nResponde *propio* (stock de nuestro almacén) o el proveedor (p. ej. *JCH*; con el precio de compra con IGV si lo sabes: *JCH 180*).${sug}`;
}

function originButtons(s: OcStep): QuickAnswer[] {
  const b: QuickAnswer[] = [{ id: "propio", title: "Stock propio" }]; // "stock …" es comando del cotizador
  for (const n of s.suggestionNames ?? []) if (b.length < 3) b.push({ id: n, title: clip20(n) });
  return b;
}

function stockPrompt(s: Pick<OcStep, "stockWarn">): string {
  return `⚠️ Stock propio insuficiente (contador de apoyo; Odoo manda):\n${(s.stockWarn ?? []).map((w) => `• ${w}`).join("\n")}\n¿Sigo igual con el pedido? *sí*, o *no* para escribir los ítems.`;
}

/** Proveedores de la lista y config para resolver orígenes. */
async function originDeps() {
  const ps = await priceStore();
  const orders = loadPortalConfig().orders;
  return { ps, rows: await ps.allRows(), suppliers: await ps.listSuppliers().catch(() => [] as Supplier[]), overrides: orders.supplierProviders, own: orders.ownStock, pricing: settings().pricing };
}

/** Disponible por fila de stock de los ítems (sin contar lo que ya descontó esta misma OC: rehacerla no se cuenta a sí misma). */
async function availOf(s: OcStep, items: PedidoItem[], rows: PriceRow[]): Promise<Avail> {
  const ps = await priceStore();
  const committed = committedMap(await ps.listStockDeductions().catch(() => []), orderStockKey(s.companyId, s.numero, s.orderId));
  const out: Avail = {};
  for (const it of items) {
    const id = it.stock?.rowId;
    const row = id ? rows.find((r) => r.id === id) : undefined;
    if (id && row && row.stock !== null) out[id] = { cargadas: row.stock, enPedidos: committed.get(id) ?? 0 };
  }
  return out;
}

/**
 * Ítems listos (de la cotización o escritos): origen de cada producto, contraste con la cotización / la OC, origen que
 * falta y stock; luego las preguntas. Cada control que pregunta deja la fase y se retoma con `advance`.
 */
async function prepareItems(ctx: PortalContext, s: OcStep, company: Company, items: PedidoItem[], prefix: string): Promise<void> {
  const d = await originDeps();
  s.items = resolveOrigins(items, d);
  s.checked = false;
  s.stockOk = false;
  s.origins = unknownOrigins(s.items);
  await advance(ctx, s, company, prefix);
}

async function advance(ctx: PortalContext, s: OcStep, company: Company, prefix: string): Promise<void> {
  const items = s.items ?? [];
  const head = (body: string) => (prefix ? `${prefix}\n\n${body}` : body);
  if (!s.checked) {
    s.checked = true;
    const diffs = await orderDiffs(ctx, s, items);
    if (diffs.length) {
      s.phase = "check";
      s.checkDiffs = diffs;
      await save(ctx, s);
      await ask(ctx, s, head(checkPrompt(s)));
      return;
    }
  }
  if (s.origins?.length) {
    s.phase = "origin";
    await setSuggestions(s);
    await save(ctx, s);
    await ask(ctx, s, head(originPrompt(s)));
    return;
  }
  if (!s.stockOk) {
    s.stockOk = true;
    const d = await originDeps();
    const avail = await availOf(s, items, d.rows);
    const committed = new Map(Object.entries(avail).map(([k, v]) => [k, v.enPedidos]));
    const short = stockChecks(items, d.rows, committed).filter((c) => c.pedido > c.disponible);
    if (short.length) {
      s.phase = "stock";
      s.stockWarn = short.map((c) => `*${c.description}*: pides ${c.pedido} y hay ${availableText(c)}.`);
      await save(ctx, s);
      await ask(ctx, s, head(stockPrompt(s)));
      return;
    }
  }
  await enterQuestions(ctx, s, company, items, prefix);
}

/** Sugerencias por marca para el producto sin origen (lista de proveedores). */
async function setSuggestions(s: OcStep): Promise<void> {
  const it = s.items?.[s.origins?.[0] ?? -1];
  s.suggestions = [];
  s.suggestionNames = [];
  if (!it?.marca) return;
  const ps = await priceStore();
  const list = await ps.listSuppliers().catch(() => [] as Supplier[]);
  const origin = Object.entries(settings().quote.brandOrigin).find(([k]) => fold(k) === fold(it.marca!))?.[1];
  const sug = suggestSuppliers(it.marca, list, { origin });
  s.suggestions = sug.map(supplierLabel);
  s.suggestionNames = sug.map((x) => x.name);
}

/** "stock" / "jch 180" / "van llantas" -> el origen elegido; null si no se entiende. */
export function parseOriginAnswer(text: string, suppliers: Supplier[]): { stock: true } | { proveedor: string; precio?: number; supplier?: Supplier } | null {
  const t = text.trim();
  if (!t) return null;
  if (/^(?:stock|almac[eé]n|propio|nuestro|de\s+stock|stock\s+propio|san\s+luis)\b/i.test(fold(t))) return { stock: true };
  const m = t.match(/^(.*?)[\s,]*(?:a\s+|precio\s+|s\/\.?\s*|us?\$\s*|\$\s*)?(\d+(?:[.,]\d{1,2})?)\s*(?:c\/u|con igv|inc\.? igv)?$/i);
  const name = (m ? m[1] : t).replace(/^(?:proveedor|de|del|a)\s+/i, "").trim();
  if (!name || name.length < 2 || /^\d+$/.test(name)) return null;
  const precio = m ? Number(m[2].replace(",", ".")) : undefined;
  const supplier = findSupplier(name, suppliers);
  return { proveedor: supplier?.name ?? name.toUpperCase(), ...(precio !== undefined ? { precio } : {}), ...(supplier ? { supplier } : {}) };
}

async function enterQuestions(ctx: PortalContext, s: OcStep, company: Company, items: PedidoItem[], prefix: string): Promise<void> {
  s.items = items;
  s.phase = "questions";
  const branches = [...new Set(items.map((it) => it.sucursal).filter((b): b is string => !!b))];
  s.branches = branches.length ? branches : null;
  s.branchIdx = 0;
  s.branchAnswers = [];
  s.qctx = await questionContext(ctx, s, company, 0);
  await askNext(ctx, s, company, prefix);
}

/** Ítems de la sucursal `i` (todos sin sucursales). */
const branchItems = (s: OcStep, i: number): PedidoItem[] => (s.branches?.length ? (s.items ?? []).filter((it) => it.sucursal === s.branches![i]) : (s.items ?? []));

async function questionContext(ctx: PortalContext, s: OcStep, company: Company, i: number): Promise<QuestionContext> {
  const prof = await ctx.store.getOrderProfile(company.id);
  const root = (prof?.data ?? {}) as OrderProfile;
  const sucursal = s.branches?.[i];
  const profile = branchProfile(root, sucursal);
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
  const items = branchItems(s, i);
  const ps = await priceStore();
  const suppliers = await ps.listSuppliers().catch(() => [] as Supplier[]);
  const names = [...new Set(items.filter((it) => it.terceros).map((it) => it.terceros!.proveedor.trim().toUpperCase()))];
  const proveedores = names.map((nombre) => {
    const x = findSupplier(nombre, suppliers) ?? supplierForProvider(nombre, suppliers);
    const def = x && (x.lastPayment || x.lastDelivery) ? [x.lastPayment, x.lastDelivery].filter(Boolean).join(", ") : undefined;
    return { nombre, ...(def ? { def } : {}) };
  });
  const lastVenta = s.branchAnswers?.length ? s.branchAnswers[s.branchAnswers.length - 1].venta : root.last?.venta;
  return {
    profile,
    terceros: items.some((it) => !!it.terceros),
    proveedores,
    plazo,
    // sin sucursal: la dirección de la cotización como fiscal; con sucursal, la cotización trae la sucursal (no la fiscal)
    sugerencias: { direccionFiscal: sucursal ? undefined : quoteAddress, contacto: c0 ? [c0.nombre, c0.telefono ? `Cel. ${c0.telefono}` : ""].filter(Boolean).join(" - ") : undefined },
    cliente: shortName(company.razonSocial),
    ...(sucursal ? { sucursal, venta: { def: nextVenta(lastVenta) } } : {}),
  };
}

/** Siguiente pregunta; terminada una sucursal, la siguiente (con lo común ya respondido); al final, el pedido. */
async function askNext(ctx: PortalContext, s: OcStep, company: Company, prefix = ""): Promise<void> {
  let q = nextOrderQuestion(s.answers, s.qctx!);
  while (!q && s.branches && (s.branchIdx ?? 0) < s.branches.length - 1) {
    const done = s.answers;
    s.branchAnswers = [...(s.branchAnswers ?? []), done];
    s.branchIdx = (s.branchIdx ?? 0) + 1;
    s.qctx = await questionContext(ctx, s, company, s.branchIdx);
    // lo común a todas las sucursales no se vuelve a preguntar: dirección fiscal, plazo y condiciones de cada proveedor
    s.answers = {
      cliente: { direccionFiscal: done.cliente.direccionFiscal },
      clienteListo: done.cliente.direccionFiscal ? ["direccionFiscal"] : [],
      plazoCreditoDias: done.plazoCreditoDias,
      plazoEscrito: done.plazoEscrito,
      ...(done.proveedores ? { proveedores: done.proveedores } : {}),
      ...(done.pagoProveedor !== undefined ? { pagoProveedor: done.pagoProveedor, recojo: done.recojo } : {}),
      observacionesTerceros: undefined,
    };
    const branch = titleWords(s.branches[s.branchIdx]);
    prefix = `${prefix ? `${prefix}\n\n` : ""}✅ Listo *${titleWords(s.branches[s.branchIdx - 1])}*. Ahora el pedido de *${branch}*.`;
    q = nextOrderQuestion(s.answers, s.qctx);
  }
  if (!q) {
    await finishOrder(ctx, s, company, prefix);
    return;
  }
  s.field = q.field;
  await save(ctx, s);
  await ask(ctx, s, prefix ? `${prefix}\n\n${q.text}` : q.text);
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
  // corrida H: una OC en Excel que llega con las preguntas ya empezadas se contrasta igual (y se pregunta si no coincide)
  if (s.phase === "questions" && s.items?.length) {
    const diffs = await orderDiffs(ctx, s, s.items);
    if (diffs.length) {
      s.phase = "check";
      s.checkDiffs = diffs;
      await save(ctx, s);
      await ask(ctx, s, `📎 Guardé la OC (${file.fileName}).\n\n${checkPrompt(s)}`);
      return;
    }
  }
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
      s.quoteNumbers = s.quoteNumber ? [s.quoteNumber] : null;
      s.clientLabel = clientLabelOf(s.quoteNumber ? await (await priceStore()).getQuote(s.quoteNumber).catch(() => null) : null);
      await prepareItems(ctx, s, company, s.quoteItems ?? [], "");
      return true;
    }
    if (NO_ANSWER.test(text)) {
      s.phase = "items";
      s.comparedQuote = null; // dijo que no es esa cotización: no hay con qué contrastar
      s.quoteNumber = null;
      s.quoteItems = null;
      await save(ctx, s);
      await ctx.reply(itemsPrompt());
      return true;
    }
    // corrida H: los números de una o varias cotizaciones (una por sucursal)
    const nums = quoteNumbersIn(text);
    if (nums) {
      const { quotes, missing } = await quotesByNumbers(ctx, company, nums);
      if (missing.length || !quotes.length) {
        await ask(ctx, s, `No encontré la cotización ${missing.map((n) => `*${n}*`).join(", ")} de *${shortName(company.razonSocial)}*.\n\n${quotePrompt(s)}`);
        return true;
      }
      const items = quotes.flatMap((q) => pedidoFromQuote(q).items);
      s.quoteNumbers = quotes.map((q) => q.number);
      s.quoteNumber = quotes[0].number;
      s.quoteItems = items;
      s.quoteTerm = quotes[0].paymentTerm || null;
      s.currency = quotes[0].currency;
      s.clientLabel = clientLabelOf(quotes[0]);
      await prepareItems(ctx, s, company, items, `Uso ${quotes.length > 1 ? "las cotizaciones" : "la cotización"} ${quotes.map((q) => `*${shortQuoteNumber(q.number)}*${q.unit ? ` (${titleWords(q.unit)})` : ""}`).join(", ")}.`);
      return true;
    }
    s.comparedQuote = s.quoteNumber; // escribió los ítems: la cotización no se usa (pero se contrasta)
    s.quoteNumber = null;
    s.quoteItems = null;
    s.phase = "items";
  }

  // corrida H: diferencias con la cotización / la OC
  if (s.phase === "check") {
    if (YES_QUOTE.test(text) || isDefaultAnswer(text)) {
      s.checkDiffs = null;
      if (s.qctx && s.items?.length && (s.answers.clienteListo.length || s.answers.clienteConfirmado)) {
        s.phase = "questions"; // la OC llegó con las preguntas empezadas: se sigue donde iba
        await askNext(ctx, s, company);
      } else await advance(ctx, s, company, "");
      return true;
    }
    if (NO_ANSWER.test(text)) {
      s.phase = "items";
      s.checkDiffs = null;
      s.quoteNumber = null;
      s.quoteItems = null;
      s.quoteNumbers = null;
      await save(ctx, s);
      await ctx.reply(itemsPrompt());
      return true;
    }
    if (!findTyreSizes(text).length) {
      await ask(ctx, s, checkPrompt(s));
      return true;
    }
    s.phase = "items"; // escribió los ítems de nuevo
    s.checkDiffs = null;
  }

  if (s.phase === "origin") {
    const idx = s.origins?.[0];
    const it = idx !== undefined ? s.items?.[idx] : undefined;
    const d = await originDeps();
    const ans = it ? parseOriginAnswer(text, d.suppliers) : null;
    if (!it || !ans) {
      await ask(ctx, s, `No entendí. ${originPrompt(s)}`);
      return true;
    }
    if ("stock" in ans) {
      const row = stockRowFor(it, d.rows);
      it.stock = row ? { rowId: row.id, origin: `${foldKey(row.provider)}|${row.kind}`, almacen: d.own.warehouse } : { almacen: d.own.warehouse };
    } else {
      const x = ans.supplier;
      it.terceros = { proveedor: ans.proveedor, ...(x ? { contacto: x.contact, telefono: x.phone, email: x.email } : {}), ...(ans.precio !== undefined ? { precioCompraConIgv: ans.precio } : {}) };
    }
    delete it.origenDesconocido;
    // el mismo producto en otras líneas (otras UB) sale del mismo lugar
    for (const other of s.items ?? []) {
      if (other !== it && other.origenDesconocido && pedidoDescription(other) === pedidoDescription(it)) {
        if (it.stock) other.stock = { ...it.stock };
        if (it.terceros) other.terceros = { ...it.terceros };
        delete other.origenDesconocido;
      }
    }
    s.origins = unknownOrigins(s.items ?? []);
    await advance(ctx, s, company, "");
    return true;
  }

  if (s.phase === "stock") {
    if (YES_QUOTE.test(text) || isDefaultAnswer(text)) {
      s.stockWarn = null;
      await advance(ctx, s, company, "");
      return true;
    }
    if (NO_ANSWER.test(text)) {
      s.phase = "items";
      s.stockWarn = null;
      s.quoteNumber = null;
      s.quoteItems = null;
      s.quoteNumbers = null;
      await save(ctx, s);
      await ctx.reply(itemsPrompt());
      return true;
    }
    if (!findTyreSizes(text).length) {
      await ask(ctx, s, stockPrompt(s));
      return true;
    }
    s.phase = "items";
    s.stockWarn = null;
  }

  // modelo que no existe en esa medida: la opción elegida (botón, número o nombre), o los ítems escritos de nuevo
  if (s.phase === "model") {
    const c = s.choices?.[0];
    const pick = c ? modelAnswer(text, c) : null;
    if (c && pick) {
      s.picks = { ...(s.picks ?? {}), [c.line]: pick };
      s.choices = s.choices!.slice(1);
      if (s.choices.length) {
        await save(ctx, s);
        await ask(ctx, s, modelPrompt(s));
        return true;
      }
      return itemsFrom(ctx, s, company, s.itemsText ?? "", s.picks);
    }
    if (!findTyreSizes(text).length) {
      await ask(ctx, s, `No entendí «${text.length > 40 ? `${text.slice(0, 39)}…` : text}» como una de las opciones.\n\n${modelPrompt(s)}`);
      return true;
    }
    s.phase = "items"; // escribió los ítems de nuevo
  }

  if (s.phase === "items") {
    if (!text) {
      await ctx.reply(itemsPrompt());
      return true;
    }
    // corrida H, punto 5: varias llantas en una nota de voz (misma separación que la cotización por voz)
    if (ctx.msg.type === "audio") {
      const v = orderItemsFromVoice(text, await voiceCatalogOf(ctx));
      if (!v.ok) {
        await ctx.reply(v.ask);
        return true;
      }
      if (v.notes.length) await ctx.reply(v.notes.join("\n"));
      text = v.text;
    }
    return itemsFrom(ctx, s, company, text, {});
  }

  // corrida H, punto 5: con los ítems armados, "el segundo eran diez", "quita el tercero", "al primero ponle precio 259" o
  // "agrega …" por voz cambian los ítems del pedido (y se vuelven a revisar origen, stock y cotización)
  if (ctx.msg.type === "audio" && s.phase === "questions" && s.items?.length) {
    const edit = parseVoiceEdit(spokenToDigits(text));
    if (edit) return voiceOrderEdit(ctx, s, company, edit);
  }

  // preguntas
  const q = nextOrderQuestion(s.answers, s.qctx!);
  if (!q) {
    await finishOrder(ctx, s, company, "");
    return true;
  }
  // un pedido no es una observación: el mensaje sigue al cotizador y el pedido se aparta (routePortal avisa)
  if ((q.field === "observaciones" || q.field === "observacionesTerceros") && orderShaped(text)) return false;
  const r = applyOrderAnswer(s.answers, q, text, s.qctx!, ctx.now);
  if (r.error) {
    await ask(ctx, s, `${r.error}\n\n${q.text}`);
    return true;
  }
  s.answers = r.answers;
  await askNext(ctx, s, company);
  return true;
});

async function voiceCatalogOf(ctx: PortalContext) {
  return ctx.voiceCatalog ? await ctx.voiceCatalog().catch(() => undefined) : undefined;
}

/** Corrección dirigida o ítem agregado por voz sobre los ítems del pedido (corrida H, punto 5). */
async function voiceOrderEdit(ctx: PortalContext, s: OcStep, company: Company, edit: VoiceEdit): Promise<boolean> {
  let items = s.items ?? [];
  let said: string;
  if (edit.kind === "add") {
    const v = orderItemsFromVoice(edit.text, await voiceCatalogOf(ctx));
    if (!v.ok) {
      await ctx.reply(v.ask);
      return true;
    }
    const res = await parseOrderItems(v.text, { priceStore: await priceStore(), settings: settings(), today: limaDateKey(ctx.now) });
    if (!res.ok) {
      await ctx.reply(`${res.error}${res.choices ? " Díctalo con el modelo que sí hay, o escríbelo." : ""}`);
      return true;
    }
    if (items.length + res.items.length > PEDIDO_MAX_ITEMS) {
      await ctx.reply(pedidoTooManyItems(items.length + res.items.length));
      return true;
    }
    items = [...items, ...res.items];
    said = `Agregué ${res.items.map((it) => `${it.cantidad} × ${pedidoDescription(it)}`).join(", ")}.`;
  } else {
    const r = applyOrderEdit(items, edit);
    if (!r.ok) {
      await ctx.reply(r.error);
      return true;
    }
    items = r.items;
    said = r.said;
  }
  await prepareItems(ctx, s, company, items, `✏️ ${said}\nEntendí:\n${itemLines(items, s.currency ?? "USD")}\nTotal: ${money(itemsTotal(items), s.currency ?? "USD")} inc. IGV`);
  return true;
}

/** Arma los ítems del texto con las elecciones hechas; si algún modelo no existe en esa medida, lo pregunta (fase model). */
async function itemsFrom(ctx: PortalContext, s: OcStep, company: Company, text: string, picks: Record<number, string>): Promise<boolean> {
  const res = await parseOrderItems(text, { priceStore: await priceStore(), settings: settings(), today: limaDateKey(ctx.now), picks });
  if (!res.ok && res.choices) {
    s.phase = "model";
    s.itemsText = text;
    s.choices = res.choices;
    s.picks = picks;
    s.currency = res.currency;
    await save(ctx, s);
    await ask(ctx, s, modelPrompt(s));
    return true;
  }
  if (!res.ok) {
    s.phase = "items";
    s.itemsText = null;
    s.choices = null;
    s.picks = null;
    await save(ctx, s);
    await ctx.reply(res.error + (await brandSuggestions(text)));
    return true;
  }
  s.currency = res.currency;
  s.itemsText = null;
  s.choices = null;
  s.picks = null;
  s.quoteNumbers = null;
  const d = await originDeps();
  const resolved = resolveOrigins(res.items, d);
  const avail = await availOf(s, resolved, d.rows);
  await prepareItems(ctx, s, company, res.items, `Entendí:\n${itemLines(resolved, res.currency, avail)}\nTotal: ${money(itemsTotal(res.items), res.currency)} inc. IGV`);
  return true;
}

/** Corrida H, 3b: para una marca que no está en ninguna lista, a qué proveedores pedirla (columna MARCAS). */
async function brandSuggestions(text: string): Promise<string> {
  const ps = await priceStore();
  const suppliers = await ps.listSuppliers().catch(() => [] as Supplier[]);
  if (!suppliers.length) return "";
  const rows = await ps.allRows();
  const known = new Set(rows.map((r) => fold(r.brand)).filter(Boolean));
  const out: string[] = [];
  for (const brand of brandsInText(text)) {
    if (known.has(fold(brand))) continue;
    const origin = Object.entries(settings().quote.brandOrigin).find(([k]) => fold(k) === fold(brand))?.[1];
    const sug = suggestSuppliers(brand, suppliers, { origin });
    if (sug.length) out.push(`*${brand}* no está en ninguna lista; puedes pedirla a: ${sug.map(supplierLabel).join(" · ")}`);
  }
  return out.length ? `\n\n💡 ${out.join("\n💡 ")}` : "";
}

// ── pedido ──

const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Set", "Oct", "Nov", "Dic"];

/** "Nov26- Prosegur - Venta 009 Juliaca UBs 1231-1812-1911-2005-2201.xlsx" (config/portal.json orders.branchFileName). */
export function branchFileName(pattern: string, v: { fecha: string; cliente: string; venta: string; sucursal: string; ubs: string[] }): string {
  const [y, m] = v.fecha.split("-");
  const name = pattern
    .replace(/\{Mes\}/g, MESES[Number(m) - 1] ?? m)
    .replace(/\{aa\}/g, y.slice(2))
    .replace(/\{Cliente\}/g, titleWords(v.cliente))
    .replace(/\{Venta\}/g, v.venta)
    .replace(/\{Sucursal\}/g, titleWords(v.sucursal))
    .replace(/\{UBs\}/g, v.ubs.join("-"))
    .replace(/\s+UBs\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${cleanFileName(name)}.xlsx`;
}

async function finishOrder(ctx: PortalContext, s: OcStep, company: Company, prefix: string): Promise<void> {
  const { store, user, now } = ctx;
  const cur = s.currency;
  const orders = loadPortalConfig().orders;
  const allAnswers = s.branches?.length ? [...(s.branchAnswers ?? []), s.answers] : [s.answers];
  const parts = (s.branches?.length ? s.branches : [null]).map((sucursal, i) => ({ sucursal, items: branchItems(s, i), a: allAnswers[i] ?? s.answers }));
  const files: { fileName: string; data: PedidoData; sucursal: string | null; venta?: string; ubs: string[] }[] = [];
  for (const part of parts) {
    const a = part.a;
    const lines = groupPedidoItems(part.items);
    const ubs = [...new Set(part.items.flatMap((it) => it.ubs ?? []))];
    const obs = [a.observaciones?.trim(), part.sucursal && ubs.length ? `UBs ${ubs.join("-")}` : ""].filter(Boolean).join(" — ");
    const data: PedidoData = {
      fecha: limaDateKey(now),
      atc: user.nombre,
      moneda: cur === "PEN" ? "PEN" : "USD",
      cliente: { razonSocial: company.razonSocial, ruc: company.ruc, ...a.cliente },
      plazoCreditoDias: a.plazoCreditoDias ?? null,
      items: lines.map((it) => (it.terceros && a.proveedores?.[it.terceros.proveedor.trim().toUpperCase()] ? { ...it, terceros: { ...it.terceros, pago: a.proveedores[it.terceros.proveedor.trim().toUpperCase()].pago || undefined, entrega: a.proveedores[it.terceros.proveedor.trim().toUpperCase()].entrega } } : it)),
      entrega: entregaFromAnswers(a),
      observaciones: obs,
      observacionesTerceros: a.observacionesTerceros,
      stockPropio: orders.ownStock,
    };
    const fileName = part.sucursal ? branchFileName(orders.branchFileName, { fecha: data.fecha, cliente: s.clientLabel || shortName(company.razonSocial), venta: a.venta ?? "", sucursal: part.sucursal, ubs }) : formatPedidoFileName(data);
    files.push({ fileName, data, sucursal: part.sucursal, venta: a.venta, ubs });
  }
  const buffers = await Promise.all(files.map((f) => buildPedidoXlsx(f.data)));
  await clearPending(store, ctx.from);
  if (prefix) await ctx.reply(prefix);
  for (let i = 0; i < files.length; i++) await ctx.sendDocument(buffers[i], files[i].fileName, undefined, XLSX_MIME);

  const items = s.items ?? [];
  const total = itemsTotal(items);
  const taxPct = items[0]?.igvPct ?? 18;
  const totalSinIgv = r2(total / (1 + taxPct / 100));
  const unidades = items.reduce((n, it) => n + it.cantidad, 0);

  // corrida H: contador de stock (el mismo pedido rehecho reemplaza lo que había descontado)
  const ps = await priceStore();
  const stockKey = orderStockKey(company.id, s.numero, s.orderId);
  const deductions = deductionsFor(items);
  let stockNote = "";
  try {
    await ps.setStockDeductions(stockKey, `OC ${s.numero ?? "s/n"} · ${shortName(company.razonSocial)}`, deductions, now);
    if (deductions.length) {
      const rows = await ps.allRows();
      const committed = committedMap(await ps.listStockDeductions());
      const left = deductions.map((d) => {
        const row = rows.find((r) => r.id === d.rowId);
        const c = committed.get(d.rowId) ?? 0;
        return row && row.stock !== null ? `${d.description}: ${availableText({ cargadas: row.stock, enPedidos: c, disponible: row.stock - c })}` : null;
      });
      stockNote = `📦 Descontado del stock: ${left.filter(Boolean).join(" · ")}`;
    }
  } catch (err) {
    ctx.log(`portal: no pude descontar el stock del pedido ${stockKey}: ${(err as Error).message}`);
  }
  // condiciones de cada proveedor: se recuerdan en la lista de proveedores
  const suppliers = await ps.listSuppliers().catch(() => [] as Supplier[]);
  for (const a of allAnswers) {
    for (const [name, t] of Object.entries(a.proveedores ?? {})) {
      const x = findSupplier(name, suppliers);
      if (x) await ps.setSupplierTerms(supplierKey(x.name), { payment: t.pago || undefined, delivery: t.entrega || undefined }).catch((err) => ctx.log(`portal: no pude recordar las condiciones de ${name}: ${(err as Error).message}`));
    }
  }

  // oportunidad: la de la OC si sigue abierta, la abierta de la empresa, o una nueva; a Cerrado ganado
  let opp = s.opportunityId ? await store.getOpportunity(s.opportunityId) : null;
  if (!opp || opp.closedAt) opp = (await store.getOpenOpportunity(company.id, user.id)) ?? (await store.getOpenOpportunity(company.id));
  if (!opp) opp = await store.createOpportunity({ companyId: company.id, ownerUserId: company.ownerUserId ?? user.id, quoteNumber: s.quoteNumber, montoEstimado: total, createdBy: user.id, at: now });
  await store.updateOpportunity(opp.id, { montoEstimado: total, ...(s.quoteNumber && !opp.quoteNumber ? { quoteNumber: s.quoteNumber } : {}) });
  opp = (await store.moveStage(opp.id, "cerrado_ganado", user.id, now)) ?? opp;

  const a0 = allAnswers[0];
  await store.addActivity({
    companyId: company.id,
    opportunityId: opp.id,
    userId: user.id,
    tipo: ACT_OC,
    texto: `OC ${s.numero ?? "s/n"} · ${money(total, cur)} inc. IGV · ${unidades} und. · pedido para Patricia${files.length > 1 ? ` (${files.length} sucursales)` : ""}`,
    canal: "whatsapp",
    data: {
      orderId: s.orderId,
      numero: s.numero,
      quoteNumber: s.quoteNumber,
      ...(s.quoteNumbers && s.quoteNumbers.length > 1 ? { quoteNumbers: s.quoteNumbers } : {}),
      pedidoFile: files[0].fileName,
      ...(files.length > 1 || files[0].sucursal ? { pedidos: files.map((f) => ({ archivo: f.fileName, sucursal: f.sucursal, venta: f.venta, ubs: f.ubs })) } : {}),
      stockKey,
      ventaEsperada: {
        moneda: cur,
        total,
        totalSinIgv,
        unidades,
        items: items.map((it) => ({ cantidad: it.cantidad, descripcion: pedidoDescription(it), precioUnitarioConIgv: pedidoUnitPrice(it), ...(it.terceros ? { proveedor: it.terceros.proveedor } : {}), ...(it.ubs?.length ? { ubs: it.ubs } : {}) })),
      },
      entrega: files[0].data.entrega,
      plazoCreditoDias: files[0].data.plazoCreditoDias,
    },
    occurredAt: now,
  });
  if (!company.esCliente) await store.updateCompany(company.id, { esCliente: true });
  // el plazo escrito en la OC solo queda como el de la empresa si no tenía uno; si tenía otro, no se cambia (se dice)
  let plazoNote = "";
  if (a0.plazoEscrito && a0.plazoCreditoDias != null && a0.plazoCreditoDias !== company.creditTermsDays) {
    if (company.creditTermsDays === null) await setCompanyCreditTerms(store, company.id, a0.plazoCreditoDias);
    else plazoNote = `El plazo habitual sigue en ${company.creditTermsDays} días; cámbialo en el portal si corresponde.`;
  }
  // memoria del cliente (y de cada sucursal): se relee al guardar y solo se cambian los campos de este pedido (otro pedido
  // de la misma empresa hecho mientras tanto no se pierde; lo que no se respondió aquí queda como estaba)
  let root = ((await store.getOrderProfile(company.id))?.data ?? {}) as OrderProfile;
  parts.forEach((part, i) => {
    const a = allAnswers[i] ?? s.answers;
    root = withBranchProfile(root, part.sucursal ?? undefined, profileFromAnswers(branchProfile(root, part.sucursal ?? undefined), a));
  });
  await store.setOrderProfile(company.id, root as Record<string, unknown>);
  await store.updatePurchaseOrder(s.orderId, { status: OC_STATUS_DONE, opportunityId: opp.id, quoteNumber: s.quoteNumber });

  const lines: string[] = [
    `✅ Pedido de *${shortName(company.razonSocial)}* listo (${[s.numero ? `OC ${s.numero}` : "OC sin n°", s.quoteNumbers && s.quoteNumbers.length > 1 ? `cotizaciones ${s.quoteNumbers.map(shortQuoteNumber).join(", ")}` : s.quoteNumber ? `cotización ${shortQuoteNumber(s.quoteNumber)}` : ""].filter(Boolean).join(", ")}):`,
  ];
  for (const [i, f] of files.entries()) {
    const a = allAnswers[i] ?? s.answers;
    const c = f.data.cliente;
    if (files.length > 1 || f.sucursal) lines.push(`📄 *${f.fileName}*`);
    lines.push(
      itemLines(f.data.items, cur),
      ...(files.length > 1 ? [] : [`Total: *${money(total, cur)}* inc. IGV (${money(totalSinIgv, cur)} sin IGV)`]),
      `Entrega: ${fechaEntregaLabel(a.fechaEntrega)} en ${c.direccionEntrega || "—"} · Contacto: ${c.contacto || "—"}`,
      `Enllante: ${a.enllante ?? "—"} · Marcado: ${a.marcado ?? "—"} · Flete: ${[a.flete, a.valorFlete].filter(Boolean).join(" ") || "—"} · ${f.data.plazoCreditoDias == null ? "Plazo: —" : f.data.plazoCreditoDias <= 0 ? "Contado" : `Crédito ${f.data.plazoCreditoDias} días`}`,
      ...Object.entries(a.proveedores ?? {}).map(([n, t]) => `Proveedor ${n}: ${t.pago || "—"} · Recojo: ${t.entrega || "—"}`),
      ...(!a.proveedores && f.data.items.some((it) => it.terceros) ? [`Proveedor: ${a.pagoProveedor || "—"} · Recojo: ${a.recojo || "—"}`] : []),
      ...(c.agencia ? [`Agencia: ${agenciaText(c)}`] : []),
      ...(f.data.observaciones ? [`Obs.: ${f.data.observaciones}`] : []),
      ...(a.observacionesTerceros ? [`Obs. despacho: ${a.observacionesTerceros}`] : []),
    );
  }
  if (files.length > 1) lines.push(`Total: *${money(total, cur)}* inc. IGV (${money(totalSinIgv, cur)} sin IGV)`);
  lines.push(`Oportunidad → *${stageLabel(opp.etapa)}*.${s.hasFile ? "" : " _(OC sin adjunto)_"}`, ...(stockNote ? [stockNote] : []), ...(plazoNote ? [plazoNote] : []), "", files.length > 1 ? PATRICIA_REMINDER_BRANCHES : PATRICIA_REMINDER);
  const progress = await companyProgressLine(store, company, 7);
  if (progress) lines.push(progress);
  await ctx.reply(lines.join("\n"));
}

// ── corrida H: anular un pedido (devuelve su stock) y ver los descuentos de stock ──

/** "oc 4500123", "pedido 4500123 de zbuss", "la oc 4500123" -> el número de OC (y la empresa si se escribió). */
export function parseAnular(args: string): { numero: string; empresa: string } | null {
  const t = args.trim().replace(/^(?:la\s+)?(?:oc|o\/c|pedido|orden(?:\s+de\s+compra)?)\s*(?:n[°ºo]\.?|nro\.?|#)?\s*/i, "");
  const m = t.match(/^([A-Za-z0-9][\w/-]*)(?:\s+(?:de|del|para)?\s*(.+))?$/);
  if (!m || !/\d/.test(m[1])) return null;
  return { numero: m[1], empresa: (m[2] ?? "").trim() };
}

registerPortalCommand("anular", async (ctx, args) => {
  const p = parseAnular(args);
  if (!p) {
    await ctx.reply("Escríbelo así: *anular oc 4500123* (el n° de la OC del pedido; devuelve al stock lo que había descontado).");
    return;
  }
  const all = await ctx.store.listPurchaseOrders({ status: OC_STATUS_DONE });
  const hits = [];
  for (const o of all) {
    if (!o.numero || o.numero.toUpperCase() !== p.numero.toUpperCase()) continue;
    const company = await ctx.store.getCompany(o.companyId);
    if (!company || !canEditCompany(ctx.user, company)) continue;
    if (p.empresa && !fold(company.razonSocial).includes(fold(p.empresa)) && company.ruc !== p.empresa) continue;
    hits.push({ o, company });
  }
  if (!hits.length) {
    await ctx.reply(`No encontré un pedido generado de la OC *${p.numero}* que puedas anular.`);
    return;
  }
  if (hits.length > 1) {
    await ctx.reply(`Hay ${hits.length} pedidos con la OC *${p.numero}* (${hits.map((h) => shortName(h.company.razonSocial)).join(", ")}). Escribe *anular oc ${p.numero} <empresa>*.`);
    return;
  }
  const { o, company } = hits[0];
  const ps = await priceStore();
  const key = orderStockKey(company.id, o.numero, o.id);
  const before = (await ps.listStockDeductions().catch(() => [])).filter((d) => d.orderKey === key);
  await ps.releaseStockDeductions(key, ctx.now);
  await ctx.store.updatePurchaseOrder(o.id, { status: OC_STATUS_VOIDED });
  const back = before.length ? `\n📦 Devolví al stock: ${before.map((d) => `${d.quantity} × ${d.description}`).join(" · ")}.` : "";
  await ctx.reply(`🗑️ Anulé el pedido de la OC *${o.numero}* de *${shortName(company.razonSocial)}*.${back}\nSi Patricia ya lo recibió, avísale por correo.`);
});

registerPortalCommand("descuentos", async (ctx) => {
  if (ctx.user.rol !== "admin" && ctx.user.rol !== "supervisor") {
    await ctx.reply("Los descuentos de stock los ve el supervisor o el administrador. Para ver el disponible de una medida: *stock 295/80R22.5*.");
    return;
  }
  const ps = await priceStore();
  const list = await ps.listStockDeductions();
  if (!list.length) {
    await ctx.reply("📦 No hay descuentos de stock activos: el disponible es lo cargado (Odoo).");
    return;
  }
  const rows = await ps.allRows();
  const byRow = new Map<string, typeof list>();
  for (const d of list) byRow.set(d.rowId, [...(byRow.get(d.rowId) ?? []), d]);
  const lines = ["📦 *Descuentos de stock activos* (contador de apoyo; la referencia es Odoo):"];
  for (const [rowId, ds] of byRow) {
    const row = rows.find((r) => r.id === rowId);
    const committed = ds.reduce((n, d) => n + d.quantity, 0);
    const where = [...new Set(ds.map((d) => d.warehouse).filter(Boolean))].join(", ");
    const avail = row && row.stock !== null ? availableText({ cargadas: row.stock, enPedidos: committed, disponible: row.stock - committed }) : `${committed} en pedidos`;
    lines.push(`• *${ds[0].description}*${where ? ` (${where})` : ""}: ${avail}`);
    for (const d of ds) lines.push(`   − ${d.quantity} · ${d.label} · ${d.createdAt.slice(8, 10)}/${d.createdAt.slice(5, 7)}`);
  }
  lines.push("", "Un pedido anulado (*anular oc …*) devuelve lo suyo; una carga nueva de stock pone el contador en cero.");
  await ctx.reply(lines.join("\n"));
});
