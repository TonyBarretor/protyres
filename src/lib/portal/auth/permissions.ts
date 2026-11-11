/**
 * Permisos del portal. Todos ven todas las empresas; editar depende del rol:
 *   vendedor   -> solo las suyas (owner_user_id = su id)
 *   supervisor -> todo
 *   admin      -> todo
 *   tecnico    -> solo lectura
 */
import type { Company, PortalUser } from "../store/types";

type UserLike = Pick<PortalUser, "id" | "rol" | "activo">;

/** Supervisor y admin ven (y gestionan) todo: pipeline de todos, asignar dueños, etc. */
export function canSeeAll(user: UserLike | null | undefined): boolean {
  return !!user && user.activo && (user.rol === "supervisor" || user.rol === "admin");
}

export function canEditCompany(user: UserLike | null | undefined, company: Pick<Company, "ownerUserId"> | null | undefined): boolean {
  if (!user || !user.activo || !company) return false;
  if (user.rol === "supervisor" || user.rol === "admin") return true;
  if (user.rol === "vendedor") return company.ownerUserId === user.id;
  return false;
}
