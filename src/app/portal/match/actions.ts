"use server";
/**
 * Server actions de Match Venta (corrida K). Cada una vuelve a leer la sesión (requireUser) y comprueba permisos contra
 * los datos; no se confía en que la página solo muestre el botón a quien puede. Next compara el Origin con el Host en
 * cada server action (una página de otro sitio no puede dispararlas). Al terminar vuelven a la lista con ?aviso= o
 * ?error= y el ancla de la tarjeta (funciona sin JavaScript).
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/portal/auth/session";
import { loadPortalConfig } from "@/lib/portal/config";
import { recalcMatchSafely, scheduleMatchVisit, setCompanyDireccion, setPriorityAndRecalc } from "@/lib/portal/match";
import { getPortalStore } from "@/lib/portal/store";
import { formId, formText, type FormLike } from "@/lib/portal/ui/labels";
import { assignFromMatch, canEditMatchProduct, canUseMatch, MATCH_PATH, MAX_APLICACION, normalizeCode, parsePlanConfirm, safeMatchBack, visitStart } from "@/lib/portal/ui/match";
import { ownStockSource } from "@/lib/store/own-stock";

function done(back: string, kind: "aviso" | "error", msg: string): never {
  const url = new URL(back, "http://x");
  url.searchParams.delete("aviso");
  url.searchParams.delete("error");
  url.searchParams.set(kind, msg);
  redirect(`${url.pathname}${url.search}${url.hash}`);
}

async function ctx(f: FormLike) {
  const user = await requireUser();
  const back = safeMatchBack(formText(f, "volver", 600));
  if (!canUseMatch(user)) done("/portal", "error", "Tu rol no usa Match Venta.");
  return { user, back, store: await getPortalStore() };
}

/** Prender / quitar la prioridad de un producto del stock propio y recalcular el cruce. */
export async function togglePriority(formData: FormData): Promise<void> {
  const { user, back, store } = await ctx(formData);
  if (!canEditMatchProduct(user)) done(back, "error", "Tu rol no puede marcar prioridades.");
  const code = normalizeCode(formText(formData, "code", 30));
  if (!code) done(back, "error", "Producto no válido.");
  const on = formText(formData, "on", 1) === "1";
  const r = await setPriorityAndRecalc(store, { code, on, user, prices: ownStockSource() });
  await store.flush();
  revalidatePath("/portal", "layout");
  // al quitar la prioridad del producto abierto, volver a la lista de productos
  const to = !on && r.ok && back.includes(`p=${code}`) ? MATCH_PATH : back;
  done(to, r.ok ? "aviso" : "error", r.text.replace(/\*/g, ""));
}

/** Editar la aplicación del producto (afina el cruce para todos): queda con quién la cambió y se recalcula. */
export async function saveAplicacion(formData: FormData): Promise<void> {
  const { user, back, store } = await ctx(formData);
  if (!canEditMatchProduct(user)) done(back, "error", "Tu rol no puede editar la aplicación.");
  const code = normalizeCode(formText(formData, "code", 30));
  if (!code) done(back, "error", "Producto no válido.");
  const raw = formText(formData, "aplicacion", MAX_APLICACION + 1);
  if (raw.length > MAX_APLICACION) done(back, "error", `La aplicación es muy larga (máximo ${MAX_APLICACION} caracteres).`);
  const products = await store.listMatchProducts();
  if (!products.some((p) => p.code === code)) done(back, "error", "Ese producto no está en Match Venta.");
  await store.setMatchApplication(code, raw || null, user.id);
  await recalcMatchSafely({ store, prices: ownStockSource(), why: `aplicación de ${code}` });
  await store.flush();
  revalidatePath("/portal", "layout");
  done(back, "aviso", raw ? `Aplicación de ${code}: ${raw}.` : `Aplicación de ${code} borrada.`);
}

/** Asignármela (solo empresas sin dueño; atómico). */
export async function assignMatch(formData: FormData): Promise<void> {
  const { user, back, store } = await ctx(formData);
  const companyId = formId(formData, "companyId");
  if (!companyId) done(back, "error", "Empresa no encontrada.");
  const r = await assignFromMatch(store, user, companyId);
  await store.flush();
  revalidatePath("/portal", "layout");
  if (!r.ok) done(back, "error", r.error);
  done(back, "aviso", r.text);
}

/** Agendar visita: fecha (hoy, mañana u otra) y hora opcional; asigna si no tiene dueño y queda ligada al producto. */
export async function scheduleMatch(formData: FormData): Promise<void> {
  const { user, back, store } = await ctx(formData);
  const companyId = formId(formData, "companyId");
  const code = normalizeCode(formText(formData, "code", 30));
  if (!companyId || !code) done(back, "error", "Empresa o producto no válido.");
  const when = visitStart({ dia: formText(formData, "dia", 10), fecha: formText(formData, "fecha", 10), hora: formText(formData, "hora", 5) });
  if (!when.ok) done(back, "error", when.error);
  const r = await scheduleMatchVisit(store, { companyId, productCode: code, user, startsAt: when.startsAt, canal: "portal" });
  await store.flush();
  revalidatePath("/portal", "layout");
  done(back, r.ok ? "aviso" : "error", r.text.replace(/\*/g, ""));
}

/** Agregar dirección (dueño, sin dueño o supervisor/admin): la usa "Cómo llegar". */
export async function saveDireccion(formData: FormData): Promise<void> {
  const { user, back, store } = await ctx(formData);
  const companyId = formId(formData, "companyId");
  if (!companyId) done(back, "error", "Empresa no encontrada.");
  const r = await setCompanyDireccion(store, user, companyId, formText(formData, "direccion", 400));
  await store.flush();
  revalidatePath("/portal", "layout");
  if (!r.ok) done(back, "error", r.error);
  done(back, "aviso", r.company.direccion ? "Dirección guardada." : "Dirección borrada.");
}

/** Confirmar el reparto de "Planificar visitas": agenda cada una con su día (y hora) y vuelve a Hoy con el resumen. */
export async function confirmPlan(formData: FormData): Promise<void> {
  const { user, back, store } = await ctx(formData);
  const items = parsePlanConfirm(formData);
  if (!items.length) done(back, "error", "No hay visitas para agendar.");
  const holidays = loadPortalConfig().holidays;
  let creadas = 0;
  let repetidas = 0;
  const fallas: string[] = [];
  for (const it of items) {
    const when = it.fecha && holidays.includes(it.fecha) ? { ok: false as const, error: "feriado" } : visitStart({ dia: "otra", fecha: it.fecha, hora: it.hora });
    if (!when.ok) {
      const c = await store.getCompany(it.companyId);
      fallas.push(`${c?.razonSocial ?? `#${it.companyId}`} (${when.error === "feriado" ? "ese día es feriado" : when.error.replace(/\.$/, "").toLowerCase()})`);
      continue;
    }
    const r = await scheduleMatchVisit(store, { companyId: it.companyId, productCode: it.code, user, startsAt: when.startsAt, canal: "portal" });
    if (!r.ok) fallas.push(r.text.replace(/\*/g, ""));
    else if (r.duplicate) repetidas++;
    else creadas++;
  }
  await store.flush();
  revalidatePath("/portal", "layout");
  const msg = [`Agendé ${creadas} ${creadas === 1 ? "visita" : "visitas"}`, repetidas ? `${repetidas} ya estaban agendadas` : "", fallas.length ? `no pude: ${fallas.join("; ")}` : ""].filter(Boolean).join(" · ");
  if (!creadas && !repetidas) done(back, "error", `${msg}.`);
  done("/portal/hoy", fallas.length ? "error" : "aviso", `${msg}.`);
}

