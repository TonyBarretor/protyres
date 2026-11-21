/**
 * Estado del portal en la conversación de WhatsApp (tabla portal_conversations / store JSON), separado del estado del
 * cotizador. Guarda un paso pendiente (lo que el bot preguntó y espera como respuesta) y, desde B6, los avisos que no se
 * pudieron mandar por la ventana de 24 h de WhatsApp (`notices`): routePortal los muestra en el siguiente mensaje del usuario.
 *
 * Tipos de paso de B1: choose_company (elegir de una lista numerada), intent_choice (¿cotización o reporte?),
 * report_draft (texto del reporte guardado para el intérprete, bloque B3). Los bloques siguientes añaden los suyos.
 */
import type { DraftField, ReportDraft } from "../report/draft";
import type { PortalConversation, PortalStore } from "../store/types";

/** Un paso pendiente vence a las 2 horas: después, el mensaje se clasifica como si no hubiera paso. */
export const PENDING_TTL_MS = 2 * 60 * 60 * 1000;

export interface PendingStep {
  kind: string;
  /** ISO. */
  createdAt: string;
  [key: string]: unknown;
}

/** Aviso que no se pudo enviar (fuera de la ventana de 24 h): se muestra en el siguiente mensaje del usuario. */
export interface PortalNotice {
  text: string;
  /** ISO. */
  createdAt: string;
  /** De dónde salió ("resumen_diario", ...). */
  kind?: string;
}

/** Se guardan como máximo estos avisos (los más recientes). */
export const MAX_NOTICES = 7;

export interface PortalConvState {
  pending?: PendingStep | null;
  /** Procesos en pausa (corrida D, punto 7): pasos que quedaron atrás, para retomarlos o descartarlos. */
  paused?: PausedProcess[];
  /** Anterior a `paused` (solo `oc`, 24 h): se sigue leyendo para no perder un pedido apartado antes del cambio. */
  parked?: Record<string, PendingStep & { parkedAt: string }>;
  /** Opcional: los estados anteriores a B6 no lo traen. */
  notices?: PortalNotice[];
  [key: string]: unknown;
}

export interface CompanyOption {
  id: number;
  label: string;
}

/** Elegir una empresa de la lista; `action` dice qué hacer con la elegida (registro de acciones por empresa). */
export interface ChooseCompanyStep extends PendingStep {
  kind: "choose_company";
  action: string;
  options: CompanyOption[];
  args?: Record<string, unknown>;
}

/** "¿Es una cotización o un reporte?": el texto original espera la respuesta. */
export interface IntentChoiceStep extends PendingStep {
  kind: "intent_choice";
  text: string;
  /** ISO: cuándo llegó el mensaje original. */
  occurredAt: string;
  /** Nota de voz: `text` es su transcripción (*cotización* -> cotización por voz; *reporte* -> reporte con canal voz). */
  voice?: boolean;
}

/**
 * Reporte en borrador esperando respuesta: `field` = la pregunta hecha (una cosa a la vez) o null si se mostró el resumen
 * y se espera *sí* o una corrección. Sin `draft` (paso del marcador anterior): se interpreta `text` de nuevo.
 */
export interface ReportDraftStep extends PendingStep {
  kind: "report_draft";
  text: string;
  occurredAt: string;
  audio?: { id: string; mimeType: string } | null;
  draft?: ReportDraft;
  field?: DraftField | null;
  /** Corrida J: la empresa que se buscó y no está en el padrón (se ofrecen *Crear empresa nueva* / *Buscar otra vez*). */
  notFound?: string | null;
  /**
   * Corrida J: la empresa no tiene dueño y se espera *Asignármela y guardar todo* (`guardar todo`) o *Guardar solo la
   * nota* (`solo la nota`).
   */
  ownerChoice?: boolean;
}

/**
 * Corrida J: la empresa buscada no está en el padrón (resolveCompany con `offerCreate`): se ofrecieron *Crear empresa
 * nueva* (`nueva empresa`, con lo buscado) y *Buscar otra vez*. Al crearla o encontrarla sigue `action` con `args`.
 */
export interface CompanyNotFoundStep extends PendingStep {
  kind: "company_not_found" | "company_search";
  action: string;
  args: Record<string, unknown>;
  /** Lo que se buscó (company_not_found). */
  query?: string;
}

export function isExpired(step: PendingStep, now: Date): boolean {
  const t = Date.parse(step.createdAt);
  return !Number.isFinite(t) || now.getTime() - t > PENDING_TTL_MS;
}

/** El paso pendiente vigente de un estado ya leído (null si no hay o venció). */
export function pendingOf(conv: PortalConversation | null | undefined, now: Date): PendingStep | null {
  const pending = (conv?.state as PortalConvState | undefined)?.pending;
  if (!pending || typeof pending !== "object" || typeof pending.kind !== "string") return null;
  return isExpired(pending, now) ? null : pending;
}

/** El paso pendiente vigente (null si no hay o venció). */
export async function getPending(store: PortalStore, phone: string, now: Date): Promise<PendingStep | null> {
  return pendingOf(await store.getPortalConversation(phone), now);
}

/** Avisos pendientes de un estado ya leído (los mal formados se ignoran). */
export function noticesOf(conv: PortalConversation | null | undefined): PortalNotice[] {
  const list = (conv?.state as PortalConvState | undefined)?.notices;
  if (!Array.isArray(list)) return [];
  return list.filter((n): n is PortalNotice => !!n && typeof n === "object" && typeof n.text === "string" && !!n.text.trim());
}

/** Guarda un aviso pendiente (conserva el resto del estado; como máximo MAX_NOTICES, los más recientes). */
export async function addNotice(store: PortalStore, phone: string, notice: PortalNotice): Promise<void> {
  const conv = await store.getPortalConversation(phone);
  const notices = [...noticesOf(conv), notice].slice(-MAX_NOTICES);
  await store.setPortalConversation(phone, { ...((conv?.state as PortalConvState) ?? {}), notices });
}

/** Borra los avisos de un estado ya leído; devuelve el estado que queda (null si no queda nada). */
export async function clearNotices(store: PortalStore, phone: string, conv: PortalConversation): Promise<PortalConversation | null> {
  const { notices: _drop, ...rest } = conv.state as PortalConvState;
  const left = Object.keys(rest).length ? rest : null;
  await store.setPortalConversation(phone, left);
  return left ? { ...conv, state: left } : null;
}

export async function setPending(store: PortalStore, phone: string, step: Omit<PendingStep, "createdAt"> & { createdAt?: string }, now: Date): Promise<void> {
  const conv = await store.getPortalConversation(phone);
  const state: PortalConvState = { ...((conv?.state as PortalConvState) ?? {}), pending: { ...step, createdAt: step.createdAt ?? now.toISOString() } as PendingStep };
  await store.setPortalConversation(phone, state);
}

/** Borra el paso pendiente (no-op si no hay estado). */
export async function clearPending(store: PortalStore, phone: string): Promise<void> {
  const conv = await store.getPortalConversation(phone);
  if (!conv) return;
  const { pending: _drop, ...rest } = conv.state as PortalConvState;
  await store.setPortalConversation(phone, Object.keys(rest).length ? rest : null);
}

// ── procesos en pausa (corrida D, punto 7) ──

/**
 * Un proceso en pausa (un paso pendiente que quedó atrás porque llegó otra cosa: una cotización, otro comando) se puede
 * retomar durante 48 h; después caduca y se avisa (al siguiente mensaje del vendedor y en el resumen diario). Reemplaza
 * al `parked` de `oc` (24 h) y a las 24 h del punto 4: un solo plazo para todo.
 */
export const PAUSED_TTL_MS = 48 * 60 * 60 * 1000;
/** Máximo de procesos en pausa por empresa y por vendedor: al superarlo se pide resolver el más antiguo. */
export const MAX_PAUSED_PER_COMPANY = 1;
export const MAX_PAUSED_TOTAL = 3;

export interface PausedProcess {
  /** Referencia corta para los botones y para escribir (`continuar 2`): el menor número libre. */
  ref: string;
  /** El paso tal cual quedó (empresa, fase, respuestas ya dadas). */
  step: PendingStep;
  companyId: number | null;
  /** "pedido de ZBUSS", "reporte de visita de ZBUSS". */
  label: string;
  /** "falta fecha de entrega". */
  missing: string;
  /** El reporte espera solo el *sí*: el recordatorio lleva *Sí, guardar* en vez de *Continuar*. */
  confirm?: boolean;
  /** ISO. */
  pausedAt: string;
}

/** Los procesos en pausa de un estado ya leído (incluidos los vencidos), el más antiguo primero. */
export function pausedOf(conv: PortalConversation | null | undefined): PausedProcess[] {
  const list = (conv?.state as PortalConvState | undefined)?.paused;
  if (!Array.isArray(list)) return [];
  return (list as PausedProcess[]).filter((p) => !!p && typeof p === "object" && !!p.step && typeof p.step.kind === "string" && typeof p.ref === "string");
}

export function pausedExpired(p: Pick<PausedProcess, "pausedAt">, now: Date): boolean {
  const t = Date.parse(p.pausedAt);
  return !Number.isFinite(t) || now.getTime() - t > PAUSED_TTL_MS;
}

/** Hasta cuándo se puede retomar. */
export function pausedUntil(p: Pick<PausedProcess, "pausedAt">): Date {
  return new Date(Date.parse(p.pausedAt) + PAUSED_TTL_MS);
}

/** El paso pendiente guardado aunque haya vencido (para pasarlo a pausa en vez de perderlo). */
export function rawPendingOf(conv: PortalConversation | null | undefined): PendingStep | null {
  const pending = (conv?.state as PortalConvState | undefined)?.pending;
  return pending && typeof pending === "object" && typeof pending.kind === "string" ? pending : null;
}

async function writePaused(store: PortalStore, phone: string, list: PausedProcess[]): Promise<void> {
  const conv = await store.getPortalConversation(phone);
  const state = { ...((conv?.state as PortalConvState) ?? {}) };
  if (list.length) state.paused = list;
  else delete state.paused;
  if (!conv && !list.length) return;
  await store.setPortalConversation(phone, Object.keys(state).length ? state : null);
}

/** Agrega un proceso en pausa (con la menor referencia libre); devuelve el proceso guardado. */
export async function addPaused(store: PortalStore, phone: string, p: Omit<PausedProcess, "ref">): Promise<PausedProcess> {
  const list = pausedOf(await store.getPortalConversation(phone));
  const used = new Set(list.map((x) => x.ref));
  let n = 1;
  while (used.has(String(n))) n++;
  const saved: PausedProcess = { ...p, ref: String(n) };
  await writePaused(store, phone, [...list, saved]);
  return saved;
}

/** Saca un proceso de la pausa (por referencia); null si ya no estaba. */
export async function removePaused(store: PortalStore, phone: string, ref: string): Promise<PausedProcess | null> {
  const list = pausedOf(await store.getPortalConversation(phone));
  const hit = list.find((p) => p.ref === ref) ?? null;
  if (hit) await writePaused(store, phone, list.filter((p) => p.ref !== ref));
  return hit;
}

/**
 * El paso en pausa de este tipo (null si no hay o venció): lo que antes era el pedido "apartado" de `oc`. También lee el
 * `parked` de los estados anteriores (24 h), para no perder un pedido apartado antes de este cambio.
 */
export function parkedOf(conv: PortalConversation | null | undefined, kind: string, now: Date): PendingStep | null {
  const hit = [...pausedOf(conv)].reverse().find((p) => p.step.kind === kind && !pausedExpired(p, now));
  if (hit) return hit.step;
  const p = (conv?.state as PortalConvState | undefined)?.parked?.[kind];
  if (!p || typeof p !== "object" || p.kind !== kind) return null;
  const t = Date.parse(p.parkedAt);
  if (!Number.isFinite(t) || now.getTime() - t > LEGACY_PARKED_TTL_MS) return null;
  const { parkedAt: _at, ...step } = p;
  return step as PendingStep;
}

/** Plazo del `parked` anterior (solo para leer estados viejos). */
const LEGACY_PARKED_TTL_MS = 24 * 60 * 60 * 1000;

/** Borra el `parked` anterior de este tipo (estados de antes de los procesos en pausa). */
export async function clearLegacyParked(store: PortalStore, phone: string, kind: string): Promise<void> {
  const conv = await store.getPortalConversation(phone);
  const state = (conv?.state as PortalConvState | undefined) ?? null;
  if (!state?.parked?.[kind]) return;
  const parked = { ...state.parked };
  delete parked[kind];
  const next: PortalConvState = { ...state, parked };
  if (!Object.keys(parked).length) delete next.parked;
  await store.setPortalConversation(phone, Object.keys(next).length ? next : null);
}
