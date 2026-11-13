/**
 * Fechas y horas en español escritas por WhatsApp ("martes 10am", "el martes a las 10", "mañana 3pm", "pasado mañana 9:30",
 * "hoy 16:00", "15/11 9:00", "15/11/2026 9h", "15 de noviembre 10 am", "lunes 3 y media", "viernes al mediodía",
 * "10:30 am", "3pm"), en hora de Lima (UTC−5 fijo; helpers de ui/time.ts). Puro: `now` se inyecta.
 *
 * Reglas:
 *   - Día de semana = el próximo; si hoy es ese día, el de la semana siguiente ("hoy" es hoy).
 *   - Fecha sin año = la próxima ocurrencia (si el día ya pasó este año, el año siguiente).
 *   - Solo hora = hoy si todavía no pasó, si no mañana.
 *   - Hora sin am/pm entre 1 y 6 = de la tarde (horario de oficina: "lunes 3 y media" = 15:30).
 *   - Un número suelto cuenta como hora solo pegado a un día ("martes 10"); solo, hace falta am/pm, ":mm", "h", "a las"...
 *   - Día sin hora = allDay (medianoche de Lima): quien llama pide la hora.
 */
import { addDays, limaDateKey, limaStartOfDay, parseLimaLocal } from "../ui/time";

export interface DateMatch {
  /** Instante (hora de Lima resuelta). Con allDay, la medianoche de Lima de ese día. */
  date: Date;
  /** Lo que se consumió del texto original (día y hora; si estaban separados, unidos por un espacio). */
  text: string;
  /** Se dio el día pero no la hora. */
  allDay?: boolean;
  /** Solo se dio la hora (día deducido: hoy o mañana). */
  timeOnly?: boolean;
  /** Texto antes del día/hora. */
  before: string;
  /** Texto después (sin lo consumido). */
  after: string;
  /** El texto sin lo consumido (before + after). */
  rest: string;
}

export interface TimeOfDay {
  hour: number;
  minute: number;
}

const WEEKDAYS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
const MONTHS: Record<string, number> = {
  enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3, abril: 4, abr: 4, mayo: 5, may: 5, junio: 6, jun: 6, julio: 7, jul: 7,
  agosto: 8, ago: 8, setiembre: 9, septiembre: 9, set: 9, sep: 9, sept: 9, octubre: 10, oct: 10, noviembre: 11, nov: 11, diciembre: 12, dic: 12,
};
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

const L = "(?<![a-z0-9])";
const R = "(?![a-z0-9])";
const PREFIX = String.raw`(?:(?:para\s+)?(?:el|este|esta)\s+)?(?:(?:proximo|siguiente)\s+)?`;

type DayKind = "hoy" | "manana" | "pasado" | "weekday" | "date";
interface DayHit {
  start: number;
  end: number;
  kind: DayKind;
  weekday?: number;
  d?: number;
  m?: number;
  y?: number;
}

const DAY_RES: { kind: DayKind; re: RegExp }[] = [
  { kind: "pasado", re: new RegExp(`${L}${PREFIX}pasado\\s+manana${R}`, "g") },
  { kind: "manana", re: new RegExp(`${L}(?<!(?:de|en|por)\\s+la\\s+)(?<!pasado\\s+)(?:para\\s+)?manana${R}`, "g") },
  { kind: "hoy", re: new RegExp(`${L}(?:para\\s+)?hoy(?:\\s+dia)?${R}`, "g") },
  { kind: "weekday", re: new RegExp(`${L}${PREFIX}(${WEEKDAYS.join("|")})${R}`, "g") },
  { kind: "date", re: new RegExp(`${L}(?:(?:para\\s+)?el\\s+)?(\\d{1,2})\\s*[/-]\\s*(\\d{1,2})(?:\\s*[/-]\\s*(\\d{4}|\\d{2}))?(?![0-9])`, "g") },
  { kind: "date", re: new RegExp(`${L}(?:(?:para\\s+)?el\\s+)?(\\d{1,2})\\s+(?:de\\s+)?(${MONTH_ALT})\\.?(?:\\s+(?:de|del)\\s+(\\d{4}))?${R}`, "g") },
];

interface TimeHit extends TimeOfDay {
  start: number;
  end: number;
  /** Se reconoce como hora aunque esté sola (am/pm, :mm, h, "a las", "y media", mediodía...). */
  strong: boolean;
}

const MERIDIEM = String.raw`a\.?\s?m\.?|p\.?\s?m\.?`;
const TIME_RE = new RegExp(
  `${L}(?:(a\\s+las|a\\s+la|las|al|a)\\s+)?(?:(medio\\s?dia)|(\\d{1,2})(?:\\s*[:.]\\s*(\\d{2})|\\s*(h)(?:rs?|oras?|s)?\\.?(?:\\s*(\\d{2}))?)?\\s*(${MERIDIEM})?(?:\\s+y\\s+(media|cuarto))?(?:\\s+(?:de|en|por)\\s+la\\s+(manana|tarde|noche))?)(?![a-z0-9])`,
  "g",
);

/** Minúsculas y sin tildes, misma longitud que el original (los índices sirven para cortar el texto original). */
function foldSameLength(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const f = c.normalize("NFD")[0].toLowerCase();
    out += f.length === 1 ? f : c;
  }
  return out;
}

function findDays(t: string): DayHit[] {
  const hits: DayHit[] = [];
  for (const { kind, re } of DAY_RES) {
    re.lastIndex = 0;
    for (let m = re.exec(t); m; m = re.exec(t)) {
      const hit: DayHit = { start: m.index, end: m.index + m[0].length, kind };
      if (kind === "weekday") hit.weekday = WEEKDAYS.indexOf(m[1]);
      if (kind === "date") {
        hit.d = parseInt(m[1], 10);
        hit.m = /^\d+$/.test(m[2]) ? parseInt(m[2], 10) : MONTHS[m[2]];
        if (m[3]) hit.y = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
      }
      hits.push(hit);
    }
  }
  // sin solapes: gana el más largo, luego el primero
  hits.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: DayHit[] = [];
  for (const h of hits) if (!kept.some((k) => h.start < k.end && k.start < h.end)) kept.push(h);
  kept.sort((a, b) => a.start - b.start);
  // "martes 18/11", "martes 18 de noviembre": manda la fecha explícita
  const merged: DayHit[] = [];
  for (const h of kept) {
    const prev = merged[merged.length - 1];
    if (prev && prev.kind === "weekday" && h.kind === "date" && /^[\s,]*$/.test(t.slice(prev.end, h.start))) {
      merged[merged.length - 1] = { ...h, start: prev.start };
    } else merged.push(h);
  }
  return merged;
}

function toTime(m: RegExpExecArray): Omit<TimeHit, "start" | "end"> | null {
  const [, prefix, noon, hStr, mm1, hForm, mm2, mer, frac, part] = m;
  if (noon) return { hour: 12, minute: 0, strong: true };
  let hour = parseInt(hStr, 10);
  const mmStr = mm1 ?? mm2;
  let minute = mmStr ? parseInt(mmStr, 10) : 0;
  if (frac && !mmStr) minute = frac === "media" ? 30 : 15;
  if (hour > 23 || minute > 59) return null;
  const merKind = mer ? (mer[0] === "p" ? "pm" : "am") : null;
  if (merKind === "pm" && hour < 12) hour += 12;
  else if (merKind === "am" && hour === 12) hour = 0;
  else if (!merKind && (part === "tarde" || part === "noche") && hour < 12) hour += 12;
  else if (!merKind && !part && hour >= 1 && hour <= 6) hour += 12;
  const strong = !!(mm1 || hForm || mer || frac || part || (prefix && prefix !== "a"));
  return { hour, minute, strong };
}

function findTimes(t: string, days: DayHit[]): TimeHit[] {
  // los días ya reconocidos se tapan para que "15/11" o "15 de noviembre" no cuenten como hora
  let masked = t;
  for (const d of days) masked = masked.slice(0, d.start) + "\u0001".repeat(d.end - d.start) + masked.slice(d.end);
  const out: TimeHit[] = [];
  TIME_RE.lastIndex = 0;
  for (let m = TIME_RE.exec(masked); m; m = TIME_RE.exec(masked)) {
    const tm = toTime(m);
    if (tm) out.push({ ...tm, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const GAP_RE = /^[\s,]*(?:(?:a\s+las?|al|a|las?|el|del|de|para\s+el)\s*)?[\s,]*$/;

function dayKey(day: DayHit, now: Date): string | null {
  const today = limaStartOfDay(now);
  const todayKey = limaDateKey(now);
  const plus = (n: number) => limaDateKey(addDays(today, n));
  switch (day.kind) {
    case "hoy":
      return todayKey;
    case "manana":
      return plus(1);
    case "pasado":
      return plus(2);
    case "weekday": {
      const wd = new Date(`${todayKey}T00:00:00Z`).getUTCDay();
      return plus((day.weekday! - wd + 7) % 7 || 7);
    }
    case "date": {
      const valid = (y: number) => {
        const key = `${y}-${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`;
        return parseLimaLocal(`${key}T00:00`) ? key : null;
      };
      if (!day.m || !day.d) return null;
      if (day.y) return valid(day.y);
      // la próxima ocurrencia (29/02 puede estar hasta 4 años adelante)
      const year = parseInt(todayKey.slice(0, 4), 10);
      for (let y = year; y <= year + 4; y++) {
        const key = valid(y);
        if (key && key >= todayKey) return key;
      }
      return null;
    }
  }
}

function at(key: string, t: TimeOfDay): Date {
  return parseLimaLocal(`${key}T${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`)!;
}

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
}

function build(src: string, ranges: [number, number][], date: Date, extra: Partial<DateMatch>): DateMatch {
  ranges.sort((a, b) => a[0] - b[0]);
  const text = ranges.map(([a, b]) => src.slice(a, b).trim()).join(" ");
  const before = tidy(src.slice(0, ranges[0][0]));
  let afterRaw = "";
  let pos = ranges[0][1];
  for (const [a, b] of ranges.slice(1)) {
    afterRaw += `${src.slice(pos, a)} `;
    pos = b;
  }
  afterRaw += src.slice(pos);
  const after = tidy(afterRaw);
  return { date, text, before, after, rest: tidy(`${before} ${after}`), ...extra };
}

/**
 * Busca un día y/o una hora en `input`. Prioridad: día con hora pegada (antes o después) > día y hora separados >
 * solo día (allDay) > solo hora (hoy si no pasó, si no mañana). null si no hay nada reconocible o la fecha no existe.
 */
export function parseSpanishDateTime(input: string, now: Date): DateMatch | null {
  const src = input.normalize("NFC");
  const t = foldSameLength(src);
  const allDays = findDays(t);
  // una fecha que no existe ("31/02") no se reemplaza por otra cosa: mejor preguntar
  if (allDays.some((d) => !dayKey(d, now))) return null;
  const days = allDays;
  const times = findTimes(t, days);

  for (const d of days) {
    const after = times.find((h) => h.start >= d.end && GAP_RE.test(t.slice(d.end, h.start)));
    const before = after ? null : times.find((h) => h.end <= d.start && GAP_RE.test(t.slice(h.end, d.start)) && h.strong);
    const tm = after ?? before;
    // pegados: un solo tramo (incluye el conector: "10 de la mañana *del* viernes")
    if (tm) return build(src, [[Math.min(d.start, tm.start), Math.max(d.end, tm.end)]], at(dayKey(d, now)!, tm), {});
  }
  const strong = times.filter((h) => h.strong);
  if (days.length && strong.length) {
    const d = days[0];
    const tm = strong[0];
    return build(src, [[d.start, d.end], [tm.start, tm.end]], at(dayKey(d, now)!, tm), {});
  }
  if (days.length) {
    const d = days[0];
    return build(src, [[d.start, d.end]], at(dayKey(d, now)!, { hour: 0, minute: 0 }), { allDay: true });
  }
  if (strong.length) {
    const tm = strong[0];
    let date = at(limaDateKey(now), tm);
    if (date.getTime() <= now.getTime()) date = at(limaDateKey(addDays(limaStartOfDay(now), 1)), tm);
    return build(src, [[tm.start, tm.end]], date, { timeOnly: true });
  }
  return null;
}

/** Solo una hora ("10", "10am", "a las 3 y media", "mediodía"); el texto entero debe ser la hora. null si no lo es. */
export function parseTimeOfDay(input: string): TimeOfDay | null {
  const t = foldSameLength(input.normalize("NFC").trim()).replace(/[.!]+$/, "");
  TIME_RE.lastIndex = 0;
  const m = TIME_RE.exec(t);
  if (!m || m.index !== 0 || m[0].length !== t.length) return null;
  const tm = toTime(m);
  return tm ? { hour: tm.hour, minute: tm.minute } : null;
}

/** Ese día (Lima) a esa hora. */
export function atLimaTime(day: Date, time: TimeOfDay): Date {
  return at(limaDateKey(day), time);
}

const WEEKDAY_LABEL = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** "martes 18/11 10:00" (hora de Lima); con allDay sin hora. */
export function formatCitaDate(d: Date, allDay = false): string {
  const local = new Date(d.getTime() - 5 * 60 * 60 * 1000);
  const dd = String(local.getUTCDate()).padStart(2, "0");
  const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
  const hm = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
  return `${WEEKDAY_LABEL[local.getUTCDay()]} ${dd}/${mm}${allDay ? "" : ` ${hm}`}`;
}

/**
 * Días aproximados que se dicen en un reporte (no en una cita, que pide día y hora exactos): "la próxima semana" / "la
 * semana que viene" / "la otra semana" = el lunes siguiente; "fin de mes" / "a fines de mes" = el último día del mes en
 * curso (Lima). Medianoche de Lima; null si no hay ninguno.
 */
export function parseVagueDay(input: string, now: Date): Date | null {
  const t = foldSameLength(input.normalize("NFC"));
  const today = limaStartOfDay(now);
  if (/(?<![a-z])(?:(?:la\s+)?(?:proxima|siguiente|otra)\s+semana|(?:la\s+)?semana\s+que\s+viene)(?![a-z])/.test(t)) {
    const dow = new Date(today.getTime() - 5 * 60 * 60 * 1000).getUTCDay();
    return addDays(today, ((8 - dow) % 7) || 7);
  }
  if (/(?<![a-z])(?:a\s+)?(?:fin|fines|finales)\s+de(?:l)?\s+mes(?![a-z])/.test(t)) {
    const [y, m] = limaDateKey(now).split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return parseLimaLocal(`${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}T00:00`);
  }
  return null;
}
