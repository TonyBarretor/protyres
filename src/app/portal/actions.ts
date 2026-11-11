"use server";
/**
 * Server actions del portal (ficha y pipeline). Cada una vuelve a leer la sesión (requireUser) y comprueba permisos
 * contra los datos del store: no se confía en que la página solo muestre el botón a quien puede.
 * Al terminar redirigen a la página de origen con ?aviso= o ?error= (funciona sin JavaScript).
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canEditCompany } from "@/lib/portal/auth/permissions";
import { requireUser } from "@/lib/portal/auth/session";
import { isStageId, stageLabel } from "@/lib/portal/stages";
import { getPortalStore } from "@/lib/portal/store";
import type { PortalStore, PortalUser } from "@/lib/portal/store/types";
import { formId, formText, isTemperatura, parseContactForm, temperaturaLabel, type FormLike } from "@/lib/portal/ui/labels";
import { canAssignSelf, canEditOpportunity, canReassign } from "@/lib/portal/ui/permissions";
import { parseLimaLocal } from "@/lib/portal/ui/time";

/** Solo rutas internas del portal (evita redirecciones abiertas con un "volver" manipulado). */
function safeBack(f: FormLike, fallback: string): string {
  const v = formText(f, "volver", 500);
  return v.startsWith("/portal") && !v.startsWith("//") && !v.includes("\\") ? v : fallback;
}

function done(path: string, kind: "aviso" | "error", msg: string): never {
  const url = new URL(path, "http://x");
  url.searchParams.delete("aviso");
  url.searchParams.delete("error");
  url.searchParams.set(kind, msg);
  redirect(`${url.pathname}${url.search}`);
}

const companyPath = (id: number) => `/portal/empresas/${id}`;

async function loadCompany(f: FormLike) {
  const user = await requireUser();
  const store = await getPortalStore();
  const companyId = formId(f, "companyId");
  const company = companyId ? await store.getCompany(companyId) : null;
  if (!company) done("/portal", "error", "Empresa no encontrada.");
  return { user, store, company };
}

async function log(store: PortalStore, user: PortalUser, companyId: number, texto: string, opportunityId: number | null = null, tipo = "nota") {
  await store.addActivity({ companyId, opportunityId, userId: user.id, tipo, texto, canal: "portal" });
}

/**
 * Asignarme (o, para supervisor/admin, asignar a otro con `userId`): fija el dueño, crea una oportunidad en Prospecto si
 * la empresa no tiene una abierta (si la tiene, pasa al nuevo dueño) y registra la actividad.
 */
export async function assignCompany(formData: FormData): Promise<void> {
  const { user, store, company } = await loadCompany(formData);
  const back = companyPath(company.id);
  const targetId = formId(formData, "userId") ?? user.id;
  let target: PortalUser | null = user;
  if (targetId !== user.id) {
    if (!canReassign(user)) done(back, "error", "Solo supervisor o admin pueden asignar a otra persona.");
    target = await store.getUser(targetId);
    if (!target || !target.activo) done(back, "error", "Usuario no válido.");
  } else if (!canAssignSelf(user, company)) {
    done(back, "error", "Esta empresa ya tiene dueño. Pide al supervisor que la reasigne.");
  }
  if (company.ownerUserId === target.id) done(back, "aviso", `La empresa ya es de ${target.nombre}.`);

  await store.setOwner(company.id, target.id);
  let opp = await store.getOpenOpportunity(company.id);
  if (!opp) {
    opp = await store.createOpportunity({ companyId: company.id, ownerUserId: target.id, etapa: "prospecto", createdBy: user.id });
  } else if (opp.ownerUserId !== target.id) {
    opp = (await store.updateOpportunity(opp.id, { ownerUserId: target.id })) ?? opp;
  }
  await log(store, user, company.id, target.id === user.id ? `${user.nombre} se asignó la empresa.` : `${user.nombre} asignó la empresa a ${target.nombre}.`, opp.id);
  revalidatePath("/portal", "layout");
  done(back, "aviso", target.id === user.id ? "Empresa asignada a ti." : `Empresa asignada a ${target.nombre}.`);
}

/** Liberar la empresa (sin dueño): supervisor/admin. La oportunidad abierta queda sin dueño. */
export async function releaseCompany(formData: FormData): Promise<void> {
  const { user, store, company } = await loadCompany(formData);
  const back = companyPath(company.id);
  if (!canReassign(user)) done(back, "error", "Solo supervisor o admin pueden liberar una empresa.");
  await store.setOwner(company.id, null);
  const opp = await store.getOpenOpportunity(company.id);
  if (opp) await store.updateOpportunity(opp.id, { ownerUserId: null });
  await log(store, user, company.id, `${user.nombre} liberó la empresa (sin dueño).`, opp?.id ?? null);
  revalidatePath("/portal", "layout");
  done(back, "aviso", "Empresa liberada.");
}

export async function setTemperatura(formData: FormData): Promise<void> {
  const { user, store, company } = await loadCompany(formData);
  const back = companyPath(company.id);
  if (!canEditCompany(user, company)) done(back, "error", "Solo el dueño de la empresa (o supervisor) puede cambiarla.");
  const raw = formText(formData, "temperatura", 20);
  const temperatura = raw === "" ? null : isTemperatura(raw) ? raw : undefined;
  if (temperatura === undefined) done(back, "error", "Temperatura no válida.");
  if (temperatura === company.temperatura) done(back, "aviso", "Sin cambios.");
  await store.updateCompany(company.id, { temperatura });
  await log(store, user, company.id, `Temperatura: ${temperaturaLabel(temperatura)}.`);
  revalidatePath("/portal", "layout");
  done(back, "aviso", "Temperatura guardada.");
}

// ── contactos ──

export async function addContact(formData: FormData): Promise<void> {
  const { user, store, company } = await loadCompany(formData);
  const back = companyPath(company.id);
  if (!canEditCompany(user, company)) done(back, "error", "Solo el dueño de la empresa (o supervisor) puede editar contactos.");
  const parsed = parseContactForm(formData);
  if (!parsed.ok) done(back, "error", parsed.error);
  await store.addContact({ companyId: company.id, ...parsed.data, createdBy: user.id });
  await log(store, user, company.id, `Nuevo contacto: ${parsed.data.nombre}.`);
  revalidatePath(back);
  done(back, "aviso", "Contacto guardado.");
}

async function loadContact(formData: FormData) {
  const ctx = await loadCompany(formData);
  const back = companyPath(ctx.company.id);
  const contactId = formId(formData, "contactId");
  const contact = contactId ? await ctx.store.getContact(contactId) : null;
  if (!contact || contact.companyId !== ctx.company.id) done(back, "error", "Contacto no encontrado.");
  if (!canEditCompany(ctx.user, ctx.company)) done(back, "error", "Solo el dueño de la empresa (o supervisor) puede editar contactos.");
  return { ...ctx, back, contact };
}

export async function updateContact(formData: FormData): Promise<void> {
  const { store, back, contact } = await loadContact(formData);
  const parsed = parseContactForm(formData);
  if (!parsed.ok) done(back, "error", parsed.error);
  await store.updateContact(contact.id, parsed.data);
  revalidatePath(back);
  done(back, "aviso", "Contacto actualizado.");
}

export async function deleteContact(formData: FormData): Promise<void> {
  const { user, store, company, back, contact } = await loadContact(formData);
  await store.deleteContact(contact.id);
  await log(store, user, company.id, `Contacto eliminado: ${contact.nombre}.`);
  revalidatePath(back);
  done(back, "aviso", "Contacto eliminado.");
}

// ── oportunidades ──

async function loadOpportunity(formData: FormData, fallback: string) {
  const user = await requireUser();
  const store = await getPortalStore();
  const back = safeBack(formData, fallback);
  const oppId = formId(formData, "opportunityId");
  const opp = oppId ? await store.getOpportunity(oppId) : null;
  if (!opp) done(back, "error", "Oportunidad no encontrada.");
  const company = await store.getCompany(opp.companyId);
  if (!canEditOpportunity(user, opp, company)) done(back, "error", "Solo el dueño de la oportunidad (o supervisor) puede cambiarla.");
  return { user, store, back, opp, company };
}

/** Mover de etapa (guarda historial vía moveStage) y registra la actividad. */
export async function moveOpportunityStage(formData: FormData): Promise<void> {
  const { user, store, back, opp } = await loadOpportunity(formData, "/portal/pipeline");
  const etapa = formText(formData, "etapa", 40);
  if (!isStageId(etapa)) done(back, "error", "Etapa no válida.");
  if (etapa === opp.etapa) done(back, "aviso", "La oportunidad ya está en esa etapa.");
  await store.moveStage(opp.id, etapa, user.id);
  await log(store, user, opp.companyId, `Etapa: ${stageLabel(opp.etapa)} → ${stageLabel(etapa)}.`, opp.id, "etapa");
  revalidatePath("/portal", "layout");
  done(back, "aviso", `Movida a ${stageLabel(etapa)}.`);
}

/** Próxima acción (texto + fecha/hora de Lima) de la oportunidad; vacío la borra. */
export async function setNextAction(formData: FormData): Promise<void> {
  const { store, back, opp } = await loadOpportunity(formData, "/portal/hoy");
  const texto = formText(formData, "proximaAccion", 300);
  const rawAt = formText(formData, "proximaAccionAt", 30);
  const at = rawAt ? parseLimaLocal(rawAt) : null;
  if (rawAt && !at) done(back, "error", "Fecha de la próxima acción no válida.");
  if (at && !texto) done(back, "error", "Escribe qué hay que hacer.");
  await store.updateOpportunity(opp.id, { proximaAccion: texto || null, proximaAccionAt: at });
  revalidatePath("/portal", "layout");
  done(back, "aviso", texto ? "Próxima acción guardada." : "Próxima acción borrada.");
}
