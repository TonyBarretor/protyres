/**
 * `enlazar` (cotización recién armada → oportunidad del portal) y `reenviada 032` (pasa a Cotización enviada).
 *
 * Corrida J: si el cliente de la cotización no está en el portal, `enlazar` lo busca de nuevo (resolveCompany con
 * `offerCreate`): una empresa -> se enlaza; varias -> lista; ninguna -> *Crear empresa nueva* / *Buscar otra vez*, y al
 * crearla o elegirla se enlaza (acción por empresa "enlazar").
 */
import { confirmQuoteLink, getLinkStep, linkStepTo, markQuoteForwarded, quoteNumberMatches } from "../../quotes/link";
import { resolveCompany } from "../companies";
import { registerCompanyAction, registerPortalCommand } from "../registry";

registerPortalCommand("enlazar", async (ctx, args) => {
  const step = await getLinkStep(ctx.store, ctx.from, ctx.now);
  const typed = args.trim();
  if (step && step.companyId === null && (!typed || quoteNumberMatches(step.quoteNumber, typed))) {
    const company = await resolveCompany(ctx, step.query || step.ruc || step.razonSocial, "enlazar", {}, { offerCreate: true });
    if (company) await linkStepTo(ctx, step, company);
    return;
  }
  await confirmQuoteLink(ctx, args);
});

registerCompanyAction("enlazar", async (ctx, company) => {
  const step = await getLinkStep(ctx.store, ctx.from, ctx.now);
  if (!step) {
    await ctx.reply("No tengo ninguna cotización por enlazar. Cuando cotices para una empresa del portal te pregunto.");
    return;
  }
  await linkStepTo(ctx, step, company);
});

registerPortalCommand("reenviada", async (ctx, args) => {
  await markQuoteForwarded(ctx, args);
});
