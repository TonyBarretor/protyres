/**
 * Estado del portal en la conversación de WhatsApp (tabla portal_conversations / store JSON), separado del estado del
 * cotizador. Por ahora solo guarda un paso pendiente: lo que el bot preguntó y espera como respuesta.
 *
 * Tipos de paso de B1: choose_company (elegir de una lista numerada), intent_choice (¿cotización o reporte?),
 * report_draft (texto del reporte guardado para el intérprete, bloque B3). Los bloques siguientes añaden los suyos.
 */
import type { DraftField, ReportDraft } from "../report/draft";
import type { PortalStore } from "../store/types";

/** Un paso pendiente vence a las 2 horas: después, el mensaje se clasifica como si no hubiera paso. */
export const PENDING_TTL_MS = 2 * 60 * 60 * 1000;

export interface PendingStep {
  kind: string;
  /** ISO. */
  createdAt: string;
  [key: string]: unknown;
}

export interface PortalConvState {
  pending?: PendingStep | null;
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

/** El paso pendiente vigente (null si no hay o venció). */
export async function getPending(store: PortalStore, phone: string, now: Date): Promise<PendingStep | null> {
  const conv = await store.getPortalConversation(phone);
  const pending = (conv?.state as PortalConvState | undefined)?.pending;
  if (!pending || typeof pending !== "object" || typeof pending.kind !== "string") return null;
  return isExpired(pending, now) ? null : pending;
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
