/**
 * Corrida J, punto 4: la invitación de calendario por correo. Outlook clásico de escritorio (calendario "Solo este PC")
 * no se puede escribir desde fuera; lo que sí entiende es una invitación iTIP (RFC 5546/6047): un correo con la parte
 * `text/calendar; method=REQUEST` dentro de multipart/alternative, que muestra con Aceptar y guarda en su calendario
 * local. El mismo .ics va además como adjunto (respaldo para otros clientes).
 *
 * Remitente y servicio: los mismos que ya usa el proyecto (Resend: RESEND_API_KEY + EMAIL_FROM, y EMAIL_REDIRECT_TO como
 * modo prueba), sin remitente ni dominio nuevos. Apagado (con el motivo) si falta la clave, si EMAIL_FROM falta o es el de
 * ejemplo / onboarding@resend.dev, o si es @360tyres.pe (su SPF estricto haría rechazar el correo).
 *
 * Transporte (config/portal.json `appointments.invite.transport`):
 *   - "smtp" (por defecto): el MIME armado aquí por el SMTP de Resend (smtp.resend.com:465, usuario `resend`, la clave
 *     de la API). Es el único camino de Resend que deja poner la parte text/calendar inline.
 *   - "api": la API JSON de Resend con el .ics adjunto como `text/calendar; method=REQUEST` (no permite parte inline;
 *     Outlook lo muestra como adjunto que se abre y acepta). Alternativa si el SMTP no sale desde el servidor.
 * En pruebas y en el simulador, configureCalendarMailer() reemplaza el envío (nunca sale un correo real).
 */
import crypto from "node:crypto";
import { surveyEmailReady } from "../survey/email";
import { smtpSend } from "./smtp";

type Env = Record<string, string | undefined>;

export interface CalendarInviteMail {
  /** EMAIL_FROM tal cual ("Nombre <dir@dominio>"). */
  from: string;
  to: string[];
  subject: string;
  text: string;
  /** El .ics (METHOD:REQUEST o CANCEL) con CRLF. */
  ics: string;
  method: "REQUEST" | "CANCEL";
  /** Nombre del adjunto (termina en .ics). */
  fileName: string;
}

export interface CalendarSendResult {
  sent: boolean;
  /** false: el correo no está configurado (no se intentó). */
  configured: boolean;
  /** Destinos reales (EMAIL_REDIRECT_TO si está). */
  to: string[];
  id?: string;
  error?: string;
}

export type CalendarMailer = (mail: CalendarInviteMail, env: Env) => Promise<{ sent: boolean; id?: string; error?: string }>;

export type CalendarTransport = "smtp" | "api";

let override: CalendarMailer | null = null;

/** Pruebas y simulador: reemplaza el envío (null = el real). Con un mailer puesto, el estado de las variables no importa. */
export function configureCalendarMailer(m: CalendarMailer | null): void {
  override = m;
}

export function calendarMailerConfigured(): boolean {
  return override !== null;
}

/** "Nombre <dir@dominio>" | "dir@dominio" -> { name, email } (null si no hay dirección). */
export function parseFromAddress(from: string): { name: string | null; email: string } | null {
  const s = from.trim();
  const m = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(s);
  if (m) return { name: m[1].replace(/^"|"$/g, "").trim() || null, email: m[2] };
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(s) ? { name: null, email: s } : null;
}

export type CalendarEmailStatus = { ready: true; from: string; organizer: { name: string | null; email: string } } | { ready: false; reason: string };

/** ¿Se puede mandar la invitación? Mismo criterio que la encuesta (remitente propio verificado) y nunca @360tyres.pe. */
export function calendarEmailStatus(env: Env = process.env): CalendarEmailStatus {
  const key = (env.RESEND_API_KEY ?? "").trim();
  const from = (env.EMAIL_FROM ?? "").trim();
  if (!key) return { ready: false, reason: "falta RESEND_API_KEY" };
  if (!from) return { ready: false, reason: "falta EMAIL_FROM (remitente de un dominio verificado en Resend)" };
  const parsed = parseFromAddress(from);
  if (!parsed) return { ready: false, reason: "EMAIL_FROM no es una dirección válida" };
  if (/@360tyres\.pe$/i.test(parsed.email)) return { ready: false, reason: "EMAIL_FROM usa @360tyres.pe (su SPF estricto haría rechazar el correo)" };
  if (!surveyEmailReady(env)) return { ready: false, reason: "EMAIL_FROM es el de ejemplo o el de pruebas de Resend (no es un dominio verificado)" };
  return { ready: true, from, organizer: parsed };
}

// ── MIME ──

const CRLF = "\r\n";

/** Quita saltos y controles de un valor de cabecera. */
function headerSafe(s: string): string {
  return s.replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, " ").trim();
}

/** RFC 2047: palabras codificadas en UTF-8/base64 de hasta ~45 bytes cada una (no se parte un carácter). */
function encodeWords(s: string): string {
  const clean = headerSafe(s);
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  const chunks: string[] = [];
  let cur = "";
  for (const ch of clean) {
    if (Buffer.byteLength(cur + ch, "utf8") > 45) {
      chunks.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, "utf8").toString("base64")}?=`).join(`${CRLF} `);
}

function fromHeader(from: string): string {
  const p = parseFromAddress(from);
  if (!p) return headerSafe(from);
  return p.name ? `${/^[A-Za-z0-9 .'-]*$/.test(p.name) ? p.name : encodeWords(p.name)} <${p.email}>` : p.email;
}

function base64Lines(s: string): string {
  return (Buffer.from(s, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join(CRLF);
}

/** Nombre de archivo seguro para cabeceras: sin comillas, barras ni controles; termina en .ics. */
function safeFileName(name: string): string {
  const base = headerSafe(name).replace(/["\\/\s]+/g, "-").replace(/[^\x20-\x7E]/g, "") || "cita.ics";
  return /\.ics$/i.test(base) ? base : `${base}.ics`;
}

/**
 * El correo completo (CRLF):
 *   multipart/mixed
 *     multipart/alternative
 *       text/plain; charset=UTF-8
 *       text/calendar; charset=UTF-8; method=REQUEST|CANCEL   <- Outlook la muestra como reunión (Aceptar)
 *     application/ics; name="….ics"  (adjunto)                <- respaldo
 */
export function buildInviteMime(mail: CalendarInviteMail, opts: { date?: Date; messageId?: string } = {}): string {
  const fromEmail = parseFromAddress(mail.from)?.email ?? "portal@localhost";
  const domain = fromEmail.split("@")[1] ?? "localhost";
  const rand = () => crypto.randomBytes(12).toString("hex");
  const mixed = `mixed_${rand()}`;
  const alt = `alt_${rand()}`;
  const file = safeFileName(mail.fileName);
  const headers = [
    `From: ${fromHeader(mail.from)}`,
    `To: ${mail.to.map(headerSafe).join(", ")}`,
    `Subject: ${encodeWords(mail.subject)}`,
    `Date: ${(opts.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${opts.messageId ?? `<${rand()}@${domain}>`}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];
  const parts = [
    ...headers,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(mail.text.replace(/\r?\n/g, "\r\n")),
    `--${alt}`,
    `Content-Type: text/calendar; charset=UTF-8; method=${mail.method}`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(mail.ics),
    `--${alt}--`,
    "",
    `--${mixed}`,
    `Content-Type: application/ics; name="${file}"`,
    `Content-Disposition: attachment; filename="${file}"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(mail.ics),
    `--${mixed}--`,
    "",
  ];
  return parts.join(CRLF);
}

// ── envío ──

async function sendViaSmtp(mail: CalendarInviteMail, env: Env): Promise<{ sent: boolean; id?: string; error?: string }> {
  const from = parseFromAddress(mail.from)!.email;
  const reply = await smtpSend(
    { host: (env.RESEND_SMTP_HOST ?? "").trim() || "smtp.resend.com", port: Number(env.RESEND_SMTP_PORT) || 465, secure: true, user: "resend", pass: env.RESEND_API_KEY!.trim() },
    { from, to: mail.to },
    buildInviteMime(mail),
  );
  const id = /id=([\w-]+)/i.exec(reply)?.[1];
  return { sent: true, ...(id ? { id } : {}) };
}

async function sendViaApi(mail: CalendarInviteMail, env: Env): Promise<{ sent: boolean; id?: string; error?: string }> {
  const { Resend } = await import("resend");
  const resend = new Resend(env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: mail.from,
    to: mail.to,
    subject: headerSafe(mail.subject),
    text: mail.text,
    attachments: [{ filename: safeFileName(mail.fileName), content: Buffer.from(mail.ics, "utf8").toString("base64"), contentType: `text/calendar; charset=UTF-8; method=${mail.method}` }],
  });
  if (error) return { sent: false, error: error.message };
  return { sent: true, id: data?.id };
}

/**
 * Manda la invitación. Nunca lanza: apagado, sin destinatarios o con error vuelve `sent: false` y el motivo (la cita no
 * depende del correo). EMAIL_REDIRECT_TO desvía todos los destinos (modo prueba).
 */
export async function sendCalendarInvite(mail: CalendarInviteMail, env: Env = process.env, transport: CalendarTransport = "smtp"): Promise<CalendarSendResult> {
  const redirect = (env.EMAIL_REDIRECT_TO ?? "").trim();
  const to = redirect ? [redirect] : [...new Set(mail.to.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (!override) {
    const status = calendarEmailStatus(env);
    if (!status.ready) return { sent: false, configured: false, to, error: status.reason };
  }
  if (!to.length) return { sent: false, configured: true, to, error: "sin destinatarios" };
  const out = { ...mail, to };
  try {
    const r = override ? await override(out, env) : transport === "api" ? await sendViaApi(out, env) : await sendViaSmtp(out, env);
    return { sent: r.sent, configured: true, to, ...(r.id ? { id: r.id } : {}), ...(r.error ? { error: r.error } : {}) };
  } catch (err) {
    return { sent: false, configured: true, to, error: ((err as Error)?.message ?? String(err)).slice(0, 300) };
  }
}
