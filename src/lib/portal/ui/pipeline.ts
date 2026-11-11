/**
 * Tablero del pipeline (/portal/pipeline): oportunidades agrupadas por etapa, en el orden del embudo. Puro.
 * Las columnas cerradas solo muestran lo cerrado en los últimos `closedDays` días (el tablero es para trabajar lo vivo).
 */
import { STAGES, isClosedStage, type StageId } from "../stages";
import type { Opportunity } from "../store/types";

export const CLOSED_WINDOW_DAYS = 90;

export interface PipelineColumn {
  id: StageId;
  label: string;
  probabilidad: number;
  closed: boolean;
  items: Opportunity[];
  /** Suma de montos estimados (los que lo tienen). */
  monto: number;
  /** Suma de monto × probabilidad / 100. */
  ponderado: number;
}

export interface GroupPipelineOptions {
  now?: Date;
  closedDays?: number;
  /** Solo las de este dueño. */
  ownerId?: number;
}

export function groupPipeline(opps: Opportunity[], opts: GroupPipelineOptions = {}): PipelineColumn[] {
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - (opts.closedDays ?? CLOSED_WINDOW_DAYS) * 24 * 60 * 60 * 1000;
  const cols: PipelineColumn[] = STAGES.map((s) => ({ id: s.id, label: s.label, probabilidad: s.probabilidad, closed: isClosedStage(s.id), items: [], monto: 0, ponderado: 0 }));
  const byId = new Map(cols.map((c) => [c.id as string, c]));
  for (const o of opps) {
    if (opts.ownerId !== undefined && o.ownerUserId !== opts.ownerId) continue;
    const col = byId.get(o.etapa);
    if (!col) continue;
    if (col.closed && (o.closedAt ?? o.updatedAt).getTime() < cutoff) continue;
    col.items.push(o);
    if (o.montoEstimado !== null) {
      col.monto += o.montoEstimado;
      col.ponderado += (o.montoEstimado * col.probabilidad) / 100;
    }
  }
  for (const c of cols) {
    c.items.sort((a, b) => {
      // Primero las que tienen próxima acción (la más cercana), luego la actualizada más recientemente.
      const pa = a.proximaAccionAt?.getTime() ?? Infinity;
      const pb = b.proximaAccionAt?.getTime() ?? Infinity;
      return pa - pb || b.updatedAt.getTime() - a.updatedAt.getTime() || a.id - b.id;
    });
  }
  return cols;
}

/** Totales del tablero (solo columnas abiertas). */
export function pipelineTotals(cols: PipelineColumn[]): { abiertas: number; monto: number; ponderado: number } {
  let abiertas = 0;
  let monto = 0;
  let ponderado = 0;
  for (const c of cols) {
    if (c.closed) continue;
    abiertas += c.items.length;
    monto += c.monto;
    ponderado += c.ponderado;
  }
  return { abiertas, monto, ponderado };
}
