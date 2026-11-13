/**
 * Intérprete de reportes de visita / llamada: de un texto libre o de la transcripción de una nota de voz saca un JSON
 * validado con zod (ExtractedReport). Usa la API de Anthropic como el resto del repo (modelo LLM_MODEL, salida
 * estructurada forzando una herramienta con input_schema); si la respuesta no valida, un único reintento devolviéndole
 * al modelo los errores. Sin ANTHROPIC_API_KEY (o si el modelo falla) -> reglas simples con confianza "baja".
 *
 * Puro salvo la llamada al modelo; el cliente se inyecta (tests sin red).
 */
import { KNOWN_BRANDS } from "../../tyre/brands";
import { jaroWinkler, phoneticKey } from "../voice/fuzzy";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getAnthropic, llmModel } from "../../llm/client";
import { parseSpanishDateTime, parseVagueDay } from "../bot/dates";
import { STAGES, STAGE_IDS, stageIndex, type StageId } from "../stages";
import { formatLimaDateTime, limaDateKey } from "../ui/time";
import { applyVocabulary } from "../voice/vocabulary";
import { displayName, matchCompanies, type CompanyRef } from "./match";

// ── esquema ──

const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "fecha ISO 8601 inválida" });

export const ExtractedReportSchema = z.object({
  empresa: z.object({ nombre: z.string().min(1), ruc: z.string().nullable().optional() }).nullable(),
  tipo: z.enum(["visita", "llamada", "nota"]),
  contacto: z.object({ nombre: z.string().nullable(), cargo: z.string().nullable() }).nullable(),
  interes: z.object({
    medidas: z.array(z.string()),
    posicion: z.string().nullable().optional(),
    cantidades: z.string().nullable().optional(),
    notas: z.string().nullable().optional(),
    /** Marcas que el cliente usa hoy / que quiere probar o cotizar (nombres del catálogo). */
    marcasUsa: z.array(z.string()).optional(),
    marcasInteres: z.array(z.string()).optional(),
  }),
  proximaAccion: z.object({ texto: z.string().min(1), fecha: isoDate.nullable().optional() }).nullable(),
  etapaSugerida: z.enum(STAGE_IDS as [StageId, ...StageId[]]).nullable(),
  ocurrioEn: isoDate.nullable(),
  confianza: z.enum(["alta", "media", "baja"]),
  faltantes: z.array(z.string()),
});
export type ExtractedReport = z.infer<typeof ExtractedReportSchema>;
export type ReportTipo = ExtractedReport["tipo"];

const nullableString = (description: string) => ({ type: ["string", "null"], description });

/** input_schema de la herramienta (mismo contenido que ExtractedReportSchema). */
export const REPORT_TOOL_SCHEMA = {
  type: "object",
  properties: {
    empresa: {
      type: ["object", "null"],
      description: "Empresa cliente de la que se habla. Si coincide con una de la lista del vendedor, usa ese nombre y RUC exactos. null si no se menciona.",
      properties: { nombre: { type: "string" }, ruc: nullableString("RUC de 11 dígitos si se conoce") },
      required: ["nombre"],
    },
    tipo: { type: "string", enum: ["visita", "llamada", "nota"], description: "visita = fue en persona; llamada = por teléfono/WhatsApp; nota = otro apunte." },
    contacto: {
      type: ["object", "null"],
      description: "Persona con la que habló. null si no se menciona.",
      properties: { nombre: nullableString("Nombre de la persona"), cargo: nullableString("Cargo (gerente, jefe de flota, compras...)") },
      required: ["nombre", "cargo"],
    },
    interes: {
      type: "object",
      properties: {
        medidas: { type: "array", items: { type: "string" }, description: "Medidas de llanta tal como se dijeron (11R22.5, 295/80R22.5...). [] si ninguna." },
        posicion: nullableString("Posición: direccional, tracción, mixta, carreta..."),
        cantidades: nullableString("Cantidades mencionadas, en texto ('40 llantas al mes')."),
        notas: nullableString("Otros datos útiles: precio objetivo, CPK, problemas, competencia."),
        marcasUsa: { type: "array", items: { type: "string" }, description: "Marcas de llanta que el cliente usa hoy ('usan Continental'). [] si no dice." },
        marcasInteres: { type: "array", items: { type: "string" }, description: "Marcas que quiere probar o que pide cotizar ('quieren probar Linglong'). [] si no dice." },
      },
      required: ["medidas"],
    },
    proximaAccion: {
      type: ["object", "null"],
      description: "Lo siguiente que hará el vendedor. null si no lo dice.",
      properties: { texto: { type: "string", description: "Qué hará ('Llamar para cotizar', 'Visitar con el técnico')." }, fecha: nullableString("Cuándo, ISO 8601 con zona -05:00; null si no lo dice.") },
      required: ["texto"],
    },
    etapaSugerida: { type: ["string", "null"], enum: [...STAGE_IDS, null], description: "Etapa del pipeline en la que queda la oportunidad según el reporte; null si no se puede decir." },
    ocurrioEn: nullableString("Cuándo ocurrió la visita/llamada, ISO 8601 con zona -05:00; null si no lo dice (se usa la hora del mensaje)."),
    confianza: { type: "string", enum: ["alta", "media", "baja"], description: "Qué tan seguro estás de la interpretación." },
    faltantes: { type: "array", items: { type: "string" }, description: "Datos importantes que faltan o son ambiguos (p. ej. 'empresa', 'fecha de la próxima acción')." },
  },
  required: ["empresa", "tipo", "contacto", "interes", "proximaAccion", "etapaSugerida", "ocurrioEn", "confianza", "faltantes"],
} as const;

// ── contexto y dependencias ──

export interface ExtractContext {
  now: Date;
  vendedor: { id: number | null; nombre: string };
  /** Empresas asignadas / con oportunidad del vendedor. */
  companies: CompanyRef[];
  /** Vocabulario aprendido (se aplica al texto y se le pasa al modelo). */
  vocabulary?: { term: string; meaning: string }[];
  /** Marcas conocidas (catálogo y lista general) para registrar las que usa o quiere el cliente; por defecto KNOWN_BRANDS. */
  brands?: string[];
}

/** Lo mínimo del cliente de Anthropic que se usa (inyectable en tests). */
export interface LlmClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<{ content: Anthropic.ContentBlock[]; usage?: Partial<Pick<Anthropic.Usage, "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens">> | null }> };
}

export interface ExtractDeps {
  /** undefined = el del repo (getAnthropic(), null sin clave); null = sin modelo (solo reglas). */
  client?: LlmClient | null;
  model?: string;
}

export interface LlmUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ExtractResult {
  report: ExtractedReport;
  via: "llm" | "rules";
  /** Texto ya pasado por el vocabulario. */
  text: string;
  /** Tokens usados por el modelo en este reporte (para el costo; sin modelo, ausente). */
  usage?: LlmUsage;
  /** Las reglas reconocen el mismo tipo ("visité…", "llamé…"): no hace falta preguntarlo aunque el modelo dude. */
  tipoSeguro?: boolean;
  /** Había modelo pero falló (clave inválida, red, respuesta inválida): por qué se usaron reglas. */
  llmError?: string;
}

const TOOL_NAME = "registrar_reporte";

function resolveClient(deps: ExtractDeps): LlmClient | null {
  if (deps.client !== undefined) return deps.client;
  return getAnthropic() as unknown as LlmClient | null;
}

/** "2026-11-11T15:30:00-05:00" */
export function limaIso(d: Date): string {
  const local = new Date(d.getTime() - 5 * 60 * 60 * 1000);
  return `${local.toISOString().slice(0, 19)}-05:00`;
}

function systemPrompt(ctx: ExtractContext): string {
  const empresas = ctx.companies.length
    ? ctx.companies.map((c) => `- ${c.razonSocial} (RUC ${c.ruc})`).join("\n")
    : "(ninguna asignada)";
  const etapas = STAGES.map((s) => `- ${s.id}: ${s.label}`).join("\n");
  const vocab = (ctx.vocabulary ?? []).map((v) => `- "${v.term}" = ${v.meaning}`).join("\n");
  return `Eres el asistente comercial de 360 Tyres (venta de llantas de camión y bus en Perú). Un vendedor reporta por WhatsApp (texto o nota de voz transcrita) una visita, una llamada o una nota sobre un cliente. Extrae los datos con la herramienta ${TOOL_NAME}.

Ahora en Lima: ${formatLimaDateTime(ctx.now)} (${limaIso(ctx.now)}). Resuelve "hoy", "ayer", "el viernes", "mañana a las 10" respecto de esa fecha, en hora de Lima (-05:00). Un día de semana para una próxima acción es el próximo.
Vendedor: ${ctx.vendedor.nombre}.
Empresas del vendedor (si el reporte habla de una, usa su razón social y RUC exactos):
${empresas}
Etapas válidas del pipeline (usa el id):
${etapas}
Pista de etapa: una visita hecha -> visita_realizada; cita acordada a futuro -> cita_agendada; cotización enviada -> cotizacion_enviada; negociando precio/condiciones -> negociacion; compra confirmada / orden de compra -> cerrado_ganado; no comprará -> cerrado_perdido.
${vocab ? `Vocabulario del negocio:\n${vocab}\n` : ""}Términos: "enllante" = llanta montada en aro; "CPK" = costo por kilómetro; "Fenixway" y "Flama 77" son productos.
Marcas: en interes.marcasUsa las que el cliente usa hoy y en interes.marcasInteres las que quiere probar o cotizar.
No inventes datos: null o [] si no se dicen. Pon confianza "baja" si no está claro de qué empresa o de qué tipo de contacto se trata, y lista en faltantes lo que falta.`;
}

type Msg = Anthropic.MessageParam;

async function callTool(client: LlmClient, model: string, system: string, messages: Msg[], usage?: LlmUsage): Promise<Anthropic.ToolUseBlock | null> {
  const res = await client.messages.create({
    model,
    max_tokens: 1500,
    system,
    tools: [{ name: TOOL_NAME, description: "Registra el reporte estructurado.", input_schema: REPORT_TOOL_SCHEMA as unknown as Anthropic.Tool["input_schema"] }],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages,
  });
  if (usage) {
    usage.calls++;
    usage.inputTokens += (res.usage?.input_tokens ?? 0) + (res.usage?.cache_read_input_tokens ?? 0) + (res.usage?.cache_creation_input_tokens ?? 0);
    usage.outputTokens += res.usage?.output_tokens ?? 0;
  }
  const block = res.content.find((b) => b.type === "tool_use");
  return block && block.type === "tool_use" ? block : null;
}

function issuesText(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ");
}

/** Pide la herramienta; si no valida, un reintento con los errores. null si no hay modelo o falla dos veces. */
async function askModel(client: LlmClient, model: string, system: string, userText: string, usage?: LlmUsage): Promise<ExtractedReport | null> {
  const messages: Msg[] = [{ role: "user", content: userText }];
  const first = await callTool(client, model, system, messages, usage);
  if (first) {
    const ok = ExtractedReportSchema.safeParse(first.input);
    if (ok.success) return ok.data;
    messages.push({ role: "assistant", content: [first] });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: first.id, is_error: true, content: `Respuesta inválida: ${issuesText(ok.error)}. Vuelve a llamar ${TOOL_NAME} con todos los campos correctos.` }],
    });
  }
  const second = await callTool(client, model, system, messages, usage);
  if (!second) return null;
  const ok = ExtractedReportSchema.safeParse(second.input);
  return ok.success ? ok.data : null;
}

/** Ajusta lo que dio el modelo a la lista del vendedor (nombre y RUC exactos si coincide). */
function normalizeCompany(report: ExtractedReport, companies: CompanyRef[]): ExtractedReport {
  if (!report.empresa) return report;
  const ruc = (report.empresa.ruc ?? "").replace(/\D/g, "");
  const hit = companies.find((c) => ruc.length === 11 && c.ruc === ruc) ?? (() => {
    const m = matchCompanies(report.empresa!.nombre, companies);
    return m.length === 1 ? m[0] : null;
  })();
  return hit ? { ...report, empresa: { nombre: hit.razonSocial, ruc: hit.ruc } } : { ...report, empresa: { nombre: report.empresa.nombre, ruc: ruc.length === 11 ? ruc : (report.empresa.ruc ?? null) } };
}

export async function extractReport(text: string, ctx: ExtractContext, deps: ExtractDeps = {}): Promise<ExtractResult> {
  const clean = applyVocabulary(text.trim(), ctx.vocabulary ?? []);
  const client = resolveClient(deps);
  let llmError: string | undefined;
  const usage: LlmUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  if (client) {
    try {
      const r = await askModel(client, deps.model ?? llmModel(), systemPrompt(ctx), clean, usage);
      if (r) {
        const report = reconcile(normalizeCompany(r, ctx.companies), clean, ctx);
        const tipoSeguro = detectTipo(clean) === report.tipo;
        return { report: tipoSeguro ? { ...report, faltantes: report.faltantes.filter((f) => f !== "tipo") } : report, via: "llm", text: clean, usage, ...(tipoSeguro ? { tipoSeguro } : {}) };
      }
      llmError = "el modelo no devolvió un reporte válido";
    } catch (err) {
      // error de red / API (p. ej. 401 clave inválida): se sigue con reglas, pero se dice por qué
      llmError = String((err as Error)?.message ?? err).slice(0, 300);
    }
  }
  const rules = extractByRules(clean, ctx);
  return { report: rules, via: "rules", text: clean, ...(detectTipo(clean) ? { tipoSeguro: true } : {}), ...(llmError ? { llmError } : {}) };
}

/**
 * Corrección sobre un reporte ya extraído ("no, fue con el gerente", "la llamada es el viernes"): el modelo devuelve el
 * reporte completo actualizado. null si no hay modelo o no se pudo (quien llama aplica reglas).
 */
export async function correctReport(current: ExtractedReport, correction: string, ctx: ExtractContext, deps: ExtractDeps = {}): Promise<ExtractedReport | null> {
  const client = resolveClient(deps);
  if (!client) return null;
  const clean = applyVocabulary(correction.trim(), ctx.vocabulary ?? []);
  const user = `Borrador actual del reporte (JSON):\n${JSON.stringify(current)}\n\nEl vendedor corrige o completa: "${clean}"\n\nDevuelve el reporte COMPLETO actualizado: cambia solo lo que la corrección indica y conserva el resto tal cual.`;
  try {
    const r = await askModel(client, deps.model ?? llmModel(), systemPrompt(ctx), user);
    return r ? normalizeCompany(r, ctx.companies) : null;
  } catch {
    return null;
  }
}

// ── modelo + reglas (pasada 5 con el modelo real, 2026-11-13) ──

const SENT_QUOTE = /\bcotizacion\s+enviada|\b(?:le|les)\s+(?:mande|envie|pase)\s+(?:la\s+)?cotizacion|\b(?:mande|envie)\s+(?:la\s+)?cotizacion/;
const VISIT_ACTION = /\b(visit|cita|reunion|pasar|volver|regresar|ir\b)/;

/**
 * Lo que el modelo hace mal y las reglas bien (medido con los audios): las fechas relativas ("el martes", "pasado
 * mañana", "la próxima semana": el modelo se equivocaba de día y copiaba la hora del mensaje), la etapa sin evidencia
 * ("quedamos en mandarle la cotización" no es *Cotización enviada*; "llamar" no es una *Cita agendada*), las marcas
 * (contra el catálogo) y la forma del cargo. El resto (empresa, contacto, notas, texto de la próxima acción) es del modelo.
 */
export function reconcile(r: ExtractedReport, text: string, ctx: ExtractContext): ExtractedReport {
  const t = fold(text);
  const rules = extractByRules(text, ctx);
  const out: ExtractedReport = { ...r, interes: { ...r.interes } };
  if (rules.ocurrioEn) out.ocurrioEn = rules.ocurrioEn;
  if (rules.proximaAccion?.fecha) out.proximaAccion = { texto: r.proximaAccion?.texto ?? rules.proximaAccion.texto, fecha: rules.proximaAccion.fecha };
  if (out.etapaSugerida === "cotizacion_enviada" && !SENT_QUOTE.test(t)) out.etapaSugerida = rules.etapaSugerida === "cotizacion_enviada" ? null : rules.etapaSugerida;
  if (out.etapaSugerida === "cita_agendada" && !(out.proximaAccion && VISIT_ACTION.test(fold(out.proximaAccion.texto)))) {
    out.etapaSugerida = rules.etapaSugerida === "cita_agendada" ? null : rules.etapaSugerida;
  }
  // una visita reportada ya ocurrió: la etapa es Visita realizada como mínimo (el modelo sugería *Cita agendada* por el
  // "quedamos en volver …"); lo que va más allá (cotización enviada, negociación…) se respeta
  if (out.tipo === "visita" && (!out.etapaSugerida || stageIndex(out.etapaSugerida) < stageIndex("visita_realizada")) && !(out.etapaSugerida && /^cerrado/.test(out.etapaSugerida))) {
    out.etapaSugerida = "visita_realizada";
  }
  const brands = ctx.brands?.length ? ctx.brands : KNOWN_BRANDS;
  const norm = (list: string[] | undefined) => (list ?? []).map((b) => canonicalBrand(b, brands)).filter((b): b is string => !!b);
  const interes = uniq([...norm(r.interes.marcasInteres), ...(rules.interes.marcasInteres ?? [])]);
  out.interes.marcasInteres = interes;
  out.interes.marcasUsa = uniq([...norm(r.interes.marcasUsa), ...(rules.interes.marcasUsa ?? [])]).filter((b) => !interes.includes(b));
  if (out.contacto?.cargo) out.contacto = { ...out.contacto, cargo: capitalize(out.contacto.cargo) };
  return out;
}

const uniq = (xs: string[]) => [...new Set(xs)];
const capitalize = (s: string) => {
  const c = s.trim().replace(/\s+/g, " ");
  return c ? c[0].toUpperCase() + c.slice(1) : c;
};

/** La marca del catálogo que corresponde a lo dicho (igual sin tildes/mayúsculas, o muy parecida); null si ninguna. */
function canonicalBrand(said: string, brands: string[]): string | null {
  const f = fold(said).trim();
  const exact = brands.find((b) => fold(b) === f);
  if (exact) return exact;
  const k = phoneticKey(said);
  if (k.length < 5) return null;
  let best: { b: string; s: number } | null = null;
  for (const b of brands) {
    const s = jaroWinkler(k, phoneticKey(b));
    if (s >= 0.92 && (!best || s > best.s)) best = { b, s };
  }
  return best?.b ?? null;
}

const INTEREST_CUE = /\b(probar|prueba|pruebe|quieren|quiere|quiero|interes\w*|cotizacion\s+de|cotizar|cotice|pidieron|piden|pide)\b/;
const USE_CUE = /\b(usa|usan|utiliza|utilizan|trabaja|trabajan|tienen|tiene|montan|monta|ruedan|compran|compra)\b/;

/** Marcas mencionadas por oración/cláusula: tras "quieren probar…" -> interés; tras "usan…" -> las que usa. */
export function detectBrands(text: string, brands: string[] = KNOWN_BRANDS): { usa: string[]; interes: string[] } {
  const usa: string[] = [];
  const interes: string[] = [];
  const sorted = [...brands].sort((a, b) => b.length - a.length);
  for (const clause of text.split(/[.;,\n]+/)) {
    let c = ` ${fold(clause).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ")} `;
    const hits: { b: string; at: number }[] = [];
    for (const b of sorted) {
      const fb = fold(b).replace(/[^a-z0-9ñ ]+/g, " ").trim();
      if (fb.length < 3) continue;
      const at = c.indexOf(` ${fb} `);
      if (at < 0) continue;
      hits.push({ b, at });
      // la más larga gana ("Double Coin" antes que "Coin"): se tapa para las siguientes
      c = `${c.slice(0, at + 1)}${"#".repeat(fb.length)}${c.slice(at + 1 + fb.length)}`;
    }
    for (const h of hits.sort((a, b) => a.at - b.at)) {
      const before = c.slice(0, h.at);
      if (INTEREST_CUE.test(before)) interes.push(h.b);
      else if (USE_CUE.test(before)) usa.push(h.b);
    }
  }
  return { usa: uniq(usa), interes: uniq(interes) };
}

// ── reglas (sin modelo) ──

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

export function detectTipo(text: string): ReportTipo | null {
  const t = fold(text);
  // el primer verbo manda: "Llamé a X, dice que lo visite el lunes" es una llamada
  const v = /\b(visite|visitamos|visita(?:mos)?\s+(?:a|hoy|ayer)|fui\s+a|fuimos\s+a|estuve\s+en|pase\s+por|me\s+reuni|nos\s+reunimos)\b/.exec(t);
  const l = /\b(llame|llamamos|me\s+llamo|nos\s+llamo|hable\s+por\s+telefono|telefonee|por\s+telefono)\b/.exec(t);
  if (v && (!l || v.index <= l.index)) return "visita";
  if (l) return "llamada";
  if (/\bvisita\b/.test(t)) return "visita";
  if (/\bllamada\b/.test(t)) return "llamada";
  return null;
}

const SIZE_RE = /(?<![\w/.])(\d{3}\/\d{2}\s?R\s?\d{2}(?:[.,]5)?|\d{1,2}(?:[.,]\d{2})?\s?R\s?\d{2}(?:[.,]5)?|\d{4}\s?R\s?\d{2})(?![\w])/gi;

export function detectSizes(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SIZE_RE)) {
    const s = m[1].toUpperCase().replace(/\s+/g, "").replace(",", ".");
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

const CARGO_RE = /\b((?:gerente|jefe|jefa|supervisor[a]?|encargad[oa]|administrador[a]?|due[ñn][oa]|propietari[oa]|asistente|coordinador[a]?|comprador[a]?|analista|logistic[oa])(?:\s+(?:de|del|general|comercial|de\s+la)\s+[a-zñáéíóú]+(?:\s+de\s+[a-zñáéíóú]+)?)?)/i;

/** "con el gerente de flota" -> "Gerente de flota". */
export function detectCargo(text: string): string | null {
  const m = CARGO_RE.exec(text);
  if (!m) return null;
  const c = m[1].trim().replace(/\s+/g, " ");
  return c[0].toUpperCase() + c.slice(1).toLowerCase();
}

/**
 * Nombre propio del contacto (palabras con mayúscula) tras "con", "me/nos atendió", "me/nos recibió", "atendido por":
 * "con Juan Pérez", "hablé con la señora Rosa", "me atendió Carlos Quispe, el jefe de flota". Gana el primero del texto.
 */
export function detectContactName(text: string): string | null {
  const re = /(?:\bcon|\b[Mm]e\s+atendi[oó]|\b[Nn]os\s+atendi[oó]|\b[Mm]e\s+recibi[oó]|\b[Nn]os\s+recibi[oó]|\batendid[oa]\s+por)\s+(?:el\s+|la\s+)?(?:se[ñn]or(?:a|ita)?\s+|sr\.?\s+|sra\.?\s+|ing\.?\s+|ingenier[oa]\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,2})/g;
  const m = re.exec(text);
  return m ? m[1] : null;
}

const PAST_VERB = /\b(visite|visitamos|fui|fuimos|estuve|estuvimos|llame|llamamos|hable|hablamos|me\s+reuni|nos\s+reunimos|pase\s+por|me\s+atendio|nos\s+atendio)\b/;
const WEEKDAY_RE = /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/;
/** "visité ZBUSS el martes": verbo en pasado y luego el día, sin "que"/"dice"/"para"/coma entre ellos. */
function pastWeekday(t: string): boolean {
  const v = PAST_VERB.exec(t);
  const w = WEEKDAY_RE.exec(t);
  if (!v || !w || w.index < v.index) return false;
  return !/[,;]|\b(que|dice|dijo|pide|pidio|para|quiere|quieren|quedamos)\b/.test(t.slice(v.index + v[0].length, w.index));
}
const FUTURE_HINT = /\b(proxim[oa]|quedamos|qued[eé]|volver|regresar|llamar(?:le|los)?|visitar(?:le|los)?|cita|reunion|mandar|enviar|cotizar|pasar[eé]|ir[eé]|llamo\s+el|voy\s+a)\b/;

function nextActionText(t: string): string {
  if (/\bcotiz/.test(t)) return "Enviar cotización";
  if (/\bllam/.test(t)) return "Llamar";
  if (/\b(visit|cita|reunion|pasar|volver|regresar)/.test(t)) return "Visitar";
  return "Seguimiento";
}

export interface RuleDates {
  ocurrioEn: string | null;
  proximaAccion: { texto: string; fecha: string | null } | null;
}

/**
 * Fechas por reglas, por oración: "ayer" -> ocurrió ayer; la fecha de una oración con verbo de seguimiento ("quedamos en
 * volver a llamar el lunes") -> próxima acción; la de una oración sin él ("visité ZBUSS hoy en la mañana") -> ocurrió, si
 * no es futura. Días aproximados ("la próxima semana", "fin de mes") también valen para la próxima acción. Día sin hora:
 * 9:00 de Lima.
 */
export function detectDates(text: string, now: Date): RuleDates {
  const t = fold(text);
  let ocurrioEn: string | null = null;
  let proximaAccion: RuleDates["proximaAccion"] = null;
  if (/\bayer\b/.test(t)) ocurrioEn = limaIso(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  else if (/\banteayer\b/.test(t)) ocurrioEn = limaIso(new Date(now.getTime() - 48 * 60 * 60 * 1000));
  const nine = (d: Date) => new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const sentences = text.split(/(?<=[.;!?\n])\s*/).map((x) => x.trim()).filter(Boolean);
  let futureSeen = false;
  for (const sentence of sentences) {
    const st = fold(sentence);
    const future = FUTURE_HINT.test(st);
    const parsed = parseSpanishDateTime(sentence, now);
    const vague = parsed ? null : parseVagueDay(sentence, now);
    let date = parsed ? (parsed.allDay ? nine(parsed.date) : parsed.date) : vague ? nine(vague) : null;
    // "Visité ZBUSS el martes" dicho un viernes: en pasado, el día de semana es el último que pasó, no el próximo
    // (solo si el día va con el verbo en pasado: "llamé a Andino, dice que lo visite el lunes" es futuro)
    if (date && parsed && !future && pastWeekday(st) && date.getTime() > now.getTime()) date = new Date(date.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (future) futureSeen = true;
    if (!date) continue;
    // "visité hoy" a las 8:00: hoy (9:00 por defecto) no es una próxima acción sino cuándo ocurrió
    if (!future && parsed?.allDay && limaDateKey(parsed.date) === limaDateKey(now)) {
      if (!ocurrioEn) ocurrioEn = limaIso(date.getTime() > now.getTime() ? now : date);
      continue;
    }
    if (!proximaAccion && (future || date.getTime() > now.getTime())) proximaAccion = { texto: nextActionText(st), fecha: limaIso(date) };
    else if (!future && !ocurrioEn && date.getTime() <= now.getTime()) ocurrioEn = limaIso(date);
  }
  if (!proximaAccion && futureSeen && /\b(proxim[oa]|quedamos|volver|llamar|visitar|cotizar|enviar|mandar)\b/.test(t)) {
    proximaAccion = { texto: nextActionText(t), fecha: null };
  }
  return { ocurrioEn, proximaAccion };
}

/** Interpretación mínima sin modelo. Siempre confianza "baja". */
export function extractByRules(text: string, ctx: ExtractContext): ExtractedReport {
  const tipoHit = detectTipo(text);
  const tipo = tipoHit ?? "nota";
  const hits = matchCompanies(text, ctx.companies);
  const empresa = hits.length === 1 ? { nombre: hits[0].razonSocial, ruc: hits[0].ruc } : null;
  const cargo = detectCargo(text);
  const nombre = detectContactName(text);
  const companyWords = new Set(hits.flatMap((h) => displayName(h.razonSocial).toLowerCase().split(/\s+/)));
  const nombreOk = nombre && !nombre.toLowerCase().split(/\s+/).some((w) => companyWords.has(w)) ? nombre : null;
  const { ocurrioEn, proximaAccion } = detectDates(text, ctx.now);
  const t = fold(text);
  const marcas = detectBrands(text, ctx.brands?.length ? ctx.brands : KNOWN_BRANDS);
  let etapa: StageId | null = null;
  if (/\bcotizacion\s+enviada|\ble\s+(?:mande|envie)\s+(?:la\s+)?cotizacion/.test(t)) etapa = "cotizacion_enviada";
  else if (tipo === "visita") etapa = "visita_realizada";
  else if (/\bcita\b/.test(t) && proximaAccion?.fecha) etapa = "cita_agendada";
  const faltantes: string[] = [];
  if (!empresa) faltantes.push("empresa");
  if (!tipoHit) faltantes.push("tipo");
  if (proximaAccion && !proximaAccion.fecha) faltantes.push("fecha de la próxima acción");
  return {
    empresa,
    tipo,
    contacto: nombreOk || cargo ? { nombre: nombreOk, cargo } : null,
    interes: { medidas: detectSizes(text), posicion: detectPosition(t), cantidades: detectQuantities(t), notas: null, marcasUsa: marcas.usa, marcasInteres: marcas.interes },
    proximaAccion,
    etapaSugerida: etapa,
    ocurrioEn,
    confianza: "baja",
    faltantes,
  };
}

function detectPosition(t: string): string | null {
  if (/\b(direccional|delanter[oa]s?)\b/.test(t)) return "direccional";
  if (/\btraccion\b/.test(t)) return "tracción";
  if (/\bmixt[oa]s?\b/.test(t)) return "mixta";
  if (/\b(carreta|semirremolque|remolque|trailer)\b/.test(t)) return "carreta";
  return null;
}

function detectQuantities(t: string): string | null {
  const m = /\b(\d{1,4})\s+(llantas|neumaticos|unidades|camiones|buses)\b(?:\s+(?:al|por)\s+(mes|ano|semana))?/.exec(t);
  return m ? m[0] : null;
}
