/**
 * Registros del bot del portal: los bloques B2..C2 completan los comandos (cita, oc, avance, prepropuesta, aprende),
 * los pasos pendientes y el intérprete de reportes sin tocar el router ni el handler.
 *
 *   registerPortalCommand("cita", async (ctx, args) => { ... });
 *   registerPendingHandler("report_confirm", async (ctx, step, text) => true);   // false = no era respuesta
 *   registerCompanyAction("cita", async (ctx, company, args) => { ... });        // tras elegir empresa de una lista
 *   setReportHandler(async (ctx, text, { occurredAt }) => { ... });
 */
import type { MessageLogEntry } from "../../store/types";
import { interactiveAsText, type ListRow, type ReplyButton } from "../../whatsapp/interactive";
import type { InboundMessage } from "../../whatsapp/webhook";
import type { Company, PortalStore, PortalUser } from "../store/types";
import type { VoiceCatalog } from "../voice/catalog";
import type { PortalCommandName } from "./router";
import { setPending, type PendingStep, type ReportDraftStep } from "./state";

export interface PortalContext {
  store: PortalStore;
  user: PortalUser;
  /** Número del usuario (solo dígitos, como llega del webhook). */
  from: string;
  msg: InboundMessage;
  reply(body: string): Promise<void>;
  /**
   * Mensaje con botones de respuesta (máx. 3). `id` de cada botón = el texto equivalente que el bot ya entiende escrito
   * (`sí`, `corregir`, `asignarme 20602221505`); el prefijo `pt:` lo pone el canal. Sin canal interactivo, fuera de los
   * límites o si WhatsApp lo rechaza: va como texto (`opts.fallback`, o body + "Responde *a* o *b*."). Opcional: un
   * contexto armado a mano (tests) no lo trae; usa replyButtons()/replyList() de este módulo, que caen a `reply`.
   */
  replyButtons?(body: string, buttons: ReplyButton[], opts?: InteractiveReplyOptions): Promise<void>;
  /** Lista para elegir (máx. 10 filas en total; `id` de cada fila = texto equivalente, p. ej. el número de la opción). */
  replyList?(body: string, buttonLabel: string, rows: ListRow[], opts?: InteractiveReplyOptions & { sectionTitle?: string }): Promise<void>;
  /** Documento al mismo usuario (sin leyenda si caption es "" o undefined). */
  sendDocument(file: Buffer, fileName: string, caption?: string, mimeType?: string): Promise<void>;
  /**
   * Texto a OTRO usuario interno (p. ej. aviso al jefe técnico). Solo a números de usuarios activos en `users`: a
   * cualquier otro número lanza error (el bot nunca escribe a clientes). Lanza también si WhatsApp rechaza el envío.
   */
  sendTextTo(phone: string, body: string): Promise<void>;
  /**
   * Pasa `text` al cotizador como si el usuario lo hubiera escrito (respuesta "cotización" a la pregunta ambigua). Con
   * `voice` (la transcripción literal) es una cotización por voz: el cotizador no arma el PDF sin un *ok* escrito.
   */
  requote(text: string, opts?: { voice?: string }): Promise<void>;
  /** Marcas, diseños y medidas de las listas de precios (keyterms y validación de la medida dictada). Opcional. */
  voiceCatalog?(): Promise<VoiceCatalog>;
  env: Record<string, string | undefined>;
  now: Date;
  log(msg: string): void;
  /** Descarga un medio de WhatsApp (nota de voz). Opcional: sin él, el intérprete usa la Graph API (o lo inyectado con configureReportBot). */
  downloadMedia?(mediaId: string): Promise<{ data: Buffer; mimeType: string; fileName?: string }>;
  /** Registra un mensaje en `messages` (la transcripción de una nota de voz). Opcional: sin él, el store del cotizador. */
  logMessage?(entry: MessageLogEntry): Promise<void>;
}

export interface InteractiveReplyOptions {
  /** Texto si no va como interactivo (por defecto: body + las opciones escritas). */
  fallback?: string;
  footer?: string;
}

/** Botones (o el texto equivalente si el contexto no tiene canal interactivo). */
export async function replyButtons(ctx: Pick<PortalContext, "reply" | "replyButtons">, body: string, buttons: ReplyButton[], opts: InteractiveReplyOptions = {}): Promise<void> {
  if (ctx.replyButtons) return ctx.replyButtons(body, buttons, opts);
  await ctx.reply(opts.fallback ?? interactiveAsText({ type: "button", body, buttons }));
}

/** Lista (o el texto equivalente si el contexto no tiene canal interactivo). */
export async function replyList(ctx: Pick<PortalContext, "reply" | "replyList">, body: string, buttonLabel: string, rows: ListRow[], opts: InteractiveReplyOptions & { sectionTitle?: string } = {}): Promise<void> {
  if (ctx.replyList) return ctx.replyList(body, buttonLabel, rows, opts);
  await ctx.reply(opts.fallback ?? interactiveAsText({ type: "list", body, button: buttonLabel, sections: [{ rows }] }));
}

export type PortalCommandHandler = (ctx: PortalContext, args: string) => Promise<void>;
/** Devuelve false si el texto no era respuesta al paso (se descarta el paso y el mensaje se clasifica de nuevo). */
export type PendingHandler = (ctx: PortalContext, step: PendingStep, text: string) => Promise<boolean>;
export type CompanyActionHandler = (ctx: PortalContext, company: Company, args: Record<string, unknown>) => Promise<void>;
export interface ReportOptions {
  occurredAt: Date;
  audio?: { id: string; mimeType: string } | null;
  /** `text` ya es la transcripción de una nota de voz (no se vuelve a Deepgram; la actividad queda con canal voz). */
  voice?: boolean;
}
export type ReportHandler = (ctx: PortalContext, text: string, opts: ReportOptions) => Promise<void>;

const commands = new Map<PortalCommandName, PortalCommandHandler>();
const pendingHandlers = new Map<string, PendingHandler>();
const companyActions = new Map<string, CompanyActionHandler>();

export function registerPortalCommand(name: PortalCommandName, handler: PortalCommandHandler): void {
  commands.set(name, handler);
}

export function getPortalCommand(name: PortalCommandName): PortalCommandHandler | undefined {
  return commands.get(name);
}

export function registerPendingHandler(kind: string, handler: PendingHandler): void {
  pendingHandlers.set(kind, handler);
}

export function getPendingHandler(kind: string): PendingHandler | undefined {
  return pendingHandlers.get(kind);
}

/**
 * Por qué se deja un paso pendiente: el mensaje siguió al cotizador ("quoter"), llegó otro comando del portal ("command")
 * o el usuario escribió `cancelar` ("cancel").
 */
export type DropReason = "quoter" | "command" | "cancel";
/** Lo que necesita un manejador de descarte (sin el mensaje: con `cancelar` no se arma el contexto completo). */
export type DropContext = Pick<PortalContext, "store" | "from" | "now" | "log">;
/** Al descartar un paso de este tipo: puede apartarlo o cerrar lo que dejó abierto; el texto devuelto se le dice al usuario. */
export type PendingDropHandler = (ctx: DropContext, step: PendingStep, reason: DropReason) => Promise<string | null>;

const dropHandlers = new Map<string, PendingDropHandler>();

export function registerPendingDrop(kind: string, handler: PendingDropHandler): void {
  dropHandlers.set(kind, handler);
}

export function getPendingDrop(kind: string): PendingDropHandler | undefined {
  return dropHandlers.get(kind);
}

/** Cómo se describe un paso en pausa: "pedido de ZBUSS" (falta "fecha de entrega"). */
export interface PauseInfo {
  companyId: number | null;
  label: string;
  missing: string;
  /** Solo falta el *sí* (reporte con el resumen mostrado): el recordatorio ofrece *Sí, guardar*. */
  confirm?: boolean;
}

/**
 * Un tipo de paso que puede quedar en pausa (corrida D, punto 7): `describe` arma el recordatorio y `resume` lo vuelve a
 * dejar pendiente y repite la pregunta en curso, con las respuestas que ya tenía. Los pasos sin esto se descartan como antes.
 */
export interface Pausable {
  describe(ctx: DropContext, step: PendingStep): Promise<PauseInfo>;
  resume(ctx: PortalContext, step: PendingStep, prefix: string): Promise<void>;
}

const pausables = new Map<string, Pausable>();

export function registerPausable(kind: string, p: Pausable): void {
  pausables.set(kind, p);
}

export function getPausable(kind: string): Pausable | undefined {
  return pausables.get(kind);
}

export function registerCompanyAction(action: string, handler: CompanyActionHandler): void {
  companyActions.set(action, handler);
}

export function getCompanyAction(action: string): CompanyActionHandler | undefined {
  return companyActions.get(action);
}

export const REPORT_PLACEHOLDER = "(intérprete de reportes: próximo bloque)";

/** Por defecto (hasta el bloque B3): guarda el texto como paso pendiente y responde un marcador. */
export const placeholderReportHandler: ReportHandler = async (ctx, text, opts) => {
  const step: Omit<ReportDraftStep, "createdAt"> = { kind: "report_draft", text, occurredAt: opts.occurredAt.toISOString(), audio: opts.audio ?? null };
  await setPending(ctx.store, ctx.from, step, ctx.now);
  const what = opts.audio && !text ? "tu nota de voz" : `tu reporte: «${text.length > 160 ? `${text.slice(0, 157)}…` : text}»`;
  await ctx.reply(`📝 Recibí ${what}\n${REPORT_PLACEHOLDER}`);
};

let defaultReportHandler: ReportHandler = placeholderReportHandler;
let reportHandler: ReportHandler = placeholderReportHandler;

/** Reemplaza el intérprete (tests); null vuelve al de por defecto (el de bot/report.ts, o el marcador si no se cargó). */
export function setReportHandler(handler: ReportHandler | null): void {
  reportHandler = handler ?? defaultReportHandler;
}

/** El intérprete de reportes de verdad (bot/report.ts) se registra como el de por defecto. */
export function setDefaultReportHandler(handler: ReportHandler): void {
  defaultReportHandler = handler;
  reportHandler = handler;
}

/** Reporte de visita / llamada / nota (texto o voz) de un usuario del portal. */
export function handleReport(ctx: PortalContext, text: string, opts: ReportOptions): Promise<void> {
  return reportHandler(ctx, text, opts);
}
