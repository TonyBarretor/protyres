/**
 * `contacto <empresa>: <nombre>, <cargo>, <teléfono o correo>` -> guarda el contacto de la empresa.
 * El teléfono y el correo se reconocen por su forma (pueden ir los dos, en cualquier orden); lo demás es el cargo.
 * Mismo permiso que en el portal: el dueño de la empresa, o supervisor/admin.
 *
 * Sin el formato exacto (corrida D, punto 3) se toma lo que se entiende: `contacto zbuss Carlos Quispe jefe de flota
 * 987654321` (empresa al inicio, sin dos puntos ni comas: cargo por sus palabras, teléfono y correo por su forma, el resto
 * es el nombre). Si falta el nombre se pregunta (paso contacto_nombre); si falta la empresa, también (contacto_empresa).
 */
import { canEditCompany } from "../../auth/permissions";
import { detectCargo } from "../../report/extract";
import type { Company } from "../../store/types";
import { resolveCompany, shortName, splitCompany, unusedNote } from "../companies";
import { askAgain } from "../pause";
import { companyProgressLine } from "../progress";
import { registerCompanyAction, registerPausable, registerPendingHandler, registerPortalCommand, replyButtons, type PortalContext } from "../registry";
import { clearPending, setPending, type PendingStep } from "../state";

export const CONTACT_USAGE = "Escríbelo así: *contacto ZBUSS: Juan Pérez, jefe de flota, 987654321*";

export interface ParsedContact {
  empresa: string;
  nombre: string;
  cargo: string | null;
  telefono: string | null;
  email: string | null;
}

type ContactData = Omit<ParsedContact, "empresa">;
/** Contacto a medias (falta el nombre o la empresa). */
type PartialContact = Omit<ContactData, "nombre"> & { nombre: string | null };

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

const EMAIL_ANY = /[^\s@,;:]+@[^\s@,;:]+\.[^\s@,;:]+/;
const PHONE_ANY = /\+?\d[\d\s().-]{4,}\d/;
/** Palabras sueltas alrededor de los datos que no son parte del nombre. */
const FILLER = /^(?:es|el|la|de|del|y|cel(?:ular)?|telf?|tel[eé]fono|correo|email|cargo|nombre|contacto|-)$/i;

/**
 * Contacto sin formato: correo y teléfono por su forma (en cualquier parte), cargo por sus palabras (gerente, jefe de
 * flota, encargado de compras…), y el nombre con lo que queda. Con comas se respeta el orden nombre, cargo.
 */
export function parseContactLoose(text: string): PartialContact {
  let t = ` ${text.trim()} `;
  const em = EMAIL_ANY.exec(t);
  const email = em ? em[0].toLowerCase() : null;
  if (em) t = t.replace(em[0], " ");
  let telefono: string | null = null;
  const ph = PHONE_ANY.exec(t);
  if (ph && ph[0].replace(/\D/g, "").length >= 6) {
    telefono = ph[0].replace(/[^\d+]/g, "");
    t = t.replace(ph[0], " ");
  }
  const parts = t
    .split(/[,;\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
  let cargo: string | null = null;
  const names: string[] = [];
  for (const part of parts) {
    const c: string | null = !cargo ? detectCargo(part) : null;
    if (c) {
      cargo = c;
      // lo de antes del cargo, en la misma parte, es el nombre ("Carlos Quispe jefe de flota")
      const at = part.toLowerCase().indexOf(c.toLowerCase());
      const left = at > 0 ? part.slice(0, at) : "";
      if (left.trim()) names.push(left);
    } else if (parts.length > 1 && names.length && !cargo) cargo = part.slice(0, 120);
    else names.push(part);
  }
  const nombre = names
    .join(" ")
    .split(/\s+/)
    .filter((w) => w && !FILLER.test(w))
    .join(" ")
    .replace(/[^\p{L}\s.'-]/gu, "")
    .trim();
  return { nombre: /\p{L}{2}/u.test(nombre) ? nombre.slice(0, 120) : null, cargo, telefono, email };
}

async function saveContact(ctx: PortalContext, company: Company, c: ContactData & { note?: string }): Promise<void> {
  if (!canEditCompany(ctx.user, company)) {
    await ctx.reply(`*${company.razonSocial}* no es tuya. Primero: *asignarme ${company.ruc}* (o pide al supervisor).`);
    return;
  }
  const saved = await ctx.store.addContact({ companyId: company.id, nombre: c.nombre, cargo: c.cargo, telefono: c.telefono, email: c.email, createdBy: ctx.user.id });
  const opp = await ctx.store.getOpenOpportunity(company.id);
  await ctx.store.addActivity({ companyId: company.id, opportunityId: opp?.id ?? null, userId: ctx.user.id, tipo: "nota", texto: `Nuevo contacto: ${saved.nombre}.`, canal: "whatsapp", occurredAt: ctx.now });
  const detail = [saved.cargo, saved.telefono, saved.email].filter(Boolean).join(" · ");
  const missing = !saved.telefono && !saved.email ? "\n_Sin teléfono ni correo: agrégalo en la ficha del portal._" : "";
  const progress = await companyProgressLine(ctx.store, company, 2);
  const body = `✔ Contacto guardado en *${company.razonSocial}*:\n${saved.nombre}${detail ? ` · ${detail}` : ""}${missing}${c.note ? `\n${c.note}` : ""}${progress ? `\n${progress}` : ""}`;
  // si lo que sigue es la cita, un botón para agendarla (id `cita <RUC>`: pregunta el día y la hora)
  if (progress.includes("Sigue: agendar la cita")) await replyButtons(ctx, body, [{ id: `cita ${company.ruc}`, title: "Agendar cita" }], { fallback: body });
  else await ctx.reply(body);
}

/** Paso pendiente: la empresa está, falta el nombre del contacto. */
export interface ContactoNombreStep extends PendingStep {
  kind: "contacto_nombre";
  companyId: number;
  contact: PartialContact;
}

/** Paso pendiente: el contacto está, falta la empresa. */
export interface ContactoEmpresaStep extends PendingStep {
  kind: "contacto_empresa";
  contact: PartialContact;
}

async function askName(ctx: PortalContext, company: Company, c: PartialContact): Promise<void> {
  if (!canEditCompany(ctx.user, company)) {
    await ctx.reply(`*${company.razonSocial}* no es tuya. Primero: *asignarme ${company.ruc}* (o pide al supervisor).`);
    return;
  }
  const step: Omit<ContactoNombreStep, "createdAt"> = { kind: "contacto_nombre", companyId: company.id, contact: c };
  await setPending(ctx.store, ctx.from, step, ctx.now);
  await ctx.reply(nameQuestion(company, c));
}

function nameQuestion(company: Company, c: PartialContact): string {
  const detail = [c.cargo, c.telefono, c.email].filter(Boolean).join(" · ");
  return `¿Cómo se llama el contacto de *${company.razonSocial}*${detail ? ` (${detail})` : ""}? Escribe su nombre.`;
}

const companyQuestion = (c: PartialContact) => `¿De qué empresa es ${c.nombre ?? "el contacto"}? Escribe el nombre o el RUC.`;

/** Con la empresa ya escrita: guarda, o pregunta el nombre si falta. */
async function withCompany(ctx: PortalContext, query: string, c: PartialContact, note: string): Promise<void> {
  if (c.nombre) {
    const data = { ...c, nombre: c.nombre, ...(note ? { note } : {}) };
    const company = await resolveCompany(ctx, query, "contacto", data as unknown as Record<string, unknown>, { note });
    if (company) await saveContact(ctx, company, data);
    return;
  }
  const company = await resolveCompany(ctx, query, "contacto_sin_nombre", c as unknown as Record<string, unknown>, { note });
  if (company) await askName(ctx, company, c);
}

registerCompanyAction("contacto", (ctx, company, args) => saveContact(ctx, company, args as unknown as ContactData));
registerCompanyAction("contacto_sin_nombre", (ctx, company, args) => askName(ctx, company, args as unknown as PartialContact));

registerPortalCommand("contacto", async (ctx, args) => {
  const parsed = parseContactArgs(args);
  if (!("error" in parsed)) {
    const { empresa, ...contact } = parsed;
    const company = await resolveCompany(ctx, empresa, "contacto", contact as unknown as Record<string, unknown>);
    if (company) await saveContact(ctx, company, contact);
    return;
  }
  // sin el formato exacto: lo que se entienda, y se pregunta lo que falta
  const colon = args.indexOf(":");
  let query: string | null = null;
  let contactText = args;
  let note = "";
  if (colon >= 0) {
    const empresa = args.slice(0, colon).trim();
    contactText = args.slice(colon + 1);
    if (empresa) {
      const split = await splitCompany(ctx.store, empresa);
      query = split?.query ?? empresa;
      note = split ? unusedNote(split.rest) : "";
    }
  } else {
    const split = await splitCompany(ctx.store, args, { strict: true });
    if (split) {
      query = split.query;
      contactText = split.rest;
    }
  }
  const c = parseContactLoose(contactText);
  // sin empresa reconocible, solo se pregunta si hay un dato de contacto (teléfono, correo o cargo): "contacto andes Juan"
  // puede ser cualquier cosa y recibe el formato
  if ((!c.nombre && !c.telefono && !c.email && !c.cargo) || (!query && !c.telefono && !c.email && !c.cargo)) {
    await ctx.reply(parsed.error);
    return;
  }
  if (!query) {
    const step: Omit<ContactoEmpresaStep, "createdAt"> = { kind: "contacto_empresa", contact: c };
    await setPending(ctx.store, ctx.from, step, ctx.now);
    await ctx.reply(companyQuestion(c));
    return;
  }
  await withCompany(ctx, query, c, note);
});

/** Respuesta a "¿cómo se llama?": un nombre (letras, hasta 6 palabras). Otro texto no es respuesta. */
registerPendingHandler("contacto_nombre", async (ctx, step, text) => {
  const s = step as ContactoNombreStep;
  const t = text.trim().replace(/[.!]+$/, "");
  if (!/^[\p{L}][\p{L}\s.'-]*$/u.test(t) || t.split(/\s+/).length > 6) return false;
  await clearPending(ctx.store, ctx.from);
  const company = await ctx.store.getCompany(s.companyId);
  if (!company) {
    await ctx.reply("Esa empresa ya no está en el padrón.");
    return true;
  }
  await saveContact(ctx, company, { ...s.contact, nombre: t.slice(0, 120) });
  return true;
});

/** Respuesta a "¿de qué empresa?": nombre o RUC. Si no nombra una empresa del padrón, no es respuesta. */
registerPendingHandler("contacto_empresa", async (ctx, step, text) => {
  const s = step as ContactoEmpresaStep;
  const split = await splitCompany(ctx.store, text);
  if (!split) return false;
  await withCompany(ctx, split.query, s.contact, unusedNote(split.rest));
  return true;
});

// ── en pausa (corrida D, punto 7): "contacto de ZBUSS (falta el nombre)"; *Continuar* repite la pregunta ──

registerPausable("contacto_nombre", {
  async describe(ctx, step) {
    const s = step as ContactoNombreStep;
    const c = await ctx.store.getCompany(s.companyId).catch(() => null);
    return { companyId: s.companyId, label: `contacto de ${c ? shortName(c.razonSocial) : "la empresa"}`, missing: "falta el nombre" };
  },
  async resume(ctx, step, prefix) {
    const s = step as ContactoNombreStep;
    const c = await ctx.store.getCompany(s.companyId);
    if (!c) return void (await ctx.reply("Esa empresa ya no está en el padrón."));
    await askAgain(ctx, step, prefix, nameQuestion(c, s.contact));
  },
});

registerPausable("contacto_empresa", {
  async describe(_ctx, step) {
    const s = step as ContactoEmpresaStep;
    return { companyId: null, label: `contacto ${s.contact.nombre ?? "nuevo"}`, missing: "falta la empresa" };
  },
  async resume(ctx, step, prefix) {
    await askAgain(ctx, step, prefix, companyQuestion((step as ContactoEmpresaStep).contact));
  },
});
