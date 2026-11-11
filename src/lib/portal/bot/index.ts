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
 * Cuando un paso pendiente se deja (cancelar, otro comando, o el mensaje sigue al cotizador) corre su manejador de descarte
 * si lo tiene (registerPendingDrop): `oc` aparta el pedido para retomarlo y avisa, o marca la OC cancelada.
 *
 * Latencia: lo que no es comando explícito tiene PORTAL_ROUTE_TIMEOUT_MS (4 s) para las lecturas que deciden (usuario,
 * estado, avisos, empresas nombradas); si vence, se registra y sigue el cotizador. Ya decidido que el mensaje es del
 * portal (reporte, respuesta a un paso), el manejador corre sin límite: cortarlo dejaría el mensaje a medias y además
 * lo procesaría el cotizador. Un comando explícito espera al store (y si falla, da error).
 *
 * Avisos pendientes (B6, `notices` en el estado del portal: lo que el cron diario no pudo mandar por la ventana de 24 h):
 * con CUALQUIER mensaje del usuario, también los que van al cotizador, se mandan primero en un mensaje aparte y se borran;
 * luego todo sigue igual que sin avisos. Cuesta una lectura: en el camino del portal se reutiliza la del paso pendiente;
 * en las salidas tempranas (reenviado, adjunto, cotizador a mitad de flujo) es una sola lectura de portal_conversations
 * por número (sin fila para quien no es del portal). Si falla, se registra y el mensaje sigue su camino.
 */
import type { MessageLogEntry } from "../../store/types";
import type { InboundMessage } from "../../whatsapp/webhook";
import { getPortalStore } from "../store";
import { digits } from "../store/shared";
import type { PortalConversation, PortalStore, PortalUser } from "../store/types";
import { noticesMessage } from "../notify/notices";
import { mentionsKnownCompany } from "./companies";
import "./report";
import { comingSoon } from "./commands";
import { getPendingDrop, getPendingHandler, getPortalCommand, handleReport, registerPendingHandler, type DropContext, type DropReason, type PortalContext } from "./registry";
import { classifyIntent, isCancel, isQuoterCommand, mediaAccepted, parsePortalCommand, textSignals, type Intent } from "./router";
import { withTimeout } from "../quotes/link";
import { clearNotices, clearPending, noticesOf, pendingOf, setPending, type IntentChoiceStep, type PendingStep } from "./state";
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
  /** Tiempo límite de las decisiones que no son comando explícito (tests); por defecto PORTAL_ROUTE_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** Compatibilidad con la fase A. */
export type PortalCommandInput = PortalRouteInput;

export const NOT_REGISTERED = "Tu número no está registrado en el portal. Pide a Tony que te agregue.";
/**
 * Tiempo máximo para decidir si un mensaje es del portal cuando no es un comando explícito (leer usuario, estado y
 * avisos): si la base tarda más, se registra y sigue el cotizador. Los comandos explícitos esperan lo que haga falta.
 */
export const PORTAL_ROUTE_TIMEOUT_MS = 4000;
const routeTimeout = (input: PortalRouteInput) => input.timeoutMs ?? PORTAL_ROUTE_TIMEOUT_MS;

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

/**
 * Manda los avisos pendientes de `conv` (si hay) en un mensaje aparte y los borra. Devuelve el estado que queda.
 * Nunca lanza: si el envío falla los avisos se quedan para el próximo mensaje.
 */
async function deliverNotices(input: PortalRouteInput, store: PortalStore, conv: PortalConversation | null, log: (m: string) => void): Promise<PortalConversation | null> {
  const notices = noticesOf(conv);
  if (!conv || !notices.length) return conv;
  try {
    await input.reply(noticesMessage(notices));
  } catch (err) {
    log(`portal: no pude mandar los avisos pendientes: ${(err as Error).message}`);
    return conv;
  }
  try {
    return await clearNotices(store, input.from, conv);
  } catch (err) {
    log(`portal: no pude borrar los avisos pendientes: ${(err as Error).message}`);
    return conv;
  }
}

/** Salidas tempranas hacia el cotizador: solo mira si hay avisos pendientes (una lectura, con tiempo límite). */
async function deliverNoticesOnly(input: PortalRouteInput): Promise<void> {
  const log = input.log ?? (() => undefined);
  try {
    await withTimeout(
      (async () => {
        const store = input.store ?? (await getPortalStore());
        await deliverNotices(input, store, await store.getPortalConversation(input.from), log);
      })(),
      routeTimeout(input),
    );
  } catch (err) {
    log(`portal: no pude revisar los avisos pendientes: ${(err as Error).message}`);
  }
}

/** ¿Hay un paso pendiente del portal que espera este adjunto (p.ej. la OC tras `oc …`)? Solo con el cotizador en idle. */
async function mediaForPendingStep(input: PortalRouteInput, m: { forwarded: boolean; hasMedia: boolean; quoteStep: string; text: string }): Promise<boolean> {
  if (m.forwarded || !m.hasMedia || m.quoteStep !== "idle") return false;
  try {
    return await withTimeout(
      (async () => {
        const store = input.store ?? (await getPortalStore());
        const user = await store.getUserByWhatsapp(input.from);
        if (!user || !user.activo) return false;
        const now = input.now ?? new Date();
        return mediaAccepted(pendingOf(await store.getPortalConversation(input.from), now), m.text, now);
      })(),
      routeTimeout(input),
    );
  } catch (err) {
    (input.log ?? (() => undefined))(`portal: no pude revisar el paso pendiente: ${(err as Error).message}`);
    return false;
  }
}

/** Lo que se lee del store para decidir (usuario, estado, paso pendiente y si el texto nombra una empresa conocida). */
interface Decision {
  store: PortalStore;
  active: PortalUser | null;
  conv: PortalConversation | null;
}

/**
 * Descarta el paso pendiente: su manejador de descarte (si tiene) puede apartarlo o cerrar lo que dejó abierto y devolver un
 * aviso, que se manda antes de que siga el cotizador. Nunca lanza.
 */
async function dropPending(input: PortalRouteInput, dctx: DropContext, step: PendingStep | null, reason: DropReason, notify = true): Promise<void> {
  try {
    const hook = step ? getPendingDrop(step.kind) : undefined;
    const notice = hook ? await hook(dctx, step!, reason) : null;
    await clearPending(dctx.store, dctx.from);
    if (notice && notify) await input.reply(notice);
  } catch (err) {
    dctx.log(`portal: no pude dejar el paso pendiente: ${(err as Error).message}`);
  }
}

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
  const log = input.log ?? (() => undefined);

  // nada de esto puede ser del portal: va al cotizador (antes, los avisos pendientes si los hay). Una nota de voz con el
  // cotizador a mitad de un flujo también es del cotizador (router, regla 6).
  if (msg.forwarded || (!cmd && !cancel && (isAudio ? quoteStep !== "idle" : hasMedia || quoteStep !== "idle" || !text))) {
    // excepción: un adjunto sin leyenda justo después de `oc` (paso pendiente con acceptsMedia) es del portal
    if (!(await mediaForPendingStep(input, { forwarded: !!msg.forwarded, hasMedia: hasMedia && !isAudio, quoteStep, text }))) {
      await deliverNoticesOnly(input);
      return false;
    }
  }

  // lecturas para decidir: un comando explícito espera lo que haga falta (y si el store falla, da error); cualquier otra
  // cosa tiene PORTAL_ROUTE_TIMEOUT_MS y, si vence o falla, sigue el cotizador
  const decide = async (): Promise<Decision> => {
    const store = input.store ?? (await getPortalStore());
    const user = await store.getUserByWhatsapp(from);
    const active = user && user.activo ? user : null;
    const conv = active ? await store.getPortalConversation(from) : null;
    return { store, active, conv };
  };
  let d: Decision;
  try {
    d = cmd ? await decide() : await withTimeout(decide(), routeTimeout(input));
  } catch (err) {
    if (cmd) throw err;
    log(`portal: store no disponible o lento, sigue el cotizador: ${(err as Error).message}`);
    return false;
  }
  const { store, active } = d;
  const now = input.now ?? new Date();
  // avisos pendientes (con tiempo límite: si tarda, se quedan para el próximo mensaje)
  let conv = d.conv;
  if (active && conv) {
    const before = conv;
    conv = await withTimeout(deliverNotices(input, store, conv, log), routeTimeout(input)).catch((err: Error) => {
      log(`portal: los avisos pendientes tardaron: ${err.message}`);
      return before;
    });
  }
  const dctx: DropContext = { store, from, now, log };
  if (cancel) {
    if (active) await withTimeout(dropPending(input, dctx, pendingOf(conv, now), "cancel"), routeTimeout(input)).catch((err: Error) => log(`portal: no pude limpiar el paso pendiente: ${err.message}`));
    return false;
  }
  if (cmd?.name === "portal" && !active) {
    await input.reply(NOT_REGISTERED);
    return true;
  }
  if (!active) return false;

  const pending: PendingStep | null = pendingOf(conv, now);
  // un paso sin manejador todavía (p. ej. report_draft antes del bloque B3) no captura mensajes
  const live = pending && getPendingHandler(pending.kind) ? pending : null;

  let mentions = false;
  if (!cmd && !isAudio && quoteStep === "idle" && !live && !isQuoterCommand(text)) {
    const sig = textSignals(text);
    const words = fold(text).split(" ").filter(Boolean).length;
    if (!sig.strongQuote && !sig.strongReport && !sig.weakReport && words >= 1 && words <= 15) {
      try {
        mentions = await withTimeout(mentionsKnownCompany(store, text), routeTimeout(input));
      } catch (err) {
        log(`portal: no pude buscar empresas en el texto, sigue el cotizador: ${(err as Error).message}`);
        return false;
      }
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
  const base = { text, hasMedia, mediaType: msg.type, state: quoteStep, isPortalUser: true, forwarded: msg.forwarded, mentionsKnownCompany: mentions, now };
  let intent: Intent = classifyIntent({ ...base, pendingPortalStep: live });

  if (intent === "portal_command" && cmd) {
    // un comando nuevo deja atrás la pregunta anterior (`oc` avisa él mismo si retoma o reemplaza un pedido)
    if (pending) await dropPending(input, dctx, pending, "command", cmd.name !== "oc");
    const handler = getPortalCommand(cmd.name);
    if (handler) await handler(ctx, cmd.args);
    else await input.reply(comingSoon(cmd.name));
    return true;
  }
  let dropped = false;
  if (intent === "portal_flow" && live) {
    const consumed = await getPendingHandler(live.kind)!(ctx, live, text);
    if (consumed) return true;
    await dropPending(input, dctx, live, "quoter");
    dropped = true;
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
  if (pending && !dropped) await dropPending(input, dctx, pending, "quoter");
  return false;
}

/** Nombre de la fase A: mismo comportamiento que routePortal. */
export const handlePortalCommand = routePortal;
