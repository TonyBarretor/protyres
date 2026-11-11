/**
 * Reglas de la encuesta comunes a los dos stores (bloque C3).
 */
import type { Survey } from "./types";

/** Una encuesta `pendiente` sin `enviada_at` con más de esto desde que se creó quedó huérfana (el proceso se cortó entre crearla y entregarla). */
export const ORPHAN_PENDING_MS = 24 * 3600 * 1000;

/**
 * ¿Cuenta para "sin encuesta en los últimos N meses"? Sí, salvo las que nunca se entregaron: vencidas sin `enviada_at` (el
 * envío falló) y pendientes sin `enviada_at` de más de 1 día (huérfanas). Esas no impiden volver a intentarlo.
 * Misma regla en SQL en pg-portal-store (createSurvey).
 */
export function surveyCounts(s: Pick<Survey, "estado" | "enviadaAt" | "createdAt">, now: Date): boolean {
  if (s.enviadaAt !== null || s.estado === "respondida") return true;
  if (s.estado === "vencida") return false;
  if (s.estado === "pendiente" && now.getTime() - s.createdAt.getTime() > ORPHAN_PENDING_MS) return false;
  return true;
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
