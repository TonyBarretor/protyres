/**
 * Estados de la evaluación crediticia y su máquina de transiciones (pura).
 *
 *   sin_evaluar    -> en_evaluacion | aprobado | observado | rechazado   (se puede cargar directo un reporte ya leído)
 *   en_evaluacion  -> aprobado | observado | rechazado                    (no vuelve a "sin evaluar": ya hay un trámite)
 *   aprobado       -> en_evaluacion | observado | rechazado               (re-evaluar, observar o retirar el crédito)
 *   observado      -> en_evaluacion | aprobado | rechazado                (se levanta la observación o se decide)
 *   rechazado      -> en_evaluacion                                       (solo con una nueva evaluación; nunca directo a aprobado)
 *   mismo estado   -> permitido: edición de campos (calificación, notas, PDF...) sin cambiar de estado
 *
 * Nada vuelve a `sin_evaluar`: una vez evaluada, la empresa conserva su historial; para empezar de nuevo, en_evaluacion.
 *
 * Validación por estado (validateCredit): aprobado exige línea (> 0) y plazo (días enteros 0–365); observado y rechazado
 * exigen una nota que explique el motivo.
 */
import type { CompanyCredit, CreditEstado } from "../store/types";

export const CREDIT_ESTADOS: { id: CreditEstado; label: string }[] = [
  { id: "sin_evaluar", label: "sin evaluar" },
  { id: "en_evaluacion", label: "en evaluación" },
  { id: "aprobado", label: "aprobado" },
  { id: "observado", label: "observado" },
  { id: "rechazado", label: "rechazado" },
];

const TRANSITIONS: Record<CreditEstado, readonly CreditEstado[]> = {
  sin_evaluar: ["en_evaluacion", "aprobado", "observado", "rechazado"],
  en_evaluacion: ["aprobado", "observado", "rechazado"],
  aprobado: ["en_evaluacion", "observado", "rechazado"],
  observado: ["en_evaluacion", "aprobado", "rechazado"],
  rechazado: ["en_evaluacion"],
};

export function isCreditEstado(v: unknown): v is CreditEstado {
  return typeof v === "string" && Object.hasOwn(TRANSITIONS, v);
}

export function creditEstadoLabel(e: CreditEstado | null | undefined): string {
  return CREDIT_ESTADOS.find((s) => s.id === (e ?? "sin_evaluar"))!.label;
}

/** Estado efectivo: sin fila de crédito = sin_evaluar. */
export function creditEstadoOf(credit: Pick<CompanyCredit, "estado"> | null | undefined): CreditEstado {
  return credit?.estado ?? "sin_evaluar";
}

/** ¿Se puede pasar de `from` a `to`? Mismo estado = sí (edición de campos). */
export function canTransition(from: CreditEstado, to: CreditEstado): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** Estados a los que se puede ir desde `from` (incluido él mismo, primero), para el selector de la ficha. */
export function nextEstados(from: CreditEstado): CreditEstado[] {
  return [from, ...TRANSITIONS[from]];
}

/** Estados con aviso al cotizar (bot y ficha). */
export function needsCreditWarning(estado: CreditEstado): boolean {
  return estado === "sin_evaluar" || estado === "rechazado";
}

export const MONEDAS = ["USD", "PEN"] as const;

export interface CreditFields {
  estado: CreditEstado;
  linea?: number | null;
  plazoDias?: number | null;
  moneda?: string | null;
  notas?: string | null;
}

/** Errores de validación del estado destino (vacío = válido). */
export function validateCredit(c: CreditFields): string[] {
  const errors: string[] = [];
  if (c.linea !== null && c.linea !== undefined && (!Number.isFinite(c.linea) || c.linea < 0)) errors.push("La línea debe ser un monto positivo.");
  if (c.plazoDias !== null && c.plazoDias !== undefined && (!Number.isInteger(c.plazoDias) || c.plazoDias < 0 || c.plazoDias > 365)) errors.push("El plazo debe ser de 0 a 365 días.");
  if (c.moneda && !(MONEDAS as readonly string[]).includes(c.moneda)) errors.push("Moneda no válida (USD o PEN).");
  if (c.estado === "aprobado") {
    if (!c.linea || c.linea <= 0) errors.push("Para aprobar, indica la línea aprobada.");
    if (c.plazoDias === null || c.plazoDias === undefined) errors.push("Para aprobar, indica el plazo aprobado (días).");
  }
  if ((c.estado === "observado" || c.estado === "rechazado") && !c.notas?.trim()) errors.push(`Para marcarlo ${creditEstadoLabel(c.estado)}, escribe el motivo en las notas.`);
  return errors;
}
