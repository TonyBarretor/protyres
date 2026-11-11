/**
 * Tiempos de una oportunidad (puro): días en cada etapa (opportunity_stage_history) y días entre los hitos
 * asignación → primera llamada / cita / visita / cotización (actividades + historial).
 *
 * Hitos (el primero de cada uno):
 *  - asignación: actividad con data.evento = "asignacion" (bot `asignarme`) o con texto "se asignó la empresa" /
 *    "asignó la empresa a" (portal); si no hay, la entrada a la primera etapa del historial.
 *  - primera llamada: actividad tipo "llamada".
 *  - cita: actividad tipo "cita" (cuando se agendó) o entrada a Cita agendada.
 *  - visita: actividad tipo "visita" (occurred_at = cuándo fue) o entrada a Visita realizada.
 *  - cotización: actividad tipo "cotizacion" o entrada a Cotización enviada.
 * Las diferencias son en días (con decimales, 2 cifras); null si falta alguno de los dos hitos.
 */
import { STAGE_IDS, type StageId } from "../stages";
import type { Activity, StageHistoryEntry } from "../store/types";

const DAY_MS = 24 * 60 * 60 * 1000;

export type TimelineHistory = Pick<StageHistoryEntry, "etapa" | "enteredAt" | "leftAt">;
export type TimelineActivity = Pick<Activity, "tipo" | "texto" | "data" | "occurredAt">;

export interface OpportunityTimeline {
  /** Días en cada etapa (suma si se volvió a entrar); la etapa abierta cuenta hasta `now`. Solo etapas visitadas. */
  diasPorEtapa: Partial<Record<StageId, number>>;
  hitos: { asignacion: Date | null; primeraLlamada: Date | null; cita: Date | null; visita: Date | null; cotizacion: Date | null };
  asignacionAPrimeraLlamada: number | null;
  asignacionACita: number | null;
  asignacionAVisita: number | null;
  asignacionACotizacion: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function earliest(...dates: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (d && !Number.isNaN(d.getTime()) && (!best || d.getTime() < best.getTime())) best = d;
  return best;
}

function firstActivity(activities: TimelineActivity[], pred: (a: TimelineActivity) => boolean): Date | null {
  return earliest(...activities.filter(pred).map((a) => a.occurredAt));
}

function firstEntry(history: TimelineHistory[], etapa: StageId): Date | null {
  return earliest(...history.filter((h) => h.etapa === etapa).map((h) => h.enteredAt));
}

const ASSIGN_TEXT = /se asign[oó] la empresa|asign[oó] la empresa a/i;

export function isAssignment(a: TimelineActivity): boolean {
  return (a.data as { evento?: unknown } | null)?.evento === "asignacion" || ASSIGN_TEXT.test(a.texto ?? "");
}

function days(from: Date | null, to: Date | null): number | null {
  if (!from || !to) return null;
  return round2((to.getTime() - from.getTime()) / DAY_MS);
}

export function opportunityTimeline(history: TimelineHistory[], activities: TimelineActivity[], now: Date = new Date()): OpportunityTimeline {
  const diasPorEtapa: Partial<Record<StageId, number>> = {};
  for (const h of history) {
    if (!(STAGE_IDS as string[]).includes(h.etapa)) continue;
    const end = h.leftAt ?? now;
    const d = Math.max(0, end.getTime() - h.enteredAt.getTime()) / DAY_MS;
    diasPorEtapa[h.etapa] = round2((diasPorEtapa[h.etapa] ?? 0) + d);
  }
  const asignacion = firstActivity(activities, isAssignment) ?? earliest(...history.map((h) => h.enteredAt));
  const primeraLlamada = firstActivity(activities, (a) => a.tipo === "llamada");
  const cita = earliest(firstActivity(activities, (a) => a.tipo === "cita"), firstEntry(history, "cita_agendada"));
  const visita = earliest(firstActivity(activities, (a) => a.tipo === "visita"), firstEntry(history, "visita_realizada"));
  const cotizacion = earliest(firstActivity(activities, (a) => a.tipo === "cotizacion"), firstEntry(history, "cotizacion_enviada"));
  return {
    diasPorEtapa,
    hitos: { asignacion, primeraLlamada, cita, visita, cotizacion },
    asignacionAPrimeraLlamada: days(asignacion, primeraLlamada),
    asignacionACita: days(asignacion, cita),
    asignacionAVisita: days(asignacion, visita),
    asignacionACotizacion: days(asignacion, cotizacion),
  };
}
