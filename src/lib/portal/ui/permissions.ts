/**
 * Reglas de las acciones del portal que no cubre auth/permissions.ts. Las server actions las vuelven a comprobar.
 */
import { canEditCompany, canSeeAll, canSeeUsage } from "../auth/permissions";
import { roleCanUploadSales, type SalesSettings } from "../sales/config";
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
 * Subir ventas reales. ventas-odoo, punto 14: los roles salen de config/portal.json → sales.uploadRoles (por defecto admin,
 * supervisor y vendedor). Una carga del reporte de Odoo actualiza sin duplicar (clave estable por línea), cada carga
 * queda en el historial con quién la subió, y si sube un vendedor se avisa al administrador.
 */
export function canUploadSales(user: UserLike | null | undefined, settings?: SalesSettings): boolean {
  return !!user && user.activo && roleCanUploadSales(user.rol, settings);
}

/**
 * ventas-odoo, puntos 8 y 9: el historial de ventas de la ficha (precio, costo, proveedor y margen son internos) y asignar
 * el cliente final de una factura de leasing: vendedor, supervisor y admin activos. El técnico ve la ficha sin este bloque.
 */
export function canSeeSalesHistory(user: UserLike | null | undefined): boolean {
  return !!user && user.activo && (user.rol === "vendedor" || user.rol === "supervisor" || user.rol === "admin");
}

export function canAssignClienteFinal(user: UserLike | null | undefined): boolean {
  return canSeeSalesHistory(user);
}

/**
 * Validar el ranking de atractivo (/portal/validar-ranking, corrida G): vendedor, supervisor y admin. El técnico no
 * trabaja la cartera.
 */
export function canValidateRanking(user: UserLike | null | undefined): boolean {
  return !!user && user.activo && (user.rol === "vendedor" || user.rol === "supervisor" || user.rol === "admin");
}

/** Bloque "Validación del ranking" del Tablero (coincidencia, diferencias y notas): solo el administrador. */
export function canSeeRankingReport(user: UserLike | null | undefined): boolean {
  return canSeeUsage(user);
}
