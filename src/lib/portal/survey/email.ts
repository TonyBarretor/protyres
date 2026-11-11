/**
 * Envío del correo de invitación con Resend (como el cotizador, src/lib/quote/email.ts): RESEND_API_KEY, EMAIL_FROM y
 * EMAIL_REDIRECT_TO (si está, todo correo va a esa dirección: modo prueba). En modo prueba la invitación automática no
 * crea ni envía nada (solo informa, como dryRun: no se marca a nadie como encuestado ni se gasta la ventana de 6 meses);
 * el envío manual sí sale, redirigido, y la vista previa lo avisa.
 *
 * A diferencia del cotizador, aquí no hay modo borrador: si el remitente no está verificado no se envía y quien llama
 * cae al plan B (el vendedor reenvía el enlace por WhatsApp).
 */
import type { EmailMessage } from "./messages";

type Env = Record<string, string | undefined>;

/**
 * Resend listo para escribir a clientes: clave y remitente propio. El de ejemplo de .env.example (@example.com) y el de
 * pruebas de Resend (onboarding@resend.dev, solo entrega a la cuenta dueña) no cuentan como verificados.
 */
export function surveyEmailReady(env: Env = process.env): boolean {
  const key = (env.RESEND_API_KEY ?? "").trim();
  const from = (env.EMAIL_FROM ?? "").trim();
  if (!key || !from) return false;
  return !/@example\.(com|org|net)\b/i.test(from) && !/@resend\.dev\b/i.test(from);
}

/** Destino de EMAIL_REDIRECT_TO (modo prueba) o null. */
export function surveyRedirectTo(env: Env = process.env): string | null {
  return (env.EMAIL_REDIRECT_TO ?? "").trim() || null;
}

/** Modo prueba: EMAIL_REDIRECT_TO puesto. */
export function surveyTestMode(env: Env = process.env): boolean {
  return surveyRedirectTo(env) !== null;
}

/** Forma básica de correo (la del formulario de contactos). */
export function isEmail(v: string | null | undefined): v is string {
  return !!v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

export interface SurveyEmailInput extends EmailMessage {
  to: string;
  replyTo?: string | null;
}

export interface SurveyEmailResult {
  sent: boolean;
  /** Destino real (EMAIL_REDIRECT_TO si está). */
  to: string;
  id?: string;
  error?: string;
}

export type SurveyEmailSender = (msg: SurveyEmailInput, env: Env) => Promise<SurveyEmailResult>;

export const sendSurveyEmail: SurveyEmailSender = async (msg, env) => {
  const to = surveyRedirectTo(env) ?? msg.to.trim();
  if (!surveyEmailReady(env)) return { sent: false, to, error: "Resend no está configurado con un remitente verificado" };
  if (!isEmail(to)) return { sent: false, to, error: "correo no válido" };
  const { Resend } = await import("resend");
  const resend = new Resend(env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: env.EMAIL_FROM!.trim(),
    to: [to],
    replyTo: msg.replyTo || undefined,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
  if (error) return { sent: false, to, error: error.message };
  return { sent: true, to, id: data?.id };
};
