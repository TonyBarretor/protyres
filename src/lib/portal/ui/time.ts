/**
 * Fechas del portal en hora de Lima (America/Lima = UTC−5 todo el año; Perú no tiene horario de verano desde 1994).
 * Puro: sirve en el servidor (que corre en UTC en Vercel) sin depender de la zona del proceso.
 */
export const LIMA_TZ = "America/Lima";
const LIMA_OFFSET_MS = -5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "AAAA-MM-DD" del día en Lima. */
export function limaDateKey(d: Date): string {
  return new Date(d.getTime() + LIMA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Medianoche (Lima) del día de `d`, como instante. */
export function limaStartOfDay(d: Date): Date {
  const key = limaDateKey(d);
  return new Date(Date.parse(`${key}T00:00:00Z`) - LIMA_OFFSET_MS);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/** Valor de <input type="datetime-local"> ("AAAA-MM-DDTHH:mm") leído como hora de Lima. null si no es válido. */
export function parseLimaLocal(v: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec((v ?? "").trim());
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const check = new Date(utc);
  if (check.getUTCMonth() !== Number(m[2]) - 1 || check.getUTCDate() !== Number(m[3])) return null;
  return new Date(utc - LIMA_OFFSET_MS);
}

/** Instante -> valor para <input type="datetime-local"> en hora de Lima. */
export function toLimaLocalInput(d: Date | null | undefined): string {
  if (!d) return "";
  return new Date(d.getTime() + LIMA_OFFSET_MS).toISOString().slice(0, 16);
}

const fmtDateTime = new Intl.DateTimeFormat("es-PE", { timeZone: LIMA_TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const fmtDate = new Intl.DateTimeFormat("es-PE", { timeZone: LIMA_TZ, weekday: "long", day: "numeric", month: "long" });
const fmtShort = new Intl.DateTimeFormat("es-PE", { timeZone: LIMA_TZ, day: "2-digit", month: "2-digit", year: "numeric" });
const fmtTime = new Intl.DateTimeFormat("es-PE", { timeZone: LIMA_TZ, hour: "2-digit", minute: "2-digit", hour12: false });

/** "mar, 11 nov, 15:30" */
export function formatLimaDateTime(d: Date): string {
  return fmtDateTime.format(d);
}

/** "martes, 11 de noviembre" */
export function formatLimaDay(d: Date): string {
  return fmtDate.format(d);
}

/** "11/11/2026" */
export function formatLimaShort(d: Date): string {
  return fmtShort.format(d);
}

/** "15:30" */
export function formatLimaTime(d: Date): string {
  return fmtTime.format(d);
}
