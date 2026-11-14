/**
 * `mejores` (corrida G, punto 5; también "mis mejores flotas", "¿cuáles son mis mejores flotas?" escrito o por voz) ->
 * las 5 flotas de mayor puntaje que no son de otro vendedor (scoring/best.ts: sin dueño y propias sin actividad
 * reciente), cada una con su nivel y la explicación de una línea, presentadas como estimación. Va con una lista de
 * WhatsApp cuyas filas son `asignarme <RUC>` (elegir una = escribir el comando) y, si hay más, una fila *Ver 5 más*.
 *
 * Deja un paso pendiente (`mejores`) con las empresas ya mostradas: `más` / `siguientes` / `otras` trae las 5 siguientes
 * del ranking sin repetir (aunque entretanto se haya asignado alguna) y, al terminar, "no hay más". Otro texto no es
 * respuesta: el paso se deja y el mensaje sigue su camino (un reporte es reporte).
 *
 * Sin cálculo de puntajes todavía: una línea clara. El técnico ve la lista sin filas para asignarse (canAssignSelf).
 * Al final, una sola vez por usuario, el aviso de validar el ranking (bot/ranking-notice.ts).
 */
import { fold } from "../../../tyre/brands";
import { loadPortalConfig } from "../../config";
import { bestFleets } from "../../scoring/best";
import { explainLine, NIVEL_LABEL } from "../../scoring/explain";
import type { BestCompany } from "../../store/types";
import { canAssignSelf } from "../../ui/permissions";
import { shortName } from "../companies";
import { rankingNotice } from "../ranking-notice";
import { registerPendingHandler, registerPortalCommand, replyList, type PortalContext } from "../registry";
import { clearPending, setPending, type PendingStep } from "../state";
import { LIST_ROW_DESCRIPTION_MAX, LIST_ROWS_MAX } from "../../../whatsapp/interactive";

export const MEJORES_STEP = "mejores";
export const MEJORES_NOT_READY = "⏳ El ranking de mejores flotas aún no está listo. Pruébalo más tarde o pregúntale a tu supervisor.";
export const MEJORES_EMPTY = "No encontré flotas libres para ti en el ranking: las de mejor puntaje ya tienen dueño o las trabajaste hace poco.";
export const MEJORES_NO_MORE = "No hay más flotas en tu lista. Escribe *mejores* para verla de nuevo desde el inicio.";
const ESTIMATE_SHORT = "_Es una estimación con el padrón y tus ventas: orienta a quién llamar primero, no decide._";
const MORE_ID = "más";
/** Cuántas empresas mostradas se recuerdan (para no repetir con `más`). */
const MAX_SEEN = 200;

interface MejoresStep extends PendingStep {
  kind: typeof MEJORES_STEP;
  /** Ids de las empresas ya mostradas, en orden. */
  seen: number[];
}

/** "más", "mas", "ver más", "siguientes", "otras", "las siguientes 5", "dame más" (y el id de la fila *Ver 5 más*). */
const MORE_RE = /^(?:(?:ver|dame|muestrame|y)\s+)?(?:(?:las|unas)\s+)?(?:mas|siguientes|otras)(?:\s+(?:\d{1,2}|cinco))?(?:\s+(?:flotas|empresas))?$/;

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

function itemLines(c: BestCompany, n: number, withRuc: boolean): string[] {
  const nivel = c.nivel ? ` · ${NIVEL_LABEL[c.nivel]}` : "";
  const tuya = c.propia ? " · _ya es tuya_" : "";
  const ruc = withRuc ? ` · RUC ${c.ruc}` : "";
  const why = explainLine(c.scoreDetalle);
  return [`*${n}. ${c.razonSocial}*${nivel}${tuya}${ruc}`, ...(why ? [why] : [])];
}

/** Una tanda: las `size` siguientes del ranking que no están en `seen`. */
async function nextBatch(ctx: PortalContext, seen: number[], size: number): Promise<{ rows: BestCompany[]; total: number; before: number }> {
  const cfg = loadPortalConfig().scoring;
  // las ya vistas que sigan en la lista están entre las primeras seen.length + size: se pide eso y se filtra
  const res = await bestFleets(ctx.store, ctx.user, cfg, { now: ctx.now, limit: seen.length + size, offset: 0 });
  const skip = new Set(seen);
  const rows = res.rows.filter((c) => !skip.has(c.id)).slice(0, size);
  return { rows, total: res.total, before: res.rows.filter((c) => skip.has(c.id)).length };
}

async function showBatch(ctx: PortalContext, seen: number[]): Promise<void> {
  const size = Math.min(loadPortalConfig().scoring.mejores.bot, LIST_ROWS_MAX - 1);
  const { rows, total, before } = await nextBatch(ctx, seen, size);
  if (!rows.length) {
    await clearPending(ctx.store, ctx.from);
    await ctx.reply(seen.length ? MEJORES_NO_MORE : MEJORES_EMPTY);
    return;
  }
  // posición en la lista: después de las ya vistas que siguen en ella
  const start = before + 1;
  const end = before + rows.length;
  const more = total > end;
  const allSeen = [...seen, ...rows.map((c) => c.id)].slice(-MAX_SEEN);
  // el paso queda también tras la última tanda: un `más` entonces responde "no hay más"
  const step: Omit<MejoresStep, "createdAt"> = { kind: MEJORES_STEP, seen: allSeen };
  await setPending(ctx.store, ctx.from, step, ctx.now);

  const canAssign = canAssignSelf(ctx.user, { ownerUserId: null });
  const head = [`⭐ *Tus mejores flotas* · ${start}–${end} de ${total}`, ESTIMATE_SHORT];
  const items = (withRuc: boolean) => rows.flatMap((c, i) => ["", ...itemLines(c, start + i, withRuc)]);
  const moreHint = more ? `*más* trae las siguientes ${Math.min(size, total - end)}.` : "Son todas.";
  if (!canAssign) {
    await ctx.reply([...head, ...items(false), "", `_Solo vendedores y supervisores se asignan empresas._ ${moreHint}`].join("\n"));
  } else {
    const body = [...head, ...items(false), "", `Elige una en la lista para asignártela. ${moreHint}`].join("\n");
    const fallback = [...head, ...items(true), "", `Para tomar una: *asignarme <RUC>*. ${moreHint}`].join("\n");
    const listRows = rows.map((c) => ({
      id: `asignarme ${c.ruc}`,
      title: shortName(c.razonSocial),
      description: clip([c.propia ? "Ya es tuya" : "", c.nivel ? NIVEL_LABEL[c.nivel] : "", explainLine(c.scoreDetalle)].filter(Boolean).join(" · "), LIST_ROW_DESCRIPTION_MAX),
    }));
    if (more) listRows.push({ id: MORE_ID, title: `Ver ${Math.min(size, total - end)} más`, description: "Las siguientes del ranking" });
    await replyList(ctx, body, "Elegir flota", listRows, { fallback });
  }
  const notice = await rankingNotice(ctx);
  if (notice) await ctx.reply(notice);
}

registerPortalCommand("mejores", async (ctx) => {
  if (!(await ctx.store.latestScoreRun())) {
    await ctx.reply(MEJORES_NOT_READY);
    return;
  }
  await showBatch(ctx, []);
});

registerPendingHandler(MEJORES_STEP, async (ctx, step, text) => {
  if (!MORE_RE.test(fold(text ?? ""))) return false;
  const seen = Array.isArray(step.seen) ? (step.seen as unknown[]).filter((x): x is number => typeof x === "number") : [];
  await showBatch(ctx, seen);
  return true;
});
