/**
 * `asignarme <nombre o RUC>` -> la empresa pasa al usuario (vendedor: solo si no tiene dueño o ya es suya;
 * supervisor/admin: siempre), oportunidad en Prospecto si no hay una abierta, actividad registrada y la ficha completa.
 * Mismas reglas que el botón "Asignarme" del portal (src/app/portal/actions.ts). Acepta nombre o RUC (`asignarme zbuss`;
 * con varias coincidencias, lista para elegir), relleno ("asígname a la empresa zbuss") y texto de más, que se dice en
 * una línea. Por voz llega igual: una transcripción que empieza con el comando se trata como el comando (bot/report.ts).
 */
import { canAssignSelf } from "../../ui/permissions";
import type { Company } from "../../store/types";
import { formatFicha, resolveCompany, splitCompany, unusedNote } from "../companies";
import { companyProgressLine } from "../progress";
import { registerCompanyAction, registerPortalCommand, type PortalContext } from "../registry";

export async function assignToMe(ctx: PortalContext, company: Company, note = ""): Promise<void> {
  const { store, user } = ctx;
  if (!canAssignSelf(user, company)) {
    const owner = company.ownerUserId ? await store.getUser(company.ownerUserId) : null;
    await ctx.reply(
      user.rol === "tecnico"
        ? "Tu rol no puede asignarse empresas."
        : `*${company.razonSocial}* ya es de ${owner?.nombre ?? "otro vendedor"}. Pide al supervisor que la reasigne.`,
    );
    return;
  }
  const already = company.ownerUserId === user.id;
  let current = company;
  if (!already) current = (await store.setOwner(company.id, user.id)) ?? company;
  let opp = await store.getOpenOpportunity(company.id);
  if (!opp) {
    opp = await store.createOpportunity({ companyId: company.id, ownerUserId: user.id, etapa: "prospecto", createdBy: user.id, at: ctx.now });
  } else if (opp.ownerUserId !== user.id) {
    opp = (await store.updateOpportunity(opp.id, { ownerUserId: user.id })) ?? opp;
  }
  if (!already) {
    const prev = company.ownerUserId ? await store.getUser(company.ownerUserId) : null;
    const texto = prev ? `${user.nombre} se asignó la empresa (antes: ${prev.nombre}).` : `${user.nombre} se asignó la empresa.`;
    // data.evento = "asignacion": hito de inicio para las métricas de tiempos (metrics/timeline.ts)
    await store.addActivity({ companyId: company.id, opportunityId: opp.id, userId: user.id, tipo: "nota", texto, canal: "whatsapp", occurredAt: ctx.now, data: { evento: "asignacion", ownerUserId: user.id, previousOwnerUserId: company.ownerUserId } });
  }
  const ficha = await formatFicha(store, current, { full: true, env: ctx.env, now: ctx.now });
  // tomarla completa el paso 1 del proceso (línea de avance, al final); "ya era tuya" no completa nada
  const progress = already ? "" : await companyProgressLine(store, current, 1);
  await ctx.reply(`${already ? "✔ Ya era tuya." : "✔ Empresa asignada a ti."}${note ? `\n${note}` : ""}\n\n${ficha}${progress ? `\n${progress}` : ""}`);
}

registerCompanyAction("asignarme", (ctx, company) => assignToMe(ctx, company));

registerPortalCommand("asignarme", async (ctx, args) => {
  const split = await splitCompany(ctx.store, args);
  const note = split ? unusedNote(split.rest) : "";
  const company = await resolveCompany(ctx, split?.query ?? args, "asignarme", {}, { note });
  if (company) await assignToMe(ctx, company, note);
});
