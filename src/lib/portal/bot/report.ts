/**
 * Reportes de visita / llamada / nota por WhatsApp (texto o nota de voz) y `aprende X = Y` (bloque B3).
 *
 *  0. Una nota de voz cuya transcripción empieza con un comando del portal ("asígname ZBUSS") corre ese comando.
 *  1. Voz: descarga el audio (Graph API, o lo que se inyecte), lo transcribe con Deepgram Nova-3 con las empresas del
 *     vendedor y el vocabulario aprendido como keyterms, guarda la transcripción en `messages` (kind "transcript") y
 *     responde "🎙️ Entendí: «…»". Sin DEEPGRAM_API_KEY: la voz aún no está activa, pide texto.
 *  2. Interpreta el texto (Anthropic, o reglas sin clave) y arma un borrador. Si falta algo (empresa, tipo con confianza
 *     baja, fecha de la próxima acción) pregunta UNA cosa a la vez; si no, muestra el resumen y espera confirmación.
 *     El borrador vive en el paso pendiente `report_draft` (vence a las 2 h; `cancelar` lo borra).
 *     El resumen lleva los botones *Sí, guardar* (id `sí`) y *Corregir* (id `corregir`: pide el cambio y sigue esperando).
 *  3. `sí` guarda: actividad (occurred_at = lo dicho o la hora del mensaje), oportunidad (la crea si no hay; la etapa solo
 *     avanza, con historial), próxima acción y contacto nuevo. `no` descarta. Otro texto corrige el borrador.
 *     La oportunidad solo se toca si el vendedor puede editar la empresa (canEditCompany, como `cita`/`contacto`); si no,
 *     se guarda solo la actividad (sin oportunidad ni contacto) y se le dice de quién es la empresa.
 *  4. Corrida J: empresa SIN dueño (vendedor): antes de guardar se ofrece *Asignármela y guardar todo* (`guardar todo`:
 *     la asigna de forma atómica —si otro vendedor la tomó un instante antes, se le dice y se guarda solo la nota— y guarda
 *     el reporte completo: oportunidad, contacto, etapa y próxima acción) o *Guardar solo la nota* (`solo la nota`).
 *  5. Corrida J: si la empresa no está en el padrón, "No encontré «X»" con *Crear empresa nueva* (`nueva empresa`: el alta
 *     sigue con este reporte, bot/commands/nueva-empresa.ts) y *Buscar otra vez*.
 *
 * Dependencias inyectables (tests y simulador) con configureReportBot: cliente de Anthropic, fetch de Deepgram, descarga
 * de medios y registro de mensajes. La descarga inyectada con configureReportBot manda sobre ctx.downloadMedia (el simulador no tiene Graph API).
 */
import { KNOWN_BRANDS } from "../../tyre/brands";
import { fixCatalogTerms } from "../voice/fuzzy";
import { getStore } from "../../store";
import type { MessageLogEntry } from "../../store/types";
import { GraphWhatsAppClient, graphConfigFromEnv } from "../../whatsapp/client";
import { applyCorrection, draftToRecords, formatDraftSummary, isConfirmation, isRejection, makeDraft, nextQuestion, type DraftField, type ReportDraft } from "../report/draft";
import { extractReport, type ExtractContext, type LlmClient } from "../report/extract";
import { displayName, matchCompanies, type CompanyRef } from "../report/match";
import { canEditCompany } from "../auth/permissions";
import { canAssignSelf } from "../ui/permissions";
import { stageIndex, stageLabel, type StageId } from "../stages";
import type { Company, PortalStore } from "../store/types";
import { formatLimaDateTime } from "../ui/time";
import { DEEPGRAM_MODEL, deepgramKeyFromEnv, transcribe, TranscriptionError, VoiceNotConfigured } from "../voice/deepgram";
import { audioDurationSec } from "../voice/duration";
import { audioBudget, limitsConfig, recordAudio, voiceDisabled } from "../../guard/usage";
import { buildKeyterms, parseLearnCommand } from "../voice/vocabulary";
import { findCompanies, mentionedCompanies, replyNotFound, SEARCH_AGAIN_RE, shortName } from "./companies";
import { askAgain } from "./pause";
import { companyProgressLine } from "./progress";
import { getPortalCommand, registerPausable, registerPendingHandler, registerPortalCommand, replyButtons, setDefaultReportHandler, type PortalContext, type ReportOptions } from "./registry";
import { fold } from "../../tyre/brands";
import { parsePortalCommand } from "./router";
import { clearPending, setPending, type ReportDraftStep } from "./state";

export const VOICE_OFF = "La voz aún no está activa. Escríbeme el reporte en texto, por favor.";
export const VOICE_FAILED = "No pude transcribir tu nota de voz. Escríbeme el reporte en texto, por favor.";
export const VOICE_EMPTY = "No te escuché bien (¿salió muy corta o en silencio?). Repítela, por favor, o escríbemelo.";
/** Transcripción de una o dos palabras sin nada que hacer con ella (corrida F, punto 4). */
export const VOICE_TOO_SHORT = "No te escuché bien: repítelo con un poco más de detalle, por favor (o escríbemelo).";
export const VOICE_DISABLED_REPLY = "La voz está apagada por ahora. Escríbeme el texto, por favor.";
export const VOICE_TOO_LONG = (maxSec: number) => `Tu nota de voz dura más de ${Math.round(maxSec / 60)} minutos y no la transcribo. Mándame una más corta o escríbeme el texto, por favor.`;
export const VOICE_DOWNLOAD_FAILED = "No pude descargar tu nota de voz de WhatsApp. Escríbeme el reporte en texto, por favor.";
export const REPORT_DISCARDED = "Listo, descarté el reporte. No guardé nada.";
/** Respuesta al botón *Corregir* (o a escribir `corregir`): el borrador sigue esperando. */
export const REPORT_CORRECT_PROMPT = "¿Qué corrijo? Escríbeme el cambio (p. ej. *fue con el gerente de flota* o *la próxima visita es el viernes 10am*), o *no* para descartar.";
/** Botones del resumen: id = el texto equivalente (`sí` guarda, `corregir` pide la corrección). */
export const REPORT_CONFIRM_BUTTONS = [
  { id: "sí", title: "Sí, guardar" },
  { id: "corregir", title: "Corregir" },
];
const CORRECT_WORD = /^(?:corregir|corrige|corrijo|corregirlo|quiero corregir)[.!]*$/i;
/**
 * Corrida J: empresa sin dueño. Botones (título ≤ 20 caracteres de WhatsApp; el texto del mensaje los nombra completos).
 * El id no empieza con "guardar": `guardar …` es el verbo de los procesos en pausa (routePortal lo atiende antes).
 */
export const OWNER_CHOICE_BUTTONS = [
  { id: "asignármela", title: "Asignar y guardar" },
  { id: "solo la nota", title: "Guardar solo la nota" },
];

type Download = (mediaId: string) => Promise<{ data: Buffer; mimeType: string; fileName?: string }>;

export interface ReportBotDeps {
  /** Cliente de Anthropic: undefined = el del repo (getAnthropic, null sin clave); null = solo reglas. */
  llm?: LlmClient | null;
  /** fetch para Deepgram (tests). */
  deepgramFetch?: typeof fetch;
  /** Descarga de medios cuando el enganche no la pasa (simulador: lee el archivo local). */
  downloadMedia?: Download;
  /** Registro en `messages` cuando el enganche no lo pasa. */
  logMessage?: (entry: MessageLogEntry) => Promise<void>;
}

let deps: ReportBotDeps = {};

/** Inyecta dependencias (tests, simulador); null vuelve a las de producción. */
export function configureReportBot(d: ReportBotDeps | null): void {
  deps = d ?? {};
}

let graph: GraphWhatsAppClient | null = null;

/** Descarga de medios del bot: la inyectada (simulador, tests), la del handler o la Graph API. También la usa `oc`. */
export function downloader(ctx: PortalContext): Download {
  if (deps.downloadMedia) return deps.downloadMedia; // inyectado (simulador, tests) manda sobre el cliente del handler
  if (ctx.downloadMedia) return (id) => ctx.downloadMedia!(id);
  return async (id) => {
    if (!graph) {
      const cfg = graphConfigFromEnv();
      if (!cfg) throw new Error("WhatsApp no configurado (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)");
      graph = new GraphWhatsAppClient(cfg);
    }
    return graph.downloadMedia(id);
  };
}

async function logMessage(ctx: PortalContext, entry: MessageLogEntry): Promise<void> {
  try {
    if (ctx.logMessage) await ctx.logMessage(entry);
    else if (deps.logMessage) await deps.logMessage(entry);
    else await (await getStore()).logMessage(entry);
  } catch (err) {
    ctx.log(`portal: no pude registrar la transcripción: ${(err as Error).message}`);
  }
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

// ── contexto del vendedor ──

/** Empresas del vendedor: las que tiene asignadas y las de sus oportunidades abiertas. */
export async function sellerCompanies(store: PortalStore, userId: number): Promise<CompanyRef[]> {
  const out = new Map<number, CompanyRef>();
  const owned = await store.searchCompanies({ ownerUserId: userId, pageSize: 500 });
  for (const c of owned.rows) out.set(c.id, { id: c.id, razonSocial: c.razonSocial, ruc: c.ruc });
  const opps = await store.listOpportunities({ ownerId: userId, open: true });
  for (const o of opps.slice(0, 200)) {
    if (out.has(o.companyId)) continue;
    const c = await store.getCompany(o.companyId);
    if (c) out.set(c.id, { id: c.id, razonSocial: c.razonSocial, ruc: c.ruc });
  }
  return [...out.values()];
}

async function extractContext(ctx: PortalContext, extra: CompanyRef[] = []): Promise<ExtractContext> {
  const companies = await sellerCompanies(ctx.store, ctx.user.id);
  for (const c of extra) if (!companies.some((x) => x.id === c.id)) companies.push(c);
  const vocabulary = (await ctx.store.listVocabulary()).map((v) => ({ term: v.term, meaning: v.meaning }));
  // marcas para registrar las que usa / quiere el cliente: las principales del catálogo y la lista general
  const catalog = ctx.voiceCatalog ? await ctx.voiceCatalog().catch(() => null) : null;
  const brands = [...new Set([...(catalog?.brands ?? []).slice(0, 80), ...KNOWN_BRANDS])];
  return { now: ctx.now, vendedor: { id: ctx.user.id, nombre: ctx.user.nombre }, companies, vocabulary, brands };
}

const ref = (c: Company): CompanyRef => ({ id: c.id, razonSocial: c.razonSocial, ruc: c.ruc });
const pick = (d: ReportDraft, c: CompanyRef): ReportDraft => ({ ...d, companyId: c.id, empresa: { nombre: c.razonSocial, ruc: c.ruc }, candidates: [c] });

/**
 * Empresa del borrador cuando no salió de la lista del vendedor: el texto contra su lista (reglas: varias = candidatas),
 * y si no, el padrón (el nombre que dio el modelo, o una razón social nombrada en el texto).
 */
async function resolveFromPadron(store: PortalStore, d: ReportDraft, text: string, companies: CompanyRef[]): Promise<ReportDraft> {
  if (d.companyId !== null || d.candidates.length > 0) return d;
  const mine = matchCompanies(text, companies);
  if (mine.length === 1) return pick(d, mine[0]);
  if (mine.length > 1) return { ...d, candidates: mine.slice(0, 5) };
  let found: Company[] = [];
  if (d.empresa?.nombre) found = (await findCompanies(store, d.empresa.ruc && /^\d{11}$/.test(d.empresa.ruc) ? d.empresa.ruc : d.empresa.nombre)).rows;
  if (!found.length) found = await mentionedCompanies(store, text).catch(() => []);
  if (found.length === 1) return pick(d, ref(found[0]));
  if (found.length > 1) return { ...d, candidates: found.slice(0, 5).map(ref) };
  return d;
}

// ── voz ──

/** Resultado de transcribir: el texto, o qué decirle al usuario (sin clave, no se pudo descargar, falló, vino vacío). */
export type VoiceResult = { ok: true; text: string } | { ok: false; reply: string };

/** Una sola transcripción por mensaje: routePortal transcribe primero (precedencia del punto 7) y el paso la reutiliza. */
const heard = new WeakMap<object, VoiceResult>();

/**
 * Descarga y transcribe la nota de voz del mensaje SIN responder nada (lo hace quien llama). Keyterms: empresas del
 * vendedor, vocabulario aprendido y, si el canal lo da, el catálogo de precios (marcas, diseños y medidas: punto 8).
 * Se guarda por mensaje: la segunda llamada con el mismo ctx.msg no vuelve a Deepgram.
 */
export async function fetchVoice(ctx: PortalContext, audio: { id: string; mimeType: string }): Promise<VoiceResult> {
  const hit = heard.get(ctx.msg);
  if (hit) return hit;
  const r = await fetchVoiceOnce(ctx, audio);
  heard.set(ctx.msg, r);
  return r;
}

/**
 * Corrida E: VOICE_DISABLED=1 apaga la voz al instante (sin descarga ni Deepgram). Tras descargar (gratis) y ANTES de
 * pagar Deepgram: la duración (OGG exacta; otros formatos, cota por bytes) contra limits.maxVoiceSeconds y contra los
 * minutos de voz del día (por usuario y global). Lo transcrito se registra con la duración que informa Deepgram.
 */
async function fetchVoiceOnce(ctx: PortalContext, audio: { id: string; mimeType: string }): Promise<VoiceResult> {
  if (voiceDisabled(ctx.env)) return { ok: false, reply: VOICE_DISABLED_REPLY };
  const apiKey = deepgramKeyFromEnv(ctx.env);
  if (!apiKey) return { ok: false, reply: VOICE_OFF };
  let media: { data: Buffer; mimeType: string };
  try {
    media = await downloader(ctx)(audio.id);
  } catch (err) {
    ctx.log(`portal: no pude descargar el audio ${audio.id}: ${(err as Error).message}`);
    return { ok: false, reply: VOICE_DOWNLOAD_FAILED };
  }
  const maxSec = limitsConfig().maxVoiceSeconds;
  const est = audioDurationSec(media.data, media.mimeType || audio.mimeType);
  if (est.seconds > maxSec) {
    ctx.log(`portal: nota de voz de ${Math.round(est.seconds)} s${est.exact ? "" : " (estimado por bytes)"} > ${maxSec} s: no se transcribe`);
    return { ok: false, reply: VOICE_TOO_LONG(maxSec) };
  }
  const capped = await audioBudget(est.seconds);
  if (capped) return { ok: false, reply: capped };
  const [companies, learned, catalog] = await Promise.all([
    sellerCompanies(ctx.store, ctx.user.id),
    ctx.store.listVocabulary(),
    ctx.voiceCatalog
      ? ctx.voiceCatalog().catch((err: Error) => {
          ctx.log(`portal: no pude leer el catálogo para la voz: ${err.message}`);
          return undefined;
        })
      : Promise.resolve(undefined),
  ]);
  const keyterms = buildKeyterms({ companies: companies.map((c) => c.razonSocial), learned, catalog });
  let text: string;
  try {
    const r = await transcribe(media.data, media.mimeType || audio.mimeType, { apiKey, keyterms, fetchImpl: deps.deepgramFetch });
    await recordAudio(r.durationSec || est.seconds, DEEPGRAM_MODEL);
    text = r.text.trim();
  } catch (err) {
    if (err instanceof VoiceNotConfigured) return { ok: false, reply: VOICE_OFF };
    ctx.log(`portal: transcripción fallida: ${(err as Error).message}`);
    return { ok: false, reply: err instanceof TranscriptionError && err.status === null && /vac[ií]o/.test(err.message) ? VOICE_EMPTY : VOICE_FAILED };
  }
  if (!text) return { ok: false, reply: VOICE_EMPTY };
  return { ok: true, text };
}

/** Guarda la transcripción en `messages` (kind "transcript"). */
export async function logTranscript(ctx: PortalContext, text: string): Promise<void> {
  await logMessage(ctx, { phone: ctx.from, direction: "in", kind: "transcript", body: text });
}

/** Transcribe la nota de voz del mensaje; null = ya se respondió el error (pedir texto). También la usan las preguntas de `oc`. */
export async function transcribeVoice(ctx: PortalContext, audio: { id: string; mimeType: string }): Promise<string | null> {
  const r = await fetchVoice(ctx, audio);
  if (!r.ok) {
    await ctx.reply(r.reply);
    return null;
  }
  await logTranscript(ctx, r.text);
  await ctx.reply(`🎙️ Entendí: «${clip(r.text, 400)}»`);
  return r.text;
}

// ── borrador ──

/** Corrida J: lo que acompaña al borrador en el paso (empresa no encontrada; elección con empresa sin dueño). */
interface DraftExtra {
  notFound?: string | null;
  ownerChoice?: boolean;
}

/** Guarda el borrador como paso pendiente y responde la siguiente pregunta o el resumen. */
async function showDraft(ctx: PortalContext, draft: ReportDraft, base: { text: string; occurredAt: string }, prefix = "", extra: DraftExtra = {}): Promise<void> {
  const q = extra.ownerChoice ? null : nextQuestion(draft);
  // la empresa que se buscó y no está en el padrón: se ofrece crearla (solo mientras se pregunta la empresa)
  const notFound = q?.field === "empresa" && draft.candidates.length <= 1 && extra.notFound?.trim() ? extra.notFound.trim() : null;
  const step: Omit<ReportDraftStep, "createdAt"> = {
    kind: "report_draft",
    text: base.text,
    occurredAt: base.occurredAt,
    audio: null,
    draft,
    field: q?.field ?? null,
    ...(notFound ? { notFound } : {}),
    ...(extra.ownerChoice ? { ownerChoice: true } : {}),
  };
  await setPending(ctx.store, ctx.from, step, ctx.now);
  const head = prefix ? `${prefix}\n\n` : "";
  if (q) {
    if (notFound) await replyNotFound(ctx, `${head}No encontré «${clip(notFound, 80)}» en el padrón. ${q.text}`);
    else await ctx.reply(`${head}${q.text}`);
    return;
  }
  const company = draft.companyId !== null ? await ctx.store.getCompany(draft.companyId) : null;
  if (extra.ownerChoice && company) {
    const body = `${head}*${displayName(company.razonSocial)}* no tiene dueño. ¿Qué guardo?\n• *Asignármela y guardar todo*: queda a tu nombre y guardo oportunidad, contacto, etapa y próxima acción.\n• *Guardar solo la nota*: solo la actividad; la empresa sigue libre.`;
    await replyButtons(ctx, body, OWNER_CHOICE_BUTTONS, { fallback: `${body}\n\nResponde *asignármela* o *solo la nota*.` });
    return;
  }
  const summary = `${head}${formatDraftSummary(draft, company)}`;
  await replyButtons(ctx, summary, REPORT_CONFIRM_BUTTONS, { fallback: summary });
}

/**
 * Corrida J: la empresa del reporte ya está (creada con `nueva empresa` o encontrada después de "Buscar otra vez"): el
 * borrador sigue con ella, sin perder lo dictado (resumen, o la siguiente pregunta).
 */
export async function continueReportWithCompany(ctx: PortalContext, step: ReportDraftStep, company: Company, prefix = ""): Promise<void> {
  if (!step.draft) return;
  const c = ref(company);
  const draft: ReportDraft = { ...pick(step.draft, c), answered: [...step.draft.answered.filter((f) => f !== "empresa"), "empresa"] };
  await showDraft(ctx, draft, { text: step.text, occurredAt: step.occurredAt }, prefix);
}

/** Reporte nuevo (texto o voz). */
export async function interpretReport(ctx: PortalContext, rawText: string, opts: ReportOptions): Promise<void> {
  let text = rawText.trim();
  let canal: "whatsapp" | "voz" = opts.voice ? "voz" : "whatsapp";
  if (opts.audio && !opts.voice) {
    const t = await transcribeVoice(ctx, opts.audio);
    if (t === null) return;
    // una nota de voz que empieza con un comando del portal ("asígname ZBUSS", "empresa zbuss") es ese comando
    const cmd = text ? null : parsePortalCommand(t.replace(/^[\s¿¡]+|[\s.!?¡¿]+$/g, ""));
    const handler = cmd ? getPortalCommand(cmd.name) : undefined;
    if (cmd && handler) {
      await handler(ctx, cmd.args);
      return;
    }
    text = text ? `${text}\n${t}` : t;
    canal = "voz";
  }
  if (!text) {
    await ctx.reply("Cuéntame el reporte: con qué empresa, si fue visita o llamada, con quién y qué quedó pendiente.");
    return;
  }
  // por voz: marcas y diseños mal oídos, por parecido contra el catálogo ("Fénix Suite" -> "Fenixway")
  if (canal === "voz" && ctx.voiceCatalog) {
    const catalog = await ctx.voiceCatalog().catch(() => null);
    if (catalog) text = fixCatalogTerms(text, { brands: catalog.brands, designs: catalog.designs }).text;
  }
  const ectx = await extractContext(ctx);
  const res = await extractReport(text, ectx, { client: deps.llm });
  if (res.usage) ctx.log(`portal: reporte por modelo (${res.usage.calls} llamada(s), ${res.usage.inputTokens} tokens de entrada, ${res.usage.outputTokens} de salida)`);
  if (res.llmError) ctx.log(`portal: el modelo no armó el reporte (${res.llmError}); uso reglas.${/^tope /.test(res.llmError) ? "" : " Revisa ANTHROPIC_API_KEY con: npm run llm:check"}`);
  let draft = makeDraft(res.report, { companies: ectx.companies, canal, texto: res.text, messageAt: opts.occurredAt, via: res.via });
  // con reglas la confianza siempre es baja: si el tipo se reconoció ("visité", "llamé") no se pregunta
  if ((res.via === "rules" && !res.report.faltantes.includes("tipo")) || res.tipoSeguro) draft.answered = draft.answered.includes("tipo") ? draft.answered : [...draft.answered, "tipo"];
  draft = await resolveFromPadron(ctx.store, draft, res.text, ectx.companies);
  // corrida J: nombró una empresa que no está en el padrón: se ofrece crearla
  const notFound = draft.companyId === null && draft.candidates.length === 0 ? (draft.empresa?.ruc || draft.empresa?.nombre || null) : null;
  await showDraft(ctx, draft, { text, occurredAt: opts.occurredAt.toISOString() }, "", { notFound });
}

/** Etapa a la que lleva el reporte: la sugerida; una visita hecha, al menos Visita realizada. */
export function targetStage(draft: Pick<ReportDraft, "tipo" | "etapaSugerida">): StageId | null {
  if (draft.tipo !== "visita") return draft.etapaSugerida;
  if (!draft.etapaSugerida || stageIndex(draft.etapaSugerida) < stageIndex("visita_realizada")) return "visita_realizada";
  return draft.etapaSugerida;
}

/** Guarda el borrador confirmado y responde qué se hizo. */
async function saveDraft(ctx: PortalContext, draft: ReportDraft, base: { text: string; occurredAt: string }): Promise<void> {
  const { store, user } = ctx;
  const company = draft.companyId !== null ? await store.getCompany(draft.companyId) : null;
  if (!company) {
    const again: ReportDraft = { ...draft, companyId: null, answered: draft.answered.filter((f) => f !== "empresa") };
    await showDraft(ctx, again, { text: draft.texto, occurredAt: draft.messageAt });
    return;
  }
  if (!canEditCompany(user, company)) {
    // corrida J: sin dueño, el vendedor elige entre asignársela y guardar todo, o solo la nota
    if (company.ownerUserId === null && canAssignSelf(user, company)) {
      await showDraft(ctx, draft, base, "", { ownerChoice: true });
      return;
    }
    await saveActivityOnly(ctx, draft, company, await store.listContacts(company.id));
    return;
  }
  await saveFull(ctx, draft, company);
}

/**
 * Corrida J: *Asignármela y guardar todo*. La asignación es atómica (setOwner solo si sigue sin dueño): si otro vendedor
 * la tomó un instante antes, se le dice y se guarda solo la nota; si no, la actividad de asignación y el reporte completo.
 */
async function claimAndSave(ctx: PortalContext, draft: ReportDraft, company: Company): Promise<void> {
  const { store, user, now } = ctx;
  const claimed = await store.setOwner(company.id, user.id, { onlyIfOwner: null });
  if (!claimed) {
    const fresh = (await store.getCompany(company.id)) ?? company;
    if (fresh.ownerUserId === user.id) {
      await saveFull(ctx, draft, fresh); // ya era suya (doble toque)
      return;
    }
    await saveActivityOnly(ctx, draft, fresh, await store.listContacts(fresh.id), await takenLead(ctx, fresh));
    return;
  }
  const opp = await store.getOpenOpportunity(company.id);
  if (opp && opp.ownerUserId !== user.id) await store.updateOpportunity(opp.id, { ownerUserId: user.id });
  // data.evento = "asignacion": hito de inicio para las métricas de tiempos (metrics/timeline.ts), como `asignarme`
  await store.addActivity({ companyId: company.id, opportunityId: opp?.id ?? null, userId: user.id, tipo: "nota", texto: `${user.nombre} se asignó la empresa (al reportar).`, canal: draft.canal === "voz" ? "voz" : "whatsapp", occurredAt: now, data: { evento: "asignacion", ownerUserId: user.id, previousOwnerUserId: null } });
  await saveFull(ctx, draft, claimed, ["• Empresa asignada a ti"]);
}

/** "⚠️ *X* acaba de quedar asignada a Juan: no pude asignártela." (otro vendedor la tomó mientras se elegía). */
async function takenLead(ctx: PortalContext, company: Company): Promise<string> {
  const owner = company.ownerUserId !== null ? await ctx.store.getUser(company.ownerUserId).catch(() => null) : null;
  return `⚠️ *${displayName(company.razonSocial)}* acaba de quedar asignada a ${owner?.nombre ?? "otro vendedor"}: no pude asignártela.`;
}

/** El reporte completo: actividad, oportunidad (nueva o la abierta, la etapa solo avanza), próxima acción y contacto. */
async function saveFull(ctx: PortalContext, draft: ReportDraft, company: Company, lead: string[] = []): Promise<void> {
  const { store, user, now } = ctx;
  const contacts = await store.listContacts(company.id);
  const opp = await store.getOpenOpportunity(company.id);
  const rec = draftToRecords({ ...draft, etapaSugerida: targetStage(draft) }, { userId: user.id, now, opportunity: opp, contacts });
  const lines: string[] = [...lead];
  let oppId = opp?.id ?? null;
  if (rec.newOpportunity) {
    // la abierta o una nueva en una sola operación: dos confirmaciones a la vez no dejan dos oportunidades
    const { opportunity: created, created: isNew } = await store.openOrCreateOpportunity({ ...rec.newOpportunity, ownerUserId: company.ownerUserId ?? user.id });
    oppId = created.id;
    if (isNew) lines.push(`• Oportunidad nueva en *${stageLabel(created.etapa)}*`);
  }
  if (rec.stageChange) {
    // el historial no puede entrar a la etapa antes de la entrada a la actual (reporte atrasado): entonces, ahora
    const hist = await store.stageHistory(rec.stageChange.opportunityId);
    const lastEntered = hist.length ? hist[hist.length - 1].enteredAt.getTime() : 0;
    const occurred = rec.activity.occurredAt.getTime();
    const at = occurred >= lastEntered && occurred <= now.getTime() ? rec.activity.occurredAt : now;
    await store.moveStage(rec.stageChange.opportunityId, rec.stageChange.to, user.id, at);
    lines.push(`• Etapa: ${stageLabel(rec.stageChange.from)} → *${stageLabel(rec.stageChange.to)}*`);
  } else if (opp) {
    lines.push(`• Etapa: ${stageLabel(opp.etapa)} (sin cambio)`);
  }
  if (rec.opportunityPatch) await store.updateOpportunity(rec.opportunityPatch.opportunityId, rec.opportunityPatch.patch);
  const { createdAt: _createdAt, ...activity } = rec.activity;
  await store.addActivity({ ...activity, opportunityId: oppId });
  if (rec.newContact) {
    const c = await store.addContact(rec.newContact);
    lines.push(`• Contacto nuevo: ${c.nombre}${c.cargo ? ` (${c.cargo})` : ""}`);
  }
  if (draft.proximaAccion) {
    const f = draft.proximaAccion.fecha ? new Date(draft.proximaAccion.fecha) : null;
    lines.push(`• Próxima acción: ${draft.proximaAccion.texto}${f && !Number.isNaN(f.getTime()) ? ` — ${formatLimaDateTime(f)}` : " _(sin fecha)_"}`);
  }
  await clearPending(store, ctx.from);
  const tipo = draft.tipo === "visita" ? "visita" : draft.tipo === "llamada" ? "llamada" : "nota";
  // una visita completa el paso 4 del proceso (línea de avance); una llamada o nota no completa ningún paso
  const progress = draft.tipo === "visita" ? await companyProgressLine(store, company, 4) : "";
  await ctx.reply(`✔ Guardado: ${tipo} — *${displayName(company.razonSocial)}* (${formatLimaDateTime(activity.occurredAt)}).${lines.length ? `\n${lines.join("\n")}` : ""}${progress ? `\n${progress}` : ""}`);
}

/** "La empresa es de Juan: …" / "La empresa no tiene dueño: …". */
async function ownerPhrase(store: PortalStore, company: Company): Promise<string> {
  const owner = company.ownerUserId !== null ? await store.getUser(company.ownerUserId).catch(() => null) : null;
  if (owner) return `La empresa es de ${owner.nombre}`;
  return company.ownerUserId === null ? `La empresa no tiene dueño (*asignarme ${company.ruc}* para tomarla)` : "La empresa es de otro vendedor";
}

/** Empresa que el vendedor no puede editar: solo la actividad (sin oportunidad); la oportunidad y los contactos no se tocan. */
async function saveActivityOnly(ctx: PortalContext, draft: ReportDraft, company: Company, contacts: Awaited<ReturnType<PortalStore["listContacts"]>>, lead = ""): Promise<void> {
  const { store, user, now } = ctx;
  const rec = draftToRecords({ ...draft, etapaSugerida: null }, { userId: user.id, now, opportunity: null, contacts });
  const { createdAt: _createdAt, ...activity } = rec.activity;
  await store.addActivity({ ...activity, opportunityId: null });
  await clearPending(store, ctx.from);
  const tipo = draft.tipo === "visita" ? "visita" : draft.tipo === "llamada" ? "llamada" : "nota";
  const extra = rec.newContact ? `\n_El contacto ${rec.newContact.nombre} queda en el texto del reporte; agregarlo es del dueño._` : "";
  const why = lead ? `${lead} Guardé solo la actividad, sin oportunidad ni contacto.` : `${await ownerPhrase(store, company)}: guardé la actividad sin mover su oportunidad.`;
  await ctx.reply(`✔ Guardado: ${tipo} — *${displayName(company.razonSocial)}* (${formatLimaDateTime(activity.occurredAt)}).\n${why}${extra}`);
}

/** Respuesta al borrador: sí / no / respuesta a la pregunta / corrección (también por voz). */
registerPendingHandler("report_draft", async (ctx, step, rawText) => {
  const s = step as ReportDraftStep;
  if (!s.draft) {
    // paso del marcador anterior: se interpreta el texto guardado
    await clearPending(ctx.store, ctx.from);
    await interpretReport(ctx, s.text, { occurredAt: new Date(s.occurredAt), audio: s.audio ?? null });
    return true;
  }
  let text = rawText.trim();
  if (ctx.msg.type === "audio" && ctx.msg.media) {
    const t = await transcribeVoice(ctx, { id: ctx.msg.media.id, mimeType: ctx.msg.media.mimeType });
    if (t === null) return true; // el borrador sigue esperando
    text = t;
  }
  if (!text) return false;
  const draft = s.draft;
  const field = s.field ?? null;
  const base = { text: s.text, occurredAt: s.occurredAt };
  if (isRejection(text)) {
    await clearPending(ctx.store, ctx.from);
    await ctx.reply(REPORT_DISCARDED);
    return true;
  }
  // corrida J: empresa sin dueño, *Asignármela y guardar todo* o *Guardar solo la nota*
  if (s.ownerChoice) return answerOwnerChoice(ctx, s, text);
  if (field === "empresa") {
    // corrida J: *Crear empresa nueva* dictado o escrito dentro de la respuesta (el comando sigue con este reporte)
    const cmd = parsePortalCommand(text.replace(/^[\s¿¡]+|[\s.!?¡¿]+$/g, ""));
    const create = cmd?.name === "nueva_empresa" ? getPortalCommand("nueva_empresa") : undefined;
    if (cmd && create) {
      await create(ctx, cmd.args);
      return true;
    }
    if (SEARCH_AGAIN_RE.test(text.trim())) {
      await showDraft(ctx, draft, base);
      return true;
    }
  }
  if (CORRECT_WORD.test(text.trim())) {
    await ctx.reply(field ? `${nextQuestion(draft)?.text ?? REPORT_CORRECT_PROMPT}` : REPORT_CORRECT_PROMPT);
    return true;
  }
  if (isConfirmation(text)) {
    if (field) {
      await ctx.reply(`${nextQuestion(draft)?.text ?? "Falta un dato."}\n_(o *cancelar* para descartar el reporte)_`);
      return true;
    }
    await saveDraft(ctx, draft, base);
    return true;
  }
  const ectx = await extractContext(ctx, draft.candidates);
  let next = await applyCorrection(draft, text, { ctx: ectx, deps: { client: deps.llm }, field });
  if (field === "empresa" && next.companyId === null) {
    // la respuesta puede ser una empresa del padrón que no está en la lista del vendedor
    const { rows, total } = await findCompanies(ctx.store, text);
    if (rows.length === 1 && total === 1) next = { ...pick(next, ref(rows[0])), answered: [...next.answered.filter((f) => f !== "empresa"), "empresa"] };
    else if (rows.length > 1) next = { ...next, candidates: rows.slice(0, 5).map(ref) };
  }
  // corrida J: tampoco está en el padrón: se ofrece crearla (o buscar otra vez)
  const notFound = field === "empresa" && next.companyId === null && next.candidates.length <= 1 ? text : null;
  await showDraft(ctx, next, base, "", { notFound });
  return true;
});

const OWNER_ALL = /\b(?:asign\w*|todo|tomarla|tomo|completo)\b/;
const OWNER_NOTE = /\bnota\b|\bsolo\s+(?:la\s+)?actividad\b/;

/** Respuesta a la elección con empresa sin dueño (botón, escrito o dictado). */
async function answerOwnerChoice(ctx: PortalContext, s: ReportDraftStep, text: string): Promise<boolean> {
  const draft = s.draft!;
  const company = draft.companyId !== null ? await ctx.store.getCompany(draft.companyId) : null;
  const base = { text: s.text, occurredAt: s.occurredAt };
  if (!company) {
    await showDraft(ctx, { ...draft, companyId: null, answered: draft.answered.filter((f) => f !== "empresa") }, base);
    return true;
  }
  const t = fold(text);
  const note = OWNER_NOTE.test(t);
  const all = !note && OWNER_ALL.test(t);
  if (!note && !all) {
    if (CORRECT_WORD.test(text.trim())) {
      await showDraft(ctx, draft, base);
      return true;
    }
    // otra cosa (un reporte nuevo, una cotización): no es la respuesta; routePortal la clasifica y esto queda en pausa
    if (!isConfirmation(text) && t.split(" ").filter(Boolean).length > 3) return false;
    await showDraft(ctx, draft, base, isConfirmation(text) ? "" : `No entendí «${clip(text, 60)}».`, { ownerChoice: true });
    return true;
  }
  if (company.ownerUserId !== null || !canAssignSelf(ctx.user, company)) {
    // cambió mientras elegía (se ofreció porque no tenía dueño): si ya puede editarla, todo; si otro la tomó, se dice y la nota
    if (canEditCompany(ctx.user, company)) await saveFull(ctx, draft, company);
    else await saveActivityOnly(ctx, draft, company, await ctx.store.listContacts(company.id), await takenLead(ctx, company));
    return true;
  }
  if (note) await saveActivityOnly(ctx, draft, company, await ctx.store.listContacts(company.id));
  else await claimAndSave(ctx, draft, company);
  return true;
}

/** Qué le falta al borrador, para el recordatorio de la pausa. */
const FIELD_MISSING: Record<DraftField, string> = { empresa: "falta la empresa", tipo: "falta si fue visita, llamada o nota", "proximaAccion.fecha": "falta la fecha de la próxima acción" };

/** En pausa (corrida D, puntos 4 y 7): "reporte de visita de ZBUSS (falta confirmar)"; con el resumen mostrado, *Sí, guardar*. */
registerPausable("report_draft", {
  async describe(ctx, step) {
    const s = step as ReportDraftStep;
    if (!s.draft) return { companyId: null, label: `reporte «${clip(s.text || "nota de voz", 40)}»`, missing: "falta interpretarlo" };
    const d = s.draft;
    const company = d.companyId !== null ? await ctx.store.getCompany(d.companyId).catch(() => null) : null;
    const tipo = d.tipo === "visita" ? "de visita" : d.tipo === "llamada" ? "de llamada" : d.tipo === "nota" ? "(nota)" : "";
    const label = `reporte ${tipo}${company ? ` de ${shortName(company.razonSocial)}` : ""}`.replace(/\s+/g, " ").trim();
    const field = s.field ?? null;
    if (s.ownerChoice) return { companyId: company?.id ?? null, label, missing: "falta elegir: asignártela y guardar todo, o solo la nota" };
    return { companyId: company?.id ?? null, label, missing: field ? FIELD_MISSING[field] : "falta confirmar", ...(field ? {} : { confirm: true }) };
  },
  async resume(ctx, step, prefix) {
    const s = step as ReportDraftStep;
    if (!s.draft) {
      await askAgain(ctx, step, prefix, "Respóndeme *sí* para interpretarlo, o *cancelar*.");
      return;
    }
    await showDraft(ctx, s.draft, { text: s.text, occurredAt: s.occurredAt }, prefix, { notFound: s.notFound ?? null, ownerChoice: !!s.ownerChoice });
  },
});

setDefaultReportHandler(interpretReport);

// ── aprende ──

registerPortalCommand("aprende", async (ctx, args) => {
  const parsed = parseLearnCommand(`aprende ${args}`);
  if (!parsed) {
    await ctx.reply("Escríbelo así: *aprende flama setenta y siete = Flama 77*");
    return;
  }
  await ctx.store.addVocabulary({ term: parsed.term, meaning: parsed.meaning, addedBy: ctx.user.id });
  await ctx.reply(`Aprendido: ${parsed.term} = ${parsed.meaning}`);
});
