/** `hoy` -> acciones vencidas y de hoy, próximas (7 días), sin fecha y citas (misma selección que /portal/hoy). */
import { stageLabel } from "../../stages";
import type { PortalStore } from "../../store/types";
import { appointmentWindow, selectToday } from "../../ui/today";
import { formatLimaDay, formatLimaShort, formatLimaTime } from "../../ui/time";
import { portalBaseUrl } from "../../auth/tokens";
import { registerPortalCommand } from "../registry";
import { pausedExpired, pausedOf, pausedUntil } from "../state";

const MAX_PER_SECTION = 8;

async function namesOf(store: PortalStore, ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const id of new Set(ids)) out.set(id, (await store.getCompany(id))?.razonSocial ?? `empresa ${id}`);
  return out;
}

function capped<T>(list: T[], fmt: (x: T) => string): string[] {
  const lines = list.slice(0, MAX_PER_SECTION).map(fmt);
  if (list.length > MAX_PER_SECTION) lines.push(`• …y ${list.length - MAX_PER_SECTION} más`);
  return lines;
}

registerPortalCommand("hoy", async (ctx) => {
  const { store, user, now } = ctx;
  const opps = await store.listOpportunities({ ownerId: user.id, open: true });
  const { from, to } = appointmentWindow(now);
  const appts = await store.listAppointments({ userId: user.id, from, to });
  const sel = selectToday(opps, appts, now);
  const names = await namesOf(store, [...opps.map((o) => o.companyId), ...appts.map((a) => a.companyId)]);
  const out: string[] = [`📅 *Hoy* · ${formatLimaDay(now)}`];

  const todayCitas = sel.citas.filter((d) => d.esHoy).flatMap((d) => d.citas);
  const laterCitas = sel.citas.filter((d) => !d.esHoy).flatMap((d) => d.citas);
  if (todayCitas.length) {
    out.push("", "*Citas de hoy*");
    out.push(...capped(todayCitas, (a) => `• ${formatLimaTime(a.startsAt)} ${names.get(a.companyId)}${a.lugar ? ` — ${a.lugar}` : ""}${a.conTecnico ? " (con técnico)" : ""}`));
  }
  if (sel.acciones.length) {
    out.push("", "*Acciones*");
    out.push(...capped(sel.acciones, ({ opportunity: o, vencida }) => `• ${vencida ? "⚠️ " : ""}${names.get(o.companyId)}: ${o.proximaAccion?.trim() || stageLabel(o.etapa)}${vencida ? ` _(vencida ${formatLimaShort(o.proximaAccionAt!)})_` : ""}`));
  }
  if (laterCitas.length) {
    out.push("", "*Próximas citas (7 días)*");
    out.push(...capped(laterCitas, (a) => `• ${formatLimaShort(a.startsAt)} ${formatLimaTime(a.startsAt)} ${names.get(a.companyId)}${a.conTecnico ? " (con técnico)" : ""}`));
  }
  if (sel.proximas.length) {
    out.push("", "*Próximas acciones (7 días)*");
    out.push(...capped(sel.proximas, (o) => `• ${formatLimaShort(o.proximaAccionAt!)} ${names.get(o.companyId)}: ${o.proximaAccion?.trim() || stageLabel(o.etapa)}`));
  }
  if (sel.sinFecha.length) {
    out.push("", "*Sin fecha*");
    out.push(...capped(sel.sinFecha, (o) => `• ${names.get(o.companyId)}: ${o.proximaAccion?.trim()}`));
  }
  // procesos en pausa (corrida D, punto 7): se retoman con *continuar N* o se descartan con *descartar N*
  const paused = pausedOf(await store.getPortalConversation(ctx.from)).filter((p) => !pausedExpired(p, now));
  if (paused.length) {
    out.push("", "*En pausa*");
    out.push(...paused.map((p) => `• *${p.ref}.* ${p.label} (${p.missing}) · vence ${formatLimaShort(pausedUntil(p))} ${formatLimaTime(pausedUntil(p))}`));
    out.push(`_Responde *continuar ${paused[0].ref}* o *descartar ${paused[0].ref}*._`);
  }
  if (out.length === 1) {
    out.push("", opps.length ? `Nada pendiente para hoy. Tienes ${opps.length} oportunidad${opps.length === 1 ? "" : "es"} abierta${opps.length === 1 ? "" : "s"} sin próxima acción.` : "No tienes acciones ni citas. Toma una empresa con *asignarme <nombre o RUC>*.");
  }
  out.push("", `Detalle: ${portalBaseUrl(ctx.env)}/portal/hoy`);
  await ctx.reply(out.join("\n"));
});
