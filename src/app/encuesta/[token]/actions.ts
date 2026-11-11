"use server";
/**
 * Respuesta de la encuesta pública (sin sesión: el token del enlace es la credencial). Valida en el servidor, guarda una
 * sola vez y vuelve a la página con el resultado (funciona sin JavaScript: formulario + redirect).
 */
import { redirect } from "next/navigation";
import { getPortalStore } from "@/lib/portal/store";
import { submitSurvey } from "@/lib/portal/survey/service";
import { isSurveyTokenShape, SURVEY_PATH } from "@/lib/portal/survey/tokens";

export async function submitSurveyAction(formData: FormData): Promise<void> {
  const raw = formData.get("token");
  const token = typeof raw === "string" && isSurveyTokenShape(raw) ? raw : null;
  // el token solo tiene [A-Za-z0-9_-]: la ruta de vuelta no puede salir de /encuesta
  const back = token ? `${SURVEY_PATH}/${token}` : `${SURVEY_PATH}/invalido`;
  if (!token) redirect(back);
  const store = await getPortalStore();
  const r = await submitSurvey(store, token, formData);
  if (r.ok) redirect(`${back}?r=ok`);
  if (r.reason === "datos") redirect(`${back}?error=${r.errors.join(",")}`);
  if (r.reason === "respondida") redirect(`${back}?r=ya`);
  redirect(back);
}
