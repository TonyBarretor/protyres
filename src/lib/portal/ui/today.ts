/**
 * "Hoy" (/portal/hoy): próximas acciones vencidas o de hoy y citas de hoy y los próximos 7 días, en hora de Lima. Puro.
 */
import type { Appointment, Opportunity } from "../store/types";
import { addDays, limaDateKey, limaStartOfDay } from "./time";

export const APPOINTMENT_DAYS = 7;

export interface TodayAction {
  opportunity: Opportunity;
  /** Antes de hoy (Lima). */
  vencida: boolean;
}

export interface AppointmentDay {
  /** "AAAA-MM-DD" (Lima). */
  day: string;
  esHoy: boolean;
  citas: Appointment[];
}

export interface TodaySelection {
  /** Desde (inclusive) y hasta (exclusivo) de la ventana de citas. */
  from: Date;
  to: Date;
  acciones: TodayAction[];
  citas: AppointmentDay[];
}

/** Ventana de citas: desde las 00:00 de hoy (Lima) hasta el final del día hoy+7. */
export function appointmentWindow(now: Date, days = APPOINTMENT_DAYS): { from: Date; to: Date } {
  const from = limaStartOfDay(now);
  return { from, to: addDays(from, days + 1) };
}

/**
 * Acciones: oportunidades abiertas con proximaAccionAt antes del fin de hoy (Lima), la más antigua primero.
 * Citas: no canceladas dentro de la ventana, agrupadas por día (Lima) y ordenadas por hora.
 */
export function selectToday(opps: Opportunity[], appointments: Appointment[], now: Date, days = APPOINTMENT_DAYS): TodaySelection {
  const startToday = limaStartOfDay(now);
  const endToday = addDays(startToday, 1);
  const acciones = opps
    .filter((o) => o.closedAt === null && o.proximaAccionAt !== null && o.proximaAccionAt.getTime() < endToday.getTime())
    .sort((a, b) => a.proximaAccionAt!.getTime() - b.proximaAccionAt!.getTime() || a.id - b.id)
    .map((o) => ({ opportunity: o, vencida: o.proximaAccionAt!.getTime() < startToday.getTime() }));

  const { from, to } = appointmentWindow(now, days);
  const todayKey = limaDateKey(now);
  const byDay = new Map<string, Appointment[]>();
  for (const a of [...appointments].sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime() || x.id - y.id)) {
    if (a.estado === "cancelada") continue;
    const t = a.startsAt.getTime();
    if (t < from.getTime() || t >= to.getTime()) continue;
    const key = limaDateKey(a.startsAt);
    const list = byDay.get(key);
    if (list) list.push(a);
    else byDay.set(key, [a]);
  }
  const citas = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, list]) => ({ day, esHoy: day === todayKey, citas: list }));
  return { from, to, acciones, citas };
}
