/**
 * `estado <empresa>` (corrida D, punto 7): los 7 pasos del proceso comercial con la empresa (hecho / pendiente / omitido,
 * derivados de lo registrado: bot/progress.ts), la próxima acción con fecha y lo que haya en pausa con ella. Acepta nombre
 * o RUC y texto de más (como `empresa`). Es una consulta: no lleva línea de avance.
 */
import { formatLimaDateTime } from "../../ui/time";
import type { Company } from "../../store/types";
import { resolveCompany, shortName, splitCompany, unusedNote } from "../companies";
import { pauseLine } from "../pause";
import { nextStep, processFacts, processSteps, stepAction, type StepState } from "../progress";
import { registerCompanyAction, registerPortalCommand, type PortalContext } from "../registry";
import { pausedOf } from "../state";

const MARK: Record<StepState, string> = { hecho: "✅", pendiente: "⬜", omitido: "⏭️" };

export async function companyStatus(ctx: PortalContext, company: Company, note = ""): Promise<string> {
  const { store, now } = ctx;
  const facts = await processFacts(store, company);
  const steps = processSteps(facts);
  const lines = [`📋 *Estado con ${shortName(company.razonSocial)}*`];
  if (note) lines.push(note);
  for (const s of steps) lines.push(`${MARK[s.state]} ${s.n}. ${s.name} — ${s.state}`);
  // próxima acción: la de la oportunidad abierta (con su fecha), si no la próxima cita, y si no el siguiente paso
  const opp = facts.opportunity && !facts.opportunity.closedAt ? facts.opportunity : null;
  const appts = (await store.listAppointments({ companyId: company.id, from: now })).filter((a) => a.estado !== "cancelada").sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const next = nextStep(steps);
  // los 7 pasos hechos: proceso completo (una cita que siga en agenda se muestra como tal, no como próxima acción)
  if (!next && !opp) lines.push("", `Proceso completo.${appts[0] ? ` Cita en agenda: ${formatLimaDateTime(appts[0].startsAt)}.` : ""}`);
  else if (opp?.proximaAccion?.trim()) lines.push("", `Próxima acción: *${opp.proximaAccion.trim()}* — ${opp.proximaAccionAt ? formatLimaDateTime(opp.proximaAccionAt) : "_sin fecha_"}`);
  else if (appts[0]) lines.push("", `Próxima acción: *visita* — ${formatLimaDateTime(appts[0].startsAt)}`);
  else if (next) lines.push("", `Próxima acción: *${stepAction(next)}* — _sin fecha_`);
  else lines.push("", "Proceso completo.");
  const paused = pausedOf(await store.getPortalConversation(ctx.from)).filter((p) => p.companyId === company.id);
  for (const p of paused) lines.push(pauseLine(p));
  return lines.join("\n");
}

async function showStatus(ctx: PortalContext, company: Company, note = ""): Promise<void> {
  await ctx.reply(await companyStatus(ctx, company, note));
}

registerCompanyAction("estado", (ctx, company) => showStatus(ctx, company));

registerPortalCommand("estado", async (ctx, args) => {
  const split = await splitCompany(ctx.store, args);
  const note = split ? unusedNote(split.rest) : "";
  const company = await resolveCompany(ctx, split?.query ?? args, "estado", {}, { note });
  if (company) await showStatus(ctx, company, note);
});
