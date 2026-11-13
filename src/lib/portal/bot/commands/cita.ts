/**
 * `cita <empresa> <día y hora> [en <lugar>] [con danyer]`
 *   -> cita (appointments, con_tecnico), oportunidad abierta (en Prospecto si no hay) movida a Cita agendada (solo hacia
 *      adelante), próxima acción "Visita" en la fecha de la cita, actividad `cita`, y al vendedor: el .ics como documento
 *      SIN leyenda seguido del resumen en un mensaje aparte (para agregarla a Outlook).
 *   -> "con danyer" / "con el ing. danyer" / "con técnico": aviso por WhatsApp al jefe del Dpto. Técnico (config/portal.json
 *      `techLead`); sin número configurado, se le dice al vendedor que avise él.
 * La empresa es lo que va antes de la fecha (varias coincidencias -> lista y la cita sigue al elegir). Sin hora -> la pide.
 * Texto de más tras el nombre ("cita zbuss para revisar llantas el viernes 10am") se ignora y se dice en una línea; sin
 * día -> lo pregunta (paso cita_fecha); sin empresa -> la pregunta (paso cita_empresa).
 */
import { canEditCompany } from "../../auth/permissions";
import { loadPortalConfig, type PortalTechLeadConfig } from "../../config";
import { stageIndex, stageLabel } from "../../stages";
import { digits, foldText } from "../../store/shared";
import type { Appointment, Company, Contact } from "../../store/types";
import { companyUrl, leftover, resolveCompany, shortName, splitCompany, unusedNote } from "../companies";
import { atLimaTime, formatCitaDate, parseSpanishDateTime, parseTimeOfDay } from "../dates";
import { buildIcs, ICS_MIME } from "../ics";
import { askAgain } from "../pause";
import { companyProgressLine } from "../progress";
import { registerCompanyAction, registerPausable, registerPendingHandler, registerPortalCommand, replyButtons, type PortalContext } from "../registry";
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

/** Lo que falta en el comando: "fecha" (sin día; `text` = el resto sin "con danyer") o "empresa" (`partial` = lo demás). */
export interface CitaParseError {
  error: string;
  missing: "fecha" | "empresa";
  text?: string;
  partial?: Omit<ParsedCita, "empresa">;
}

/** Separa empresa, fecha, lugar y "con danyer". */
export function parseCitaArgs(args: string, now: Date): ParsedCita | CitaParseError {
  let text = args.trim();
  const tech = TECH_RE.exec(text);
  const conTecnico = !!tech;
  if (tech) text = `${text.slice(0, tech.index)} ${text.slice(tech.index + tech[0].length)}`.trim();
  const dm = parseSpanishDateTime(text, now);
  if (!dm) return { error: `No entendí el día y la hora. ${CITA_USAGE}`, missing: "fecha", text };
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
  if (!empresa) return { error: `Falta la empresa. ${CITA_USAGE}`, missing: "empresa", partial: { date: dm.date, allDay: !!dm.allDay, lugar: lugar ? lugar.slice(0, 200) : null, conTecnico } };
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
  /** "No usé: «…»." (texto de más en el comando). */
  note?: string;
}

/** Cita programada de la empresa en el mismo minuto (misma empresa, fecha y hora), de cualquier vendedor. */
export async function findDuplicateCita(store: PortalContext["store"], companyId: number, date: Date, exceptId?: number): Promise<Appointment | null> {
  const from = new Date(Math.floor(date.getTime() / 60_000) * 60_000);
  const to = new Date(from.getTime() + 60_000);
  const rows = await store.listAppointments({ companyId, estado: "programada", from, to });
  return rows.find((a) => a.id !== exceptId) ?? null;
}

/** Manda el .ics de la cita como documento sin leyenda (si WhatsApp no acepta text/calendar, como text/plain). */
async function sendCitaIcs(ctx: PortalContext, company: Company, appt: Appointment, contacts: Contact[], sequence = 0): Promise<void> {
  const cfg = loadPortalConfig();
  const url = companyUrl(company.id, ctx.env);
  const vendedor = appt.userId && appt.userId !== ctx.user.id ? ((await ctx.store.getUser(appt.userId).catch(() => null))?.nombre ?? ctx.user.nombre) : ctx.user.nombre;
  const description = [
    `Visita a ${company.razonSocial} (RUC ${company.ruc})`,
    ...contacts.slice(0, 3).map((c) => `Contacto: ${contactLine(c)}`),
    appt.conTecnico ? `Con el Ing. ${cfg.techLead.nombre} (Dpto. Técnico)` : null,
    `Vendedor: ${vendedor}`,
    `Ficha: ${url}`,
  ]
    .filter(Boolean)
    .join("\n");
  const ics = buildIcs({
    uid: `cita-${appt.id}-${company.ruc}@portal.360tyres`,
    start: appt.startsAt,
    durationMinutes: cfg.appointments.durationMinutes,
    summary: `Visita: ${company.razonSocial}`,
    location: appt.lugar,
    description,
    url,
    stamp: ctx.now,
    alarmMinutes: cfg.appointments.alarmMinutes,
    sequence,
  });
  const file = Buffer.from(ics, "utf8");
  const name = icsFileName(company, appt.startsAt);
  try {
    await ctx.sendDocument(file, name, "", ICS_MIME);
  } catch (err) {
    // la API de WhatsApp puede no aceptar text/calendar al subir: mismo archivo .ics como texto plano
    ctx.log(`portal: .ics como ${ICS_MIME} falló (${(err as Error).message}); reintento como text/plain`);
    await ctx.sendDocument(file, name, "", "text/plain");
  }
}

/**
 * Crea la cita y responde (.ics sin leyenda + resumen). La fecha ya viene con hora. Si la empresa ya tiene una cita
 * programada en ese mismo día y hora, no crea otra: lo dice y ofrece reprogramar la existente (paso cita_reprogramar).
 */
export async function createCita(ctx: PortalContext, company: Company, input: CitaInput): Promise<Appointment> {
  const { store, user, now } = ctx;
  const cfg = loadPortalConfig();
  const dup = await findDuplicateCita(store, company.id, input.date);
  if (dup) {
    await offerReschedule(ctx, company, dup, input.note);
    return dup;
  }
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

  await sendCitaIcs(ctx, company, appt, contacts);

  const lines = [`📅 Cita con *${company.razonSocial}* el *${when}*${input.lugar ? ` en ${input.lugar}` : ""} · Agrégala a tu calendario de Outlook abriendo el archivo.`];
  if (input.note) lines.push(input.note);
  lines.push(moved ? `Oportunidad: ${stageLabel(fromStage)} → *${stageLabel("cita_agendada")}* · próxima acción: Visita` : `Oportunidad: sigue en *${stageLabel(opp.etapa)}* · próxima acción: Visita`);
  const tl = techLine(notice, techName);
  if (tl) lines.push(tl);
  const progress = await companyProgressLine(store, company, 3);
  if (progress) lines.push(progress);
  await ctx.reply(lines.join("\n"));
  return appt;
}

// ── cita duplicada: reprogramar ──

/**
 * Paso pendiente: la cita pedida ya existía; se ofrece reprogramarla (nuevo día y hora) o dejarla así. La oferta
 * (`cita_reprogramar`) no se pausa: si el vendedor manda otra cosa, se deja (la cita existente sigue igual, no se pierde
 * nada). Tras elegir *Reprogramar* (`cita_reprogramar_fecha`) ya está a mitad de algo y sí pasa a pausa como los demás.
 */
export interface CitaReprogramarStep extends PendingStep {
  kind: "cita_reprogramar" | "cita_reprogramar_fecha";
  appointmentId: number;
  companyId: number;
  /** Ya eligió *Reprogramar*: solo falta el día y la hora. */
  asked?: boolean;
  /** Dio el día sin hora: ISO de la medianoche (Lima) de ese día. */
  day?: string;
}

export const RESCHEDULE_BUTTONS = [
  { id: "reprogramar", title: "Reprogramar" },
  { id: "dejarla así", title: "Dejarla así" },
];
const RESCHEDULE_WORD = /^(?:reprogramar(?:la)?|reprograma(?:la)?|cambiar(?:la)?(?: de)?(?: fecha| hora)?|mover(?:la)?|s[ií])[.!]*$/i;
const KEEP_WORD = /^(?:dejar(?:la)?(?: as[ií])?|d[eé]jala(?: as[ií])?|as[ií] est[aá] bien|no|no gracias|est[aá] bien)[.!]*$/i;
const RESCHEDULE_FILLER = /^(?:(?:mejor|para|pasala|p[aá]sala|mu[eé]vela|c[aá]mbiala|reprogr[a-z]*|al?|el|la|las|de|en|y|ok|s[ií]|mejor)[\s,.!]*)*$/i;
const rescheduleQuestion = (company: Company) => `¿Para qué día y hora reprogramo la cita con *${company.razonSocial}*? (p. ej. *jueves 4pm* o *19/11 9:00*, o *cancelar*)`;

async function offerReschedule(ctx: PortalContext, company: Company, appt: Appointment, note?: string): Promise<void> {
  const step: Omit<CitaReprogramarStep, "createdAt"> = { kind: "cita_reprogramar", appointmentId: appt.id, companyId: company.id };
  await setPending(ctx.store, ctx.from, step, ctx.now);
  const body = [
    `📅 Ya existe una cita con *${company.razonSocial}* el *${formatCitaDate(appt.startsAt)}*${appt.lugar ? ` en ${appt.lugar}` : ""}. No creé otra.`,
    note || null,
    "¿Quieres reprogramarla? Responde el nuevo día y hora, o elige.",
  ]
    .filter(Boolean)
    .join("\n");
  await replyButtons(ctx, body, RESCHEDULE_BUTTONS);
}

/** Mueve la cita existente: misma cita (mismo UID en el .ics, SEQUENCE mayor), próxima acción y actividad. */
async function rescheduleCita(ctx: PortalContext, company: Company, appt: Appointment, date: Date): Promise<void> {
  const { store, user, now } = ctx;
  const from = appt.startsAt;
  const moved = (await store.updateAppointment(appt.id, { startsAt: date })) ?? { ...appt, startsAt: date };
  const opp = appt.opportunityId ? await store.getOpportunity(appt.opportunityId).catch(() => null) : null;
  // la próxima acción solo sigue a la cita si apuntaba a ella (no se pisa una próxima acción posterior distinta)
  if (opp && opp.proximaAccion === "Visita" && opp.proximaAccionAt?.getTime() === from.getTime()) await store.updateOpportunity(opp.id, { proximaAccionAt: date });
  await store.addActivity({
    companyId: company.id,
    opportunityId: appt.opportunityId,
    userId: user.id,
    tipo: "cita",
    texto: `Cita reprogramada del ${formatCitaDate(from)} al ${formatCitaDate(date)}.`,
    canal: "whatsapp",
    occurredAt: now,
    data: { appointmentId: appt.id, startsAt: date.toISOString(), antes: from.toISOString(), reprogramada: true },
  });
  // SEQUENCE creciente sin columna nueva: segundos desde que se creó la cita
  const sequence = Math.max(1, Math.floor((now.getTime() - appt.createdAt.getTime()) / 1000));
  await sendCitaIcs(ctx, company, moved, await store.listContacts(company.id), sequence);
  await ctx.reply(`🔁 Reprogramé la cita con *${company.razonSocial}*: del ${formatCitaDate(from)} al *${formatCitaDate(date)}*${moved.lugar ? ` en ${moved.lugar}` : ""}. Abre el archivo para actualizarla en Outlook.`);
}

const reprogramarHandler: Parameters<typeof registerPendingHandler>[1] = async (ctx, step, text) => {
  const s = step as CitaReprogramarStep;
  const t = text.trim();
  const [company, appt] = await Promise.all([ctx.store.getCompany(s.companyId), ctx.store.getAppointment(s.appointmentId)]);
  if (!company || !appt || appt.estado !== "programada") {
    await clearPending(ctx.store, ctx.from);
    await ctx.reply("Esa cita ya no está programada; no la cambié.");
    return true;
  }
  if (KEEP_WORD.test(t)) {
    await clearPending(ctx.store, ctx.from);
    await ctx.reply(`Listo. Queda la cita con *${company.razonSocial}* el *${formatCitaDate(appt.startsAt)}*.`);
    return true;
  }
  if (RESCHEDULE_WORD.test(t)) {
    if (!canEditCompany(ctx.user, company)) {
      await clearPending(ctx.store, ctx.from);
      await ctx.reply(notYours(company));
      return true;
    }
    await setPending(ctx.store, ctx.from, { ...s, kind: "cita_reprogramar_fecha", asked: true }, ctx.now);
    await ctx.reply(rescheduleQuestion(company));
    return true;
  }
  // el nuevo día y hora (o solo la hora, si ya dio el día)
  let date: Date | null = null;
  let allDay = false;
  // solo una fecha (con relleno corto: "mejor el jueves 4pm", "para el 19/11 a las 9"): un reporte o una cotización que
  // menciona un día ("quedamos en mandarle la cotización el jueves") no es la respuesta
  const dm0 = parseSpanishDateTime(t, ctx.now);
  const dm = dm0 && RESCHEDULE_FILLER.test(dm0.rest) ? dm0 : null;
  if (dm) {
    date = dm.date;
    allDay = !!dm.allDay;
  } else if (s.day) {
    const tod = parseTimeOfDay(t);
    if (tod) date = atLimaTime(new Date(s.day), tod);
  }
  if (!date) return false;
  if (!canEditCompany(ctx.user, company)) {
    await clearPending(ctx.store, ctx.from);
    await ctx.reply(notYours(company));
    return true;
  }
  if (isPast(date, allDay, ctx.now)) {
    await ctx.reply(`${pastReply(date, allDay)} (o *cancelar*)`);
    return true;
  }
  if (allDay) {
    await setPending(ctx.store, ctx.from, { ...s, kind: "cita_reprogramar_fecha", asked: true, day: date.toISOString() }, ctx.now);
    await ctx.reply(hourQuestion(company, date));
    return true;
  }
  const clash = await findDuplicateCita(ctx.store, company.id, date, appt.id);
  if (clash) {
    await ctx.reply(`📅 Ya existe una cita con *${company.razonSocial}* el *${formatCitaDate(clash.startsAt)}*. Elige otro día u hora (o *cancelar*).`);
    return true;
  }
  await clearPending(ctx.store, ctx.from);
  if (date.getTime() === appt.startsAt.getTime()) {
    await ctx.reply(`La cita con *${company.razonSocial}* ya es el *${formatCitaDate(date)}*; no cambié nada.`);
    return true;
  }
  await rescheduleCita(ctx, company, appt, date);
  return true;
};
registerPendingHandler("cita_reprogramar", reprogramarHandler);
registerPendingHandler("cita_reprogramar_fecha", reprogramarHandler);

registerPausable("cita_reprogramar_fecha", {
  async describe(ctx, step) {
    const s = step as CitaReprogramarStep;
    const c = await citaCompany(ctx, s.companyId);
    return { companyId: s.companyId, label: `reprogramar la cita con ${c ? shortName(c.razonSocial) : "la empresa"}`, missing: "falta el nuevo día y hora" };
  },
  async resume(ctx, step, prefix) {
    const c = await citaCompany(ctx, (step as CitaReprogramarStep).companyId);
    if (!c) return void (await ctx.reply("Esa empresa ya no está en el padrón."));
    await askAgain(ctx, step, prefix, rescheduleQuestion(c));
  },
});

// ── flujo del comando ──

interface CitaArgs {
  fecha: string;
  allDay: boolean;
  lugar: string | null;
  conTecnico: boolean;
  note?: string;
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

/** Paso pendiente: la cita tiene empresa pero falta el día (y la hora). */
export interface CitaFechaStep extends PendingStep {
  kind: "cita_fecha";
  companyId: number;
  lugar: string | null;
  conTecnico: boolean;
}

/** Paso pendiente: la cita tiene día pero falta la empresa. */
export interface CitaEmpresaStep extends PendingStep {
  kind: "cita_empresa";
  args: CitaArgs;
}

const notYours = (company: Company) => `*${company.razonSocial}* no es tuya. Primero: *asignarme ${company.ruc}* (o pide al supervisor).`;

const hourQuestion = (company: Company, day: Date) => `¿A qué hora es la cita con *${company.razonSocial}* el ${formatCitaDate(day, true)}? Responde la hora (p. ej. *10am* o *15:30*).`;
const dateQuestion = (company: Company) => `¿Qué día y a qué hora es la cita con *${company.razonSocial}*? (p. ej. *martes 10am* o *15/11 9:00*)`;
const companyQuestion = (a: Pick<CitaArgs, "fecha" | "allDay">) => `¿Con qué empresa es la cita del ${formatCitaDate(new Date(a.fecha), a.allDay)}? Escribe el nombre o el RUC.`;

async function askHour(ctx: PortalContext, company: Company, day: Date, lugar: string | null, conTecnico: boolean, note = ""): Promise<void> {
  const step: Omit<CitaHoraStep, "createdAt"> = { kind: "cita_hora", companyId: company.id, day: day.toISOString(), lugar, conTecnico };
  await setPending(ctx.store, ctx.from, step, ctx.now);
  await ctx.reply(`${note ? `${note}\n` : ""}${hourQuestion(company, day)}`);
}

async function continueCita(ctx: PortalContext, company: Company, a: CitaArgs): Promise<void> {
  if (!canEditCompany(ctx.user, company)) {
    await ctx.reply(notYours(company));
    return;
  }
  const date = new Date(a.fecha);
  if (a.allDay) {
    await askHour(ctx, company, date, a.lugar, a.conTecnico, a.note);
    return;
  }
  await createCita(ctx, company, { date, lugar: a.lugar, conTecnico: a.conTecnico, note: a.note });
}

/** Empresa sin día: pregunta el día y la hora (paso cita_fecha). */
async function askCitaDate(ctx: PortalContext, company: Company, a: { lugar: string | null; conTecnico: boolean; note?: string }): Promise<void> {
  if (!canEditCompany(ctx.user, company)) {
    await ctx.reply(notYours(company));
    return;
  }
  const step: Omit<CitaFechaStep, "createdAt"> = { kind: "cita_fecha", companyId: company.id, lugar: a.lugar, conTecnico: a.conTecnico };
  await setPending(ctx.store, ctx.from, step, ctx.now);
  await ctx.reply(`${a.note ? `${a.note}\n` : ""}${dateQuestion(company)}`);
}

function pastReply(date: Date, allDay: boolean): string {
  return `Esa fecha ya pasó (${formatCitaDate(date, allDay)}). Escribe otro día y hora.`;
}

const isPast = (date: Date, allDay: boolean, now: Date) => (allDay ? date.getTime() < limaStartOfDay(now).getTime() : date.getTime() <= now.getTime());

registerCompanyAction("cita", (ctx, company, args) => continueCita(ctx, company, args as unknown as CitaArgs));
registerCompanyAction("cita_sin_fecha", (ctx, company, args) => askCitaDate(ctx, company, args as unknown as { lugar: string | null; conTecnico: boolean }));

registerPortalCommand("cita", async (ctx, args) => {
  const p = parseCitaArgs(args, ctx.now);
  if ("error" in p) {
    if (p.missing === "fecha" && p.text) {
      // "cita zbuss": la empresa sí está, falta el día -> se pregunta
      const split = await splitCompany(ctx.store, p.text);
      if (split) {
        const tech = TECH_RE.test(args);
        // lo que sobra suele ser una fecha que no se entendió ("la próxima semana"): se dice así
        const rest = leftover(split.rest);
        const a = { lugar: null, conTecnico: tech, note: rest ? `No entendí el día y la hora («${rest}»).` : undefined };
        const company = await resolveCompany(ctx, split.query, "cita_sin_fecha", a, { note: a.note });
        if (company) await askCitaDate(ctx, company, a);
        return;
      }
    }
    if (p.missing === "empresa" && p.partial) {
      // "cita el viernes 10am": falta la empresa -> se pregunta (paso cita_empresa)
      const d = p.partial;
      if (isPast(d.date, d.allDay, ctx.now)) {
        await ctx.reply(pastReply(d.date, d.allDay));
        return;
      }
      const citaArgs: CitaArgs = { fecha: d.date.toISOString(), allDay: d.allDay, lugar: d.lugar, conTecnico: d.conTecnico };
      const step: Omit<CitaEmpresaStep, "createdAt"> = { kind: "cita_empresa", args: citaArgs };
      await setPending(ctx.store, ctx.from, step, ctx.now);
      await ctx.reply(companyQuestion(citaArgs));
      return;
    }
    await ctx.reply(p.error);
    return;
  }
  if (isPast(p.date, p.allDay, ctx.now)) {
    await ctx.reply(pastReply(p.date, p.allDay));
    return;
  }
  // texto de más entre la empresa y la fecha ("zbuss para revisar llantas"): se usa la empresa y se dice lo demás
  const split = await splitCompany(ctx.store, p.empresa);
  const note = split ? unusedNote(split.rest) : "";
  const a: CitaArgs = { fecha: p.date.toISOString(), allDay: p.allDay, lugar: p.lugar, conTecnico: p.conTecnico, ...(note ? { note } : {}) };
  const company = await resolveCompany(ctx, split?.query ?? p.empresa, "cita", a as unknown as Record<string, unknown>, { note });
  if (company) await continueCita(ctx, company, a);
});

/** Respuesta a "¿qué día y a qué hora?": un día (con o sin hora). Otro texto no es respuesta. */
registerPendingHandler("cita_fecha", async (ctx, step, text) => {
  const s = step as CitaFechaStep;
  const dm = parseSpanishDateTime(text, ctx.now);
  if (!dm) return false;
  const allDay = !!dm.allDay;
  if (isPast(dm.date, allDay, ctx.now)) {
    await ctx.reply(`${pastReply(dm.date, allDay)} (o *cancelar*)`);
    return true;
  }
  await clearPending(ctx.store, ctx.from);
  const company = await ctx.store.getCompany(s.companyId);
  if (!company) {
    await ctx.reply("Esa empresa ya no está en el padrón.");
    return true;
  }
  if (allDay) await askHour(ctx, company, dm.date, s.lugar, s.conTecnico);
  else await createCita(ctx, company, { date: dm.date, lugar: s.lugar, conTecnico: s.conTecnico });
  return true;
});

/** Respuesta a "¿con qué empresa?": nombre o RUC (con texto de más). Si no nombra una empresa, no es respuesta. */
registerPendingHandler("cita_empresa", async (ctx, step, text) => {
  const s = step as CitaEmpresaStep;
  const split = await splitCompany(ctx.store, text);
  if (!split) return false;
  const note = unusedNote(split.rest);
  const a: CitaArgs = { ...s.args, ...(note ? { note } : {}) };
  const company = await resolveCompany(ctx, split.query, "cita", a as unknown as Record<string, unknown>, { note });
  if (company) await continueCita(ctx, company, a);
  return true;
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

// ── en pausa (corrida D, punto 7): "cita con ZBUSS (falta día y hora)"; *Continuar* repite la pregunta ──

async function citaCompany(ctx: { store: PortalContext["store"] }, id: number): Promise<Company | null> {
  return ctx.store.getCompany(id).catch(() => null);
}

registerPausable("cita_fecha", {
  async describe(ctx, step) {
    const s = step as CitaFechaStep;
    const c = await citaCompany(ctx, s.companyId);
    return { companyId: s.companyId, label: `cita con ${c ? shortName(c.razonSocial) : "la empresa"}`, missing: "falta día y hora" };
  },
  async resume(ctx, step, prefix) {
    const c = await citaCompany(ctx, (step as CitaFechaStep).companyId);
    if (!c) return void (await ctx.reply("Esa empresa ya no está en el padrón."));
    await askAgain(ctx, step, prefix, dateQuestion(c));
  },
});

registerPausable("cita_hora", {
  async describe(ctx, step) {
    const s = step as CitaHoraStep;
    const c = await citaCompany(ctx, s.companyId);
    return { companyId: s.companyId, label: `cita con ${c ? shortName(c.razonSocial) : "la empresa"} el ${formatCitaDate(new Date(s.day), true)}`, missing: "falta la hora" };
  },
  async resume(ctx, step, prefix) {
    const s = step as CitaHoraStep;
    const c = await citaCompany(ctx, s.companyId);
    if (!c) return void (await ctx.reply("Esa empresa ya no está en el padrón."));
    await askAgain(ctx, step, prefix, hourQuestion(c, new Date(s.day)));
  },
});

registerPausable("cita_empresa", {
  async describe(_ctx, step) {
    const s = step as CitaEmpresaStep;
    return { companyId: null, label: `cita del ${formatCitaDate(new Date(s.args.fecha), s.args.allDay)}`, missing: "falta la empresa" };
  },
  async resume(ctx, step, prefix) {
    await askAgain(ctx, step, prefix, companyQuestion((step as CitaEmpresaStep).args));
  },
});
