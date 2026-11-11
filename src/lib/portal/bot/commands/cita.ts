/**
 * `cita <empresa> <día y hora> [en <lugar>] [con danyer]`
 *   -> cita (appointments, con_tecnico), oportunidad abierta (en Prospecto si no hay) movida a Cita agendada (solo hacia
 *      adelante), próxima acción "Visita" en la fecha de la cita, actividad `cita`, y al vendedor: el .ics como documento
 *      SIN leyenda seguido del resumen en un mensaje aparte (para agregarla a Outlook).
 *   -> "con danyer" / "con el ing. danyer" / "con técnico": aviso por WhatsApp al jefe del Dpto. Técnico (config/portal.json
 *      `techLead`); sin número configurado, se le dice al vendedor que avise él.
 * La empresa es lo que va antes de la fecha (varias coincidencias -> lista y la cita sigue al elegir). Sin hora -> la pide.
 */
import { canEditCompany } from "../../auth/permissions";
import { loadPortalConfig, type PortalTechLeadConfig } from "../../config";
import { stageIndex, stageLabel } from "../../stages";
import { digits, foldText } from "../../store/shared";
import type { Appointment, Company, Contact } from "../../store/types";
import { companyUrl, resolveCompany, shortName } from "../companies";
import { atLimaTime, formatCitaDate, parseSpanishDateTime, parseTimeOfDay } from "../dates";
import { buildIcs, ICS_MIME } from "../ics";
import { registerCompanyAction, registerPendingHandler, registerPortalCommand, type PortalContext } from "../registry";
import { clearPending, setPending, type PendingStep } from "../state";
import { limaDateKey, limaStartOfDay } from "../../ui/time";

export const CITA_USAGE = "Escríbelo así: *cita ZBUSS martes 10am en su base de Ate* (añade *con danyer* si va el Ing. Danyer).";
export const NO_TECH_NUMBER = "No tengo el número del Ing. Danyer; avísale tú o pide a Tony que lo configure.";

/** "con danyer", "con el ing. danyer saavedra", "con el ingeniero", "con técnico", "con el técnico". */
const TECH_RE = /(?:^|[\s,;])(?:y\s+)?con\s+(?:el\s+|un\s+)?(?:(?:ing(?:eniero)?|ing°|ingº)\.?\s+)?(?:danyer(?:\s+saavedra)?|t[eé]cnico|ingeniero)(?=$|[\s,.;])/i;

export interface ParsedCita {
  empresa: string;
  date: Date;
  /** Se dio el día pero no la hora: hay que pedirla. */
  allDay: boolean;
  lugar: string | null;
  conTecnico: boolean;
}

/** Separa empresa, fecha, lugar y "con danyer". */
export function parseCitaArgs(args: string, now: Date): ParsedCita | { error: string } {
  let text = args.trim();
  const tech = TECH_RE.exec(text);
  const conTecnico = !!tech;
  if (tech) text = `${text.slice(0, tech.index)} ${text.slice(tech.index + tech[0].length)}`.trim();
  const dm = parseSpanishDateTime(text, now);
  if (!dm) return { error: `No entendí el día y la hora. ${CITA_USAGE}` };
  let empresa = dm.before.replace(/^(?:con|a|para)\s+/i, "").replace(/[\s,;:-]+(?:para|el)?$/i, "").trim();
  let lugar: string | null = dm.after.replace(/^[\s,;:.-]+/, "").replace(/^(?:en|lugar:?)\s+/i, "").replace(/[\s,;.]+$/, "").trim() || null;
  if (!lugar) {
    // "cita zbuss en su base de Ate martes 10am"
    const m = /^(.+?)\s+en\s+(.+)$/i.exec(empresa);
    if (m) {
      empresa = m[1].trim();
      lugar = m[2].trim();
    }
  }
  if (!empresa) return { error: `Falta la empresa. ${CITA_USAGE}` };
  return { empresa, date: dm.date, allDay: !!dm.allDay, lugar: lugar ? lugar.slice(0, 200) : null, conTecnico };
}

// ── jefe técnico ──

export function techLeadConfig(): PortalTechLeadConfig {
  return loadPortalConfig().techLead;
}

export function techLeadNumber(cfg: PortalTechLeadConfig, env: Record<string, string | undefined>): string | null {
  const fixed = digits(cfg.whatsapp);
  if (fixed) return fixed;
  const fromEnv = (env[cfg.whatsappEnv] ?? "")
    .split(",")
    .map((s) => digits(s))
    .find(Boolean);
  return fromEnv || null;
}

/** WhatsApp rechaza mensajes libres fuera de las 24 h desde el último mensaje del destinatario (error 131047). */
export function isWindowError(err: unknown): boolean {
  return /131047|re-?engagement|24\s*h|24 hours|customer service window|outside .*window/i.test(String((err as Error)?.message ?? err));
}

export type TechNotice = { status: "enviado"; to: string } | { status: "sin_numero" } | { status: "ventana" | "error"; to: string; error: string };

async function notifyTechLead(ctx: PortalContext, company: Company, appt: Appointment, contacts: Contact[]): Promise<TechNotice> {
  const cfg = techLeadConfig();
  const number = techLeadNumber(cfg, ctx.env);
  if (!number) return { status: "sin_numero" };
  try {
    // el bot solo escribe a usuarios internos: el jefe técnico configurado se registra como `tecnico` si aún no está
    // (si el número ya es de otro usuario, se respeta ese usuario y su rol)
    let tech = await ctx.store.getUserByWhatsapp(number);
    if (!tech) {
      tech = await ctx.store.upsertUser({ nombre: cfg.nombre, whatsapp: number, rol: "tecnico" });
      ctx.log(`portal: ${cfg.nombre} registrado como tecnico (${number})`);
    }
    const c = contacts[0];
    const body = [
      "👷 *Cita con el Dpto. Técnico*",
      `${ctx.user.nombre} agendó una visita a *${company.razonSocial}* (RUC ${company.ruc}) el *${formatCitaDate(appt.startsAt)}*${appt.lugar ? ` en ${appt.lugar}` : ""}, y pidió que lo acompañes.`,
      c ? `Contacto: ${contactLine(c)}` : null,
      `Ficha: ${companyUrl(company.id, ctx.env)}`,
    ]
      .filter(Boolean)
      .join("\n");
    await ctx.sendTextTo(number, body);
    ctx.log(`portal: aviso de cita ${appt.id} enviado al jefe técnico (${number})`);
    return { status: "enviado", to: number };
  } catch (err) {
    const error = (err as Error).message ?? String(err);
    ctx.log(`portal: no pude avisar al jefe técnico (${number}): ${error}`);
    return { status: isWindowError(err) ? "ventana" : "error", to: number, error };
  }
}

function techLine(notice: TechNotice | null, nombre: string): string | null {
  if (!notice) return null;
  if (notice.status === "enviado") return `👷 Avisé al Ing. ${nombre} por WhatsApp.`;
  if (notice.status === "sin_numero") return NO_TECH_NUMBER;
  if (notice.status === "ventana") return `⚠️ No pude avisar al Ing. ${nombre}: WhatsApp solo me deja escribirle si me escribió en las últimas 24 h. Avísale tú (o que me mande un mensaje y vuelve a agendar).`;
  return `⚠️ No pude avisar al Ing. ${nombre} (${notice.error.slice(0, 120)}). Avísale tú.`;
}

// ── la cita ──

function contactLine(c: Contact): string {
  return `${c.nombre}${c.cargo ? ` (${c.cargo})` : ""}${c.telefono ? ` · ${c.telefono}` : ""}${c.email ? ` · ${c.email}` : ""}`;
}

function slug(s: string): string {
  return foldText(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "empresa";
}

export function icsFileName(company: Company, start: Date): string {
  return `cita-${slug(shortName(company.razonSocial))}-${limaDateKey(start).replace(/-/g, "")}.ics`;
}

export interface CitaInput {
  date: Date;
  lugar: string | null;
  conTecnico: boolean;
}

/** Crea la cita y responde (.ics sin leyenda + resumen). La fecha ya viene con hora. */
export async function createCita(ctx: PortalContext, company: Company, input: CitaInput): Promise<Appointment> {
  const { store, user, now } = ctx;
  const cfg = loadPortalConfig();
  let opp = await store.getOpenOpportunity(company.id);
  if (!opp) opp = await store.createOpportunity({ companyId: company.id, ownerUserId: company.ownerUserId ?? user.id, etapa: "prospecto", createdBy: user.id, at: now });
  const appt = await store.addAppointment({ companyId: company.id, opportunityId: opp.id, userId: user.id, startsAt: input.date, lugar: input.lugar, conTecnico: input.conTecnico, estado: "programada" });
  const fromStage = opp.etapa;
  // solo hacia adelante: una oportunidad ya en Visita realizada o más allá no retrocede
  const moved = stageIndex(fromStage) < stageIndex("cita_agendada");
  if (moved) opp = (await store.moveStage(opp.id, "cita_agendada", user.id, now)) ?? opp;
  opp = (await store.updateOpportunity(opp.id, { proximaAccion: "Visita", proximaAccionAt: input.date })) ?? opp;

  const contacts = await store.listContacts(company.id);
  const notice = input.conTecnico ? await notifyTechLead(ctx, company, appt, contacts) : null;
  const when = formatCitaDate(input.date);
  const techName = cfg.techLead.nombre;
  await store.addActivity({
    companyId: company.id,
    opportunityId: opp.id,
    userId: user.id,
    tipo: "cita",
    texto: `Cita agendada para el ${when}${input.lugar ? ` en ${input.lugar}` : ""}${input.conTecnico ? ` con el Ing. ${techName}` : ""}.`,
    canal: "whatsapp",
    occurredAt: now,
    data: { appointmentId: appt.id, startsAt: input.date.toISOString(), lugar: input.lugar, conTecnico: input.conTecnico, avisoTecnico: notice },
  });

  const url = companyUrl(company.id, ctx.env);
  const description = [
    `Visita a ${company.razonSocial} (RUC ${company.ruc})`,
    ...contacts.slice(0, 3).map((c) => `Contacto: ${contactLine(c)}`),
    input.conTecnico ? `Con el Ing. ${techName} (Dpto. Técnico)` : null,
    `Vendedor: ${user.nombre}`,
    `Ficha: ${url}`,
  ]
    .filter(Boolean)
    .join("\n");
  const ics = buildIcs({
    uid: `cita-${appt.id}-${company.ruc}@portal.360tyres`,
    start: input.date,
    durationMinutes: cfg.appointments.durationMinutes,
    summary: `Visita: ${company.razonSocial}`,
    location: input.lugar,
    description,
    url,
    stamp: now,
    alarmMinutes: cfg.appointments.alarmMinutes,
  });
  const file = Buffer.from(ics, "utf8");
  const name = icsFileName(company, input.date);
  try {
    await ctx.sendDocument(file, name, "", ICS_MIME);
  } catch (err) {
    // la API de WhatsApp puede no aceptar text/calendar al subir: mismo archivo .ics como texto plano
    ctx.log(`portal: .ics como ${ICS_MIME} falló (${(err as Error).message}); reintento como text/plain`);
    await ctx.sendDocument(file, name, "", "text/plain");
  }

  const lines = [`📅 Cita con *${company.razonSocial}* el *${when}*${input.lugar ? ` en ${input.lugar}` : ""} · Agrégala a tu calendario de Outlook abriendo el archivo.`];
  lines.push(moved ? `Oportunidad: ${stageLabel(fromStage)} → *${stageLabel("cita_agendada")}* · próxima acción: Visita` : `Oportunidad: sigue en *${stageLabel(opp.etapa)}* · próxima acción: Visita`);
  const tl = techLine(notice, techName);
  if (tl) lines.push(tl);
  await ctx.reply(lines.join("\n"));
  return appt;
}

// ── flujo del comando ──

interface CitaArgs {
  fecha: string;
  allDay: boolean;
  lugar: string | null;
  conTecnico: boolean;
}

/** Paso pendiente: la cita tiene día pero falta la hora. */
export interface CitaHoraStep extends PendingStep {
  kind: "cita_hora";
  companyId: number;
  /** ISO de la medianoche (Lima) del día. */
  day: string;
  lugar: string | null;
  conTecnico: boolean;
}

async function continueCita(ctx: PortalContext, company: Company, a: CitaArgs): Promise<void> {
  if (!canEditCompany(ctx.user, company)) {
    await ctx.reply(`*${company.razonSocial}* no es tuya. Primero: *asignarme ${company.ruc}* (o pide al supervisor).`);
    return;
  }
  const date = new Date(a.fecha);
  if (a.allDay) {
    const step: Omit<CitaHoraStep, "createdAt"> = { kind: "cita_hora", companyId: company.id, day: date.toISOString(), lugar: a.lugar, conTecnico: a.conTecnico };
    await setPending(ctx.store, ctx.from, step, ctx.now);
    await ctx.reply(`¿A qué hora es la cita con *${company.razonSocial}* el ${formatCitaDate(date, true)}? Responde la hora (p. ej. *10am* o *15:30*).`);
    return;
  }
  await createCita(ctx, company, { date, lugar: a.lugar, conTecnico: a.conTecnico });
}

function pastReply(date: Date, allDay: boolean): string {
  return `Esa fecha ya pasó (${formatCitaDate(date, allDay)}). Escribe otro día y hora.`;
}

registerCompanyAction("cita", (ctx, company, args) => continueCita(ctx, company, args as unknown as CitaArgs));

registerPortalCommand("cita", async (ctx, args) => {
  const p = parseCitaArgs(args, ctx.now);
  if ("error" in p) {
    await ctx.reply(p.error);
    return;
  }
  const past = p.allDay ? p.date.getTime() < limaStartOfDay(ctx.now).getTime() : p.date.getTime() <= ctx.now.getTime();
  if (past) {
    await ctx.reply(pastReply(p.date, p.allDay));
    return;
  }
  const a: CitaArgs = { fecha: p.date.toISOString(), allDay: p.allDay, lugar: p.lugar, conTecnico: p.conTecnico };
  const company = await resolveCompany(ctx, p.empresa, "cita", a as unknown as Record<string, unknown>);
  if (company) await continueCita(ctx, company, a);
});

/** Respuesta a "¿a qué hora?": "10", "10am", "a las 3 y media", "15:30". Otro texto no es respuesta. */
registerPendingHandler("cita_hora", async (ctx, step, text) => {
  const s = step as CitaHoraStep;
  const t = parseTimeOfDay(text);
  if (!t) return false;
  const date = atLimaTime(new Date(s.day), t);
  if (date.getTime() <= ctx.now.getTime()) {
    await ctx.reply(`${pastReply(date, false)} ¿A qué hora, entonces? (o *cancelar*)`);
    return true;
  }
  await clearPending(ctx.store, ctx.from);
  const company = await ctx.store.getCompany(s.companyId);
  if (!company) {
    await ctx.reply("Esa empresa ya no está en el padrón.");
    return true;
  }
  await createCita(ctx, company, { date, lugar: s.lugar, conTecnico: s.conTecnico });
  return true;
});
