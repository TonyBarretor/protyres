/**
 * Invitación automática a la encuesta (trabajo "encuestas" del cron diario, bloque C3).
 *
 * Interruptor SURVEY_AUTO (apagado por defecto): si no es "1" o "true", o si la corrida es dryRun, no crea ni envía nada;
 * solo informa qué empresas se encuestarían. Encendido, por cada empresa elegida (select.ts):
 *   1. Vuelve a comprobar que su última venta sea real (no demo): con ventas demo no se escribe a nadie.
 *   2. Crea la encuesta solo si la empresa no tiene otra en los últimos meses (atómico en el store): correr el cron dos
 *      veces el mismo día no crea dos encuestas.
 *   3. Si hay contacto con correo y Resend tiene remitente verificado: correo de invitación al contacto.
 *   4. Si no (o el correo falla): tarea para el vendedor dueño (actividad `tarea` y, si su oportunidad abierta no tiene
 *      próxima acción, esa tarea como próxima acción) y el enlace por WhatsApp para que lo reenvíe él. Fuera de la ventana
 *      de 24 h queda como aviso pendiente (lo ve al escribir al bot). Solo a usuarios internos (el dueño en el portal).
 *   Si no se pudo entregar por ningún lado, la encuesta queda vencida sin enviar y no cuenta: se reintenta otro día.
 */
import { isWindowError } from "../bot/commands/cita";
import { addNotice } from "../bot/state";
import { loadPortalConfig, type PortalSurveysConfig } from "../config";
import type { Company, Contact, PortalStore, PortalUser } from "../store/types";
import type { WhatsAppClient } from "../../whatsapp/client";
import { isEmail, sendSurveyEmail, surveyEmailReady, type SurveyEmailSender } from "./email";
import { forwardText, invitationEmail, sellerNotice, sellerTaskText, type InvitationInput } from "./messages";
import { isRealSale, lastRealSale, selectSurveyCandidates } from "./select";
import { createSurveyLink, type CreatedSurvey } from "./service";

type Env = Record<string, string | undefined>;

export const SURVEY_NOTICE_KIND = "encuesta";

export function surveyAutoEnabled(env: Env): boolean {
  return /^(1|true)$/i.test((env.SURVEY_AUTO ?? "").trim());
}

/** Contacto al que se escribe: el primero con correo válido; si ninguno tiene, el primero (para el saludo). */
export function pickContact(contacts: Contact[]): { contact: Contact | null; withEmail: boolean } {
  const withEmail = contacts.find((c) => isEmail(c.email));
  if (withEmail) return { contact: withEmail, withEmail: true };
  return { contact: contacts[0] ?? null, withEmail: false };
}

/** Vendedor interno que puede reenviar: activo, con WhatsApp y no técnico. */
export function forwardingSeller(u: PortalUser | null | undefined): PortalUser | null {
  return u && u.activo && u.rol !== "tecnico" && !!u.whatsapp ? u : null;
}

export type SellerDelivery = "whatsapp" | "aviso_pendiente";

/**
 * Plan B: el vendedor reenvía el enlace. Primero el WhatsApp (aviso + texto para reenviar en un mensaje aparte); si sale
 * (o queda como aviso pendiente por la ventana de 24 h), la tarea y la próxima acción. Lanza si el envío falla por otra cosa.
 */
export async function deliverToSeller(
  store: PortalStore,
  client: Pick<WhatsAppClient, "sendText">,
  seller: PortalUser,
  company: Company,
  created: CreatedSurvey,
  inv: InvitationInput,
  motivo: string,
  now: Date,
  log: (m: string) => void = () => undefined,
): Promise<SellerDelivery> {
  const to = seller.whatsapp!;
  const notice = sellerNotice({ ...inv, motivo });
  const fwd = forwardText(inv);
  let status: SellerDelivery = "whatsapp";
  try {
    await client.sendText(to, notice);
    await client.sendText(to, fwd);
  } catch (err) {
    if (!isWindowError(err)) throw err;
    log(`encuestas: ${seller.nombre} (${to}) fuera de la ventana de 24 h; el enlace queda como aviso pendiente`);
    await addNotice(store, to, { text: `${notice}\n\n${fwd}`, createdAt: now.toISOString(), kind: SURVEY_NOTICE_KIND });
    status = "aviso_pendiente";
  }
  await store.markSurveySent(created.survey.id, now, "whatsapp_vendedor");
  const tarea = sellerTaskText(company.razonSocial);
  const opp = await store.getOpenOpportunity(company.id, seller.id);
  await store.addActivity({ companyId: company.id, opportunityId: opp?.id ?? null, userId: seller.id, tipo: "tarea", texto: tarea, canal: "whatsapp", data: { encuesta: created.survey.id }, occurredAt: now });
  // no se pisa una próxima acción que el vendedor ya tenía
  if (opp && !opp.proximaAccion) await store.updateOpportunity(opp.id, { proximaAccion: tarea, proximaAccionAt: now });
  return status;
}

/** Correo al contacto; si sale, marca la encuesta enviada y lo anota en la actividad. */
export async function deliverByEmail(
  store: PortalStore,
  company: Company,
  contact: Contact,
  created: CreatedSurvey,
  inv: InvitationInput,
  env: Env,
  now: Date,
  opts: { sendEmail?: SurveyEmailSender; replyTo?: string | null; userId?: number | null } = {},
): Promise<{ sent: boolean; to: string; error?: string }> {
  const msg = invitationEmail(inv);
  const res = await (opts.sendEmail ?? sendSurveyEmail)({ ...msg, to: contact.email!, replyTo: opts.replyTo ?? null }, env);
  if (!res.sent) return { sent: false, to: res.to, error: res.error };
  await store.markSurveySent(created.survey.id, now, "email");
  await store.addActivity({
    companyId: company.id,
    userId: opts.userId ?? null,
    tipo: "encuesta",
    texto: `Encuesta de satisfacción enviada por correo a ${contact.nombre} (${res.to}).`,
    canal: "email",
    data: { encuesta: created.survey.id },
    occurredAt: now,
  });
  return { sent: true, to: res.to };
}

export type InviteStatus = "correo" | "whatsapp_vendedor" | "aviso_pendiente" | "ya_encuestada" | "sin_canal" | "demo" | "error" | "simulado";

export interface InviteResult {
  companyId: number;
  razonSocial: string;
  ultimaVenta: string;
  status: InviteStatus;
  detalle?: string;
}

export interface SurveyInvitesReport {
  /** SURVEY_AUTO encendido. */
  auto: boolean;
  dryRun: boolean;
  candidatas: number;
  correos: number;
  whatsappVendedor: number;
  avisosPendientes: number;
  yaEncuestadas: number;
  sinCanal: number;
  errores: number;
  resultados: InviteResult[];
}

export interface RunSurveyInvitesInput {
  store: PortalStore;
  /** Puede faltar con dryRun o con SURVEY_AUTO apagado. */
  client?: Pick<WhatsAppClient, "sendText"> | null;
  now?: Date;
  dryRun?: boolean;
  env?: Env;
  log?: (msg: string) => void;
  /** Por defecto config/portal.json → surveys. */
  config?: PortalSurveysConfig;
  /** Para tests. */
  sendEmail?: SurveyEmailSender;
}

export async function runSurveyInvites(input: RunSurveyInvitesInput): Promise<SurveyInvitesReport> {
  const { store } = input;
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const log = input.log ?? (() => undefined);
  const cfg = input.config ?? loadPortalConfig().surveys;
  const auto = surveyAutoEnabled(env);
  const dryRun = input.dryRun ?? false;
  const sel = await selectSurveyCandidates(store, now, cfg);
  const report: SurveyInvitesReport = { auto, dryRun, candidatas: sel.candidates.length, correos: 0, whatsappVendedor: 0, avisosPendientes: 0, yaEncuestadas: 0, sinCanal: 0, errores: 0, resultados: [] };

  if (!auto || dryRun) {
    // solo informa: no crea encuestas ni escribe a nadie
    for (const c of sel.candidates) report.resultados.push({ companyId: c.company.id, razonSocial: c.company.razonSocial, ultimaVenta: c.lastSale.fecha, status: "simulado" });
    return report;
  }

  const emailReady = surveyEmailReady(env);
  for (const { company, lastSale } of sel.candidates) {
    const base = { companyId: company.id, razonSocial: company.razonSocial, ultimaVenta: lastSale.fecha };
    const push = (status: InviteStatus, detalle?: string) => report.resultados.push({ ...base, status, ...(detalle ? { detalle } : {}) });
    try {
      // doble chequeo contra demo, con datos frescos
      const fresh = lastRealSale(await store.salesByRuc(company.ruc, sel.from), sel.until);
      if (!isRealSale(lastSale) || !fresh || !isRealSale(fresh)) {
        push("demo", "sin venta real");
        continue;
      }
      const { contact, withEmail } = pickContact(await store.listContacts(company.id));
      const owner = company.ownerUserId === null ? null : await store.getUser(company.ownerUserId);
      const seller = forwardingSeller(owner);
      const byEmail = withEmail && emailReady;
      if (!byEmail && (!seller || !input.client)) {
        report.sinCanal++;
        push("sin_canal", !seller ? "sin correo (o Resend sin remitente verificado) y sin vendedor dueño con WhatsApp" : "sin cliente de WhatsApp");
        continue;
      }
      const created = await createSurveyLink(store, {
        companyId: company.id,
        contactId: contact?.id ?? null,
        canal: byEmail ? "email" : "whatsapp_vendedor",
        now,
        expiresDays: cfg.expiresDays,
        onlyIfNoneSince: sel.cooldownSince,
        env,
      });
      if (!created) {
        report.yaEncuestadas++;
        push("ya_encuestada");
        continue;
      }
      const inv: InvitationInput = { razonSocial: company.razonSocial, url: created.url, expiresAt: created.survey.expiresAt, contactName: contact?.nombre ?? null, sellerName: owner?.nombre ?? null };
      let emailError: string | undefined;
      if (byEmail) {
        const r = await deliverByEmail(store, company, contact!, created, inv, env, now, { sendEmail: input.sendEmail });
        if (r.sent) {
          report.correos++;
          push("correo", r.to);
          continue;
        }
        emailError = r.error;
        log(`encuestas: no pude enviar el correo a ${company.razonSocial}: ${r.error}`);
      }
      if (!seller || !input.client) {
        await store.expireSurvey(created.survey.id); // nunca se entregó: no cuenta, se reintenta otro día
        report.errores++;
        push("error", `correo: ${emailError ?? "no enviado"}`);
        continue;
      }
      const motivo = emailError ? `No pude enviar el correo (${emailError}).` : contact && withEmail ? "El envío de correos aún no está configurado." : "No tenemos el correo del cliente.";
      try {
        const st = await deliverToSeller(store, input.client, seller, company, created, inv, motivo, now, log);
        if (st === "whatsapp") report.whatsappVendedor++;
        else report.avisosPendientes++;
        push(st === "whatsapp" ? "whatsapp_vendedor" : "aviso_pendiente", seller.nombre);
      } catch (err) {
        await store.expireSurvey(created.survey.id);
        throw err;
      }
    } catch (err) {
      const msg = (err as Error).message;
      log(`encuestas: ${company.razonSocial}: ${msg}`);
      report.errores++;
      push("error", msg);
    }
  }
  return report;
}
