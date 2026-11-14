/**
 * Punto único medido de los servicios pagados (corrida E): toda llamada al modelo de lenguaje (structuredCall en
 * llm/client.ts y callTool en portal/report/extract.ts) y a Deepgram (portal/bot/report.ts) pasa por aquí para
 *   1. comprobar los topes del día ANTES de llamar (config/portal.json, `limits`): por usuario y del bot entero;
 *   2. registrar el uso real (tokens de `res.usage`; segundos de `metadata.duration`) con su costo estimado.
 *
 * Quién provoca el gasto sale del contexto (AsyncLocalStorage) que BotHandler.handle fija con el teléfono del mensaje,
 * así no hay que pasar parámetros por todo el cotizador. Fuera de un mensaje (sincronización de Drive, CLI) el usuario
 * es "sistema" y solo cuentan los topes globales; el registro va al store por defecto (setDefaultUsageSink, lo fija
 * getStore()), y sin él (pruebas que no lo piden) no se registra ni se limita nada.
 *
 * Al superar un tope: no se llama al servicio (UsageCapExceeded, que quien llama ya trata como "sin modelo" y sigue con
 * reglas), el usuario recibe UNA línea al final de la respuesta y el administrador un aviso UNA vez por día y por tope.
 * Los interruptores por variable de entorno se leen en cada llamada (efecto inmediato): LLM_DISABLED=1 (llm/client.ts),
 * VOICE_DISABLED=1 (voiceDisabled) y QUOTE_LLM_MODE (llm/client.ts quoteLlmMode).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { loadPortalConfig, type PortalLimitsConfig } from "../portal/config";
import { limaDateKey, limaStartOfDay } from "../portal/ui/time";
import type { UsageEntry, UsageSummaryRow } from "../store/types";

/** Propósitos medidos; el resto del código puede añadir los suyos (texto libre en la tabla). */
export type UsagePurpose = "reporte" | "cotizador_pedido" | "cotizador_imagen" | "lista_precios" | "voz" | (string & {});

export const SYSTEM_USER = "sistema";

/** Lo que el medidor necesita del store (PriceStore lo cumple). */
export interface UsageSink {
  recordUsage(entry: UsageEntry): Promise<void>;
  usageSummary(since: Date): Promise<UsageSummaryRow[]>;
  /** Marca "una vez" (false si ya estaba): aviso al administrador una vez por día y por tope. */
  markProcessed(key: string): Promise<boolean>;
}

export interface UsageContext {
  /** Teléfono (solo dígitos) de quien provoca el gasto. */
  phone: string;
  sink?: UsageSink;
  /** Líneas para el usuario al final de la respuesta (una por motivo). */
  notices: Set<string>;
  /** Manda un texto al administrador (WhatsApp del handler). */
  notifyAdmin?: (text: string) => Promise<void>;
  log?: (msg: string) => void;
  now?: () => Date;
}

const als = new AsyncLocalStorage<UsageContext>();

/** Corre `fn` con este contexto de uso (BotHandler.handle). */
export function runWithUsage<T>(ctx: UsageContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

export function currentUsage(): UsageContext | undefined {
  return als.getStore();
}

let defaultSink: UsageSink | null = null;

/** Store para el uso fuera de un mensaje ("sistema"); getStore() lo fija. null lo quita (pruebas). */
export function setDefaultUsageSink(sink: UsageSink | null): void {
  defaultSink = sink;
}

// ── eventos (simulador: contadores por mensaje) ──

export type UsageEvent =
  | { kind: "llm"; purpose: string; phone: string; model: string; inputTokens: number; outputTokens: number; costUsd: number }
  | { kind: "audio"; purpose: string; phone: string; model: string; seconds: number; costUsd: number }
  | { kind: "blocked"; purpose: string; phone: string; cap: string };

const listeners = new Set<(e: UsageEvent) => void>();

/** Escucha cada llamada medida (y cada una bloqueada por tope). Devuelve la función para dejar de escuchar. */
export function onUsageEvent(fn: (e: UsageEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(e: UsageEvent): void {
  for (const fn of listeners) {
    try {
      fn(e);
    } catch {
      // un oyente roto no detiene el bot
    }
  }
}

// ── configuración ──

let limitsOverride: PortalLimitsConfig | null = null;

export function limitsConfig(): PortalLimitsConfig {
  return limitsOverride ?? loadPortalConfig().limits;
}

/** Pruebas: topes propios (null vuelve a config/portal.json). */
export function __setLimitsForTests(cfg: PortalLimitsConfig | null): void {
  limitsOverride = cfg;
}

/** VOICE_DISABLED=1: la voz está apagada (sin descarga ni Deepgram). Se lee en cada llamada. */
export function voiceDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.VOICE_DISABLED === "1";
}

/** max_tokens de salida para un propósito (config `limits.maxTokens`), o `fallback`. */
export function maxTokensFor(purpose: UsagePurpose, fallback = 4096): number {
  return limitsConfig().maxTokens[purpose] ?? fallback;
}

/** Costo estimado de una llamada al modelo (USD): precio del primer prefijo de `limits.prices.models` que coincide. */
export function llmCost(model: string, inputTokens: number, outputTokens: number, cfg: PortalLimitsConfig = limitsConfig()): number {
  const models = cfg.prices.models;
  const key = Object.keys(models)
    .filter((k) => k !== "default" && model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  const p = (key ? models[key] : models.default) ?? { inputPerMTok: 3, outputPerMTok: 15 };
  return (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;
}

/** Costo estimado de una transcripción (USD). */
export function audioCost(seconds: number, cfg: PortalLimitsConfig = limitsConfig()): number {
  return (seconds / 60) * cfg.prices.deepgramPerMinute;
}

// ── textos ──

export const LLM_CAP_NOTICE = "⚠️ Hoy se alcanzó el tope de uso del asistente: respondí solo con reglas.";
export const VOICE_CAP_REPLY = "⚠️ Hoy se alcanzó el tope de minutos de voz. Escríbeme el texto, por favor.";
export const CLIP_NOTICE = (max: number) => `✂️ Tu mensaje era muy largo: leí solo los primeros ${max.toLocaleString("es-PE")} caracteres.`;

// ── topes ──

/** Un tope superado. `scope` usuario o global; `metric` llamadas, tokens o minutos de audio. */
export interface CapHit {
  scope: "usuario" | "global";
  metric: "llmCalls" | "llmTokens" | "audioMinutes";
  limit: number;
  used: number;
}

/** Se superó un tope: no se llamó al servicio. Quien llama lo trata como "sin modelo" (reglas). */
export class UsageCapExceeded extends Error {
  readonly code = "USAGE_CAP_EXCEEDED";
  constructor(readonly cap: CapHit) {
    super(`tope ${cap.scope} de ${METRIC_LABEL[cap.metric]} alcanzado (${fmtNum(cap.used)} de ${fmtNum(cap.limit)} hoy)`);
    this.name = "UsageCapExceeded";
  }
}

const METRIC_LABEL: Record<CapHit["metric"], string> = { llmCalls: "llamadas al modelo", llmTokens: "tokens del modelo", audioMinutes: "minutos de voz" };
const fmtNum = (n: number) => (Number.isInteger(n) ? n.toLocaleString("es-PE") : n.toFixed(1));

/** Totales de un conjunto de filas del resumen. */
export function totals(rows: UsageSummaryRow[]): { llmCalls: number; llmTokens: number; audioMinutes: number; costUsd: number } {
  let llmCalls = 0;
  let llmTokens = 0;
  let audioSeconds = 0;
  let costUsd = 0;
  for (const r of rows) {
    llmCalls += r.llmCalls;
    llmTokens += r.inputTokens + r.outputTokens;
    audioSeconds += r.audioSeconds;
    costUsd += r.costUsd;
  }
  return { llmCalls, llmTokens, audioMinutes: audioSeconds / 60, costUsd };
}

/**
 * Pura: el primer tope que se superaría con `next` (una llamada más, o tantos minutos de audio), o null.
 * Los topes por usuario no aplican a "sistema" (solo los globales).
 */
export function findCap(rows: UsageSummaryRow[], phone: string, next: { llmCall?: boolean; audioMinutes?: number }, cfg: PortalLimitsConfig): CapHit | null {
  const scopes: { scope: CapHit["scope"]; caps: PortalLimitsConfig["perUserDaily"]; rows: UsageSummaryRow[] }[] = [];
  if (phone !== SYSTEM_USER) scopes.push({ scope: "usuario", caps: cfg.perUserDaily, rows: rows.filter((r) => r.phone === phone) });
  scopes.push({ scope: "global", caps: cfg.globalDaily, rows });
  for (const s of scopes) {
    const t = totals(s.rows);
    if (next.llmCall) {
      if (t.llmCalls + 1 > s.caps.llmCalls) return { scope: s.scope, metric: "llmCalls", limit: s.caps.llmCalls, used: t.llmCalls };
      // tokens: se bloquea cuando ya se llegó al tope (el costo de la próxima llamada no se sabe antes)
      if (t.llmTokens >= s.caps.llmTokens) return { scope: s.scope, metric: "llmTokens", limit: s.caps.llmTokens, used: t.llmTokens };
    }
    if (next.audioMinutes !== undefined && t.audioMinutes + next.audioMinutes > s.caps.audioMinutes) return { scope: s.scope, metric: "audioMinutes", limit: s.caps.audioMinutes, used: t.audioMinutes };
  }
  return null;
}

function resolve(): { ctx: UsageContext | undefined; phone: string; sink: UsageSink | null; now: Date } {
  const ctx = als.getStore();
  return { ctx, phone: ctx?.phone || SYSTEM_USER, sink: ctx?.sink ?? defaultSink, now: ctx?.now?.() ?? new Date() };
}

function adminNumber(env: Record<string, string | undefined> = process.env): string | null {
  for (const v of [env.PORTAL_ADMIN_NUMBER, env.ADMIN_NUMBERS]) {
    const first = (v ?? "")
      .split(",")
      .map((s) => s.replace(/\D/g, ""))
      .find(Boolean);
    if (first) return first;
  }
  return null;
}

/** Tope superado: línea al usuario (si `notice`), aviso al administrador una vez por día y por tope, evento y log. */
async function capReached(purpose: string, cap: CapHit, notice: string | null): Promise<void> {
  const { ctx, phone, sink, now } = resolve();
  emit({ kind: "blocked", purpose, phone, cap: `${cap.scope}:${cap.metric}` });
  const why = new UsageCapExceeded(cap).message;
  ctx?.log?.(`consumo: ${why}; no se llamó al servicio (${purpose}, ${phone})`);
  if (notice) ctx?.notices.add(notice);
  const admin = adminNumber();
  if (!sink || !ctx?.notifyAdmin || !admin) return;
  const who = cap.scope === "usuario" ? phone : "global";
  try {
    if (!(await sink.markProcessed(`guard:tope:${cap.scope}:${cap.metric}:${who}:${limaDateKey(now)}`))) return;
    const quien = cap.scope === "usuario" ? `del usuario ${phone}` : "del bot (global)";
    await ctx.notifyAdmin(
      `⚠️ *Tope de consumo alcanzado* ${quien}: ${METRIC_LABEL[cap.metric]} ${fmtNum(cap.used)} de ${fmtNum(cap.limit)} hoy. ${cap.metric === "audioMinutes" ? "La voz queda apagada" : "El bot sigue solo con reglas"} hasta mañana. Detalle: npm run llm:usage o el tablero.`,
    );
  } catch (err) {
    ctx.log?.(`consumo: no pude avisar al administrador: ${(err as Error).message}`);
  }
}

/** Lee el uso de hoy (Lima) del sink; sin sink, null (no se limita). */
async function todayRows(sink: UsageSink | null, now: Date): Promise<UsageSummaryRow[] | null> {
  if (!sink) return null;
  return sink.usageSummary(limaStartOfDay(now));
}

/**
 * ¿Se puede llamar al modelo para `purpose`? false si un tope del día lo impide (y entonces ya se avisó: línea al
 * usuario, administrador). Para no descargar un archivo que luego no se va a leer (startRequestFromMedia).
 */
export async function modelBudgetOk(purpose: UsagePurpose): Promise<boolean> {
  const { phone, sink, now } = resolve();
  const rows = await todayRows(sink, now).catch(() => null);
  const cap = rows ? findCap(rows, phone, { llmCall: true }, limitsConfig()) : null;
  if (!cap) return true;
  await capReached(purpose, cap, LLM_CAP_NOTICE);
  return false;
}

interface ModelResponse {
  usage?: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | null;
}

/**
 * Llama al modelo a través del medidor: comprueba los topes (UsageCapExceeded si no se puede, sin llamar) y registra
 * los tokens reales de la respuesta con su costo.
 */
export async function meteredModelCall<R extends ModelResponse>(purpose: UsagePurpose, model: string, call: () => Promise<R>): Promise<R> {
  const { phone, sink, now } = resolve();
  const cfg = limitsConfig();
  const rows = await todayRows(sink, now).catch(() => null);
  const cap = rows ? findCap(rows, phone, { llmCall: true }, cfg) : null;
  if (cap) {
    await capReached(purpose, cap, LLM_CAP_NOTICE);
    throw new UsageCapExceeded(cap);
  }
  const res = await call();
  const u = res.usage ?? {};
  const inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const outputTokens = u.output_tokens ?? 0;
  const costUsd = llmCost(model, inputTokens, outputTokens, cfg);
  emit({ kind: "llm", purpose, phone, model, inputTokens, outputTokens, costUsd });
  if (sink) {
    await sink.recordUsage({ phone, purpose, model, inputTokens, outputTokens, costUsd, at: now }).catch((err: Error) => resolve().ctx?.log?.(`consumo: no pude registrar el uso: ${err.message}`));
  }
  return res;
}

/**
 * ¿Se puede transcribir una nota de `seconds` segundos? null = sí; si no, el texto fijo para el usuario (y ya se avisó
 * al administrador).
 */
export async function audioBudget(seconds: number): Promise<string | null> {
  const { phone, sink, now } = resolve();
  const rows = await todayRows(sink, now).catch(() => null);
  const cap = rows ? findCap(rows, phone, { audioMinutes: seconds / 60 }, limitsConfig()) : null;
  if (!cap) return null;
  await capReached("voz", cap, null);
  return VOICE_CAP_REPLY;
}

/** Registra una transcripción (segundos que informó Deepgram, o la estimación si no los dio). */
export async function recordAudio(seconds: number, model: string): Promise<void> {
  const { phone, sink, now, ctx } = resolve();
  const costUsd = audioCost(seconds);
  emit({ kind: "audio", purpose: "voz", phone, model, seconds, costUsd });
  if (!sink) return;
  await sink.recordUsage({ phone, purpose: "voz", model, audioSeconds: seconds, costUsd, at: now }).catch((err: Error) => ctx?.log?.(`consumo: no pude registrar el audio: ${err.message}`));
}

/**
 * Texto del usuario que va al modelo: se corta en `limits.maxUserChars` (o `max`) y, si se cortó, el usuario recibe
 * una línea al final de la respuesta. Las reglas siguen viendo el texto completo (esto es solo para el modelo).
 */
export function clipForModel(text: string, max: number = limitsConfig().maxUserChars): string {
  if (text.length <= max) return text;
  als.getStore()?.notices.add(CLIP_NOTICE(max));
  return text.slice(0, max);
}
