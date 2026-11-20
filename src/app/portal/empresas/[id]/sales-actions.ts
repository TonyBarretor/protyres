"use server";
/**
 * ventas-odoo, punto 9: asignar (o quitar) el cliente final de facturas de leasing, desde la ficha del banco o desde
 * /portal/ventas/leasing/<ruc> (los bancos de leasing no suelen estar en el padrón). La lógica y el permiso están en
 * lib/portal/ui/ventas.ts (assignClienteFinal); aquí se lee la sesión, se guarda y se vuelve a la página de origen con
 * ?cfaviso= o ?cferror= (se muestra dentro del bloque; funciona sin JavaScript).
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/portal/auth/session";
import { getPortalStore } from "@/lib/portal/store";
import { priceSizesSource } from "@/lib/store/price-sizes";
import { formId, formText } from "@/lib/portal/ui/labels";
import { assignClienteFinal } from "@/lib/portal/ui/ventas";

/** Solo la ficha de una empresa o la página de leasing de un banco (evita redirecciones abiertas). */
function safeBack(v: string): string {
  return /^\/portal\/(?:empresas\/\d+|ventas\/leasing\/\d{11})$/.test(v) ? v : "/portal/ventas";
}

function back(path: string, kind: "aviso" | "error", msg: string): never {
  redirect(`${path}?${new URLSearchParams({ [kind === "aviso" ? "cfaviso" : "cferror"]: msg }).toString()}#cliente-final`);
}

export async function assignClienteFinalAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const volver = safeBack(formText(formData, "volver", 200));
  const bankRuc = formText(formData, "bankRuc", 20);
  const quitar = formData.get("accion") === "quitar";
  const targetId = quitar ? null : formId(formData, "clienteFinalId");
  if (!quitar && !targetId) back(volver, "error", "Elige la empresa del cliente final (búscala por nombre o RUC).");
  const documentos = formData
    .getAll("documento")
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.slice(0, 60));
  const store = await getPortalStore();
  const res = await assignClienteFinal(store, { user, bankRuc, documentos, targetCompanyId: targetId, prices: priceSizesSource });
  if (!res.ok) back(volver, "error", res.error);
  await store.flush();
  revalidatePath("/portal", "layout");
  back(volver, "aviso", res.mensaje);
}
