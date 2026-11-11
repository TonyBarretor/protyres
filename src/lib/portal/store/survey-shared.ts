/**
 * Reglas de la encuesta comunes a los dos stores (bloque C3).
 */
import type { Survey } from "./types";

/**
 * ¿Cuenta para "sin encuesta en los últimos N meses"? Sí, salvo las que vencieron sin haberse entregado nunca (el envío
 * falló): esas no impiden volver a intentarlo al día siguiente.
 */
export function surveyCounts(s: Pick<Survey, "estado" | "enviadaAt">): boolean {
  return s.estado !== "vencida" || s.enviadaAt !== null;
}

/** Normaliza `valora` leído de la base o del JSON (jsonb, texto o lista). */
export function valoraList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}
