/**
 * Textos de la invitación a la encuesta (bloque C3): correo al contacto, mensaje para que el vendedor lo reenvíe por
 * WhatsApp y el aviso al vendedor. Puro.
 */
import { formatLimaShort } from "../ui/time";

export const BRAND = "360 Tyres";
export const SIGNATURE_COMPANY = "360 by Professional Tyres";

export interface InvitationInput {
  razonSocial: string;
  url: string;
  expiresAt: Date;
  /** Nombre del contacto (si hay). */
  contactName?: string | null;
  /** Vendedor que firma (si hay). */
  sellerName?: string | null;
}

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function greeting(i: InvitationInput): string {
  return i.contactName?.trim() ? `Estimado/a ${i.contactName.trim()}` : `Estimados señores de ${i.razonSocial}`;
}

/** Correo de invitación (texto y HTML sencillo con el mismo contenido). */
export function invitationEmail(i: InvitationInput): EmailMessage {
  const subject = `¿Cómo le fue con ${BRAND}? Encuesta de 2 minutos`;
  const vence = formatLimaShort(i.expiresAt);
  const firma = [i.sellerName?.trim(), SIGNATURE_COMPANY].filter(Boolean) as string[];
  const lines = [
    `${greeting(i)},`,
    "",
    `Gracias por confiar en ${BRAND}. Queremos saber cómo fue su experiencia con nuestra última entrega a ${i.razonSocial}.`,
    "Son 5 preguntas y toma menos de 2 minutos:",
    "",
    i.url,
    "",
    `El enlace es personal y vence el ${vence}.`,
    "",
    "Saludos cordiales,",
    ...firma,
  ];
  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#16181c;max-width:560px">`,
    `<p>${esc(greeting(i))},</p>`,
    `<p>Gracias por confiar en ${BRAND}. Queremos saber cómo fue su experiencia con nuestra última entrega a <strong>${esc(i.razonSocial)}</strong>.</p>`,
    `<p>Son 5 preguntas y toma menos de 2 minutos.</p>`,
    `<p><a href="${esc(i.url)}" style="display:inline-block;background:#f5b400;color:#16181c;font-weight:bold;text-decoration:none;padding:12px 20px;border-radius:8px">Responder la encuesta</a></p>`,
    `<p style="font-size:13px;color:#5f6570">Si el botón no funciona, copie este enlace: ${esc(i.url)}<br>El enlace es personal y vence el ${esc(vence)}.</p>`,
    `<p>Saludos cordiales,<br>${firma.map(esc).join("<br>")}</p>`,
    `</div>`,
  ].join("\n");
  return { subject, text: lines.join("\n"), html };
}

/** Texto para que el vendedor lo reenvíe al cliente por WhatsApp (sin comandos ni negritas del bot). */
export function forwardText(i: InvitationInput): string {
  return [
    `${greeting(i)}, gracias por confiar en ${BRAND}.`,
    `¿Nos ayuda con 5 preguntas (menos de 2 minutos) sobre nuestra última entrega? Su opinión nos sirve para mejorar:`,
    i.url,
    i.sellerName?.trim() ? `${i.sellerName.trim()} · ${SIGNATURE_COMPANY}` : SIGNATURE_COMPANY,
  ].join("\n");
}

/** Aviso por WhatsApp al vendedor: qué hacer y el texto listo para reenviar (en un mensaje aparte). */
export function sellerNotice(i: InvitationInput & { motivo: string }): string {
  return [
    `*Encuesta de satisfacción* — ${i.razonSocial}`,
    `${i.motivo} Reenvía al cliente el mensaje que te mando a continuación (vence el ${formatLimaShort(i.expiresAt)}).`,
  ].join("\n");
}

/** Texto de la tarea / próxima acción del vendedor. */
export function sellerTaskText(razonSocial: string): string {
  return `Reenviar la encuesta de satisfacción a ${razonSocial} (el enlace llegó por WhatsApp)`;
}
