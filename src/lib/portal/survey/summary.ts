/**
 * Resumen de respuestas de la encuesta (ficha de empresa y tablero, bloque C3). summarizeSurveys es puro.
 *
 * NPS = % promotores (9–10) − % detractores (0–6), de −100 a 100; los pasivos (7–8) solo cuentan en el total.
 */
import type { PortalStore, SurveyResponse } from "../store/types";
import { valoraLabel } from "./questions";

export interface SurveySummary {
  respuestas: number;
  /** Promedio de recomendación 0–10 (null sin respuestas). */
  promedio: number | null;
  /** NPS redondeado (null sin respuestas). */
  nps: number | null;
  promotores: number;
  pasivos: number;
  detractores: number;
  /** Promedio de satisfacción con la última entrega 1–5. */
  satisfaccion: number | null;
  /** Lo más valorado, de más a menos elegido (empate: orden alfabético). */
  valorado: { id: string; opcion: string; veces: number }[];
  /** Comentarios de "qué mejorar", el más reciente primero. */
  comentarios: { texto: string; companyId: number; fecha: Date }[];
  /** Cuántos autorizan citar su experiencia. */
  referencias: number;
}

export type NpsGroup = "promotor" | "pasivo" | "detractor";

export function npsGroup(n: number): NpsGroup {
  return n >= 9 ? "promotor" : n >= 7 ? "pasivo" : "detractor";
}

export function summarizeSurveys(responses: SurveyResponse[], opts: { maxComentarios?: number } = {}): SurveySummary {
  const n = responses.length;
  const out: SurveySummary = { respuestas: n, promedio: null, nps: null, promotores: 0, pasivos: 0, detractores: 0, satisfaccion: null, valorado: [], comentarios: [], referencias: 0 };
  if (!n) return out;
  const counts = new Map<string, number>();
  let sum = 0;
  let satSum = 0;
  let satN = 0;
  for (const r of responses) {
    sum += r.nps;
    const g = npsGroup(r.nps);
    if (g === "promotor") out.promotores++;
    else if (g === "pasivo") out.pasivos++;
    else out.detractores++;
    if (r.satisfaccionEntrega !== null) {
      satSum += r.satisfaccionEntrega;
      satN++;
    }
    for (const v of new Set(r.valora)) counts.set(v, (counts.get(v) ?? 0) + 1);
    if (r.referencia) out.referencias++;
  }
  out.promedio = Math.round((sum / n) * 10) / 10;
  out.nps = Math.round(((out.promotores - out.detractores) / n) * 100);
  out.satisfaccion = satN ? Math.round((satSum / satN) * 10) / 10 : null;
  out.valorado = [...counts.entries()]
    .map(([id, veces]) => ({ id, opcion: valoraLabel(id), veces }))
    .sort((a, b) => b.veces - a.veces || a.opcion.localeCompare(b.opcion, "es"));
  out.comentarios = responses
    .filter((r) => r.mejorar?.trim())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, opts.maxComentarios ?? 5)
    .map((r) => ({ texto: r.mejorar!.trim(), companyId: r.companyId, fecha: r.createdAt }));
  return out;
}

/** Resumen para el tablero: últimos `months` meses; con `ownerUserId`, solo las empresas de ese vendedor. */
export interface DashboardSurveySummary extends SurveySummary {
  months: number;
  /** Comentarios con la razón social de la empresa. */
  comentariosEmpresa: { texto: string; empresa: string; companyId: number; fecha: Date }[];
}

export async function loadSurveySummary(
  store: Pick<PortalStore, "listSurveyResponses" | "getCompany">,
  opts: { ownerUserId?: number; now?: Date; months?: number; maxComentarios?: number } = {},
): Promise<DashboardSurveySummary> {
  const months = opts.months ?? 12;
  const since = new Date((opts.now ?? new Date()).getTime());
  since.setUTCMonth(since.getUTCMonth() - months);
  const responses = await store.listSurveyResponses({ ownerUserId: opts.ownerUserId, since });
  const s = summarizeSurveys(responses, { maxComentarios: opts.maxComentarios ?? 5 });
  const names = new Map<number, string>();
  for (const c of s.comentarios) if (!names.has(c.companyId)) names.set(c.companyId, (await store.getCompany(c.companyId))?.razonSocial ?? `empresa ${c.companyId}`);
  return { ...s, months, comentariosEmpresa: s.comentarios.map((c) => ({ ...c, empresa: names.get(c.companyId)! })) };
}
