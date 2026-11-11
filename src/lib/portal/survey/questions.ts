/**
 * Preguntas de la encuesta de satisfacción (bloque C3) y validación de la respuesta en el servidor.
 * Puro: lo usan la página pública /encuesta/[token], su server action y los tests.
 */
import type { SurveyAnswerInput } from "../store/types";

/** Pregunta 2: "¿Qué valora más de 360 Tyres?" (hasta 3). El id es lo que se guarda en survey_answers.valora. */
export const VALORA_OPTIONS = [
  { id: "precio", label: "Precio" },
  { id: "rapidez", label: "Rapidez de atención" },
  { id: "soporte", label: "Soporte técnico" },
  { id: "gestion", label: "Gestión de la flota e informes" },
  { id: "calidad", label: "Calidad del producto" },
  { id: "posventa", label: "Posventa" },
  { id: "credito", label: "Crédito" },
  { id: "stock", label: "Disponibilidad de stock" },
] as const;

export type ValoraId = (typeof VALORA_OPTIONS)[number]["id"];

export const MAX_VALORA = 3;
export const MAX_MEJORAR = 1000;

export const SURVEY_QUESTIONS = {
  nps: "¿Qué tan probable es que recomiende 360 Tyres a un colega o a otra empresa?",
  valora: "¿Qué valora más de 360 Tyres? (elija hasta 3)",
  satisfaccion: "¿Qué tan satisfecho quedó con la última entrega?",
  mejorar: "¿Qué deberíamos mejorar?",
  referencia: "¿Podemos citar su experiencia como referencia ante otros clientes?",
} as const;

/** Etiquetas de la escala 1–5 de la pregunta 3. */
export const SATISFACCION_LABELS: Record<number, string> = { 1: "Muy insatisfecho", 2: "Insatisfecho", 3: "Neutral", 4: "Satisfecho", 5: "Muy satisfecho" };

const VALORA_IDS = new Set<string>(VALORA_OPTIONS.map((o) => o.id));

export function valoraLabel(id: string): string {
  return VALORA_OPTIONS.find((o) => o.id === id)?.label ?? id;
}

/** Lo mínimo de FormData que se usa (FormData real o un Map en tests); `getAll` para las casillas de la pregunta 2. */
export interface SurveyFormLike {
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
}

export type SurveyFieldError = "nps" | "valora" | "valora_max" | "satisfaccion" | "referencia";

export type ParsedSurvey = { ok: true; answer: SurveyAnswerInput } | { ok: false; errors: SurveyFieldError[] };

export const SURVEY_ERROR_TEXT: Record<SurveyFieldError, string> = {
  nps: "Elija un valor de 0 a 10 en la pregunta 1.",
  valora: "Elija al menos una opción en la pregunta 2.",
  valora_max: "Elija como máximo 3 opciones en la pregunta 2.",
  satisfaccion: "Elija un valor de 1 a 5 en la pregunta 3.",
  referencia: "Responda sí o no en la pregunta 5.",
};

function intIn(v: FormDataEntryValue | null, min: number, max: number): number | null {
  if (typeof v !== "string" || !/^\d{1,2}$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n >= min && n <= max ? n : null;
}

/**
 * Valida en el servidor (no se confía en el navegador): recomendación 0–10 y satisfacción 1–5 obligatorias; entre 1 y 3
 * opciones conocidas en "qué valora" (repetidas cuentan una vez; desconocidas se rechazan como error de la pregunta 2);
 * referencia sí/no obligatoria; "mejorar" opcional, recortado a MAX_MEJORAR caracteres.
 */
export function parseSurveyForm(f: SurveyFormLike): ParsedSurvey {
  const errors: SurveyFieldError[] = [];
  const nps = intIn(f.get("nps"), 0, 10);
  if (nps === null) errors.push("nps");

  const raw = f.getAll("valora").filter((v): v is string => typeof v === "string").map((v) => v.trim());
  const valora = [...new Set(raw)];
  if (valora.length === 0 || valora.some((v) => !VALORA_IDS.has(v))) errors.push("valora");
  else if (valora.length > MAX_VALORA) errors.push("valora_max");

  const satisfaccion = intIn(f.get("satisfaccion"), 1, 5);
  if (satisfaccion === null) errors.push("satisfaccion");

  const ref = f.get("referencia");
  const referencia = ref === "si" ? true : ref === "no" ? false : null;
  if (referencia === null) errors.push("referencia");

  const m = f.get("mejorar");
  const mejorar = typeof m === "string" ? m.replace(/\r\n/g, "\n").trim().slice(0, MAX_MEJORAR) : "";

  if (errors.length) return { ok: false, errors };
  return { ok: true, answer: { nps: nps!, valora, satisfaccionEntrega: satisfaccion, mejorar: mejorar || null, referencia } };
}
