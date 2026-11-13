/**
 * Guía de avance del proceso comercial por empresa (corrida D, punto 7): 1 Asignada · 2 Contacto · 3 Cita · 4 Visita ·
 * 5 Cotización · 6 Orden de compra · 7 Pedido a Patricia.
 *
 * Los pasos se DERIVAN de lo ya registrado y de la etapa de la oportunidad (no hay una lista paralela que mantener):
 *  1 Asignada: la empresa tiene dueño.
 *  2 Contacto: tiene al menos un contacto.
 *  3 Cita: una cita no cancelada, o la oportunidad abierta en Cita agendada o más allá.
 *  4 Visita: una actividad `visita`, o la oportunidad abierta en Visita realizada o más allá.
 *  5 Cotización: una cotización enlazada (actividad `cotizacion` / `cotizacion_enviada`, o quote_number en la
 *    oportunidad), o la oportunidad abierta en Cotización enviada / Negociación.
 *  6 Orden de compra: una OC registrada (no cancelada).
 *  7 Pedido a Patricia: una OC con el pedido generado.
 * (Cerrado ganado no implica los pasos 3-5: una OC puede llegar sin cotización.) Los pasos no son obligatorios en orden:
 * uno sin hacer antes del último hecho queda "omitido" (OC sin cotización -> paso 5 omitido).
 *
 * Línea de avance: las respuestas del bot que completan un paso (asignarme, contacto, cita, reporte de visita, enlazar /
 * reenviada, pedido de la OC) terminan con UNA línea `✅ Paso 3 de 7 con ZBUSS: cita agendada. Sigue: reportar la visita.`
 * Las consultas (`hoy`, `avance`, `empresa`, `estado`) y los mensajes del cotizador no la llevan.
 */
import { stageIndex } from "../stages";
import type { Company, Opportunity, PortalStore } from "../store/types";
import { shortName } from "./companies";

export type StepState = "hecho" | "pendiente" | "omitido";

export interface ProcessStep {
  n: number;
  /** "Asignada", "Contacto"... */
  name: string;
  state: StepState;
}

export const STEP_NAMES = ["Asignada", "Contacto", "Cita", "Visita", "Cotización", "Orden de compra", "Pedido a Patricia"];
/** Lo que se dice al completar cada paso. */
const STEP_DONE = ["empresa asignada", "contacto registrado", "cita agendada", "visita reportada", "cotización enlazada", "orden de compra registrada", "pedido a Patricia generado"];
/** El siguiente paso, como acción. */
const STEP_NEXT = ["asignarte la empresa", "registrar un contacto", "agendar la cita", "reportar la visita", "enviar la cotización", "registrar la orden de compra", "generar el pedido a Patricia"];

export interface ProcessFacts {
  owned: boolean;
  contacts: number;
  appointments: number;
  visits: number;
  quotes: number;
  orders: number;
  pedidos: number;
  /** Oportunidad más reciente (abierta o no). */
  opportunity: Opportunity | null;
}

/** Paso que implica la etapa de una oportunidad ABIERTA (Cita agendada -> 3, Visita realizada -> 4, Cotización/Negociación -> 5). */
function stageStep(opp: Opportunity | null): number {
  if (!opp || opp.closedAt) return 0;
  const i = stageIndex(opp.etapa);
  if (i >= stageIndex("cotizacion_enviada") && i <= stageIndex("negociacion")) return 5;
  if (i === stageIndex("visita_realizada")) return 4;
  if (i === stageIndex("cita_agendada")) return 3;
  return 0;
}

/** Los 7 pasos con hecho / pendiente / omitido. Puro. */
export function processSteps(f: ProcessFacts): ProcessStep[] {
  const byStage = stageStep(f.opportunity);
  const done = [
    f.owned,
    f.contacts > 0,
    f.appointments > 0 || byStage >= 3,
    f.visits > 0 || byStage >= 4,
    f.quotes > 0 || !!f.opportunity?.quoteNumber || byStage >= 5,
    f.orders > 0,
    f.pedidos > 0,
  ];
  const last = done.lastIndexOf(true);
  return STEP_NAMES.map((name, i) => ({ n: i + 1, name, state: done[i] ? "hecho" : i < last ? "omitido" : "pendiente" }));
}

/** Lo registrado de la empresa que deciden los pasos. */
export async function processFacts(store: PortalStore, company: Company): Promise<ProcessFacts> {
  const [contacts, appts, acts, orders, opps] = await Promise.all([
    store.listContacts(company.id),
    store.listAppointments({ companyId: company.id }),
    store.listActivities({ companyId: company.id, limit: 500 }),
    store.listPurchaseOrders({ companyId: company.id }),
    store.listOpportunities({ companyId: company.id }),
  ]);
  const opportunity = [...opps].sort((a, b) => b.id - a.id)[0] ?? null;
  return {
    owned: company.ownerUserId !== null,
    contacts: contacts.length,
    appointments: appts.filter((a) => a.estado !== "cancelada").length,
    visits: acts.filter((a) => a.tipo === "visita").length,
    quotes: acts.filter((a) => a.tipo === "cotizacion" || a.tipo === "cotizacion_enviada").length,
    orders: orders.filter((o) => o.status !== "cancelada").length,
    pedidos: orders.filter((o) => o.status === "pedido_generado").length,
    opportunity,
  };
}

/** El siguiente paso pendiente después del último hecho (null = proceso completo). */
export function nextStep(steps: ProcessStep[]): ProcessStep | null {
  const last = steps.map((s) => s.state).lastIndexOf("hecho");
  return steps.find((s) => s.n - 1 > last && s.state === "pendiente") ?? null;
}

/** Acción del paso (para "Sigue: …" y la próxima acción de `estado`). */
export const stepAction = (s: Pick<ProcessStep, "n">): string => STEP_NEXT[s.n - 1];

/**
 * "✅ Paso 3 de 7 con ZBUSS: cita agendada. Sigue: reportar la visita." para el paso `n` recién completado. Con pasos
 * omitidos antes de `n`, lo dice ("(paso 5 omitido)").
 */
export function progressLine(steps: ProcessStep[], n: number, companyName: string, done = STEP_DONE[n - 1]): string {
  const omitted = steps.filter((s) => s.state === "omitido" && s.n < n).map((s) => s.n);
  const skip = !omitted.length ? "" : omitted.length <= 2 ? ` (${omitted.length === 1 ? "paso" : "pasos"} ${omitted.join(" y ")} omitido${omitted.length === 1 ? "" : "s"})` : ` (${omitted.length} pasos omitidos)`;
  const next = nextStep(steps);
  return `✅ Paso ${n} de 7 con ${shortName(companyName)}: ${done}${skip}. ${next ? `Sigue: ${stepAction(next)}.` : "Proceso completo."}`;
}

/** La línea de avance de la empresa tras completar el paso `n`. Nunca lanza ("" si falla la lectura). */
export async function companyProgressLine(store: PortalStore, company: Company, n: number, done?: string): Promise<string> {
  try {
    const fresh = (await store.getCompany(company.id)) ?? company;
    return progressLine(processSteps(await processFacts(store, fresh)), n, fresh.razonSocial, done);
  } catch {
    return "";
  }
}
