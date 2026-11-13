/**
 * Procesos en pausa (corrida D, punto 7; reemplaza y generaliza el punto 4 y el `parked` de `oc`).
 *
 * Si el vendedor está en medio de algo con preguntas pendientes (confirmar un reporte, las preguntas del pedido de `oc`,
 * elegir empresa, el día/la hora de una cita, el nombre/la empresa de un contacto, "¿cotización o reporte?") y manda otra
 * cosa (típicamente una cotización, o un comando del portal), el paso NO se descarta: se guarda tal cual en
 * `portal_conversations.state.paused` (empresa, fase y respuestas ya dadas), se atiende el mensaje nuevo completo y al
 * terminar se recuerda: "⏸ Dejaste pendiente: pedido de ZBUSS (falta fecha de entrega)." con los botones *Continuar* y
 * *Descartar* (un reporte que solo espera el *sí*: *Sí, guardar* y *Descartar*). Cuando el mensaje va al cotizador, el
 * recordatorio sale DESPUÉS de la respuesta del cotizador (routePortal lo deja en `defer`, que el handler corre al terminar).
 *
 *  - Ids de los botones = el texto equivalente: `continuar 2`, `descartar 2`, `guardar 2` (2 = referencia del proceso, el
 *    menor número libre). Escrito: `continuar` / `descartar` solos toman el más reciente; `continuar zbuss`, el de esa empresa.
 *  - Continuar: lo vuelve a dejar pendiente (con lo que ya tenía) y repite la pregunta en curso; si había otro proceso en
 *    curso, ese pasa a pausa. Descartar: lo dice y no guarda nada (una OC queda "cancelada", como con `cancelar`).
 *  - Límite: 1 en pausa por empresa y 3 por vendedor. Al superarlo no se pierde nada: el recordatorio pide resolver
 *    primero el más antiguo, con sus botones.
 *  - Caducidad: 48 h (PAUSED_TTL_MS). Se avisa en el siguiente mensaje del vendedor (y el resumen diario los lista con su
 *    vencimiento). Un paso pendiente que venció a las 2 h (PENDING_TTL_MS) tampoco se pierde: pasa a pausa.
 *  - Nada en pausa se guarda como confirmado: guardar exige *Sí, guardar* (o *continuar* y luego *sí*).
 */
import type { ReplyButton } from "../../whatsapp/interactive";
import { fold } from "../../tyre/brands";
import type { PortalStore } from "../store/types";
import { getPausable, getPendingDrop, getPendingHandler, replyButtons, type DropContext, type PortalContext } from "./registry";
import { addPaused, clearPending, MAX_PAUSED_PER_COMPANY, MAX_PAUSED_TOTAL, pausedExpired, pausedOf, removePaused, setPending, type PausedProcess, type PendingStep } from "./state";

export const DISCARDED = (p: Pick<PausedProcess, "label">) => `🗑 Descarté: ${p.label}. No guardé nada.`;
export const EXPIRED = (p: Pick<PausedProcess, "label" | "missing">) => `⌛ Venció (48 h sin retomarlo) y lo descarté: ${p.label} (${p.missing}). No guardé nada.`;

/** "⏸ Dejaste pendiente: pedido de ZBUSS (falta fecha de entrega)." */
export function pauseLine(p: Pick<PausedProcess, "label" | "missing">): string {
  return `⏸ Dejaste pendiente: ${p.label} (${p.missing}).`;
}

export function pauseButtons(p: Pick<PausedProcess, "ref" | "confirm">): ReplyButton[] {
  return p.confirm
    ? [
        { id: `guardar ${p.ref}`, title: "Sí, guardar" },
        { id: `descartar ${p.ref}`, title: "Descartar" },
      ]
    : [
        { id: `continuar ${p.ref}`, title: "Continuar" },
        { id: `descartar ${p.ref}`, title: "Descartar" },
      ];
}

/** Lleva el paso a pausa si su tipo lo permite (registerPausable); null = no se puede pausar (se descarta como antes). */
export async function pauseStep(dctx: DropContext, step: PendingStep): Promise<PausedProcess | null> {
  const pz = getPausable(step.kind);
  if (!pz) return null;
  const info = await pz.describe(dctx, step);
  const { createdAt: _c, ...rest } = step;
  return addPaused(dctx.store, dctx.from, { step: rest as PendingStep, companyId: info.companyId, label: info.label, missing: info.missing, ...(info.confirm ? { confirm: true } : {}), pausedAt: dctx.now.toISOString() });
}

/** Si la lista supera el límite: el más antiguo que hay que resolver (null = dentro del límite). */
export function overLimit(list: PausedProcess[]): { oldest: PausedProcess; why: string } | null {
  const byCompany = new Map<number, PausedProcess[]>();
  for (const p of list) if (p.companyId !== null) byCompany.set(p.companyId, [...(byCompany.get(p.companyId) ?? []), p]);
  const crowded = [...byCompany.values()].find((l) => l.length > MAX_PAUSED_PER_COMPANY);
  if (crowded) return { oldest: crowded[0], why: `Tienes ${crowded.length} procesos en pausa con la misma empresa (máximo ${MAX_PAUSED_PER_COMPANY}).` };
  if (list.length > MAX_PAUSED_TOTAL) return { oldest: list[0], why: `Tienes ${list.length} procesos en pausa (máximo ${MAX_PAUSED_TOTAL}).` };
  return null;
}

type Channel = Pick<PortalContext, "reply" | "replyButtons">;

/**
 * Recordatorio de los procesos `refs` que siguen en pausa (uno por mensaje, con sus botones). Si se superó el límite, el
 * último pide además resolver el más antiguo y lleva los botones de ese. Nunca lanza.
 */
export async function sendPauseReminders(ch: Channel, store: PortalStore, phone: string, refs: string[], log: (m: string) => void): Promise<void> {
  if (!refs.length) return;
  try {
    const list = pausedOf(await store.getPortalConversation(phone));
    const now = list.filter((p) => refs.includes(p.ref));
    const limit = overLimit(list);
    for (let i = 0; i < now.length; i++) {
      const p = now[i];
      if (limit && i === now.length - 1) {
        const o = limit.oldest;
        const body = `${pauseLine(p)}\n${limit.why} Resuelve primero el más antiguo: ${o.label} (${o.missing}).`;
        await replyButtons(ch, body, pauseButtons(o));
      } else {
        await replyButtons(ch, pauseLine(p), pauseButtons(p));
      }
    }
  } catch (err) {
    log(`portal: no pude mandar el recordatorio de lo pendiente: ${(err as Error).message}`);
  }
}

// ── continuar / descartar / guardar ──

export type ResumeVerb = "continuar" | "descartar" | "guardar";

/** `continuar`, `continuar 2`, `retomar zbuss`, `descartar 1`, `sí, guardar 3` (texto plegado). */
const RESUME_RE = /^(continuar|retomar|descartar|guardar|si guardar)(?:\s+(.+))?$/;

export function parseResume(text: string): { verb: ResumeVerb; arg: string } | null {
  const m = RESUME_RE.exec(fold(text ?? ""));
  if (!m) return null;
  const verb: ResumeVerb = m[1] === "descartar" ? "descartar" : m[1] === "continuar" || m[1] === "retomar" ? "continuar" : "guardar";
  return { verb, arg: (m[2] ?? "").trim() };
}

/** El proceso al que se refiere `arg`: la referencia, o una parte del nombre ("zbuss"); sin arg, el más reciente. */
export function findPaused(list: PausedProcess[], arg: string): PausedProcess | null {
  if (!list.length) return null;
  if (!arg) return list[list.length - 1];
  const byRef = list.find((p) => p.ref === arg);
  if (byRef) return byRef;
  const hits = list.filter((p) => fold(p.label).includes(arg));
  return hits.length ? hits[hits.length - 1] : null;
}

/** Descarta (sin guardar nada): corre el descarte del tipo como `cancelar` (una OC queda cancelada). Nunca lanza. */
export async function discardPaused(dctx: DropContext, p: PausedProcess): Promise<void> {
  try {
    const hook = getPendingDrop(p.step.kind);
    if (hook) await hook(dctx, p.step, "cancel");
  } catch (err) {
    dctx.log(`portal: no pude cerrar lo descartado (${p.step.kind}): ${(err as Error).message}`);
  }
}

/**
 * Los procesos en pausa vencidos (48 h) se sacan y se descartan; devuelve los avisos para el usuario (uno por proceso).
 */
export async function expirePaused(dctx: DropContext): Promise<string[]> {
  const list = pausedOf(await dctx.store.getPortalConversation(dctx.from));
  const out: string[] = [];
  for (const p of list) {
    if (!pausedExpired(p, dctx.now)) continue;
    await removePaused(dctx.store, dctx.from, p.ref);
    await discardPaused(dctx, p);
    out.push(EXPIRED(p));
  }
  return out;
}

/**
 * Continuar / guardar / descartar `p` (ya elegido). `live` = el paso en curso: con continuar/guardar pasa a pausa (se
 * devuelve su referencia para el recordatorio). Continuar repite la pregunta en curso; guardar responde *sí* al paso.
 */
export async function resumePaused(ctx: PortalContext, verb: ResumeVerb, p: PausedProcess, live: PendingStep | null): Promise<string[]> {
  const dctx: DropContext = { store: ctx.store, from: ctx.from, now: ctx.now, log: ctx.log };
  await removePaused(ctx.store, ctx.from, p.ref);
  if (verb === "descartar") {
    await discardPaused(dctx, p);
    await ctx.reply(DISCARDED(p));
    return [];
  }
  const refs: string[] = [];
  if (live) {
    const parked = await pauseStep(dctx, live);
    if (parked) refs.push(parked.ref);
    else {
      const hook = getPendingDrop(live.kind);
      if (hook) await hook(dctx, live, "command");
    }
    await clearPending(ctx.store, ctx.from);
  }
  const pz = getPausable(p.step.kind);
  const handler = getPendingHandler(p.step.kind);
  if (verb === "guardar" && handler) {
    const { createdAt: _c, ...rest } = p.step;
    await setPending(ctx.store, ctx.from, rest, ctx.now);
    await handler(ctx, { ...rest, createdAt: ctx.now.toISOString() } as PendingStep, "sí");
    return refs;
  }
  if (pz) await pz.resume(ctx, p.step, `▶️ Retomo: ${p.label}.`);
  else await ctx.reply(`No puedo retomar eso (${p.label}); empieza de nuevo, por favor.`);
  return refs;
}

/** Deja `step` pendiente otra vez (con hora nueva: vuelve a tener sus 2 h) y repite la pregunta. Para los `resume` simples. */
export async function askAgain(ctx: PortalContext, step: PendingStep, prefix: string, question: string): Promise<void> {
  const { createdAt: _c, ...rest } = step;
  await setPending(ctx.store, ctx.from, rest, ctx.now);
  await ctx.reply(prefix ? `${prefix}\n\n${question}` : question);
}
