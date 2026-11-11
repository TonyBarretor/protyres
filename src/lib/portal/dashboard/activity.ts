/**
 * Actividad y tiempos (puro).
 *
 * - Por semana (lunes–domingo en Lima, últimas 8): actividades `visita`, `llamada` y `cotizacion` (la cotización enlazada
 *   desde el cotizador; `cotizacion_enviada` es el reenvío de la misma y no se cuenta otra vez).
 * - Días promedio por etapa: media de las estancias **terminadas** (con left_at) en cada etapa abierta del embudo; la
 *   estancia en curso no entra (aún no se sabe cuánto durará).
 * - Asignación → primera llamada: media de `opportunityTimeline().asignacionAPrimeraLlamada` de las oportunidades que
 *   tienen los dos hitos.
 * - Cotizaciones sin respuesta: la misma selección del recordatorio (quotes/reminders.ts), contando también las que ya
 *   se avisaron al vendedor.
 */
import { opportunityTimeline } from "../metrics/timeline";
import { ACT_FOLLOW_UP, selectQuoteFollowUps, type QuoteFollowUp } from "../quotes/reminders";
import { ACT_QUOTE } from "../quotes/link";
import { STAGES, isClosedStage, type StageId } from "../stages";
import type { Activity, Opportunity, StageHistoryEntry } from "../store/types";
import type { Week } from "./period";

export interface WeekActivity {
  start: string;
  end: string;
  visitas: number;
  llamadas: number;
  cotizaciones: number;
}

export function weeklyActivity(activities: readonly Pick<Activity, "tipo" | "occurredAt">[], weeks: readonly Week[]): WeekActivity[] {
  const out = weeks.map((w) => ({ start: w.start, end: w.end, visitas: 0, llamadas: 0, cotizaciones: 0 }));
  for (const a of activities) {
    const t = a.occurredAt.getTime();
    const i = weeks.findIndex((w) => t >= w.from.getTime() && t < w.to.getTime());
    if (i < 0) continue;
    if (a.tipo === "visita") out[i].visitas++;
    else if (a.tipo === "llamada") out[i].llamadas++;
    else if (a.tipo === ACT_QUOTE) out[i].cotizaciones++;
  }
  return out;
}

export interface StageAverage {
  etapa: StageId;
  label: string;
  /** Días promedio (1 decimal); null sin estancias terminadas. */
  dias: number | null;
  /** Estancias terminadas consideradas. */
  n: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function stageAverages(history: readonly Pick<StageHistoryEntry, "etapa" | "enteredAt" | "leftAt">[]): StageAverage[] {
  const acc = new Map<string, { sum: number; n: number }>();
  for (const h of history) {
    if (!h.leftAt) continue;
    const a = acc.get(h.etapa) ?? { sum: 0, n: 0 };
    a.sum += Math.max(0, h.leftAt.getTime() - h.enteredAt.getTime()) / DAY_MS;
    a.n++;
    acc.set(h.etapa, a);
  }
  return STAGES.filter((s) => !isClosedStage(s.id)).map((s) => {
    const a = acc.get(s.id);
    return { etapa: s.id, label: s.label, dias: a && a.n ? round1(a.sum / a.n) : null, n: a?.n ?? 0 };
  });
}

export interface AverageDays {
  dias: number | null;
  n: number;
}

/** `activities` = de las empresas de esas oportunidades (de cualquier usuario). */
export function assignmentToFirstCall(opps: readonly Opportunity[], history: readonly StageHistoryEntry[], activities: readonly Activity[], now: Date): AverageDays {
  const histBy = new Map<number, StageHistoryEntry[]>();
  for (const h of history) (histBy.get(h.opportunityId) ?? histBy.set(h.opportunityId, []).get(h.opportunityId)!).push(h);
  const actsBy = new Map<number, Activity[]>();
  for (const a of activities) (actsBy.get(a.companyId) ?? actsBy.set(a.companyId, []).get(a.companyId)!).push(a);
  let sum = 0;
  let n = 0;
  for (const o of opps) {
    // Solo actividades posteriores a la creación de la oportunidad (una llamada de una oportunidad anterior no cuenta).
    const acts = (actsBy.get(o.companyId) ?? []).filter((a) => a.occurredAt.getTime() >= o.createdAt.getTime() - 60_000);
    const d = opportunityTimeline(histBy.get(o.id) ?? [], acts, now).asignacionAPrimeraLlamada;
    if (d === null || d < 0) continue;
    sum += d;
    n++;
  }
  return { dias: n ? round1(sum / n) : null, n };
}

/** Cotizaciones enlazadas sin respuesta tras `businessDays` días hábiles (incluye las ya avisadas). */
export function unansweredQuotes(input: { opportunities: readonly Opportunity[]; activities: readonly Activity[]; stageHistory: readonly StageHistoryEntry[]; now: Date; businessDays: number; holidays: readonly string[] }): QuoteFollowUp[] {
  return selectQuoteFollowUps({
    opportunities: input.opportunities.filter((o) => o.quoteNumber && !o.closedAt),
    activities: input.activities.filter((a) => a.tipo !== ACT_FOLLOW_UP),
    stageHistory: [...input.stageHistory],
    now: input.now,
    businessDays: input.businessDays,
    holidays: input.holidays,
  });
}
