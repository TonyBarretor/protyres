"use server";
/**
 * "Enviar encuesta" desde la ficha (paso 2: confirmar tras la vista previa). Solo quien puede editar la empresa.
 * Si se envió por correo vuelve con ?aviso=. Si no, el enlace (con su token en claro, que no se guarda en la base) pasa
 * a la ficha en una cookie httpOnly de 10 minutos limitada a la ruta de la empresa, para mostrarlo y copiarlo.
 */
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { canEditCompany } from "@/lib/portal/auth/permissions";
import { requireUser } from "@/lib/portal/auth/session";
import { loadPortalConfig } from "@/lib/portal/config";
import { getPortalStore } from "@/lib/portal/store";
import { chooseContact, sendManualSurvey } from "@/lib/portal/survey/manual";
import { formId } from "@/lib/portal/ui/labels";
import { SURVEY_LINK_COOKIE } from "./survey-link";

export async function sendSurveyAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const store = await getPortalStore();
  const companyId = formId(formData, "companyId");
  const company = companyId ? await store.getCompany(companyId) : null;
  if (!company) redirect("/portal?error=" + encodeURIComponent("Empresa no encontrada."));
  const back = `/portal/empresas/${company.id}`;
  const go = (kind: "aviso" | "error", msg: string, extra = ""): never => redirect(`${back}?${kind}=${encodeURIComponent(msg)}${extra}#encuestas`);
  if (!canEditCompany(user, company)) go("error", "Solo el dueño de la empresa (o el supervisor) puede enviar la encuesta.");

  const contacts = await store.listContacts(company.id);
  const contact = chooseContact(contacts, formId(formData, "contactId"));
  let result;
  try {
    result = await sendManualSurvey(store, { company, contact, user, expiresDays: loadPortalConfig().surveys.expiresDays, env: process.env });
  } catch (err) {
    go("error", `No pude crear la encuesta: ${(err as Error).message}`);
  }
  revalidatePath(back);
  if (result!.mode === "email") go("aviso", `Encuesta enviada por correo a ${result!.to}.`);
  const r = result as Extract<typeof result, { mode: "link" }>;
  (await cookies()).set(SURVEY_LINK_COOKIE, `${r.survey.id}.${r.token}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: back,
    maxAge: 600,
  });
  const msg = r.error ? `No pude enviar el correo (${r.error}). Copia el enlace y reenvíalo por WhatsApp.` : "Encuesta creada. Copia el mensaje y reenvíalo por WhatsApp.";
  go(r.error ? "error" : "aviso", msg, `&encuesta=listo&s=${r.survey.id}`);
}
