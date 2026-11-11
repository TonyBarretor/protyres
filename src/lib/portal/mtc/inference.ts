/**
 * Probable tyre size from MTC data (clase + ejes + llantas + peso bruto). The padrón gives the vehicle brand but not
 * the model, so this is an *inference*: the UI must label llantas/ejes as "dato MTC" and the size as "inferida".
 * Rules live in config/tyre-inference.json; first match wins; all bounds inclusive.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { normalizeClase } from "./parse";
import type { MtcVehicle } from "./parse";

const RangeSchema = z.union([z.number(), z.object({ min: z.number().optional(), max: z.number().optional() })]);
export type Range = z.infer<typeof RangeSchema>;

export const ConfianzaSchema = z.enum(["alta", "media", "baja"]);
export type Confianza = z.infer<typeof ConfianzaSchema>;

export const TyreRuleSchema = z.object({
  id: z.string().optional(),
  /** Any of these classes (normalised with normalizeClase). Omitted/empty = any class. */
  clases: z.array(z.string()).optional(),
  ejes: RangeSchema.optional(),
  llantas: RangeSchema.optional(),
  llantasPorEje: RangeSchema.optional(),
  pesoBrutoKg: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
  medida: z.string(),
  confianza: ConfianzaSchema,
  nota: z.string().optional(),
});
export type TyreRule = z.infer<typeof TyreRuleSchema>;

export const TyreRulesFileSchema = z.object({ rules: z.array(TyreRuleSchema) });

export interface TyreInference {
  medida: string | null;
  confianza: Confianza | null;
  /** Id of the rule that matched (for debugging/UI tooltips). */
  regla?: string | null;
}

export function tyreRulesPath(): string {
  return process.env.TYRE_INFERENCE_CONFIG || path.join(process.cwd(), "config", "tyre-inference.json");
}

export function loadTyreRules(file = tyreRulesPath()): TyreRule[] {
  return TyreRulesFileSchema.parse(JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8"))).rules;
}

function inRange(value: number | null, r: Range | undefined): boolean {
  if (r == null) return true;
  if (value == null) return false;
  if (typeof r === "number") return value === r;
  return (r.min == null || value >= r.min) && (r.max == null || value <= r.max);
}

type InferenceInput = Pick<MtcVehicle, "clase" | "ejes" | "llantas" | "pesoBruto">;

export function ruleMatches(v: InferenceInput, rule: TyreRule): boolean {
  if (rule.clases?.length) {
    const clase = normalizeClase(v.clase);
    if (clase == null || !rule.clases.some((c) => normalizeClase(c) === clase)) return false;
  }
  if (!inRange(v.ejes, rule.ejes)) return false;
  if (!inRange(v.llantas, rule.llantas)) return false;
  if (rule.llantasPorEje != null) {
    const perAxle = v.llantas != null && v.ejes ? v.llantas / v.ejes : null;
    if (!inRange(perAxle, rule.llantasPorEje)) return false;
  }
  if (!inRange(v.pesoBruto, rule.pesoBrutoKg)) return false;
  return true;
}

export function inferTyreSize(v: InferenceInput, rules: TyreRule[]): TyreInference {
  for (const rule of rules) if (ruleMatches(v, rule)) return { medida: rule.medida, confianza: rule.confianza, regla: rule.id ?? null };
  return { medida: null, confianza: null, regla: null };
}
