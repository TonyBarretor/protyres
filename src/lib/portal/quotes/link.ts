/**
 * Cotización enlazada (bloque B4): la cotización que arma el cotizador queda en la oportunidad de la empresa del portal.
 *
 *  - presentQuote -> linkQuoteToPortal: si el vendedor es usuario del portal, busca la empresa del cliente. RUC en el pedido
 *    (o un cliente que el vendedor ya enlazó antes, por correo o nombre) -> enlaza directo y avisa en una línea. Por nombre
 *    -> pregunta aparte "¿La cotización 032 es para *ZBUSS S.A.C.* …? Responde *enlazar*" y guarda la propuesta en el
 *    estado del portal (clave `linkQuote`, no `pending`: no pisa otra pregunta del bot y sobrevive al comando).
 *  - `enlazar` -> confirmQuoteLink. `reenviada 032` -> markQuoteForwarded. `enviar` (correo) -> onQuoteSentToPortal.
 *    Enviada = oportunidad en "Cotización enviada" (solo hacia adelante) + actividad `cotizacion_enviada`.
 *  - startRequest -> portalCreditTerm: plazo de crédito de la empresa (companies.credit_terms_days) cuando el pedido no
 *    trae plazo y la memoria del cliente no dio otro, en lugar del plazo de config/pilot.json.
 *
 * Todo lo que llama el handler es seguro: si el número no es del portal, si el store falla o tarda, no hace nada (lo
 * registra en el log) y el cotizador sigue igual.
 */
import { companyKey, findCompanies, shortName } from "../bot/companies";
import type { PortalContext } from "../bot/registry";
import { isExpired, type PendingStep } from "../bot/state";
import { stageIndex, stageLabel } from "../stages";
import { getPortalStore } from "../store";
import { foldText } from "../store/shared";
import type { Activity, Company, Opportunity, PortalStore, PortalUser } from "../store/types";
import { fmtMoney } from "../../quote/pricing";
import type { Quote, QuoteRequest } from "../../quote/types";

/** Clave del estado del portal (portal_conversations) con la propuesta de enlace pendiente. */
export const LINK_STATE_KEY = "linkQuote";
export const ACT_QUOTE = "cotizacion";
export const ACT_QUOTE_SENT = "cotizacion_enviada";
/** Lo que el portal tarda como máximo en un enganche del cotizador antes de rendirse. */
export const PORTAL_HOOK_TIMEOUT_MS = 4000;

/** Propuesta de enlace por nombre esperando *enlazar* (forma de paso pendiente: kind + createdAt, vence a las 2 h). */
export interface LinkQuoteStep extends PendingStep {
  kind: "link_quote";
  quoteNumber: string;
  companyId: number;
  razonSocial: string;
  ruc: string;
  total: number;
  currency: string;
  items: number;
  itemsText: string;
  customerKey: string | null;
  customerEmail: string | null;
}

export interface HookOptions {
  /** Store del portal (tests / handler deps); por defecto getPortalStore(). */
  store?: PortalStore;
  now?: Date;
  log?: (msg: string) => void;
  timeoutMs?: number;
}

type Ctx = Pick<PortalContext, "store" | "user" | "from" | "reply" | "now" | "log">;

// ── utilidades ──

const RUC_RE = /(?<!\d)((?:10|15|16|17|20)\d{9})(?!\d)/g;

/** RUC(s) escritos en el pedido o en la referencia del cliente. */
export function rucsIn(...texts: (string | undefined | null)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of (t ?? "").matchAll(RUC_RE)) out.add(m[1]);
  return [...out];
}

/** "032" de "OCTUBRE 2026 - 032", "0001" de "COT-0001": como lo dice el vendedor. */
export function shortQuoteNumber(number: string): string {
  return number.match(/(\d+)\D*$/)?.[1] ?? number;
}

/** "032", "32", "OCTUBRE 2026 - 032" o "cot-0032" apuntan a la misma cotización. */
export function quoteNumberMatches(full: string, typed: string): boolean {
  const a = foldText(full).replace(/\s+/g, " ");
  const b = foldText(typed).replace(/\s+/g, " ").replace(/^(?:la\s+)?(?:cotizacion|cot)\s+/, "");
  if (!b) return false;
  if (a === b) return true;
  if (/^\d+$/.test(b)) {
    const m = full.match(/(\d+)\D*$/);
    return !!m && parseInt(m[1], 10) === parseInt(b, 10);
  }
  return false;
}

function customerKeyOf(c: { company?: string; name?: string }): string | null {
  const name = c.company || c.name;
  const key = name ? companyKey(name) : "";
  return key || null;
}

function itemsText(quote: Pick<Quote, "items">): string {
  const shown = quote.items.slice(0, 4).map((it) => `${it.quantity} × ${[it.sizeDisplay, it.brand, it.model].filter(Boolean).join(" ") || it.description}`);
  if (quote.items.length > 4) shown.push(`y ${quote.items.length - 4} ítems más`);
  return shown.join("; ");
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`el portal no respondió en ${ms} ms`)), ms);
    (t as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Corre `fn` con el store y el usuario activo del portal; null si el número no es del portal o algo falla. */
async function safely<T>(what: string, phone: string, opts: HookOptions, fn: (store: PortalStore, user: PortalUser) => Promise<T>): Promise<T | null> {
  const log = opts.log ?? (() => undefined);
  try {
    return await withTimeout(
      (async () => {
        const store = opts.store ?? (await getPortalStore());
        const user = await store.getUserByWhatsapp(phone);
        if (!user || !user.activo) return null;
        return fn(store, user);
      })(),
      opts.timeoutMs ?? PORTAL_HOOK_TIMEOUT_MS,
    );
  } catch (err) {
    log(`portal: ${what} falló, el cotizador sigue igual: ${(err as Error).message}`);
    return null;
  }
}

async function getLinkStep(store: PortalStore, phone: string, now: Date): Promise<LinkQuoteStep | null> {
  const conv = await store.getPortalConversation(phone);
  const step = conv?.state?.[LINK_STATE_KEY] as LinkQuoteStep | undefined;
  if (!step || typeof step !== "object" || step.kind !== "link_quote") return null;
  return isExpired(step, now) ? null : step;
}

async function setLinkStep(store: PortalStore, phone: string, step: LinkQuoteStep | null): Promise<void> {
  const conv = await store.getPortalConversation(phone);
  const { [LINK_STATE_KEY]: _drop, ...rest } = (conv?.state ?? {}) as Record<string, unknown>;
  const state = step ? { ...rest, [LINK_STATE_KEY]: step } : rest;
  if (!conv && !step) return;
  await store.setPortalConversation(phone, Object.keys(state).length ? state : null);
}

/** Actividades `cotizacion` del vendedor (más reciente primero). */
async function quoteActivities(store: PortalStore, userId: number): Promise<Activity[]> {
  const acts = await store.listActivities({ userId, limit: 500 });
  return acts.filter((a) => a.tipo === ACT_QUOTE && typeof a.data?.quoteNumber === "string");
}

/** El enlace registrado de una cotización (número completo o como lo escribe el vendedor), el más reciente. */
export async function findQuoteLink(store: PortalStore, userId: number, typed: string): Promise<Activity | null> {
  return (await quoteActivities(store, userId)).find((a) => quoteNumberMatches(String(a.data!.quoteNumber), typed)) ?? null;
}

/** Empresa que el vendedor ya enlazó antes para este cliente (mismo correo o mismo nombre sin S.A.C.). */
async function previouslyLinked(store: PortalStore, userId: number, customer: { key: string | null; email: string | null }): Promise<Company | null> {
  if (!customer.key && !customer.email) return null;
  const email = customer.email?.toLowerCase() ?? null;
  const hit = (await quoteActivities(store, userId)).find(
    (a) => (email && String(a.data?.customerEmail ?? "").toLowerCase() === email) || (customer.key && a.data?.customerKey === customer.key),
  );
  return hit ? store.getCompany(hit.companyId) : null;
}

/** Empresa por RUC exacto escrito en el pedido (una sola). */
async function companyByRuc(store: PortalStore, rucs: string[]): Promise<Company | null> {
  const found: Company[] = [];
  for (const r of rucs.slice(0, 3)) {
    const c = await store.getCompanyByRuc(r);
    if (c) found.push(c);
  }
  return found.length === 1 ? found[0] : null;
}

/** Candidata por nombre (para preguntar): una coincidencia exacta sin S.A.C./tildes, o un único resultado. */
async function companyByName(store: PortalStore, name: string | undefined): Promise<Company | null> {
  const key = name ? companyKey(name) : "";
  if (key.length < 3) return null;
  const { rows, total } = await findCompanies(store, name!, 5);
  const exact = rows.filter((c) => companyKey(c.razonSocial) === key);
  if (exact.length === 1) return exact[0];
  if (exact.length === 0 && total === 1 && key.length >= 5) return rows[0];
  return null;
}

// ── enlazar ──

interface LinkInput {
  quoteNumber: string;
  total: number;
  currency: string;
  items: number;
  itemsText: string;
  customerKey: string | null;
  customerEmail: string | null;
  via: string;
}

/** Oportunidad abierta del vendedor (o nueva, dueño = vendedor) con el número de cotización y la actividad `cotizacion`. */
async function performLink(store: PortalStore, user: PortalUser, company: Company, input: LinkInput, now: Date): Promise<Opportunity> {
  let opp = await store.getOpenOpportunity(company.id, user.id);
  if (!opp) opp = await store.createOpportunity({ companyId: company.id, ownerUserId: user.id, quoteNumber: input.quoteNumber, montoEstimado: input.total, createdBy: user.id, at: now });
  else opp = (await store.updateOpportunity(opp.id, { quoteNumber: input.quoteNumber, ...(opp.montoEstimado === null ? { montoEstimado: input.total } : {}) })) ?? opp;
  await store.addActivity({
    companyId: company.id,
    opportunityId: opp.id,
    userId: user.id,
    tipo: ACT_QUOTE,
    texto: `Cotización ${input.quoteNumber} · ${fmtMoney(input.total, input.currency)} · ${input.itemsText}`,
    canal: "whatsapp",
    data: { quoteNumber: input.quoteNumber, total: input.total, currency: input.currency, items: input.items, customerKey: input.customerKey, customerEmail: input.customerEmail, via: input.via },
    occurredAt: now,
  });
  return opp;
}

export type LinkOutcome = "linked" | "asked" | "already" | "none";

export interface LinkQuoteInput extends HookOptions {
  /** Número del vendedor. */
  from: string;
  quote: Pick<Quote, "number" | "total" | "currency" | "items" | "customer" | "requestText">;
  /** Mensaje al vendedor (va después de los mensajes del cotizador). */
  reply: (body: string) => Promise<void>;
}

/**
 * Enganche de presentQuote. RUC exacto o cliente ya enlazado -> enlaza y avisa; por nombre -> pregunta *enlazar*.
 * Una cotización que se vuelve a presentar (precio cambiado, renombrada) no se enlaza ni se pregunta dos veces.
 */
export async function linkQuoteToPortal(input: LinkQuoteInput): Promise<LinkOutcome> {
  const res = await safely("enlazar la cotización", input.from, input, async (store, user) => {
    const now = input.now ?? new Date();
    const q = input.quote;
    const short = shortQuoteNumber(q.number);
    const linked = await findQuoteLink(store, user.id, q.number);
    if (linked && linked.data?.quoteNumber === q.number) return "already" as const; // presentada otra vez: ya está
    const customer = { key: customerKeyOf(q.customer), email: q.customer.email?.trim() || null };
    const base: LinkInput = { quoteNumber: q.number, total: q.total, currency: q.currency, items: q.items.length, itemsText: itemsText(q), customerKey: customer.key, customerEmail: customer.email, via: "ruc" };

    const byRuc = await companyByRuc(store, rucsIn(q.requestText, q.customer.ref));
    const before = byRuc ? null : await previouslyLinked(store, user.id, customer);
    const direct = byRuc ?? before;
    if (direct) {
      const opp = await performLink(store, user, direct, { ...base, via: byRuc ? "ruc" : "cliente" }, now);
      await input.reply(`🔗 Cotización *${short}* enlazada a *${direct.razonSocial}* en el portal (${stageLabel(opp.etapa)}).`);
      return "linked" as const;
    }

    const candidate = await companyByName(store, q.customer.company || q.customer.name);
    if (!candidate) return "none" as const;
    const asked = await getLinkStep(store, input.from, now);
    if (asked?.quoteNumber === q.number && asked.companyId === candidate.id) return "asked" as const;
    const step: LinkQuoteStep = { kind: "link_quote", createdAt: now.toISOString(), ...base, via: "nombre", companyId: candidate.id, razonSocial: candidate.razonSocial, ruc: candidate.ruc };
    await setLinkStep(store, input.from, step);
    await input.reply(`¿La cotización *${short}* es para *${candidate.razonSocial}* (RUC ${candidate.ruc}) del portal? Responde *enlazar* o ignóralo.`);
    return "asked" as const;
  });
  return res ?? "none";
}

/**
 * `enlazar` (opcionalmente `enlazar 032`): confirma la propuesta guardada por linkQuoteToPortal. Devuelve false si no
 * había propuesta (ya respondió al vendedor). Sirve como comando del portal o como respuesta a un paso pendiente.
 */
export async function confirmQuoteLink(ctx: Ctx, args = ""): Promise<boolean> {
  const step = await getLinkStep(ctx.store, ctx.from, ctx.now);
  const typed = args.trim();
  if (!step) {
    await ctx.reply("No tengo ninguna cotización por enlazar. Cuando cotices para una empresa del portal te pregunto.");
    return false;
  }
  if (typed && !quoteNumberMatches(step.quoteNumber, typed)) {
    await ctx.reply(`La cotización por enlazar es la *${shortQuoteNumber(step.quoteNumber)}* (${step.razonSocial}). Responde *enlazar* para esa.`);
    return false;
  }
  const company = await ctx.store.getCompany(step.companyId);
  await setLinkStep(ctx.store, ctx.from, null);
  if (!company) {
    await ctx.reply("Esa empresa ya no está en el portal; no enlacé la cotización.");
    return true;
  }
  const opp = await performLink(ctx.store, ctx.user, company, { ...step, via: "nombre" }, ctx.now);
  await ctx.reply(`🔗 Listo: cotización *${shortQuoteNumber(step.quoteNumber)}* enlazada a *${company.razonSocial}* (${stageLabel(opp.etapa)}).`);
  return true;
}

// ── enviada ──

export type SentOutcome = "moved" | "recorded" | "already" | "none";

/** Oportunidad a "Cotización enviada" (solo hacia adelante, nunca desde cerrada) + actividad `cotizacion_enviada` (una vez). */
async function markSent(store: PortalStore, user: PortalUser, link: Activity, via: "correo" | "whatsapp", now: Date): Promise<{ outcome: SentOutcome; opp: Opportunity | null }> {
  const quoteNumber = String(link.data!.quoteNumber);
  const prior = await store.listActivities({ companyId: link.companyId, limit: 500 });
  const already = prior.some((a) => a.tipo === ACT_QUOTE_SENT && a.data?.quoteNumber === quoteNumber);
  let opp = link.opportunityId ? await store.getOpportunity(link.opportunityId) : null;
  let moved = false;
  if (opp && !opp.closedAt && stageIndex(opp.etapa) < stageIndex("cotizacion_enviada")) {
    opp = (await store.moveStage(opp.id, "cotizacion_enviada", user.id, now)) ?? opp;
    moved = true;
  }
  if (already) return { outcome: moved ? "moved" : "already", opp };
  await store.addActivity({
    companyId: link.companyId,
    opportunityId: link.opportunityId,
    userId: user.id,
    tipo: ACT_QUOTE_SENT,
    texto: `Cotización ${quoteNumber} enviada al cliente (${via === "correo" ? "por correo" : "reenviada por WhatsApp"})`,
    canal: "whatsapp",
    data: { quoteNumber, via, sentAt: now.toISOString() },
    occurredAt: now,
  });
  return { outcome: moved ? "moved" : "recorded", opp };
}

/** Enganche de sendQuote tras el correo enviado: si la cotización está enlazada, pasa a Cotización enviada. Silencioso. */
export async function onQuoteSentToPortal(input: HookOptions & { from: string; quoteNumber: string }): Promise<SentOutcome> {
  const res = await safely("marcar la cotización enviada", input.from, input, async (store, user) => {
    const link = await findQuoteLink(store, user.id, input.quoteNumber);
    if (!link || link.data?.quoteNumber !== input.quoteNumber) return "none" as const;
    return (await markSent(store, user, link, "correo", input.now ?? new Date())).outcome;
  });
  return res ?? "none";
}

/** `reenviada 032`: el vendedor reenvió la cotización por WhatsApp. Sin número, la última enlazada. */
export async function markQuoteForwarded(ctx: Ctx, args = ""): Promise<boolean> {
  const typed = args.trim().replace(/^(?:la\s+)?(?:cotizaci[oó]n\s+)?/i, "");
  const link = typed ? await findQuoteLink(ctx.store, ctx.user.id, typed) : ((await quoteActivities(ctx.store, ctx.user.id))[0] ?? null);
  if (!link) {
    await ctx.reply(typed ? `No encuentro la cotización *${typed}* enlazada a una empresa del portal.` : "No tienes cotizaciones enlazadas al portal. Escribe *reenviada 032*.");
    return false;
  }
  const quoteNumber = String(link.data!.quoteNumber);
  const company = await ctx.store.getCompany(link.companyId);
  const { outcome, opp } = await markSent(ctx.store, ctx.user, link, "whatsapp", ctx.now);
  const who = company ? shortName(company.razonSocial) : "la empresa";
  const stage = opp ? ` (${stageLabel(opp.etapa)})` : "";
  if (outcome === "already") await ctx.reply(`La cotización *${shortQuoteNumber(quoteNumber)}* de *${who}* ya estaba registrada como enviada${stage}.`);
  else await ctx.reply(`📤 Cotización *${shortQuoteNumber(quoteNumber)}* de *${who}* registrada como enviada${stage}.`);
  return true;
}

// ── condiciones de crédito ──

/** Guarda el plazo de crédito habitual de la empresa (días; null lo borra). */
export async function setCompanyCreditTerms(store: PortalStore, companyId: number, dias: number | null): Promise<Company | null> {
  if (dias !== null && (!Number.isInteger(dias) || dias < 0 || dias > 365)) throw new Error(`plazo de crédito inválido: ${dias} (días enteros de 0 a 365)`);
  return store.updateCompany(companyId, { creditTermsDays: dias });
}

export interface CreditTerm {
  /** Línea que se añade al pedido ("plazo: 45 días"). */
  line: string;
  /** El plazo como lo lee el parser de esa línea ("45 días"): el cotizador lo asigna a req.paymentTerm sin re-parsear. */
  term: string;
  /** Aviso para el vendedor, como el de la memoria del cliente. */
  note: string;
  days: number;
  company: Company;
}

/**
 * Plazo por defecto desde el portal para un pedido nuevo: solo si el pedido (con la memoria del cliente ya aplicada)
 * no trae plazo ni pago al contado, el número es del portal y la empresa se identifica sin dudas (RUC exacto en el
 * pedido, o un cliente que el vendedor ya enlazó) y tiene `credit_terms_days`. Si no, null: queda el de la config.
 */
export async function portalCreditTerm(input: HookOptions & { from: string; text: string; req: Pick<QuoteRequest, "paymentTerm" | "paymentType" | "customerCompany" | "customerName" | "customerEmail" | "customerRef"> }): Promise<CreditTerm | null> {
  const { req } = input;
  if (req.paymentTerm !== undefined) return null;
  if (req.paymentType && /contado|adelantad|anticipad/i.test(req.paymentType)) return null;
  const rucs = rucsIn(input.text, req.customerRef);
  const customer = { key: customerKeyOf({ company: req.customerCompany, name: req.customerName }), email: req.customerEmail?.trim() || null };
  if (!rucs.length && !customer.key && !customer.email) return null;
  return safely("leer el plazo de crédito", input.from, input, async (store, user) => {
    const company = (await companyByRuc(store, rucs)) ?? (await previouslyLinked(store, user.id, customer));
    const days = company?.creditTermsDays;
    if (!company || !days || days <= 0) return null;
    return { line: `plazo: ${days} días`, term: `${days} días`, note: `📒 plazo ${days} días (condiciones de *${company.razonSocial}* en el portal)`, days, company };
  });
}
