/**
 * Sesión del portal en componentes de servidor y server actions.
 *
 * src/proxy.ts solo mira si existe la cookie (barato); la verificación real está aquí: requireUser() lee la cookie,
 * la valida contra el store y devuelve el usuario, o redirige a /portal/login (que explica cómo pedir el enlace).
 * Cada página o acción de /portal debe llamar a requireUser() (el layout no basta para las server actions).
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getPortalStore } from "../store";
import type { PortalUser } from "../store/types";
import { LOGIN_PATH, SESSION_COOKIE } from "./constants";
import { getSessionUser } from "./tokens";

export { canEditCompany, canSeeAll } from "./permissions";

/** Usuario de la sesión actual o null. Memorizado por petición (layout + página = una sola consulta). */
export const getCurrentUser = cache(async (): Promise<PortalUser | null> => {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!value) return null;
  return getSessionUser(await getPortalStore(), value);
});

/** Usuario de la sesión; sin sesión válida redirige a /portal/login. */
export async function requireUser(): Promise<PortalUser> {
  const user = await getCurrentUser();
  if (!user) redirect(LOGIN_PATH);
  return user;
}
