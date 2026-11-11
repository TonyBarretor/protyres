/**
 * Reportes de visita / llamada / nota por WhatsApp (texto o nota de voz) y `aprende X = Y` (bloque B3).
 *
 *  1. Voz: descarga el audio (Graph API, o lo que se inyecte), lo transcribe con Deepgram Nova-3 con las empresas del
 *     vendedor y el vocabulario aprendido como keyterms, guarda la transcripción en `messages` (kind "transcript") y
 *     responde "🎙️ Entendí: «…»". Sin DEEPGRAM_API_KEY: la voz aún no está activa, pide texto.
 *  2. Interpreta el texto (Anthropic, o reglas sin clave) y arma un borrador. Si falta algo (empresa, tipo con confianza
 *     baja, fecha de la próxima acción) pregunta UNA cosa a la vez; si no, muestra el resumen y espera confirmación.
 *     El borrador vive en el paso pendiente `report_draft` (vence a las 2 h; `cancelar` lo borra).
 *  3. `sí` guarda: actividad (occurred_at = lo dicho o la hora del mensaje), oportunidad (la crea si no hay; la etapa solo
 *     avanza, con historial), próxima acción y contacto nuevo. `no` descarta. Otro texto corrige el borrador.
 *
 * Dependencias inyectables (tests y simulador) con configureReportBot: cliente de Anthropic, fetch de Deepgram, descarga
 * de medios y registro de mensajes. La descarga inyectada con configureReportBot manda sobre ctx.downloadMedia (el simulador no tiene Graph API).
 */
import { getStore } from "../../store";
import type { MessageLogEntry } from "../../store/types";
import { GraphWhatsAppClient, graphConfigFromEnv } from "../../whatsapp/client";
import { applyCorrection, draftToRecords, formatDraftSummary, isConfirmation, isRejection, makeDraft, nextQuestion, type DraftField, type ReportDraft } from "../report/draft";
import { extractReport, type ExtractContext, type LlmClient } from "../report/extract";
import { displayName, matchCompanies, type CompanyRef } from "../report/match";
import { stageIndex, stageLabel, type StageId } from "../stages";
import type { Company, PortalStore } from "../store/types";
import { formatLimaDateTime } from "../ui/time";
import { deepgramKeyFromEnv, transcribe, TranscriptionError, VoiceNotConfigured } from "../voice/deepgram";
import { buildKeyterms, parseLearnCommand } from "../voice/vocabulary";
import { findCompanies, mentionedCompanies } from "./companies";
import { registerPendingHandler, registerPortalCommand, setDefaultReportHandler, type PortalContext, type ReportOptions } from "./registry";
import { clearPending, setPending, type ReportDraftStep } from "./state";

export const VOICE_OFF = "La voz aún no está activa. Escríbeme el reporte en texto, por favor.";
export const VOICE_FAILED = "No pude transcribir tu nota de voz. Escríbeme el reporte en texto, por favor.";
export const VOICE_EMPTY = "No entendí nada en la nota de voz (¿salió en silencio?). Escríbeme el reporte en texto, por favor.";
export const VOICE_DOWNLOAD_FAILED = "No pude descargar tu nota de voz de WhatsApp. Escríbeme el reporte en texto, por favor.";
export const REPORT_DISCARDED = "Listo, descarté el reporte. No guardé nada.";

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
  return { now: ctx.now, vendedor: { id: ctx.user.id, nombre: ctx.user.nombre }, companies, vocabulary };
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

/** Transcribe la nota de voz del mensaje; null = ya se respondió el error (pedir texto). También la usan las preguntas de `oc`. */
export async function transcribeVoice(ctx: PortalContext, audio: { id: string; mimeType: string }): Promise<string | null> {
  const apiKey = deepgramKeyFromEnv(ctx.env);
  if (!apiKey) {
    await ctx.reply(VOICE_OFF);
    return null;
  }
  let media: { data: Buffer; mimeType: string };
  try {
    media = await downloader(ctx)(audio.id);
  } catch (err) {
    ctx.log(`portal: no pude descargar el audio ${audio.id}: ${(err as Error).message}`);
    await ctx.reply(VOICE_DOWNLOAD_FAILED);
    return null;
  }
  const [companies, learned] = await Promise.all([sellerCompanies(ctx.store, ctx.user.id), ctx.store.listVocabulary()]);
  const keyterms = buildKeyterms({ companies: companies.map((c) => c.razonSocial), learned });
  let text: string;
  try {
    const r = await transcribe(media.data, media.mimeType || audio.mimeType, { apiKey, keyterms, fetchImpl: deps.deepgramFetch });
    text = r.text.trim();
  } catch (err) {
    if (err instanceof VoiceNotConfigured) {
      await ctx.reply(VOICE_OFF);
      return null;
    }
    ctx.log(`portal: transcripción fallida: ${(err as Error).message}`);
    await ctx.reply(err instanceof TranscriptionError && err.status === null && /vac[ií]o/.test(err.message) ? VOICE_EMPTY : VOICE_FAILED);
    return null;
  }
  if (!text) {
    await ctx.reply(VOICE_EMPTY);
    return null;
  }
  await logMessage(ctx, { phone: ctx.from, direction: "in", kind: "transcript", body: text });
  await ctx.reply(`🎙️ Entendí: «${clip(text, 400)}»`);
  return text;
}

// ── borrador ──

/** Guarda el borrador como paso pendiente y responde la siguiente pregunta o el resumen. */
async function showDraft(ctx: PortalContext, draft: ReportDraft, base: { text: string; occurredAt: string }): Promise<void> {
  const q = nextQuestion(draft);
  const step: Omit<ReportDraftStep, "createdAt"> = { kind: "report_draft", text: base.text, occurredAt: base.occurredAt, audio: null, draft, field: q?.field ?? null };
  await setPending(ctx.store, ctx.from, step, ctx.now);
  if (q) {
    await ctx.reply(q.text);
    return;
  }
  const company = draft.companyId !== null ? await ctx.store.getCompany(draft.companyId) : null;
  await ctx.reply(formatDraftSummary(draft, company));
}

/** Reporte nuevo (texto o voz). */
export async function interpretReport(ctx: PortalContext, rawText: string, opts: ReportOptions): Promise<void> {
  let text = rawText.trim();
  let canal: "whatsapp" | "voz" = "whatsapp";
  if (opts.audio) {
    const t = await transcribeVoice(ctx, opts.audio);
    if (t === null) return;
    text = text ? `${text}\n${t}` : t;
    canal = "voz";
  }
  if (!text) {
    await ctx.reply("Cuéntame el reporte: con qué empresa, si fue visita o llamada, con quién y qué quedó pendiente.");
    return;
  }
  const ectx = await extractContext(ctx);
  const res = await extractReport(text, ectx, { client: deps.llm });
  let draft = makeDraft(res.report, { companies: ectx.companies, canal, texto: res.text, messageAt: opts.occurredAt, via: res.via });
  // con reglas la confianza siempre es baja: si el tipo se reconoció ("visité", "llamé") no se pregunta
  if (res.via === "rules" && !res.report.faltantes.includes("tipo")) draft.answered = [...draft.answered, "tipo"];
  draft = await resolveFromPadron(ctx.store, draft, res.text, ectx.companies);
  await showDraft(ctx, draft, { text, occurredAt: opts.occurredAt.toISOString() });
}

/** Etapa a la que lleva el reporte: la sugerida; una visita hecha, al menos Visita realizada. */
export function targetStage(draft: Pick<ReportDraft, "tipo" | "etapaSugerida">): StageId | null {
  if (draft.tipo !== "visita") return draft.etapaSugerida;
  if (!draft.etapaSugerida || stageIndex(draft.etapaSugerida) < stageIndex("visita_realizada")) return "visita_realizada";
  return draft.etapaSugerida;
}

/** Guarda el borrador confirmado y responde qué se hizo. */
async function saveDraft(ctx: PortalContext, draft: ReportDraft): Promise<void> {
  const { store, user, now } = ctx;
  const company = draft.companyId !== null ? await store.getCompany(draft.companyId) : null;
  if (!company) {
    const again: ReportDraft = { ...draft, companyId: null, answered: draft.answered.filter((f) => f !== "empresa") };
    await showDraft(ctx, again, { text: draft.texto, occurredAt: draft.messageAt });
    return;
  }
  const opp = await store.getOpenOpportunity(company.id);
  const contacts = await store.listContacts(company.id);
  const rec = draftToRecords({ ...draft, etapaSugerida: targetStage(draft) }, { userId: user.id, now, opportunity: opp, contacts });
  const lines: string[] = [];
  let oppId = opp?.id ?? null;
  if (rec.newOpportunity) {
    const created = await store.createOpportunity({ ...rec.newOpportunity, ownerUserId: company.ownerUserId ?? user.id });
    oppId = created.id;
    lines.push(`• Oportunidad nueva en *${stageLabel(created.etapa)}*`);
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
  await ctx.reply(`✔ Guardado: ${tipo} — *${displayName(company.razonSocial)}* (${formatLimaDateTime(activity.occurredAt)}).${lines.length ? `\n${lines.join("\n")}` : ""}`);
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
  if (isRejection(text)) {
    await clearPending(ctx.store, ctx.from);
    await ctx.reply(REPORT_DISCARDED);
    return true;
  }
  if (isConfirmation(text)) {
    if (field) {
      await ctx.reply(`${nextQuestion(draft)?.text ?? "Falta un dato."}\n_(o *cancelar* para descartar el reporte)_`);
      return true;
    }
    await saveDraft(ctx, draft);
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
  await showDraft(ctx, next, { text: s.text, occurredAt: s.occurredAt });
  return true;
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
