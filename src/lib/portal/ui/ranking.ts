/**
 * Corrida G — piezas puras de las pantallas del ranking de atractivo:
 *   parseValidationForm / buildValidationRows  el envío de /portal/validar-ranking: solo las empresas respondidas (A, B, C o
 *                                              "No la conozco"), como mucho 20, nota recortada; el nivel y el puntaje del
 *                                              sistema se leen de la base al guardar, nunca del formulario.
 *   assignReturnPath                           a dónde vuelve "Asignarme": a Hoy solo si lo pide Hoy (lista cerrada); si
 *                                              no, a la ficha. Nunca una URL arbitraria.
 */
import type { PortalStore, RankingValidationInput, ValidationAnswer } from "../store/types";
import { formText, type FormLike } from "./labels";

export const MAX_VALIDATION_ROWS = 20;
export const NOTE_MAX = 500;

export const VALIDATION_ANSWERS: { id: ValidationAnswer; label: string }[] = [
  { id: "A", label: "A" },
  { id: "B", label: "B" },
  { id: "C", label: "C" },
  { id: "desconocida", label: "No la conozco" },
];

const ANSWER_IDS = new Set<string>(VALIDATION_ANSWERS.map((a) => a.id));

export interface ValidationAnswerInput {
  companyId: number;
  nivelVendedor: ValidationAnswer;
  nota: string | null;
}

/** Campos: `ids` (las empresas mostradas, separadas por comas), `nivel_<id>` y `nota_<id>`. */
export function parseValidationForm(f: FormLike): ValidationAnswerInput[] {
  const ids: number[] = [];
  for (const raw of formText(f, "ids", 2000).split(",")) {
    const id = Number(raw.trim());
    if (Number.isSafeInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
    if (ids.length >= MAX_VALIDATION_ROWS) break;
  }
  const out: ValidationAnswerInput[] = [];
  for (const id of ids) {
    const nivel = formText(f, `nivel_${id}`, 20);
    if (!ANSWER_IDS.has(nivel)) continue;
    out.push({ companyId: id, nivelVendedor: nivel as ValidationAnswer, nota: formText(f, `nota_${id}`, NOTE_MAX) || null });
  }
  return out;
}

/** Vuelve a leer cada empresa: el nivel y el puntaje del sistema son los de la base en este momento. */
export async function buildValidationRows(answers: readonly ValidationAnswerInput[], store: Pick<PortalStore, "getCompany">, userId: number): Promise<RankingValidationInput[]> {
  const companies = await Promise.all(answers.map((a) => store.getCompany(a.companyId)));
  const rows: RankingValidationInput[] = [];
  answers.forEach((a, i) => {
    const c = companies[i];
    if (!c) return;
    rows.push({ userId, companyId: c.id, nivelVendedor: a.nivelVendedor, nota: a.nota, nivelSistema: c.nivel ?? null, scoreSistema: c.score });
  });
  return rows;
}

/** Rutas a las que "Asignarme" puede volver además de la ficha. */
const ASSIGN_RETURN = new Set(["/portal/hoy"]);

export function assignReturnPath(f: FormLike, companyId: number): string {
  const v = formText(f, "volver", 100);
  return ASSIGN_RETURN.has(v) ? v : `/portal/empresas/${companyId}`;
}
