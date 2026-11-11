/**
 * `contacto <empresa>: <nombre>, <cargo>, <teléfono o correo>` -> guarda el contacto de la empresa.
 * El teléfono y el correo se reconocen por su forma (pueden ir los dos, en cualquier orden); lo demás es el cargo.
 * Mismo permiso que en el portal: el dueño de la empresa, o supervisor/admin.
 */
import { canEditCompany } from "../../auth/permissions";
import type { Company } from "../../store/types";
import { resolveCompany } from "../companies";
import { registerCompanyAction, registerPortalCommand, type PortalContext } from "../registry";

export const CONTACT_USAGE = "Escríbelo así: *contacto ZBUSS: Juan Pérez, jefe de flota, 987654321*";

export interface ParsedContact {
  empresa: string;
  nombre: string;
  cargo: string | null;
  telefono: string | null;
  email: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "ZBUSS: Juan Pérez, jefe de flota, 987 654 321" -> partes; null si falta la empresa o el nombre. */
export function parseContactArgs(args: string): ParsedContact | { error: string } {
  const i = args.indexOf(":");
  if (i < 0) return { error: `Falta la empresa antes de los dos puntos. ${CONTACT_USAGE}` };
  const empresa = args.slice(0, i).trim();
  const parts = args
    .slice(i + 1)
    .split(/[,;\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!empresa) return { error: `Falta la empresa. ${CONTACT_USAGE}` };
  let telefono: string | null = null;
  let email: string | null = null;
  const rest: string[] = [];
  for (const p of parts) {
    const compact = p.replace(/\s+/g, "");
    if (!email && EMAIL_RE.test(compact)) email = compact.toLowerCase();
    else if (!telefono && /^[+\d][\d\s().-]{5,}$/.test(p) && compact.replace(/\D/g, "").length >= 6) telefono = compact.replace(/[^\d+]/g, "");
    else rest.push(p);
  }
  const [nombre, ...cargo] = rest;
  if (!nombre) return { error: `Falta el nombre del contacto. ${CONTACT_USAGE}` };
  return { empresa, nombre: nombre.slice(0, 120), cargo: cargo.length ? cargo.join(", ").slice(0, 120) : null, telefono, email };
}

async function saveContact(ctx: PortalContext, company: Company, c: Omit<ParsedContact, "empresa">): Promise<void> {
  if (!canEditCompany(ctx.user, company)) {
    await ctx.reply(`*${company.razonSocial}* no es tuya. Primero: *asignarme ${company.ruc}* (o pide al supervisor).`);
    return;
  }
  const saved = await ctx.store.addContact({ companyId: company.id, nombre: c.nombre, cargo: c.cargo, telefono: c.telefono, email: c.email, createdBy: ctx.user.id });
  const opp = await ctx.store.getOpenOpportunity(company.id);
  await ctx.store.addActivity({ companyId: company.id, opportunityId: opp?.id ?? null, userId: ctx.user.id, tipo: "nota", texto: `Nuevo contacto: ${saved.nombre}.`, canal: "whatsapp", occurredAt: ctx.now });
  const detail = [saved.cargo, saved.telefono, saved.email].filter(Boolean).join(" · ");
  const missing = !saved.telefono && !saved.email ? "\n_Sin teléfono ni correo: agrégalo en la ficha del portal._" : "";
  await ctx.reply(`✔ Contacto guardado en *${company.razonSocial}*:\n${saved.nombre}${detail ? ` · ${detail}` : ""}${missing}`);
}

registerCompanyAction("contacto", (ctx, company, args) => saveContact(ctx, company, args as unknown as Omit<ParsedContact, "empresa">));

registerPortalCommand("contacto", async (ctx, args) => {
  const parsed = parseContactArgs(args);
  if ("error" in parsed) {
    await ctx.reply(parsed.error);
    return;
  }
  const { empresa, ...contact } = parsed;
  const company = await resolveCompany(ctx, empresa, "contacto", contact as unknown as Record<string, unknown>);
  if (company) await saveContact(ctx, company, contact);
});
