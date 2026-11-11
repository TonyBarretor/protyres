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
  /** Pasos apartados para retomarlos después (p. ej. el pedido de una OC cuando el vendedor pasó a cotizar), por tipo. */
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

/** Un paso apartado se puede retomar durante 24 h. */
export const PARKED_TTL_MS = 24 * 60 * 60 * 1000;

/** El paso apartado de este tipo (null si no hay o venció). */
export function parkedOf(conv: PortalConversation | null | undefined, kind: string, now: Date): PendingStep | null {
  const p = (conv?.state as PortalConvState | undefined)?.parked?.[kind];
  if (!p || typeof p !== "object" || p.kind !== kind) return null;
  const t = Date.parse(p.parkedAt);
  if (!Number.isFinite(t) || now.getTime() - t > PARKED_TTL_MS) return null;
  const { parkedAt: _at, ...step } = p;
  return step as PendingStep;
}

/** Aparta un paso (o lo borra con null), conservando el resto del estado. */
export async function setParked(store: PortalStore, phone: string, kind: string, step: PendingStep | null, now: Date): Promise<void> {
  const conv = await store.getPortalConversation(phone);
  const state = { ...((conv?.state as PortalConvState) ?? {}) };
  const parked = { ...(state.parked ?? {}) };
  if (step) parked[kind] = { ...step, parkedAt: now.toISOString() };
  else delete parked[kind];
  if (Object.keys(parked).length) state.parked = parked;
  else delete state.parked;
  if (!conv && !step) return;
  await store.setPortalConversation(phone, Object.keys(state).length ? state : null);
}
