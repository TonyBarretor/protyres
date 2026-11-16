/**
 * `prepropuesta <empresa>` -> la pre-propuesta en PDF (4 páginas) como documento SIN leyenda, luego un mensaje aparte
 * ("📄 Pre-propuesta para *EMPRESA* lista: …") y la actividad `prepropuesta` en la empresa. Varias coincidencias ->
 * lista numerada y sigue al elegir. Si falta un dato obligatorio (p. ej. el vendedor no está en config/pilot.json), lo dice
 * y no manda nada. Solo la genera el vendedor dueño (o cualquier vendedor si no tiene dueño), supervisor o admin.
 */
import { canGeneratePrepropuesta } from "../../auth/permissions";
import { generatePrepropuesta, logPrepropuesta, PrepropuestaError } from "../../prepropuesta";
import type { Company } from "../../store/types";
import { fmtInt } from "../../ui/labels";
import { resolveCompany } from "../companies";
import { userErrorText } from "../../../guard/user-text";
import { registerCompanyAction, registerPortalCommand, type PortalContext } from "../registry";

export const PREPROPUESTA_USAGE = "Escríbelo así: *prepropuesta ZBUSS* (o con el RUC).";

async function sendPrepropuesta(ctx: PortalContext, company: Company): Promise<void> {
  if (!canGeneratePrepropuesta(ctx.user, company)) {
    await ctx.reply(`⚠️ La pre-propuesta de *${company.razonSocial}* solo la genera su vendedor dueño, un supervisor o un admin.`);
    return;
  }
  let gen;
  try {
    gen = await generatePrepropuesta(ctx.store, company.id, ctx.user, ctx.now);
  } catch (err) {
    if (err instanceof PrepropuestaError) {
      await ctx.reply(`⚠️ No pude generar la pre-propuesta de *${company.razonSocial}*. ${userErrorText(err)}`);
      return;
    }
    throw err;
  }
  await ctx.sendDocument(gen.pdf, gen.fileName, "", "application/pdf");
  await logPrepropuesta(ctx.store, gen, ctx.user, "whatsapp", ctx.now);
  const e = gen.data.empresa;
  const flota = `${fmtInt(e.unidades)} unidades${e.llantasPiso !== null ? `, ${fmtInt(e.llantasPiso)} llantas en piso` : ""}`;
  await ctx.reply(
    `📄 Pre-propuesta para *${e.razonSocial}* lista: ${gen.pages} páginas (quiénes somos, casos con cifras, su flota: ${flota}, y qué proponemos) con tus datos de contacto. Reenvíala al cliente o llévala a la visita.`,
  );
}

registerCompanyAction("prepropuesta", (ctx, company) => sendPrepropuesta(ctx, company));

registerPortalCommand("prepropuesta", async (ctx, args) => {
  if (!args.trim()) {
    await ctx.reply(`¿Para qué empresa? ${PREPROPUESTA_USAGE}`);
    return;
  }
  const company = await resolveCompany(ctx, args, "prepropuesta");
  if (company) await sendPrepropuesta(ctx, company);
});
