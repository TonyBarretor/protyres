/**
 * `asignarme <nombre o RUC>` -> la empresa pasa al usuario (vendedor: solo si no tiene dueño o ya es suya;
 * supervisor/admin: siempre), oportunidad en Prospecto si no hay una abierta, actividad registrada y la ficha completa.
 * Mismas reglas que el botón "Asignarme" del portal (src/app/portal/actions.ts).
 */
import { canAssignSelf } from "../../ui/permissions";
import type { Company } from "../../store/types";
import { formatFicha, resolveCompany } from "../companies";
import { registerCompanyAction, registerPortalCommand, type PortalContext } from "../registry";

export async function assignToMe(ctx: PortalContext, company: Company): Promise<void> {
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
  await ctx.reply(`${already ? "✔ Ya era tuya." : "✔ Empresa asignada a ti."}\n\n${ficha}`);
}

registerCompanyAction("asignarme", (ctx, company) => assignToMe(ctx, company));

registerPortalCommand("asignarme", async (ctx, args) => {
  const company = await resolveCompany(ctx, args, "asignarme");
  if (company) await assignToMe(ctx, company);
});
