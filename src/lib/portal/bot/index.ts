/**
 * Punto de entrada único del portal en el bot: BotHandler.handle() llama a routePortal() antes que nada del cotizador.
 * Devuelve true si el portal atendió el mensaje; con false el cotizador sigue exactamente como siempre.
 *
 * Qué entra al portal lo decide el router puro (router.ts). Aquí solo se consulta lo que el router necesita, y solo si
 * hace falta: un mensaje reenviado, un adjunto sin comando o cualquier mensaje con el cotizador a mitad de un flujo
 * vuelven al cotizador sin tocar el store del portal. Si el store del portal falla (base caída), solo los comandos
 * explícitos del portal dan error; todo lo demás sigue al cotizador.
 *
 * `cancelar` llega aquí primero: borra el paso pendiente del portal y devuelve false (el cotizador cancela lo suyo).
 */
import type { MessageLogEntry } from "../../store/types";
import type { InboundMessage } from "../../whatsapp/webhook";
import { getPortalStore } from "../store";
import { digits } from "../store/shared";
import type { PortalStore, PortalUser } from "../store/types";
import { mentionsKnownCompany } from "./companies";
import "./report";
import { comingSoon } from "./commands";
import { getPendingHandler, getPortalCommand, handleReport, registerPendingHandler, type PortalContext } from "./registry";
import { classifyIntent, isCancel, isQuoterCommand, parsePortalCommand, textSignals, type Intent } from "./router";
import { clearPending, getPending, setPending, type IntentChoiceStep, type PendingStep } from "./state";
import { fold } from "../../tyre/brands";

export { classifyIntent, parsePortalCommand } from "./router";
export { mentionedCompanies, mentionsKnownCompany } from "./companies";
export { configureReportBot } from "./report";
export { handleReport, registerCompanyAction, registerPendingHandler, registerPortalCommand, setReportHandler, type PortalContext } from "./registry";
export { noConfigReply } from "./commands/portal";

export interface PortalRouteInput {
  from: string;
  /** Texto del mensaje (o leyenda del adjunto). */
  text: string;
  /** El mensaje entrante (tipo, adjunto, reenviado, hora). Sin él se asume un texto simple. */
  msg?: InboundMessage;
  /** Paso del cotizador (ConversationState.step), o "profile" si hay un perfil elegido esperando el pedido. Por defecto idle. */
  quoteStep?: string;
  reply: (body: string) => Promise<void>;
  sendDocument?: (file: Buffer, fileName: string, caption?: string, mimeType?: string) => Promise<void>;
  /** Texto a otro número (el portal solo lo usa con usuarios internos registrados; ver PortalContext.sendTextTo). */
  sendTextTo?: (to: string, body: string) => Promise<void>;
  /** Vuelve a pasar un mensaje por BotHandler.handle() (respuesta "cotización" a la pregunta ambigua). */
  requote?: (msg: InboundMessage) => Promise<void>;
  /** Inyectado en tests y simulador; por defecto getPortalStore() (perezoso: solo si el mensaje puede ser del portal). */
  store?: PortalStore;
  env?: Record<string, string | undefined>;
  now?: Date;
  log?: (msg: string) => void;
  /** Descarga de medios (notas de voz). Opcional: sin él, Graph API perezosa desde el entorno (ver bot/report.ts). */
  downloadMedia?: (mediaId: string) => Promise<{ data: Buffer; mimeType: string; fileName?: string }>;
  /** Registro en `messages` (transcripciones). Opcional: sin él, getStore().logMessage. */
  logMessage?: (entry: MessageLogEntry) => Promise<void>;
}

/** Compatibilidad con la fase A. */
export type PortalCommandInput = PortalRouteInput;

export const NOT_REGISTERED = "Tu número no está registrado en el portal. Pide a Tony que te agregue.";
export const AMBIGUOUS_QUESTION = "¿Es una *cotización* o un *reporte* de visita/llamada? Responde *cotización* o *reporte*.";

/** Mensajes que el portal devuelve al cotizador (requote): el router no los vuelve a mirar. */
const PASS = new WeakSet<InboundMessage>();

export function isPortalCommand(text: string): boolean {
  return parsePortalCommand(text)?.name === "portal";
}

function occurredAt(msg: InboundMessage, now: Date): Date {
  const ts = Number(msg.timestamp);
  // timestamp del webhook en segundos; se descarta si es absurdo (tests usan "1") o futuro
  if (Number.isFinite(ts) && ts > 1_500_000_000 && ts * 1000 <= now.getTime() + 60_000) return new Date(ts * 1000);
  return now;
}

/** Respuesta a "¿cotización o reporte?". */
registerPendingHandler("intent_choice", async (ctx, step, text) => {
  const s = step as IntentChoiceStep;
  const t = fold(text).replace(/^(?:es\s+)?(?:una?\s+)?/, "");
  if (/^(?:1|c|cot|cotizacion|cotizar|cotiza|pedido)$/.test(t)) {
    await clearPending(ctx.store, ctx.from);
    await ctx.requote(s.text);
    return true;
  }
  if (/^(?:2|r|reporte|report|visita|llamada|nota)$/.test(t)) {
    await clearPending(ctx.store, ctx.from);
    await handleReport(ctx, s.text, { occurredAt: new Date(s.occurredAt) });
    return true;
  }
  return false;
});

export async function routePortal(input: PortalRouteInput): Promise<boolean> {
  const msg: InboundMessage = input.msg ?? { id: "", from: input.from, timestamp: "", type: "text", text: input.text, forwarded: false };
  if (PASS.has(msg)) return false;
  const from = input.from;
  const text = (input.text ?? "").trim();
  const isAudio = msg.type === "audio";
  const hasMedia = !!msg.media;
  const quoteStep = input.quoteStep ?? "idle";
  const cmd = msg.forwarded ? null : parsePortalCommand(text, { withMedia: hasMedia && !isAudio });
  const cancel = !hasMedia && isCancel(text);

  // salidas sin tocar el store: nada de esto puede ser del portal
  if (msg.forwarded) return false;
  if (!cmd && !cancel && !isAudio && (hasMedia || quoteStep !== "idle" || !text)) return false;

  const log = input.log ?? (() => undefined);
  let store: PortalStore;
  let user: PortalUser | null;
  try {
    store = input.store ?? (await getPortalStore());
    user = await store.getUserByWhatsapp(from);
  } catch (err) {
    if (cmd) throw err;
    log(`portal: store no disponible, sigue el cotizador: ${(err as Error).message}`);
    return false;
  }
  const active = user && user.activo ? user : null;
  if (cancel) {
    if (active) await clearPending(store, from).catch((err: Error) => log(`portal: no pude limpiar el paso pendiente: ${err.message}`));
    return false;
  }
  if (cmd?.name === "portal" && !active) {
    await input.reply(NOT_REGISTERED);
    return true;
  }
  if (!active) return false;

  const now = input.now ?? new Date();
  let pending: PendingStep | null = null;
  try {
    pending = await getPending(store, from, now);
  } catch (err) {
    if (cmd) throw err;
    log(`portal: no pude leer el paso pendiente: ${(err as Error).message}`);
    return false;
  }
  // un paso sin manejador todavía (p. ej. report_draft antes del bloque B3) no captura mensajes
  const live = pending && getPendingHandler(pending.kind) ? pending : null;

  let mentions = false;
  if (!cmd && !isAudio && quoteStep === "idle" && !live && !isQuoterCommand(text)) {
    const sig = textSignals(text);
    const words = fold(text).split(" ").filter(Boolean).length;
    if (!sig.strongQuote && !sig.strongReport && !sig.weakReport && words >= 1 && words <= 15) {
      mentions = await mentionsKnownCompany(store, text).catch(() => false);
    }
  }

  const ctx: PortalContext = {
    store,
    user: active,
    from,
    msg,
    reply: input.reply,
    sendDocument: input.sendDocument ?? (async () => input.reply("(no puedo enviar archivos por este canal)")),
    sendTextTo: async (to: string, body: string) => {
      const phone = digits(to);
      const target = phone ? await store.getUserByWhatsapp(phone) : null;
      if (!target || !target.activo) throw new Error(`el número ${phone || to} no es de un usuario activo del portal`);
      if (!input.sendTextTo) throw new Error("este canal no puede escribir a otros números");
      await input.sendTextTo(phone, body);
    },
    requote: async (t: string) => {
      const again: InboundMessage = { ...msg, id: `${msg.id}#cotizacion`, type: "text", text: t, media: undefined, forwarded: false };
      PASS.add(again);
      if (input.requote) await input.requote(again);
      else await input.reply("Escríbeme de nuevo el pedido para cotizarlo.");
    },
    env: input.env ?? process.env,
    now,
    log,
    downloadMedia: input.downloadMedia,
    logMessage: input.logMessage,
  };
  const base = { text, hasMedia, mediaType: msg.type, state: quoteStep, isPortalUser: true, forwarded: msg.forwarded, mentionsKnownCompany: mentions };
  let intent: Intent = classifyIntent({ ...base, pendingPortalStep: live });

  if (intent === "portal_command" && cmd) {
    if (pending) await clearPending(store, from); // un comando nuevo deja atrás la pregunta anterior
    const handler = getPortalCommand(cmd.name);
    if (handler) await handler(ctx, cmd.args);
    else await input.reply(comingSoon(cmd.name));
        return true;
  }
  if (intent === "portal_flow" && live) {
    const consumed = await getPendingHandler(live.kind)!(ctx, live, text);
    if (consumed) {
            return true;
    }
    await clearPending(store, from);
    intent = classifyIntent({ ...base, pendingPortalStep: null });
  }
  if (intent === "report") {
    await handleReport(ctx, text, { occurredAt: occurredAt(msg, now), audio: isAudio && msg.media ? { id: msg.media.id, mimeType: msg.media.mimeType } : null });
        return true;
  }
  if (intent === "ambiguous") {
    const step: Omit<IntentChoiceStep, "createdAt"> = { kind: "intent_choice", text, occurredAt: occurredAt(msg, now).toISOString() };
    await setPending(store, from, step, now);
    await input.reply(AMBIGUOUS_QUESTION);
        return true;
  }
  // quote / passthrough: el cotizador. Un paso pendiente queda descartado (el usuario pasó a otra cosa).
  if (pending) await clearPending(store, from).catch((err: Error) => log(`portal: no pude limpiar el paso pendiente: ${err.message}`));
  return false;
}

/** Nombre de la fase A: mismo comportamiento que routePortal. */
export const handlePortalCommand = routePortal;
