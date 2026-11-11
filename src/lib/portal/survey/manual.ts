/**
 * Botón "Enviar encuesta" de la ficha (bloque C3), en dos pasos: vista previa del mensaje → confirmar.
 * Con contacto con correo y Resend con remitente verificado se envía el correo; si no, se devuelve el enlace y el texto
 * para que el vendedor lo copie y lo reenvíe por WhatsApp.
 *
 * La vista previa avisa (sin bloquear) si la empresa solo tiene ventas demo, no es cliente o ya tiene una encuesta abierta,
 * y si EMAIL_REDIRECT_TO está puesto (modo prueba: el correo va a esa dirección).
 */
import { surveyCounts } from "../store/survey-shared";
import type { Company, Contact, PortalStore, PortalUser, Survey } from "../store/types";
import { addDays, formatLimaShort } from "../ui/time";
import { isEmail, surveyEmailReady, surveyRedirectTo, type SurveyEmailSender } from "./email";
import { deliverByEmail, expireIfUndelivered } from "./invite";
import { forwardText, invitationEmail, type EmailMessage, type InvitationInput } from "./messages";
import { isRealSale } from "./select";
import { createSurveyLink } from "./service";

type Env = Record<string, string | undefined>;

/** Lo que se ve antes de confirmar (el enlace real se genera al confirmar). */
export const PREVIEW_URL = "[enlace personal de la encuesta]";

export type ManualPreview =
  /** `modoPrueba`: "Modo prueba: el correo irá a …" si EMAIL_REDIRECT_TO está puesto; null si va al cliente. */
  | { mode: "email"; contact: Contact; to: string; email: EmailMessage; modoPrueba: string | null }
  | { mode: "link"; contact: Contact | null; text: string; motivo: string };

/** Contacto elegido (si es de la empresa) o, si no, el primero con correo, o el primero. */
export function chooseContact(contacts: Contact[], contactId: number | null): Contact | null {
  if (contactId !== null) {
    const c = contacts.find((x) => x.id === contactId);
    if (c) return c;
  }
  return contacts.find((c) => isEmail(c.email)) ?? contacts[0] ?? null;
}

export function previewManualSurvey(company: Company, contact: Contact | null, seller: Pick<PortalUser, "nombre">, expiresDays: number, env: Env, now: Date = new Date()): ManualPreview {
  const inv: InvitationInput = { razonSocial: company.razonSocial, url: PREVIEW_URL, expiresAt: addDays(now, expiresDays), contactName: contact?.nombre ?? null, sellerName: seller.nombre };
  const ready = surveyEmailReady(env);
  if (contact && isEmail(contact.email) && ready) {
    const redirect = surveyRedirectTo(env);
    const to = redirect ?? contact.email!.trim();
    return { mode: "email", contact, to, email: invitationEmail(inv), modoPrueba: redirect ? `Modo prueba: el correo irá a ${redirect}` : null };
  }
  const motivo = !contact ? "La empresa no tiene contactos." : !isEmail(contact.email) ? `${contact.nombre} no tiene correo.` : "El envío de correos aún no está configurado (Resend sin remitente verificado).";
  return { mode: "link", contact, text: forwardText(inv), motivo };
}

/**
 * Avisos de la vista previa (no bloquean el envío): solo ventas demo, no es cliente, o ya tiene una encuesta abierta
 * (pendiente o enviada, sin responder y sin vencer; una pendiente huérfana no cuenta).
 */
export async function manualSurveyWarnings(store: PortalStore, company: Company, now: Date = new Date()): Promise<string[]> {
  const out: string[] = [];
  if (!company.esCliente) out.push("La empresa no está marcada como cliente.");
  const sales = await store.salesByRuc(company.ruc);
  if (sales.length > 0 && !sales.some(isRealSale)) out.push("La empresa solo tiene ventas demo (de prueba).");
  const open = (await store.listSurveys({ companyId: company.id }))
    .filter((s) => (s.estado === "pendiente" || s.estado === "enviada") && s.expiresAt.getTime() > now.getTime() && surveyCounts(s, now))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (open) out.push(`Ya tiene una encuesta abierta (${open.estado}, vence el ${formatLimaShort(open.expiresAt)}) sin responder.`);
  return out;
}

export type ManualResult =
  | { mode: "email"; survey: Survey; to: string }
  | { mode: "link"; survey: Survey; url: string; token: string; text: string; error?: string };

/** Crea la encuesta y la entrega. Quien llama ya comprobó permisos (canEditCompany). */
export async function sendManualSurvey(
  store: PortalStore,
  input: { company: Company; contact: Contact | null; user: PortalUser; expiresDays: number; env: Env; now?: Date; sendEmail?: SurveyEmailSender },
): Promise<ManualResult> {
  const now = input.now ?? new Date();
  const { company, contact, user, env } = input;
  const preview = previewManualSurvey(company, contact, user, input.expiresDays, env, now);
  const created = await createSurveyLink(store, { companyId: company.id, contactId: contact?.id ?? null, canal: preview.mode === "email" ? "email" : "manual", createdBy: user.id, now, expiresDays: input.expiresDays, env });
  if (!created) throw new Error("No se pudo crear la encuesta.");
  const inv: InvitationInput = { razonSocial: company.razonSocial, url: created.url, expiresAt: created.survey.expiresAt, contactName: contact?.nombre ?? null, sellerName: user.nombre };
  let error: string | undefined;
  if (preview.mode === "email") {
    let r;
    try {
      r = await deliverByEmail(store, company, preview.contact, created, inv, env, now, { sendEmail: input.sendEmail, userId: user.id });
    } catch (err) {
      await expireIfUndelivered(store, created.survey.id);
      throw err;
    }
    if (r.sent) return { mode: "email", survey: (await store.getSurvey(created.survey.id)) ?? created.survey, to: r.to };
    error = r.error ?? "no se pudo enviar el correo";
  }
  // el vendedor se lleva el enlace: cuenta como entregada
  const survey = (await store.markSurveySent(created.survey.id, now, "manual")) ?? created.survey;
  await store.addActivity({
    companyId: company.id,
    userId: user.id,
    tipo: "encuesta",
    texto: `Encuesta de satisfacción creada; enlace para reenviar${contact ? ` a ${contact.nombre}` : ""} por WhatsApp.`,
    canal: "portal",
    data: { encuesta: created.survey.id },
    occurredAt: now,
  });
  return { mode: "link", survey, url: created.url, token: created.token, text: forwardText(inv), ...(error ? { error } : {}) };
}
