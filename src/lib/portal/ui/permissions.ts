/**
 * Reglas de las acciones del portal que no cubre auth/permissions.ts. Las server actions las vuelven a comprobar.
 */
import { canEditCompany, canSeeAll } from "../auth/permissions";
import type { Company, Opportunity, PortalUser } from "../store/types";

type UserLike = Pick<PortalUser, "id" | "rol" | "activo">;

/**
 * Asignarse una empresa: el vendedor solo si no tiene dueño (o ya es suya: no-op); supervisor/admin siempre
 * (reasignan). Técnico nunca.
 */
export function canAssignSelf(user: UserLike | null | undefined, company: Pick<Company, "ownerUserId"> | null | undefined): boolean {
  if (!user || !user.activo || !company) return false;
  if (canSeeAll(user)) return true;
  return user.rol === "vendedor" && (company.ownerUserId === null || company.ownerUserId === user.id);
}

/** Asignar la empresa a otro usuario (o liberarla): solo supervisor/admin. */
export function canReassign(user: UserLike | null | undefined): boolean {
  return canSeeAll(user);
}

/** Mover etapa / editar la próxima acción: supervisor/admin cualquiera; vendedor las suyas (dueño de la oportunidad o de la empresa). */
export function canEditOpportunity(user: UserLike | null | undefined, opp: Pick<Opportunity, "ownerUserId"> | null | undefined, company?: Pick<Company, "ownerUserId"> | null): boolean {
  if (!user || !user.activo || !opp) return false;
  if (canSeeAll(user)) return true;
  if (user.rol !== "vendedor") return false;
  return opp.ownerUserId === user.id || (!!company && canEditCompany(user, company));
}

/**
 * Subir ventas reales: solo supervisor/admin. Las ventas alimentan la participación que ven todos; un archivo mal subido
 * no se puede deshacer desde el portal (no hay borrado de ventas reales), así que el vendedor no lo hace.
 */
export function canUploadSales(user: UserLike | null | undefined): boolean {
  return canSeeAll(user);
}
