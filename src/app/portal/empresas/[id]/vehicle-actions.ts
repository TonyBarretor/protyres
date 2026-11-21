"use server";
/**
 * Corrida J: vehículos cargados a mano en la ficha de una empresa creada a mano (marca, clase, ejes, llantas, medida y
 * placa). Permiso y lógica en lib/portal/ui/empresa-nueva.ts; aquí la sesión y la vuelta a la ficha con ?aviso= / ?error=.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/portal/auth/session";
import { getPortalStore } from "@/lib/portal/store";
import { priceSizesSource } from "@/lib/store/price-sizes";
import { addVehicleFromForm, removeVehicleFromForm } from "@/lib/portal/ui/empresa-nueva";
import { formId } from "@/lib/portal/ui/labels";

function back(companyId: number, kind: "aviso" | "error", msg: string): never {
  redirect(`/portal/empresas/${companyId}?${new URLSearchParams({ [kind]: msg })}#vehiculos`);
}

async function load(formData: FormData) {
  const user = await requireUser();
  const store = await getPortalStore();
  const id = formId(formData, "companyId");
  const company = id ? await store.getCompany(id) : null;
  if (!company) redirect(`/portal?${new URLSearchParams({ error: "Empresa no encontrada." })}`);
  return { user, store, company };
}

export async function addManualVehicleAction(formData: FormData): Promise<void> {
  const { user, store, company } = await load(formData);
  const r = await addVehicleFromForm(store, user, company, formData, { prices: priceSizesSource });
  if (!r.ok) back(company.id, "error", r.error);
  await store.flush();
  revalidatePath("/portal", "layout");
  back(company.id, "aviso", r.mensaje);
}

export async function removeManualVehicleAction(formData: FormData): Promise<void> {
  const { user, store, company } = await load(formData);
  const r = await removeVehicleFromForm(store, user, company, formId(formData, "vehicleId"), { prices: priceSizesSource });
  if (!r.ok) back(company.id, "error", r.error);
  await store.flush();
  revalidatePath("/portal", "layout");
  back(company.id, "aviso", r.mensaje);
}
