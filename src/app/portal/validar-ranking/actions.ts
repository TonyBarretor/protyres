"use server";
/**
 * Envío de /portal/validar-ranking (corrida G, punto 6). Vuelve a leer la sesión y el permiso; guarda solo las empresas
 * respondidas (como mucho 20), con el nivel y el puntaje del sistema leídos de la base en este momento (nunca del
 * formulario). Funciona sin JavaScript: redirige con ?gracias=<n> o ?error=.
 */
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/portal/auth/session";
import { getPortalStore } from "@/lib/portal/store";
import { canValidateRanking } from "@/lib/portal/ui/permissions";
import { buildValidationRows, parseValidationForm } from "@/lib/portal/ui/ranking";

const PATH = "/portal/validar-ranking";

export async function submitRankingValidation(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!canValidateRanking(user)) redirect("/portal");
  const answers = parseValidationForm(formData);
  if (!answers.length) redirect(`${PATH}?error=${encodeURIComponent("Marca al menos una empresa (A, B, C o No la conozco).")}`);
  const store = await getPortalStore();
  const rows = await buildValidationRows(answers, store, user.id);
  const saved = rows.length ? await store.addRankingValidations(rows) : [];
  redirect(`${PATH}?gracias=${saved.length}`);
}
