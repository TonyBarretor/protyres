"use server";
/**
 * Corrida J: "Agregar empresa" (Prospectos). La lógica y el permiso están en lib/portal/ui/empresa-nueva.ts; aquí se lee
 * la sesión, se crea (o se encuentra la que ya tiene ese RUC) y se va a su ficha. Con un error se vuelve al formulario
 * con lo escrito y ?error= (funciona sin JavaScript).
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/portal/auth/session";
import { getPortalStore } from "@/lib/portal/store";
import { createCompanyFromForm, NEW_COMPANY_FIELDS } from "@/lib/portal/ui/empresa-nueva";
import { formText } from "@/lib/portal/ui/labels";

export async function createCompanyAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const store = await getPortalStore();
  const r = await createCompanyFromForm(store, user, formData);
  if (!r.ok) {
    if ("forbidden" in r) redirect(`/portal?${new URLSearchParams({ error: r.error })}`);
    const params = new URLSearchParams({ error: r.error });
    for (const k of NEW_COMPANY_FIELDS) {
      const v = formText(formData, k, 160);
      if (v) params.set(k, v);
    }
    redirect(`/portal/empresas/nueva?${params}`);
  }
  await store.flush();
  revalidatePath("/portal", "layout");
  const aviso = r.created ? "Empresa creada y asignada a ti, con su oportunidad en Prospecto. No está en el padrón del MTC: carga sus vehículos abajo." : "Ese RUC ya está en el portal: esta es la empresa (no se duplicó).";
  redirect(`/portal/empresas/${r.company.id}?${new URLSearchParams({ aviso })}`);
}
