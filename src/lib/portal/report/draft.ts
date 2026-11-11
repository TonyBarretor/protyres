/**
 * Borrador de un reporte de visita/llamada y su confirmación por WhatsApp. Lógica pura: el bot guarda el borrador en el
 * estado de la conversación (JSON: fechas como texto ISO), muestra el resumen, pregunta lo que falta una cosa a la vez,
 * aplica correcciones y, al confirmar, `draftToRecords` dice qué guardar.
 */
import { foldText } from "../store/shared";
import { isClosedStage, stageIndex, stageLabel, type StageId } from "../stages";
import type { ActivityCanal, ActivityInput, Contact, ContactInput, Opportunity, OpportunityInput, OpportunityPatch } from "../store/types";
import { formatLimaDateTime } from "../ui/time";
import { correctReport, detectCargo, detectContactName, detectDates, detectTipo, extractByRules, type ExtractContext, type ExtractDeps, type ExtractedReport } from "./extract";
import { displayName, matchCompanies, resolveCompanyRef, type CompanyRef } from "./match";

export const CONFIRM_LINE = "¿Está bien? Responde *sí* o corrige";

export type DraftField = "empresa" | "tipo" | "proximaAccion.fecha";

export interface ReportDraft extends ExtractedReport {
  /** Empresa identificada en la lista del vendedor (null = falta o es ambigua). */
  companyId: number | null;
  /** Candidatas cuando el nombre coincide con varias (para la pregunta numerada). */
  candidates: CompanyRef[];
  /** "voz" si vino de una nota de voz. */
  canal: "whatsapp" | "voz";
  /** Texto original (o transcripción ya pasada por el vocabulario). */
  texto: string;
  /** Hora del mensaje, ISO. */
  messageAt: string;
  /** Preguntas ya respondidas (no se repiten aunque la confianza siga baja). */
  answered: DraftField[];
  /** "llm" o "rules": de dónde salió la interpretación. */
  via?: "llm" | "rules";
}

/** Arma el borrador a partir de lo extraído. */
export function makeDraft(report: ExtractedReport, opts: { companies: CompanyRef[]; canal: "whatsapp" | "voz"; texto: string; messageAt: Date; via?: "llm" | "rules" }): ReportDraft {
  const { companyId, candidates } = resolveCompanyRef(report.empresa, opts.companies);
  return { ...report, companyId, candidates, canal: opts.canal, texto: opts.texto, messageAt: opts.messageAt.toISOString(), answered: [], via: opts.via };
}

// ── resumen ──

const TIPO_LABEL: Record<ExtractedReport["tipo"], string> = { visita: "visita", llamada: "llamada", nota: "nota" };

function fmtWhen(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : formatLimaDateTime(d);
}

/** Resumen para WhatsApp; termina siempre en CONFIRM_LINE. */
export function formatDraftSummary(draft: ReportDraft, company?: { razonSocial: string; ruc: string } | null): string {
  const lines: string[] = [];
  const emp = company ?? (draft.companyId !== null ? draft.candidates.find((c) => c.id === draft.companyId) : null);
  const empresa = emp ? `${displayName(emp.razonSocial)} (RUC ${emp.ruc})` : draft.empresa ? `${draft.empresa.nombre} _(sin identificar)_` : "_(sin identificar)_";
  lines.push(`*Reporte de ${TIPO_LABEL[draft.tipo]}* — ${empresa}`);
  lines.push(`• Cuándo: ${fmtWhen(draft.ocurrioEn) ?? `${fmtWhen(draft.messageAt) ?? "ahora"} (hora del mensaje)`}`);
  if (draft.contacto && (draft.contacto.nombre || draft.contacto.cargo)) {
    const n = draft.contacto.nombre ?? "(sin nombre)";
    lines.push(`• Contacto: ${n}${draft.contacto.cargo ? ` — ${draft.contacto.cargo}` : ""}`);
  }
  const i = draft.interes;
  const interes = [i.medidas.join(", "), i.posicion, i.cantidades].filter((x): x is string => !!x && !!x.trim());
  if (interes.length) lines.push(`• Interés: ${interes.join(" · ")}`);
  if (i.notas) lines.push(`• Notas: ${i.notas}`);
  if (draft.proximaAccion) {
    const f = fmtWhen(draft.proximaAccion.fecha);
    lines.push(`• Próxima acción: ${draft.proximaAccion.texto}${f ? ` — ${f}` : " _(sin fecha)_"}`);
  }
  if (draft.etapaSugerida) lines.push(`• Etapa: ${stageLabel(draft.etapaSugerida)}`);
  lines.push("", CONFIRM_LINE);
  return lines.join("\n");
}

// ── preguntas ──

export interface DraftQuestion {
  field: DraftField;
  text: string;
}

/** Lo siguiente que falta, una cosa a la vez: empresa > tipo (si la confianza es baja) > fecha de la próxima acción. */
export function nextQuestion(draft: ReportDraft): DraftQuestion | null {
  if (draft.companyId === null && !draft.answered.includes("empresa")) {
    if (draft.candidates.length > 1) {
      const opts = draft.candidates.map((c, n) => `${n + 1}. ${displayName(c.razonSocial)} (RUC ${c.ruc})`).join("\n");
      return { field: "empresa", text: `¿Con cuál empresa fue? Responde con el número:\n${opts}` };
    }
    return { field: "empresa", text: "¿Con qué empresa fue? Escribe el nombre o el RUC." };
  }
  if (draft.confianza === "baja" && !draft.answered.includes("tipo")) {
    return { field: "tipo", text: "¿Fue una *visita*, una *llamada* o solo una *nota*?" };
  }
  if (draft.proximaAccion && !draft.proximaAccion.fecha && !draft.answered.includes("proximaAccion.fecha")) {
    return { field: "proximaAccion.fecha", text: `¿Para cuándo es "${draft.proximaAccion.texto}"? (p. ej. *viernes 10am*, o *sin fecha*)` };
  }
  return null;
}

// ── confirmación ──

const YES = ["si", "ok", "okey", "okay", "oki", "correcto", "dale", "esta bien", "confirmo", "confirmado", "perfecto", "listo", "de acuerdo", "asi es", "exacto", "claro", "va", "yes", "todo bien", "bien"];
const NO = ["no", "cancelar", "cancela", "cancelalo", "anular", "anula", "descartar", "descartalo", "olvidalo", "no gracias", "no guardes", "no lo guardes"];

function phraseOnly(text: string, phrases: string[]): boolean {
  let t = ` ${foldText(text).replace(/[^a-z0-9ñ]+/g, " ").trim()} `;
  if (!t.trim()) return false;
  const sorted = [...phrases].sort((a, b) => b.length - a.length);
  let changed = true;
  while (changed && t.trim()) {
    changed = false;
    for (const p of sorted) {
      if (t.startsWith(` ${p} `)) {
        t = t.slice(p.length + 1);
        changed = true;
        break;
      }
    }
  }
  return !t.trim();
}

/** "sí", "si", "ok", "correcto", "dale", "está bien", "confirmo", "sí, está bien", 👍. */
export function isConfirmation(text: string): boolean {
  if (/^\s*(?:👍|👌|✅)+\s*$/u.test(text)) return true;
  return phraseOnly(text.replace(/[👍👌✅]/gu, " "), YES);
}

/** "no", "cancelar" (solos; "no, fue con el gerente" es una corrección). */
export function isRejection(text: string): boolean {
  return phraseOnly(text, NO);
}

const SKIP = ["no se", "sin fecha", "ninguno", "ninguna", "nada", "omitir", "saltar", "pasa", "despues", "luego veo", "no hay"];

// ── correcciones ──

export interface CorrectionOptions {
  ctx: ExtractContext;
  /** Cómo corregir con el modelo; por defecto correctReport(draft, text, ctx, deps). null = sin modelo. */
  extract?: ((current: ExtractedReport, text: string) => Promise<ExtractedReport | null>) | null;
  deps?: ExtractDeps;
  /** Pregunta pendiente que el texto responde; por defecto nextQuestion(draft). */
  field?: DraftField | null;
}

function pickReport(d: ReportDraft): ExtractedReport {
  return {
    empresa: d.empresa,
    tipo: d.tipo,
    contacto: d.contacto,
    interes: d.interes,
    proximaAccion: d.proximaAccion,
    etapaSugerida: d.etapaSugerida,
    ocurrioEn: d.ocurrioEn,
    confianza: d.confianza,
    faltantes: d.faltantes,
  };
}

/** Respuesta a la pregunta pendiente sin modelo: número de la lista, nombre/RUC, tipo o fecha. */
function answerByRules(draft: ReportDraft, field: DraftField, text: string, ctx: ExtractContext): ReportDraft | null {
  if (field === "empresa") {
    const n = /^\s*(\d{1,2})\s*\.?\s*$/.exec(text);
    if (n && draft.candidates.length > 1) {
      const c = draft.candidates[Number(n[1]) - 1];
      if (c) return { ...draft, companyId: c.id, empresa: { nombre: c.razonSocial, ruc: c.ruc }, candidates: [c] };
    }
    const hits = matchCompanies(text, draft.candidates.length > 1 ? draft.candidates : ctx.companies);
    const pool = hits.length ? hits : matchCompanies(text, ctx.companies);
    if (pool.length === 1) return { ...draft, companyId: pool[0].id, empresa: { nombre: pool[0].razonSocial, ruc: pool[0].ruc }, candidates: [pool[0]] };
    if (pool.length > 1) return { ...draft, companyId: null, candidates: pool.slice(0, 5) };
    return null;
  }
  if (field === "tipo") {
    const t = foldText(text);
    const tipo = /\bvisita/.test(t) ? "visita" : /\bllamada|\btelefono/.test(t) ? "llamada" : /\bnota/.test(t) ? "nota" : detectTipo(text);
    return tipo ? { ...draft, tipo } : null;
  }
  if (field === "proximaAccion.fecha" && draft.proximaAccion) {
    const { proximaAccion } = detectDates(`proxima ${text}`, ctx.now);
    if (proximaAccion?.fecha) return { ...draft, proximaAccion: { ...draft.proximaAccion, fecha: proximaAccion.fecha } };
    return null;
  }
  return null;
}

/** Correcciones libres sin modelo: cargo, nombre del contacto, tipo y fechas. */
function correctByRules(draft: ReportDraft, text: string, ctx: ExtractContext): ReportDraft {
  let d = { ...draft };
  const cargo = detectCargo(text);
  const nombre = detectContactName(text);
  if (cargo || nombre) {
    // "fue con el gerente" cambia de persona: el nombre anterior ya no vale si solo se da el cargo
    d.contacto = { nombre: nombre ?? (cargo && d.contacto?.cargo && foldText(d.contacto.cargo) !== foldText(cargo) ? null : (d.contacto?.nombre ?? null)), cargo: cargo ?? d.contacto?.cargo ?? null };
  }
  const t = foldText(text);
  const tipo = /\b(fue|era)\s+(una\s+)?llamada\b|\bpor\s+telefono\b/.test(t) ? "llamada" : /\b(fue|era)\s+(una\s+)?visita\b|\ben\s+persona\b/.test(t) ? "visita" : null;
  if (tipo) d.tipo = tipo;
  const dates = detectDates(text, ctx.now);
  const mentionsNext = /\b(proxim[oa]|llamada|visita|cita|reunion|cotiz|volver|quedamos|es\s+el|sera)\b/.test(t) && !/\b(fue|ocurrio|paso)\b/.test(t);
  if (dates.proximaAccion?.fecha && (mentionsNext || d.proximaAccion)) {
    d.proximaAccion = { texto: d.proximaAccion?.texto ?? dates.proximaAccion.texto, fecha: dates.proximaAccion.fecha };
  } else if (dates.proximaAccion?.fecha && !d.proximaAccion) {
    d.proximaAccion = { texto: dates.proximaAccion.texto, fecha: dates.proximaAccion.fecha };
  } else if (dates.ocurrioEn) {
    d.ocurrioEn = dates.ocurrioEn;
  }
  const hits = matchCompanies(text, ctx.companies);
  if (hits.length === 1 && hits[0].id !== d.companyId) d = { ...d, companyId: hits[0].id, empresa: { nombre: hits[0].razonSocial, ruc: hits[0].ruc }, candidates: [hits[0]] };
  return d;
}

/**
 * Aplica una corrección o la respuesta a la pregunta pendiente. Con modelo: el modelo reescribe el reporte; sin modelo
 * (o si falla): reglas (número/nombre de empresa, tipo, cargo, nombre, fechas). La pregunta pendiente queda respondida
 * (no se repite) aunque la respuesta sea "no sé" / "sin fecha".
 */
export async function applyCorrection(draft: ReportDraft, text: string, opts: CorrectionOptions): Promise<ReportDraft> {
  const field = opts.field === undefined ? (nextQuestion(draft)?.field ?? null) : opts.field;
  const markAnswered = (d: ReportDraft): ReportDraft => (field && !d.answered.includes(field) ? { ...d, answered: [...d.answered, field] } : d);

  if (field && phraseOnly(text, SKIP)) return markAnswered({ ...draft });

  // respuesta directa a la pregunta pendiente (número de lista, RUC, "visita", "viernes 10am"): reglas primero, sin gastar modelo
  if (field) {
    const direct = answerByRules(draft, field, text, opts.ctx);
    if (direct && (field !== "empresa" || direct.companyId !== null)) return markAnswered(direct);
  }

  const correct = opts.extract === undefined ? (cur: ExtractedReport, t: string) => correctReport(cur, t, opts.ctx, opts.deps) : opts.extract;
  let updated: ExtractedReport | null = null;
  if (correct) {
    try {
      updated = await correct(pickReport(draft), text);
    } catch {
      updated = null;
    }
  }
  let next: ReportDraft;
  if (updated) {
    next = { ...draft, ...updated };
    const sameCompany = draft.companyId !== null && draft.empresa && updated.empresa && foldText(updated.empresa.nombre) === foldText(draft.empresa.nombre);
    if (!sameCompany) {
      const r = resolveCompanyRef(updated.empresa, opts.ctx.companies);
      next.companyId = r.companyId;
      next.candidates = r.candidates;
    }
  } else {
    next = correctByRules(draft, text, opts.ctx);
  }
  // la pregunta pendiente queda respondida solo si la corrección tocó ese dato (si no, se vuelve a preguntar)
  return field && fieldValue(next, field) !== fieldValue(draft, field) ? markAnswered(next) : next;
}

function fieldValue(d: ReportDraft, field: DraftField): string {
  if (field === "empresa") return String(d.companyId);
  if (field === "tipo") return d.tipo;
  return d.proximaAccion?.fecha ?? "";
}

/** Borrador nuevo solo con reglas (sin modelo), útil para el bot y para pruebas. */
export function draftByRules(text: string, ctx: ExtractContext, canal: "whatsapp" | "voz", messageAt: Date): ReportDraft {
  return makeDraft(extractByRules(text, ctx), { companies: ctx.companies, canal, texto: text, messageAt, via: "rules" });
}

// ── al confirmar ──

export interface RecordsContext {
  userId: number | null;
  /** Ahora (createdAt). */
  now: Date;
  /** Oportunidad abierta de la empresa (null = hay que crearla). */
  opportunity: Opportunity | null;
  /** Contactos ya guardados de la empresa. */
  contacts: Contact[];
}

export interface DraftRecords {
  activity: ActivityInput & { companyId: number; occurredAt: Date; createdAt: Date };
  /** Crear oportunidad (no había abierta). */
  newOpportunity: OpportunityInput | null;
  /** Mover la oportunidad existente (solo avanza; null si no cambia). */
  stageChange: { opportunityId: number; from: StageId; to: StageId } | null;
  /** Próxima acción y su fecha sobre la oportunidad existente. */
  opportunityPatch: { opportunityId: number; patch: OpportunityPatch } | null;
  newContact: ContactInput | null;
}

/** true si `to` está más adelante que `from` en el embudo (y `from` no está cerrada). */
export function advancesStage(from: StageId, to: StageId | null): to is StageId {
  if (!to || isClosedStage(from)) return false;
  return stageIndex(to) > stageIndex(from);
}

function activityText(d: ReportDraft): string {
  const parts: string[] = [];
  const head = d.tipo === "visita" ? "Visita" : d.tipo === "llamada" ? "Llamada" : "Nota";
  const who = d.contacto && (d.contacto.nombre || d.contacto.cargo) ? ` con ${[d.contacto.nombre, d.contacto.cargo].filter(Boolean).join(" — ")}` : "";
  parts.push(`${head}${who}.`);
  const i = d.interes;
  const interes = [i.medidas.join(", "), i.posicion, i.cantidades].filter((x): x is string => !!x && !!x.trim());
  if (interes.length) parts.push(`Interés: ${interes.join(" · ")}.`);
  if (i.notas) parts.push(i.notas.trim().replace(/\.?$/, "."));
  if (d.proximaAccion) parts.push(`Próxima acción: ${d.proximaAccion.texto}${d.proximaAccion.fecha ? ` (${formatLimaDateTime(new Date(d.proximaAccion.fecha))})` : ""}.`);
  return parts.join(" ");
}

/** Qué guardar al confirmar. Lanza si la empresa no está identificada. */
export function draftToRecords(draft: ReportDraft, ctx: RecordsContext): DraftRecords {
  if (draft.companyId === null) throw new Error("El reporte no tiene empresa identificada");
  const companyId = draft.companyId;
  const occurred = draft.ocurrioEn ? new Date(draft.ocurrioEn) : new Date(draft.messageAt);
  const occurredAt = Number.isNaN(occurred.getTime()) ? ctx.now : occurred;
  const canal: ActivityCanal = draft.canal === "voz" ? "voz" : "whatsapp";
  const nextAt = draft.proximaAccion?.fecha ? new Date(draft.proximaAccion.fecha) : null;
  const proximaAccionAt = nextAt && !Number.isNaN(nextAt.getTime()) ? nextAt : null;

  const opp = ctx.opportunity;
  const activity: DraftRecords["activity"] = {
    companyId,
    opportunityId: opp?.id ?? null,
    userId: ctx.userId,
    tipo: draft.tipo,
    texto: activityText(draft),
    canal,
    data: { reporte: pickReport(draft), textoOriginal: draft.texto, via: draft.via ?? null, messageAt: draft.messageAt },
    occurredAt,
    createdAt: ctx.now,
  };

  let newOpportunity: OpportunityInput | null = null;
  let stageChange: DraftRecords["stageChange"] = null;
  let opportunityPatch: DraftRecords["opportunityPatch"] = null;
  if (!opp) {
    newOpportunity = {
      companyId,
      ownerUserId: ctx.userId,
      etapa: draft.etapaSugerida ?? "prospecto",
      proximaAccion: draft.proximaAccion?.texto ?? null,
      proximaAccionAt,
      createdBy: ctx.userId,
      at: occurredAt,
    };
  } else {
    if (advancesStage(opp.etapa, draft.etapaSugerida)) stageChange = { opportunityId: opp.id, from: opp.etapa, to: draft.etapaSugerida };
    if (draft.proximaAccion) opportunityPatch = { opportunityId: opp.id, patch: { proximaAccion: draft.proximaAccion.texto, proximaAccionAt } };
  }

  let newContact: ContactInput | null = null;
  const nombre = draft.contacto?.nombre?.trim();
  if (nombre) {
    const exists = ctx.contacts.some((c) => foldText(c.nombre) === foldText(nombre));
    if (!exists) newContact = { companyId, nombre, cargo: draft.contacto?.cargo ?? null, createdBy: ctx.userId };
  }
  return { activity, newOpportunity, stageChange, opportunityPatch, newContact };
}
