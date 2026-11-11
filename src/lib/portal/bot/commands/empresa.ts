/** `empresa <nombre o RUC>` -> ficha corta (o lista para elegir). */
import { formatFicha, resolveCompany } from "../companies";
import { registerCompanyAction, registerPortalCommand, type PortalContext } from "../registry";
import type { Company } from "../../store/types";

async function showCompany(ctx: PortalContext, company: Company): Promise<void> {
  const ficha = await formatFicha(ctx.store, company, { full: false, env: ctx.env, now: ctx.now });
  const mine = company.ownerUserId === ctx.user.id;
  const hint = mine ? "" : company.ownerUserId === null ? `\n\nPara tomarla: *asignarme ${company.ruc}*` : "";
  await ctx.reply(`${ficha}${hint}`);
}

registerCompanyAction("empresa", (ctx, company) => showCompany(ctx, company));

registerPortalCommand("empresa", async (ctx, args) => {
  const company = await resolveCompany(ctx, args, "empresa");
  if (company) await showCompany(ctx, company);
});
