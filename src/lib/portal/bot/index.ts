/**
 * Punto de entrada único del portal en el bot: BotHandler.handle() llama a routePortal() antes que nada del cotizador.
 * Devuelve true si el portal atendió el mensaje; con false el cotizador sigue exactamente como siempre.
 *
 * Qué entra al portal lo decide el router puro (router.ts). Aquí solo se consulta lo que el router necesita, y solo si
 * hace falta: un mensaje reenviado, un adjunto sin comando o cualquier mensaje con el cotizador a mitad de un flujo
 * vuelven al cotizador sin tocar el store del portal. Si el store del portal falla (base caída), solo los comandos
 * explícitos del portal dan error; todo lo demás sigue al cotizador.
 *
 * `cancelar` llega aquí primero: borra el paso pendiente del portal y devuelve false (el cotizador cancela lo suyo); corre
 * el manejador de descarte del paso si lo tiene (registerPendingDrop: `oc` marca la OC cancelada).
 * Cuando un paso pendiente se deja por otra cosa (otro comando, una cotización, un comando del cotizador) NO se descarta:
 * pasa a pausa (bot/pause.ts, corrida D) y al final de la respuesta se recuerda con *Continuar* / *Descartar*; si el
 * mensaje va al cotizador, el recordatorio se deja en `defer` y el handler lo manda después de la respuesta del cotizador.
 * La precedencia (palabra explícita, medida + cantidad/marca/precio, respuesta, pregunta con dos botones, no entendido)
 * está en la cabecera de router.ts; la regla que decidió cada mensaje se registra en `messages` (kind "route",
 * route_rule). Para quien no es usuario activo del portal nada de esto corre (ni se registra).
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
import { deliverInteractive, isPortalId, portalButtons, portalRows, type InteractiveMessage } from "../../whatsapp/interactive";
import type { InboundMessage } from "../../whatsapp/webhook";
import { getPortalStore } from "../store";
import { digits } from "../store/shared";
import type { PortalConversation, PortalStore, PortalUser } from "../store/types";
import { noticesMessage } from "../notify/notices";
import { mentionsKnownCompany } from "./companies";
import "./report";
import { comingSoon } from "./commands";
import { quoterBlocksResume } from "./commands/oc";
import { askAgain, expirePaused, findPaused, parseResume, pauseStep, resumePaused, sendPauseReminders } from "./pause";
import { getPausable, getPendingDrop, getPendingHandler, getPortalCommand, handleReport, registerPausable, registerPendingDrop, registerPendingHandler, replyButtons, type DropContext, type DropReason, type PortalContext } from "./registry";
import { isCancel, isQuoterCommand, mediaAccepted, parsePortalCommand, routeIntent, textSignals, type Intent, type RouteRule } from "./router";
import { withTimeout } from "../quotes/link";
import { clearNotices, clearPending, noticesOf, pausedOf, pendingOf, rawPendingOf, setPending, type IntentChoiceStep, type PendingStep } from "./state";
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
  /**
   * Envía un mensaje interactivo ya validado (botones / lista, ids con prefijo `pt:`); lanza si WhatsApp lo rechaza.
   * Sin él (o si falla) ctx.replyButtons / ctx.replyList caen a texto con `reply`.
   */
  replyInteractive?: (message: InteractiveMessage) => Promise<void>;
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
  /**
   * Corre `fn` cuando el handler termine con el mensaje (después de la respuesta del cotizador). routePortal lo usa para el
   * recordatorio de un proceso que pasó a pausa cuando el mensaje sigue al cotizador. Sin él, el recordatorio va antes.
   */
  defer?: (fn: () => Promise<void>) => void;
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

/** Un botón del portal que ya no responde a ninguna pregunta (venció, ya se respondió o se canceló). */
export const STALE_BUTTON = "Ese botón ya no está vigente (la pregunta venció o ya se respondió). Escríbeme lo que necesitas.";

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
 * "¿Es una cotización nueva o tu respuesta?" (P4 / P5 del router): el texto espera la respuesta y `prev` es el paso que
 * estaba en curso. *Cotización nueva* -> `prev` a pausa y el texto al cotizador; *Es mi respuesta* -> `prev` vuelve a estar
 * pendiente y responde con el texto. Otra cosa: `prev` pasa a pausa (nunca se pierde) y el mensaje sigue su camino.
 */
export const ROUTE_CHOICE = "route_choice";
export interface RouteChoiceStep extends PendingStep {
  kind: typeof ROUTE_CHOICE;
  text: string;
  prev: PendingStep | null;
}
/** Botones (títulos ≤ 20 caracteres de WhatsApp: "Es una cotización nueva" no cabe). */
export const ROUTE_CHOICE_BUTTONS = [
  { id: "cotizacion nueva", title: "Cotización nueva" },
  { id: "es mi respuesta", title: "Es mi respuesta" },
];

function routeChoiceAnswer(text: string): "quote" | "answer" | null {
  const t = fold(text).replace(/^(?:es\s+)?(?:una?\s+)?/, "");
  if (/^(?:1|cotizacion nueva|cotizacion|nueva|nueva cotizacion|cotizar)$/.test(t)) return "quote";
  if (/^(?:2|mi respuesta|respuesta|la respuesta)$/.test(t)) return "answer";
  return null;
}

// la respuesta se atiende en routePortal (necesita pausar y volver al cotizador); registrado para que el paso cuente como vigente
registerPendingHandler(ROUTE_CHOICE, async () => false);
// `cancelar` con la pregunta abierta: cancela también lo que estaba en curso (una OC queda cancelada, como siempre)
registerPendingDrop(ROUTE_CHOICE, async (dctx, step, reason) => {
  const prev = (step as RouteChoiceStep).prev;
  const hook = prev ? getPendingDrop(prev.kind) : undefined;
  return hook && prev ? hook(dctx, prev, reason) : null;
});

/** El paso real detrás de una pregunta de enrutamiento. */
const unwrap = (step: PendingStep | null): PendingStep | null => (step?.kind === ROUTE_CHOICE ? ((step as RouteChoiceStep).prev ?? null) : step);

const clip = (s: string, max = 60) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** En pausa (corrida D, punto 7): el mensaje que esperaba "¿cotización o reporte?". */
registerPausable("intent_choice", {
  async describe(_ctx, step) {
    const t = String((step as IntentChoiceStep).text ?? "");
    return { companyId: null, label: `tu mensaje «${t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t}»`, missing: "falta decir si es cotización o reporte" };
  },
  async resume(ctx, step, prefix) {
    await askAgain(ctx, step, prefix, AMBIGUOUS_QUESTION);
  },
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
  // botón / fila de un mensaje interactivo del portal (id `pt:…`): es del portal aunque el cotizador esté a mitad de un
  // flujo (un "sí" de un botón viejo nunca debe confirmar una cotización); si ya no responde a nada, se dice
  const portalButton = msg.type === "interactive" && isPortalId(msg.interactiveId) && !!text;

  // nada de esto puede ser del portal: va al cotizador (antes, los avisos pendientes si los hay). Una nota de voz con el
  // cotizador a mitad de un flujo también es del cotizador (router, regla 6).
  if (msg.forwarded || (!cmd && !cancel && !portalButton && (isAudio ? quoteStep !== "idle" : hasMedia || quoteStep !== "idle" || !text))) {
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
    d = cmd || portalButton ? await decide() : await withTimeout(decide(), routeTimeout(input));
  } catch (err) {
    if (cmd || portalButton) throw err;
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
  if ((cmd?.name === "portal" || portalButton) && !active) {
    await input.reply(NOT_REGISTERED);
    return true;
  }
  if (!active) return false;

  // procesos en pausa vencidos (48 h): se descartan avisando (antes de responder, como los avisos pendientes)
  try {
    const expired = await withTimeout(expirePaused(dctx), routeTimeout(input));
    if (expired.length) await input.reply(expired.join("\n"));
  } catch (err) {
    log(`portal: no pude revisar los procesos en pausa: ${(err as Error).message}`);
  }

  /** Procesos que este mensaje pasó a pausa: se recuerdan al final de la respuesta (después del cotizador si va allí). */
  const pausedNow: string[] = [];
  // un paso pendiente que venció (2 h) tampoco se pierde: pasa a pausa
  const stale = rawPendingOf(conv);
  if (stale && !pendingOf(conv, now)) {
    try {
      const real = unwrap(stale);
      const p = real && getPausable(real.kind) ? await pauseStep(dctx, real) : null;
      await clearPending(store, from);
      if (p) pausedNow.push(p.ref);
    } catch (err) {
      log(`portal: no pude pasar a pausa el paso vencido: ${(err as Error).message}`);
    }
  }

  let pending: PendingStep | null = pendingOf(conv, now);
  // un paso sin manejador todavía no captura mensajes
  let live = pending && getPendingHandler(pending.kind) ? pending : null;

  /** Deja el paso en curso: a pausa si su tipo lo permite (y se recuerda al final); si no, se descarta como antes. */
  const leave = async (step: PendingStep | null, reason: DropReason): Promise<void> => {
    if (!step) return;
    const real = unwrap(step);
    if (reason !== "cancel" && real && getPausable(real.kind)) {
      try {
        const p = await pauseStep(dctx, real);
        await clearPending(store, from);
        if (p) pausedNow.push(p.ref);
        return;
      } catch (err) {
        log(`portal: no pude pasar a pausa el paso pendiente: ${(err as Error).message}`);
      }
    }
    await dropPending(input, dctx, step, reason);
  };

  const mentionsFor = async (): Promise<boolean | null> => {
    if (cmd || isAudio || quoteStep !== "idle" || isQuoterCommand(text)) return false;
    const sig = textSignals(text);
    const words = fold(text).split(" ").filter(Boolean).length;
    if (sig.strongQuote || sig.strongReport || sig.weakReport || words < 1 || words > 15) return false;
    try {
      return await withTimeout(mentionsKnownCompany(store, text), routeTimeout(input));
    } catch (err) {
      log(`portal: no pude buscar empresas en el texto, sigue el cotizador: ${(err as Error).message}`);
      return null;
    }
  };
  let mentions = false;
  if (!live) {
    const m = await mentionsFor();
    if (m === null) return false;
    mentions = m;
  }

  const ctx: PortalContext = {
    store,
    user: active,
    from,
    msg,
    reply: input.reply,
    replyButtons: async (body, buttons, opts = {}) => {
      await deliverInteractive({ type: "button", body, footer: opts.footer, buttons: portalButtons(buttons) }, { send: input.replyInteractive, sendText: input.reply, log }, opts.fallback);
    },
    replyList: async (body, buttonLabel, rows, opts = {}) => {
      const sections = [{ ...(opts.sectionTitle ? { title: opts.sectionTitle } : {}), rows: portalRows(rows) }];
      await deliverInteractive({ type: "list", body, footer: opts.footer, button: buttonLabel, sections }, { send: input.replyInteractive, sendText: input.reply, log }, opts.fallback);
    },
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

  /** Registra la regla en `messages` (route_rule), recuerda lo que pasó a pausa y devuelve si el portal atendió. */
  const finish = async (handled: boolean, rule: RouteRule, what: string): Promise<boolean> => {
    if (input.logMessage) {
      const body = `${rule} → ${what}${pausedNow.length ? ` · a pausa: ${pausedNow.join(", ")}` : ""}`;
      await input.logMessage({ phone: from, direction: "in", kind: "route", body, routeRule: rule }).catch((err: Error) => log(`portal: no pude registrar la regla: ${err.message}`));
    }
    if (pausedNow.length) {
      const remind = () => sendPauseReminders(ctx, store, from, [...pausedNow], log);
      if (!handled && input.defer) input.defer(remind);
      else await remind();
    }
    return handled;
  };

  // continuar / descartar / guardar un proceso en pausa (botones del recordatorio, o escrito con el cotizador en idle)
  const resume = !cmd && !hasMedia && (quoteStep === "idle" || portalButton) ? parseResume(text) : null;
  if (resume) {
    const list = pausedOf(await store.getPortalConversation(from));
    const target = findPaused(list, resume.arg);
    if (target) {
      // retomar con el cotizador a mitad de flujo: las respuestas irían al cotizador. Revisando una cotización ya guardada,
      // ese paso se cierra; con una a medio armar, se pide terminarla primero (el proceso sigue en pausa)
      // (*Sí, guardar* de un reporte ya resumido no deja preguntas: no hace falta)
      const busy = resume.verb === "descartar" || (resume.verb === "guardar" && target.confirm) ? null : await quoterBlocksResume(ctx, quoteStep);
      if (busy) {
        await input.reply(busy);
        return finish(true, "reanudar", "cotizador ocupado");
      }
      pausedNow.push(...(await resumePaused(ctx, resume.verb, target, live)));
      return finish(true, "reanudar", `${resume.verb} ${target.step.kind}`);
    }
    if (portalButton) {
      await input.reply(STALE_BUTTON);
      return finish(true, "boton", "vencido");
    }
    if (list.length && resume.arg) {
      await input.reply(`No encuentro «${resume.arg}» en pausa. Tienes: ${list.map((p) => `*${p.ref}.* ${p.label}`).join(" · ")}`);
      return finish(true, "reanudar", "no encontrado");
    }
  }

  // respuesta a "¿cotización nueva o tu respuesta?"
  if (live?.kind === ROUTE_CHOICE) {
    const s = live as RouteChoiceStep;
    const ans = cmd ? null : routeChoiceAnswer(text);
    if (ans === "quote") {
      await clearPending(store, from);
      if (s.prev) {
        const p = await pauseStep(dctx, s.prev);
        if (p) pausedNow.push(p.ref);
      }
      await ctx.requote(s.text);
      return finish(true, "4_ambiguo", "cotización nueva");
    }
    if (ans === "answer") {
      await clearPending(store, from);
      const prev = s.prev;
      const handler = prev ? getPendingHandler(prev.kind) : undefined;
      if (!prev || !handler) {
        await input.reply("Ya no hay una pregunta abierta para esa respuesta. Escríbeme lo que necesitas.");
        return finish(true, "4_ambiguo", "respuesta sin pregunta");
      }
      const { createdAt: _c, ...rest } = prev;
      await setPending(store, from, rest, now);
      const fresh = { ...rest, createdAt: now.toISOString() } as PendingStep;
      if (!(await handler(ctx, fresh, s.text))) {
        const pz = getPausable(prev.kind);
        if (pz) await pz.resume(ctx, fresh, `No entendí «${clip(s.text)}» como respuesta.`);
        else await input.reply(`No entendí «${clip(s.text)}» como respuesta. Escríbela de otra forma o *cancelar*.`);
      }
      return finish(true, "3_respuesta", "es mi respuesta");
    }
    if (portalButton && !cmd) {
      await input.reply(STALE_BUTTON);
      return finish(true, "boton", "vencido");
    }
    // otra cosa: lo que estaba en curso pasa a pausa y el mensaje sigue su camino
    await leave(s, "quoter");
    pending = null;
    live = null;
    const m = await mentionsFor();
    if (m === null) return finish(false, "cotizador", "store lento");
    mentions = m;
  }

  if (portalButton && !cmd) {
    // respuesta a la pregunta en curso (sí / corregir / igual / el número de la lista), o un botón que ya no aplica
    if (live && (await getPendingHandler(live.kind)!(ctx, live, text))) return finish(true, "boton", live.kind);
    await input.reply(STALE_BUTTON);
    return finish(true, "boton", "vencido");
  }
  const base = { text, hasMedia, mediaType: msg.type, state: quoteStep, isPortalUser: true, forwarded: msg.forwarded, mentionsKnownCompany: mentions, now };
  let decision = routeIntent({ ...base, pendingPortalStep: live });
  let intent: Intent = decision.intent;

  if (intent === "portal_command" && cmd) {
    // un comando nuevo deja atrás la pregunta anterior: pasa a pausa (`oc` a la misma empresa la retoma él mismo)
    if (pending) await leave(pending, "command");
    const handler = getPortalCommand(cmd.name);
    if (handler) await handler(ctx, cmd.args);
    else await input.reply(comingSoon(cmd.name));
    return finish(true, "comando", cmd.name);
  }

  /** Pregunta "¿cotización nueva o tu respuesta?" con dos botones; el paso en curso queda guardado dentro. */
  const askRoute = async (step: PendingStep, rule: RouteRule, notUnderstood: boolean): Promise<boolean> => {
    const pz = getPausable(step.kind);
    const info = pz ? await pz.describe(dctx, step).catch(() => null) : null;
    const about = info ? ` (${info.label}: ${info.missing})` : "";
    const rc: Omit<RouteChoiceStep, "createdAt"> = { kind: ROUTE_CHOICE, text, prev: step };
    await setPending(store, from, rc, now);
    const body = notUnderstood
      ? `No entendí «${clip(text)}» como respuesta a lo que te pregunté${about}. ¿Es una *cotización nueva* o tu *respuesta*?`
      : `¿«${clip(text)}» es una *cotización nueva* o tu *respuesta* a lo que te pregunté${about}?`;
    await replyButtons(ctx, body, ROUTE_CHOICE_BUTTONS);
    return finish(true, rule, "pregunta");
  };

  let dropped = false;
  if (intent === "route_choice" && live) return askRoute(live, decision.rule, false);
  if (intent === "portal_flow" && live) {
    const consumed = await getPendingHandler(live.kind)!(ctx, live, text);
    if (consumed) return finish(true, decision.rule, live.kind);
    // P5: no era respuesta. Sin el paso, ¿es otra cosa clara (reporte, cotización, ambiguo)? Si no, se pregunta.
    const m = await mentionsFor();
    const again = routeIntent({ ...base, mentionsKnownCompany: m === true, pendingPortalStep: null });
    if (again.intent === "passthrough" && getPausable(live.kind) && !isAudio && text) return askRoute(live, "5_no_entendido", true);
    await leave(live, "quoter");
    dropped = true;
    decision = again;
    intent = again.intent;
  }
  if (intent === "report") {
    await handleReport(ctx, text, { occurredAt: occurredAt(msg, now), audio: isAudio && msg.media ? { id: msg.media.id, mimeType: msg.media.mimeType } : null });
    return finish(true, decision.rule, "reporte");
  }
  if (intent === "ambiguous") {
    const step: Omit<IntentChoiceStep, "createdAt"> = { kind: "intent_choice", text, occurredAt: occurredAt(msg, now).toISOString() };
    await setPending(store, from, step, now);
    await input.reply(AMBIGUOUS_QUESTION);
    return finish(true, decision.rule, "¿cotización o reporte?");
  }
  // quote / passthrough: el cotizador. El paso pendiente pasa a pausa (el usuario pasó a otra cosa) y se recuerda después.
  if (pending && !dropped) await leave(pending, "quoter");
  return finish(false, decision.rule, intent === "quote" ? "cotizador (cotización)" : "cotizador");
}

/** Nombre de la fase A: mismo comportamiento que routePortal. */
export const handlePortalCommand = routePortal;
