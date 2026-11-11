/**
 * Resumen diario por WhatsApp (bloque B6), en hora de Lima. Solo lee del store; el envío está en send.ts.
 *
 * Para cada vendedor: citas de hoy (hora, empresa, lugar, con técnico), acciones vencidas y de hoy (misma selección que
 * /portal/hoy y el comando `hoy`) y cotizaciones que piden seguimiento (quotes/reminders.ts). Sin nada de eso -> null
 * (no se le escribe). Supervisor: lo suyo y además una línea por vendedor activo (citas, vencidas, seguimientos).
 */
import { portalBaseUrl } from "../auth/tokens";
import { shortName } from "../bot/companies";
import { followUpMessage, quoteFollowUpsFor, type QuoteFollowUpWithCompany } from "../quotes/reminders";
import { stageLabel } from "../stages";
import type { Appointment, PortalStore, PortalUser } from "../store/types";
import { appointmentWindow, selectToday, type TodayAction } from "../ui/today";
import { formatLimaDay, formatLimaShort, formatLimaTime } from "../ui/time";

const MAX_PER_SECTION = 8;

export interface DigestOptions {
  /** Días hábiles para el recordatorio de cotización y feriados (por defecto config/portal.json). */
  businessDays?: number;
  holidays?: string[];
  env?: Record<string, string | undefined>;
  /** Resúmenes ya calculados en esta corrida (el supervisor reutiliza los de los vendedores). */
  cache?: Map<number, UserDay>;
}

/** Lo del día de un usuario. */
export interface UserDay {
  citas: Appointment[];
  vencidas: TodayAction[];
  /** Acciones con fecha de hoy (no vencidas). */
  deHoy: TodayAction[];
  followUps: QuoteFollowUpWithCompany[];
  /** companyId -> razón social. */
  names: Map<number, string>;
}

export interface DailyDigest {
  text: string;
  /** Recordatorios de cotización incluidos en el texto (send.ts los registra con recordQuoteFollowUp). */
  followUps: QuoteFollowUpWithCompany[];
  counts: { citas: number; vencidas: number; deHoy: number; seguimientos: number };
}

const isEmpty = (d: UserDay) => !d.citas.length && !d.vencidas.length && !d.deHoy.length && !d.followUps.length;

/** Citas, acciones y seguimientos de hoy del usuario. */
export async function userDay(store: PortalStore, user: PortalUser, now: Date, opts: DigestOptions = {}): Promise<UserDay> {
  const cached = opts.cache?.get(user.id);
  if (cached) return cached;
  const opps = await store.listOpportunities({ ownerId: user.id, open: true });
  const { from, to } = appointmentWindow(now, 0); // solo hoy
  const appts = await store.listAppointments({ userId: user.id, from, to });
  const sel = selectToday(opps, appts, now, 0);
  const citas = sel.citas.filter((d) => d.esHoy).flatMap((d) => d.citas);
  const followUps = await quoteFollowUpsFor(store, user.id, now, { businessDays: opts.businessDays, holidays: opts.holidays });
  const names = new Map<number, string>();
  for (const id of new Set([...sel.acciones.map((a) => a.opportunity.companyId), ...citas.map((a) => a.companyId)])) {
    names.set(id, (await store.getCompany(id))?.razonSocial ?? `empresa ${id}`);
  }
  const day: UserDay = { citas, vencidas: sel.acciones.filter((a) => a.vencida), deHoy: sel.acciones.filter((a) => !a.vencida), followUps, names };
  opts.cache?.set(user.id, day);
  return day;
}

function capped<T>(list: T[], fmt: (x: T) => string): string[] {
  const lines = list.slice(0, MAX_PER_SECTION).map(fmt);
  if (list.length > MAX_PER_SECTION) lines.push(`• …y ${list.length - MAX_PER_SECTION} más`);
  return lines;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const firstName = (nombre: string) => nombre.trim().split(/\s+/)[0] || nombre;

/** Una línea por vendedor para el supervisor. */
function teamLine(u: PortalUser, d: UserDay): string {
  if (isEmpty(d)) return `• ${u.nombre}: sin pendientes`;
  const parts = [plural(d.citas.length, "cita", "citas"), plural(d.vencidas.length, "vencida", "vencidas"), plural(d.followUps.length, "seguimiento", "seguimientos")];
  return `• ${u.nombre}: ${parts.join(" · ")}`;
}

/** Texto del resumen del día para `user`, o null si no hay nada que contarle. */
export async function buildDailyDigest(store: PortalStore, user: PortalUser, now: Date, opts: DigestOptions = {}): Promise<DailyDigest | null> {
  const d = await userDay(store, user, now, opts);
  const name = (id: number) => shortName(d.names.get(id) ?? `empresa ${id}`);
  const out: string[] = [];
  if (d.citas.length) {
    out.push("", "*Citas de hoy*");
    out.push(...capped(d.citas, (a) => `• ${formatLimaTime(a.startsAt)} ${name(a.companyId)}${a.lugar ? ` — ${a.lugar}` : ""}${a.conTecnico ? " (con técnico)" : ""}`));
  }
  if (d.vencidas.length) {
    out.push("", "*Acciones vencidas*");
    out.push(...capped(d.vencidas, ({ opportunity: o }) => `• ⚠️ ${name(o.companyId)}: ${o.proximaAccion?.trim() || stageLabel(o.etapa)} _(del ${formatLimaShort(o.proximaAccionAt!)})_`));
  }
  if (d.deHoy.length) {
    out.push("", "*Acciones de hoy*");
    out.push(...capped(d.deHoy, ({ opportunity: o }) => `• ${name(o.companyId)}: ${o.proximaAccion?.trim() || stageLabel(o.etapa)}`));
  }
  if (d.followUps.length) {
    out.push("", "*Cotizaciones por seguir*");
    out.push(...capped(d.followUps, (f) => followUpMessage(f)));
  }

  let team = false;
  if (user.rol === "supervisor") {
    const sellers = (await store.listUsers()).filter((u) => u.activo && u.rol === "vendedor" && u.id !== user.id);
    const lines: string[] = [];
    for (const s of sellers) {
      const sd = await userDay(store, s, now, opts);
      if (!isEmpty(sd)) team = true;
      lines.push(teamLine(s, sd));
    }
    if (team) out.push("", "*Equipo hoy*", ...lines);
  }
  if (!out.length) return null;

  const text = [`☀️ *Buenos días, ${firstName(user.nombre)}* · ${formatLimaDay(now)}`, ...out, "", `Detalle: ${portalBaseUrl(opts.env ?? process.env)}/portal/hoy`].join("\n");
  return { text, followUps: d.followUps, counts: { citas: d.citas.length, vencidas: d.vencidas.length, deHoy: d.deHoy.length, seguimientos: d.followUps.length } };
}
