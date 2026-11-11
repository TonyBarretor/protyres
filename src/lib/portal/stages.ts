/**
 * Etapas del pipeline comercial, en orden, con su probabilidad de cierre.
 * Los ids son estables (se guardan en opportunities.etapa y opportunity_stage_history.etapa); la etiqueta es lo que se muestra.
 */
export const STAGES = [
  { id: "prospecto", label: "Prospecto", probabilidad: 10 },
  { id: "cita_agendada", label: "Cita agendada", probabilidad: 20 },
  { id: "visita_realizada", label: "Visita realizada", probabilidad: 30 },
  { id: "cotizacion_enviada", label: "Cotización enviada", probabilidad: 50 },
  { id: "negociacion", label: "Negociación", probabilidad: 70 },
  { id: "cerrado_ganado", label: "Cerrado ganado", probabilidad: 100 },
  { id: "cerrado_perdido", label: "Cerrado perdido", probabilidad: 0 },
] as const;

export type StageId = (typeof STAGES)[number]["id"];
export type Stage = (typeof STAGES)[number];

export const STAGE_IDS: StageId[] = STAGES.map((s) => s.id);

/** Etapas que cierran la oportunidad (fijan closed_at). */
export const CLOSED_STAGES: StageId[] = ["cerrado_ganado", "cerrado_perdido"];

export function isStageId(v: unknown): v is StageId {
  return typeof v === "string" && (STAGE_IDS as string[]).includes(v);
}

export function getStage(id: StageId): Stage {
  const s = STAGES.find((x) => x.id === id);
  if (!s) throw new Error(`Etapa desconocida: ${id}`);
  return s;
}

export function stageProbability(id: StageId): number {
  return getStage(id).probabilidad;
}

export function stageLabel(id: string): string {
  return STAGES.find((x) => x.id === id)?.label ?? id;
}

export function isClosedStage(id: string): boolean {
  return (CLOSED_STAGES as string[]).includes(id);
}

/** Posición en el embudo (0 = prospecto); -1 si el id no existe. */
export function stageIndex(id: string): number {
  return STAGE_IDS.indexOf(id as StageId);
}
