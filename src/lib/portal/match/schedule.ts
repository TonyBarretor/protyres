/**
 * Corrida K, punto 4 — agenda de visitas desde Match Venta.
 *
 * scheduleMatchVisit: "Agendar visita" (fecha y hora opcional). Si la empresa no tiene dueño se la asigna a quien agenda
 * (atómico: setOwner con onlyIfOwner, como `asignarme`: de dos vendedores a la vez, solo uno la toma), crea la
 * oportunidad si falta (openOrCreateOpportunity: sin duplicar), crea la cita con el mecanismo existente (appointments,
 * etapa Cita agendada solo hacia adelante, próxima acción "Visita: <motivo>", actividad `cita`) y la deja ligada al
 * producto que la originó (match_visits) con su motivo ("ofrecer 295/80R22.5 Fenixway Flama 66: ya te compró 40 en
 * marzo"). La misma empresa + producto + día no se agenda dos veces.
 *
 * proposeVisitPlan: reparto por día de varias empresas, agrupando por departamento, provincia y distrito (sin
 * coordenadas: no calcula rutas), match.visitasPorDia (4) por día, de lunes a sábado sin feriados. El vendedor mueve
 * cada una antes de confirmar (la pantalla); al confirmar se llama scheduleMatchVisit por cada una.
 *
 * linkReportToMatchVisit: el reporte de una visita (texto o voz) conserva el vínculo con el producto: lleva
 * `data.match` en la actividad y marca la visita como reportada.
 */
import { limaDateKey, limaStartOfDay, addDays, formatLimaDateTime } from "../ui/time";
import { stageIndex } from "../stages";
import type { Appointment, Company, MatchVisit, Opportunity, PortalStore, PortalUser, SunatBrief } from "../store/types";
import { ubicacionEfectiva } from "../sunat/ubicacion";
import { matchCode } from "../store/shared";
import { productLabel, type MatchStockProduct } from "./stock";
import { visitReason } from "./text";
import type { MatchRunData } from "./recalc";

export interface ScheduleMatchVisitInput {
  companyId: number;
  productCode: string;
  user: Pick<PortalUser, "id" | "nombre" | "rol">;
  /** Fecha y hora de la visita (sin hora: la pantalla manda las 9:00 de Lima). */
  startsAt: Date;
  lugar?: string | null;
  now?: Date;
  canal?: "portal" | "whatsapp" | "voz";
}

export type ScheduleMatchVisitResult =
  | {
      ok: true;
      appointment: Appointment;
      opportunity: Opportunity;
      visit: MatchVisit;
      /** La empresa no tenía dueño y quedó asignada a quien agendó. */
      assigned: boolean;
      createdOpportunity: boolean;
      /** Ya había una visita de esta empresa por este producto ese día: no se creó otra. */
      duplicate: boolean;
      motivo: string;
      text: string;
    }
  | { ok: false; reason: "no_existe" | "otro_dueno" | "sin_permiso"; ownerUserId?: number | null; text: string };

/** Producto del último cálculo (para el motivo). */
async function stockOf(store: PortalStore, code: string): Promise<MatchStockProduct | null> {
  const run = await store.latestMatchRun();
  const stock = ((run?.data as unknown as MatchRunData | undefined)?.stock ?? []) as MatchStockProduct[];
  return stock.find((s) => s.code === code) ?? null;
}

/** Motivo de la visita a partir del resultado guardado (compra real primero; si no, el desglose). */
export async function matchVisitReason(store: PortalStore, companyId: number, productCode: string, now: Date = new Date()): Promise<string> {
  const code = matchCode(productCode);
  const st = await stockOf(store, code);
  const label = st ? productLabel(st) : code;
  const [r] = await store.listMatchResults({ productCodes: [code], companyIds: [companyId] });
  return visitReason(label, r?.detalle.compra, r?.detalle.desglose, now);
}

export async function scheduleMatchVisit(store: PortalStore, input: ScheduleMatchVisitInput): Promise<ScheduleMatchVisitResult> {
  const now = input.now ?? new Date();
  const { user } = input;
  const code = matchCode(input.productCode);
  if (user.rol === "tecnico") return { ok: false, reason: "sin_permiso", text: "Tu rol no puede agendar visitas de venta." };
  let company: Company | null = await store.getCompany(input.companyId);
  if (!company) return { ok: false, reason: "no_existe", text: "No encuentro esa empresa." };

  let assigned = false;
  if (company.ownerUserId === null) {
    // atómico: si otro vendedor la tomó entretanto, no se pisa
    const claimed = await store.setOwner(company.id, user.id, { onlyIfOwner: null });
    if (claimed) {
      company = claimed;
      assigned = true;
    } else company = (await store.getCompany(company.id)) ?? company;
  }
  if (company.ownerUserId !== user.id && user.rol === "vendedor") {
    const owner = company.ownerUserId !== null ? await store.getUser(company.ownerUserId).catch(() => null) : null;
    return { ok: false, reason: "otro_dueno", ownerUserId: company.ownerUserId, text: `*${company.razonSocial}* ya es de ${owner?.nombre ?? "otro vendedor"}: no puedo agendarte la visita.` };
  }
  const canal = input.canal ?? "portal";
  if (assigned) {
    await store.addActivity({ companyId: company.id, userId: user.id, tipo: "nota", texto: `${user.nombre} se asignó la empresa (al agendar desde Match Venta).`, canal, occurredAt: now, data: { evento: "asignacion", ownerUserId: user.id, previousOwnerUserId: null } });
  }
  const { opportunity: opp0, created } = await store.openOrCreateOpportunity({ companyId: company.id, ownerUserId: company.ownerUserId ?? user.id, etapa: "prospecto", createdBy: user.id, at: now });
  let opportunity = opp0;
  const motivo = await matchVisitReason(store, company.id, code, now);

  // misma empresa + producto + día: no se duplica
  const day = limaStartOfDay(input.startsAt);
  const sameDay = await store.listAppointments({ companyId: company.id, estado: "programada", from: day, to: addDays(day, 1) });
  if (sameDay.length) {
    const visits = await store.listMatchVisits({ appointmentIds: sameDay.map((a) => a.id), productCode: code });
    if (visits.length) {
      const appointment = sameDay.find((a) => a.id === visits[0].appointmentId)!;
      return { ok: true, appointment, opportunity, visit: visits[0], assigned, createdOpportunity: created, duplicate: true, motivo, text: `Ya tenías esa visita a *${company.razonSocial}* el ${formatLimaDateTime(appointment.startsAt)}.` };
    }
  }

  const appointment = await store.addAppointment({ companyId: company.id, opportunityId: opportunity.id, userId: user.id, startsAt: input.startsAt, lugar: input.lugar ?? null, conTecnico: false, notas: motivo, estado: "programada" });
  if (stageIndex(opportunity.etapa) < stageIndex("cita_agendada")) opportunity = (await store.moveStage(opportunity.id, "cita_agendada", user.id, now)) ?? opportunity;
  opportunity = (await store.updateOpportunity(opportunity.id, { proximaAccion: `Visita: ${motivo}`, proximaAccionAt: input.startsAt })) ?? opportunity;
  const visit = await store.addMatchVisit({ appointmentId: appointment.id, companyId: company.id, userId: user.id, productCode: code, motivo });
  await store.addActivity({
    companyId: company.id,
    opportunityId: opportunity.id,
    userId: user.id,
    tipo: "cita",
    texto: `Visita agendada para el ${formatLimaDateTime(input.startsAt)} (Match Venta): ${motivo}.`,
    canal,
    occurredAt: now,
    data: { appointmentId: appointment.id, startsAt: input.startsAt.toISOString(), match: { productCode: code, motivo, visitId: visit.id } },
  });
  return {
    ok: true,
    appointment,
    opportunity,
    visit,
    assigned,
    createdOpportunity: created,
    duplicate: false,
    motivo,
    text: `📅 Visita a *${company.razonSocial}* el *${formatLimaDateTime(input.startsAt)}*: ${motivo}.${assigned ? "\nLa empresa quedó asignada a ti." : ""}`,
  };
}

// ── reparto por día ──

export interface PlanCompany {
  companyId: number;
  razonSocial: string;
  departamento: string | null;
  provincia: string | null;
  distrito: string | null;
  productCode?: string;
}

export interface PlanDay {
  /** AAAA-MM-DD (Lima). */
  fecha: string;
  visitas: PlanCompany[];
  /** "LIMA / SAN ISIDRO", "AREQUIPA" (las zonas de ese día). */
  zonas: string[];
}

/**
 * Corrida L: la empresa como PlanCompany con su ubicación efectiva (el distrito de SUNAT manda si su domicilio está en el
 * departamento de la empresa; si no, el del MTC). Así el reparto agrupa por el distrito real.
 */
export function planCompanyFrom(c: Pick<Company, "id" | "razonSocial" | "departamento" | "provincia" | "distrito">, sunat: Pick<SunatBrief, "ubigeo" | "departamento" | "provincia" | "distrito"> | null | undefined, productCode?: string): PlanCompany {
  const u = ubicacionEfectiva(c, sunat);
  return { companyId: c.id, razonSocial: c.razonSocial, departamento: u.departamento, provincia: u.provincia, distrito: u.distrito, ...(productCode ? { productCode } : {}) };
}

const zoneKey = (c: PlanCompany) => [c.departamento ?? "~", c.provincia ?? "~", c.distrito ?? "~"].join("|");
export const zoneLabel = (c: PlanCompany): string => [c.departamento, c.distrito ?? c.provincia].filter(Boolean).join(" / ") || "Sin ubicación";

/** Próximo día de visita (lunes a sábado, sin feriados) desde `day` inclusive. */
function nextWorkday(day: Date, holidays: Set<string>): Date {
  let d = day;
  for (let i = 0; i < 30; i++) {
    const key = limaDateKey(d);
    const dow = new Date(`${key}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && !holidays.has(key)) return d;
    d = addDays(d, 1);
  }
  return d;
}

/**
 * Reparte las empresas en días desde `start` (inclusive): agrupa por departamento → provincia → distrito, mete grupos
 * enteros en un día mientras quepan y parte un grupo solo si es más grande que un día.
 */
export function proposeVisitPlan(companies: PlanCompany[], opts: { start: Date; perDay?: number; holidays?: string[] }): PlanDay[] {
  const perDay = Math.max(1, opts.perDay ?? 4);
  const holidays = new Set(opts.holidays ?? []);
  const groups = new Map<string, PlanCompany[]>();
  for (const c of [...companies].sort((a, b) => zoneKey(a).localeCompare(zoneKey(b)) || a.razonSocial.localeCompare(b.razonSocial))) {
    const k = zoneKey(c);
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }
  // grupos del mismo departamento juntos, y dentro los más grandes primero (llenan días enteros)
  const ordered = [...groups.values()].sort((a, b) => (a[0].departamento ?? "~").localeCompare(b[0].departamento ?? "~") || b.length - a.length || zoneKey(a[0]).localeCompare(zoneKey(b[0])));
  const days: PlanCompany[][] = [];
  let cur: PlanCompany[] = [];
  const flush = () => {
    if (cur.length) days.push(cur);
    cur = [];
  };
  for (const g of ordered) {
    const dep = g[0].departamento;
    if (cur.length && (cur[0].departamento !== dep || cur.length + g.length > perDay)) {
      // otro departamento siempre empieza día; un grupo que no cabe entero empieza día si cabe en uno
      if (cur[0].departamento !== dep || g.length <= perDay) flush();
    }
    for (const c of g) {
      if (cur.length >= perDay) flush();
      cur.push(c);
    }
  }
  flush();
  const out: PlanDay[] = [];
  let day = nextWorkday(limaStartOfDay(opts.start), holidays);
  for (const visitas of days) {
    out.push({ fecha: limaDateKey(day), visitas, zonas: [...new Set(visitas.map(zoneLabel))] });
    day = nextWorkday(addDays(day, 1), holidays);
  }
  return out;
}

// ── el reporte conserva el vínculo ──

/**
 * Visitas de Match Venta pendientes de esa empresa (de quien reporta, o de cualquiera si no tiene propias) con cita hasta
 * el día del reporte: lo que va en `data.match` de la actividad del reporte. Vacío si no hay.
 */
export async function pendingMatchVisits(store: PortalStore, companyId: number, userId: number, at: Date): Promise<MatchVisit[]> {
  const pending = await store.listMatchVisits({ companyId, pending: true });
  if (!pending.length) return [];
  const appts = await store.listAppointments({ companyId, to: addDays(limaStartOfDay(at), 1) });
  const due = new Set(appts.map((a) => a.id));
  const mine = pending.filter((v) => due.has(v.appointmentId) && v.userId === userId);
  return mine.length ? mine : pending.filter((v) => due.has(v.appointmentId));
}

/** `data.match` para la actividad del reporte. */
export function matchReportData(visits: MatchVisit[]): Record<string, unknown> | null {
  if (!visits.length) return null;
  return { match: visits.map((v) => ({ visitId: v.id, productCode: v.productCode, motivo: v.motivo })) };
}

/** Marca las visitas como reportadas con esa actividad (y la cita como realizada). */
export async function markMatchVisitsReported(store: PortalStore, visits: MatchVisit[], activityId: number, at: Date): Promise<void> {
  for (const v of visits) {
    const done = await store.markMatchVisitReported(v.id, activityId, at);
    if (done) await store.updateAppointment(v.appointmentId, { estado: "realizada" });
  }
}
