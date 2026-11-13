/**
 * `empresa <nombre o RUC>` -> ficha corta (o lista para elegir). Si la empresa se puede tomar (sin dueño, o supervisor),
 * la ficha lleva el botón *Asignarme* (id `asignarme <RUC>`: lo mismo que escribirlo). Texto de más tras el nombre
 * ("empresa zbuss y dame su ficha") se ignora y se dice en una línea.
 */
import { canAssignSelf } from "../../ui/permissions";
import { formatFicha, resolveCompany, splitCompany, unusedNote } from "../companies";
import { registerCompanyAction, registerPortalCommand, replyButtons, type PortalContext } from "../registry";
import type { Company } from "../../store/types";

async function showCompany(ctx: PortalContext, company: Company, note = ""): Promise<void> {
  const ficha = await formatFicha(ctx.store, company, { full: false, env: ctx.env, now: ctx.now });
  const mine = company.ownerUserId === ctx.user.id;
  const hint = mine ? "" : company.ownerUserId === null ? `\n\nPara tomarla: *asignarme ${company.ruc}*` : "";
  const body = `${note ? `${note}\n` : ""}${ficha}${hint}`;
  if (!mine && canAssignSelf(ctx.user, company)) await replyButtons(ctx, body, [{ id: `asignarme ${company.ruc}`, title: "Asignarme" }], { fallback: body });
  else await ctx.reply(body);
}

registerCompanyAction("empresa", (ctx, company) => showCompany(ctx, company));

registerPortalCommand("empresa", async (ctx, args) => {
  const split = await splitCompany(ctx.store, args);
  const note = split ? unusedNote(split.rest) : "";
  const company = await resolveCompany(ctx, split?.query ?? args, "empresa", {}, { note });
  if (company) await showCompany(ctx, company, note);
});
