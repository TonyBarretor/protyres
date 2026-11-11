/**
 * Recordatorio de cotización sin respuesta (bloque B4): una cotización enlazada a una oportunidad abierta que lleva
 * `quotes.followUpBusinessDays` días hábiles (lun–vie en Lima, sin los feriados de config/portal.json) sin actividad
 * posterior de la empresa ni cambio de etapa genera un aviso al vendedor. Se avisa una sola vez por cotización.
 *
 * La selección es pura (selectQuoteFollowUps); el cron (B6) usa quoteFollowUpsFor(store, userId, now), manda
 * followUpMessage(f) al vendedor y registra el aviso con recordQuoteFollowUp (actividad `recordatorio_cotizacion`).
 */
import { loadPortalConfig } from "../config";
import { stageIndex } from "../stages";
import type { Activity, Opportunity, PortalStore, StageHistoryEntry } from "../store/types";
import { ACT_QUOTE, ACT_QUOTE_SENT, shortQuoteNumber } from "./link";
import { shortName } from "../bot/companies";

export const ACT_FOLLOW_UP = "recordatorio_cotizacion";
const LIMA_OFFSET_MS = 5 * 60 * 60 * 1000; // Lima: UTC-5 todo el año

/** Fecha de calendario en Lima ("AAAA-MM-DD"). */
export function limaDate(d: Date): string {
  return new Date(d.getTime() - LIMA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Lunes a viernes y no feriado. `day` = "AAAA-MM-DD". */
export function isBusinessDay(day: string, holidays: readonly string[] = []): boolean {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.includes(day);
}

/**
 * Días hábiles transcurridos de `from` a `to` (fechas de Lima): cuenta los días hábiles posteriores al de `from` hasta
 * el de `to` inclusive. Lunes -> jueves = 3; viernes -> miércoles = 3; el mismo día = 0; `to` anterior = 0.
 */
export function businessDaysBetween(from: Date, to: Date, holidays: readonly string[] = []): number {
  const start = limaDate(from);
  const end = limaDate(to);
  if (end <= start) return 0;
  let n = 0;
  const d = new Date(`${start}T00:00:00Z`);
  for (;;) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.toISOString().slice(0, 10);
    if (day > end) break;
    if (isBusinessDay(day, holidays)) n++;
  }
  return n;
}

export interface QuoteFollowUp {
  opportunityId: number;
  companyId: number;
  ownerUserId: number | null;
  quoteNumber: string;
  /** Desde cuándo espera respuesta (enlace o envío, el último). */
  since: Date;
  businessDays: number;
  sent: boolean;
}

export interface SelectFollowUpsInput {
  opportunities: Opportunity[];
  /** Actividades de las empresas de esas oportunidades (de cualquier usuario). */
  activities: Activity[];
  now: Date;
  businessDays: number;
  holidays?: readonly string[];
  /** Historial de etapas (opcional): un cambio de etapa posterior a la cotización cuenta como respuesta. */
  stageHistory?: StageHistoryEntry[];
}

const OWN_TIPOS = new Set<string>([ACT_QUOTE_SENT, ACT_FOLLOW_UP]);

/** Cotizaciones enlazadas sin respuesta registrada tras `businessDays` días hábiles (la más antigua primero). */
export function selectQuoteFollowUps(input: SelectFollowUpsInput): QuoteFollowUp[] {
  const out: QuoteFollowUp[] = [];
  const limit = stageIndex("cotizacion_enviada");
  for (const opp of input.opportunities) {
    const qn = opp.quoteNumber;
    if (!qn || opp.closedAt || stageIndex(opp.etapa) > limit) continue;
    const acts = input.activities.filter((a) => a.companyId === opp.companyId);
    const ofQuote = acts.filter((a) => a.data?.quoteNumber === qn && (a.tipo === ACT_QUOTE || a.tipo === ACT_QUOTE_SENT));
    if (!ofQuote.some((a) => a.tipo === ACT_QUOTE)) continue; // no está enlazada por el cotizador
    if (acts.some((a) => a.tipo === ACT_FOLLOW_UP && a.data?.quoteNumber === qn)) continue; // ya se avisó
    const since = new Date(Math.max(...ofQuote.map((a) => a.occurredAt.getTime())));
    const answered = acts.some((a) => a.occurredAt.getTime() > since.getTime() && !OWN_TIPOS.has(a.tipo) && !(a.tipo === ACT_QUOTE && a.data?.quoteNumber === qn));
    if (answered) continue;
    const moved = (input.stageHistory ?? []).some((h) => h.opportunityId === opp.id && h.enteredAt.getTime() > since.getTime() && h.etapa !== "cotizacion_enviada");
    if (moved) continue;
    const days = businessDaysBetween(since, input.now, input.holidays ?? []);
    if (days < input.businessDays) continue;
    out.push({ opportunityId: opp.id, companyId: opp.companyId, ownerUserId: opp.ownerUserId, quoteNumber: qn, since, businessDays: days, sent: ofQuote.some((a) => a.tipo === ACT_QUOTE_SENT) });
  }
  return out.sort((a, b) => a.since.getTime() - b.since.getTime());
}

export interface QuoteFollowUpWithCompany extends QuoteFollowUp {
  razonSocial: string;
}

/** Recordatorios del vendedor `userId` a `now` (config/portal.json: quotes.followUpBusinessDays, holidays). */
export async function quoteFollowUpsFor(store: PortalStore, userId: number, now: Date, opts: { businessDays?: number; holidays?: string[] } = {}): Promise<QuoteFollowUpWithCompany[]> {
  const cfg = opts.businessDays === undefined || opts.holidays === undefined ? loadPortalConfig() : null;
  const businessDays = opts.businessDays ?? cfg!.quotes.followUpBusinessDays;
  const holidays = opts.holidays ?? cfg!.holidays;
  const opportunities = (await store.listOpportunities({ ownerId: userId, open: true })).filter((o) => o.quoteNumber);
  const activities: Activity[] = [];
  const stageHistory: StageHistoryEntry[] = [];
  for (const companyId of [...new Set(opportunities.map((o) => o.companyId))]) activities.push(...(await store.listActivities({ companyId, limit: 500 })));
  for (const o of opportunities) stageHistory.push(...(await store.stageHistory(o.id)));
  const selected = selectQuoteFollowUps({ opportunities, activities, now, businessDays, holidays, stageHistory });
  const out: QuoteFollowUpWithCompany[] = [];
  for (const f of selected) out.push({ ...f, razonSocial: (await store.getCompany(f.companyId))?.razonSocial ?? `empresa ${f.companyId}` });
  return out;
}

/** Texto del aviso al vendedor. */
export function followUpMessage(f: QuoteFollowUpWithCompany): string {
  const what = f.sent ? "enviada" : "enlazada";
  return `⏰ La cotización *${shortQuoteNumber(f.quoteNumber)}* a *${shortName(f.razonSocial)}* (${what}) lleva ${f.businessDays} días hábiles sin respuesta. ¿Le hacemos seguimiento? Registra lo que pase con un reporte.`;
}

/** Registra que se avisó (no se vuelve a avisar por esa cotización). */
export async function recordQuoteFollowUp(store: PortalStore, f: QuoteFollowUp, now: Date): Promise<Activity> {
  return store.addActivity({
    companyId: f.companyId,
    opportunityId: f.opportunityId,
    userId: f.ownerUserId,
    tipo: ACT_FOLLOW_UP,
    texto: `Recordatorio: cotización ${f.quoteNumber} sin respuesta tras ${f.businessDays} días hábiles`,
    canal: "whatsapp",
    data: { quoteNumber: f.quoteNumber, businessDays: f.businessDays },
    occurredAt: now,
  });
}
