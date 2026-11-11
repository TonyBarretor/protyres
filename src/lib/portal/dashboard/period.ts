/**
 * Fechas del tablero en hora de Lima (UTC−5 todo el año). Puro.
 *
 * Avance esperado a la fecha (decisión C2): proporción de **días hábiles** (lunes a viernes, sin los feriados de
 * config/portal.json `holidays`) transcurridos del periodo, contando el día de hoy como transcurrido. Es el mismo
 * calendario que usa el recordatorio de cotizaciones (quotes/reminders.ts). Un sábado o domingo no hace subir lo esperado:
 * el avance esperado del sábado es el del viernes.
 */
import { isBusinessDay } from "../quotes/reminders";
import type { IsoDate } from "../store/types";
import { limaDateKey, limaStartOfDay } from "../ui/time";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Día de calendario en Lima ("AAAA-MM-DD"). */
export function limaToday(now: Date): IsoDate {
  return limaDateKey(now);
}

/** Suma días a una fecha de calendario. */
export function addIsoDays(day: IsoDate, n: number): IsoDate {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export interface Period {
  /** Inclusive. */
  start: IsoDate;
  /** Inclusive. */
  end: IsoDate;
}

export function monthOf(day: IsoDate): Period {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${day.slice(0, 7)}-01`, end: `${day.slice(0, 7)}-${String(last).padStart(2, "0")}` };
}

export function yearOf(day: IsoDate): Period {
  return { start: `${day.slice(0, 4)}-01-01`, end: `${day.slice(0, 4)}-12-31` };
}

/** Días hábiles entre `start` y `end`, ambos inclusive (0 si end < start). */
export function countBusinessDays(start: IsoDate, end: IsoDate, holidays: readonly string[] = []): number {
  let n = 0;
  for (let d = start; d <= end; d = addIsoDays(d, 1)) if (isBusinessDay(d, holidays)) n++;
  return n;
}

export interface ExpectedProgress {
  /** Días hábiles transcurridos (hoy incluido). */
  elapsed: number;
  /** Días hábiles del periodo. */
  total: number;
  /** elapsed / total (0..1). */
  ratio: number;
}

/** Avance esperado a `today` en el periodo (días hábiles; ver cabecera). */
export function expectedProgress(period: Period, today: IsoDate, holidays: readonly string[] = []): ExpectedProgress {
  const total = countBusinessDays(period.start, period.end, holidays);
  const upTo = today < period.end ? today : period.end;
  const elapsed = today < period.start ? 0 : countBusinessDays(period.start, upTo, holidays);
  return { elapsed, total, ratio: total ? elapsed / total : 1 };
}

export interface Week {
  /** Lunes (Lima). */
  start: IsoDate;
  /** Domingo (Lima). */
  end: IsoDate;
  /** Instante de inicio (lunes 00:00 Lima). */
  from: Date;
  /** Instante de fin, exclusivo (lunes siguiente 00:00 Lima). */
  to: Date;
}

/** Las últimas `n` semanas lunes–domingo en Lima, la actual incluida (en curso), la más antigua primero. */
export function lastWeeks(now: Date, n = 8): Week[] {
  const today = limaToday(now);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = addIsoDays(today, -((dow + 6) % 7));
  const mondayStart = limaStartOfDay(new Date(Date.parse(`${monday}T12:00:00Z`)));
  const out: Week[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = addIsoDays(monday, -7 * i);
    const from = new Date(mondayStart.getTime() - 7 * i * DAY_MS);
    out.push({ start, end: addIsoDays(start, 6), from, to: new Date(from.getTime() + 7 * DAY_MS) });
  }
  return out;
}

/** Mismo día de hace 12 meses (Lima): inicio de la ventana de participación del tablero. */
export function twelveMonthsBefore(day: IsoDate): IsoDate {
  const y = Number(day.slice(0, 4)) - 1;
  const md = day.slice(5);
  // 29 de febrero -> 28 en un año no bisiesto
  const d = new Date(`${y}-${md}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(5, 10) !== md ? `${y}-${md.slice(0, 2)}-28` : `${y}-${md}`;
}
