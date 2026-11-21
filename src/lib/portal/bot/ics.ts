/**
 * Archivo .ics (RFC 5545) de una cita: el respaldo que se abre desde WhatsApp (METHOD:PUBLISH) y la invitación por correo
 * (iTIP, RFC 5546: METHOD:REQUEST / CANCEL con ORGANIZER y ATTENDEE) que Outlook muestra con Aceptar.
 * Hora con TZID America/Lima + VTIMEZONE (UTC−5 fijo, sin horario de verano); DTSTAMP en UTC. Líneas plegadas a 75
 * octetos (UTF-8, sin partir caracteres), CRLF, y escape de \ ; , y saltos de línea en los textos.
 */
import { LIMA_TZ } from "../ui/time";

export interface IcsEvent {
  /** Estable: la misma cita produce el mismo UID (Outlook actualiza en vez de duplicar). */
  uid: string;
  start: Date;
  durationMinutes: number;
  summary: string;
  location?: string | null;
  description?: string | null;
  url?: string | null;
  /** DTSTAMP; por defecto ahora. */
  stamp?: Date;
  /** Aviso antes de la cita (minutos); 0 o null = sin aviso. */
  alarmMinutes?: number | null;
  /** SEQUENCE: mayor que la anterior cuando la misma cita (mismo UID) cambia, para que Outlook la actualice. Por defecto 0. */
  sequence?: number;
  /**
   * PUBLISH (por defecto): el archivo que se abre a mano. REQUEST / CANCEL (iTIP, RFC 5546): la invitación por correo
   * que Outlook muestra con Aceptar (o "Quitar del calendario"); exigen ORGANIZER y al menos un ATTENDEE.
   */
  method?: IcsMethod;
  /** Quien organiza (el remitente del bot, nunca el invitado: si fuera el mismo, Outlook la trata como reunión propia). */
  organizer?: IcsPerson | null;
  /** Invitados (solo usuarios internos). */
  attendees?: IcsPerson[];
}

export type IcsMethod = "PUBLISH" | "REQUEST" | "CANCEL";

export interface IcsPerson {
  email: string;
  name?: string | null;
}

export const ICS_MIME = "text/calendar";

/**
 * Escape de un valor TEXT (RFC 5545 §3.3.11): \ ; , y saltos de línea (CRLF, LF o CR solo) como \n. Los caracteres de
 * control que TEXT no admite (todos salvo el tabulador) se quitan: un nombre de empresa o una nota con un CR suelto no
 * puede abrir una línea nueva del .ics (p. ej. "ATTENDEE:" o "END:VEVENT" inyectados).
 */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n|\u2028|\u2029/g, "\\n")
    .replace(/[\u0000-\u0008\u000A-\u001F\u007F]/g, "");
}

/** Pliega una línea de contenido a 75 octetos (continuaciones empiezan con un espacio). */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    const limit = out.length === 0 ? 75 : 74; // la continuación ya lleva el espacio inicial
    if (bytes + n > limit) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.map((l, i) => (i === 0 ? l : ` ${l}`)).join("\r\n");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 20261118T150000Z */
export function icsUtc(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** 20261118T100000 en hora de Lima (para DTSTART;TZID=America/Lima). */
export function icsLima(d: Date): string {
  return icsUtc(new Date(d.getTime() - 5 * 60 * 60 * 1000)).slice(0, -1);
}

/** Correo simple para un mailto: (sin espacios, controles, comillas ni separadores de propiedad). */
const ICS_EMAIL_RE = /^[^\s@"<>:;,\\]+@[^\s@"<>:;,\\]+\.[^\s@"<>:;,\\]+$/;

/** CN como param-text sin comillas: fuera ", ;, :, ,, = y controles (no puede abrir otro parámetro ni otra línea). */
function paramText(s: string): string {
  return s
    .replace(/[\u0000-\u001F\u007F\u2028\u2029";:,=]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function personLine(prop: "ORGANIZER" | "ATTENDEE", p: IcsPerson): string {
  const email = p.email.trim();
  if (!ICS_EMAIL_RE.test(email)) throw new Error(`ics: correo no válido en ${prop}`);
  const cn = p.name ? paramText(p.name) : "";
  const params = [cn ? `CN=${cn}` : null, ...(prop === "ATTENDEE" ? ["CUTYPE=INDIVIDUAL", "ROLE=REQ-PARTICIPANT", "PARTSTAT=NEEDS-ACTION", "RSVP=FALSE"] : [])].filter(Boolean);
  return `${prop}${params.map((x) => `;${x}`).join("")}:mailto:${email}`;
}

export function buildIcs(ev: IcsEvent): string {
  const end = new Date(ev.start.getTime() + ev.durationMinutes * 60_000);
  const method = ev.method ?? "PUBLISH";
  const itip = method !== "PUBLISH";
  if (itip && !ev.organizer) throw new Error(`ics: METHOD:${method} necesita ORGANIZER`);
  if (itip && !ev.attendees?.length) throw new Error(`ics: METHOD:${method} necesita al menos un ATTENDEE`);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//360 Tyres//Portal comercial//ES",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VTIMEZONE",
    `TZID:${LIMA_TZ}`,
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:-0500",
    "TZOFFSETTO:-0500",
    "TZNAME:-05",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `DTSTAMP:${icsUtc(ev.stamp ?? new Date())}`,
    `DTSTART;TZID=${LIMA_TZ}:${icsLima(ev.start)}`,
    `DTEND;TZID=${LIMA_TZ}:${icsLima(end)}`,
    `SUMMARY:${escapeText(ev.summary)}`,
  ];
  if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
  if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
  if (ev.url) lines.push(`URL:${ev.url}`);
  if (itip) {
    lines.push(personLine("ORGANIZER", ev.organizer!));
    for (const a of ev.attendees!) lines.push(personLine("ATTENDEE", a));
  }
  const cancel = method === "CANCEL";
  lines.push(cancel ? "STATUS:CANCELLED" : "STATUS:CONFIRMED", `SEQUENCE:${Math.max(0, Math.floor(ev.sequence ?? 0))}`, "TRANSP:OPAQUE");
  if (!cancel && ev.alarmMinutes && ev.alarmMinutes > 0) {
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(ev.summary)}`, `TRIGGER:-PT${Math.round(ev.alarmMinutes)}M`, "END:VALARM");
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

/** Lee un .ics de vuelta (desplegado y sin escapes) — para pruebas y verificación: [{ name, params, value }]. */
export function parseIcsLines(ics: string): { name: string; params: Record<string, string>; value: string }[] {
  const unfolded = ics.replace(/\r\n[ \t]/g, "");
  return unfolded
    .split("\r\n")
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(":");
      const [name, ...ps] = line.slice(0, i).split(";");
      const params: Record<string, string> = {};
      for (const p of ps) {
        const [k, v] = p.split("=");
        params[k] = v;
      }
      const value = line.slice(i + 1).replace(/\\([\\;,nN])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
      return { name, params, value };
    });
}
