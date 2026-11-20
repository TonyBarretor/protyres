/**
 * ventas-odoo: configuración de "Subir ventas" en config/portal.json → `sales` (además de `sales.columnMap`, que lee
 * xlsx.ts para el formato simple).
 *
 *  - uploadRoles: roles que pueden subir ventas (página y servidor). Por defecto admin, supervisor y vendedor.
 *  - excludeStatus: valores de STATUS cuyas líneas no cuentan (se guardan marcadas como excluidas).
 *  - creditNoteAmountOnlyReasons: motivos de nota de crédito ("Reversión de: F003-4319, AJUSTE DE PRECIO") que solo
 *    corrigen el monto: restan montos pero no neumáticos (la mercadería no volvió).
 *  - leasingRucs: RUC de entidades de leasing (bancos); sus ventas sin cliente final van a "Por asignar cliente final".
 *  - vendorAliases: texto del VENDEDOR (sin importar mayúsculas ni tildes) → nombre del usuario del portal.
 *  - vendorsWithoutOwner: textos del VENDEDOR que no son una persona ("Facturación", "Administrator"): quedan como texto.
 */
import { z } from "zod";
import { loadPortalConfig } from "../config";
import type { UserRole } from "../store/types";

const ROLES = ["admin", "supervisor", "vendedor", "tecnico"] as const;

const SalesOdooSchema = z.looseObject({
  uploadRoles: z.array(z.enum(ROLES)).default(["admin", "supervisor", "vendedor"]),
  excludeStatus: z.array(z.string()).default(["Cancelado", "Borrador"]),
  creditNoteAmountOnlyReasons: z.array(z.string()).default(["DESCUENTO", "AJUSTE DE PRECIO"]),
  leasingRucs: z.array(z.string().regex(/^\d{11}$/)).default(["20100047218", "20100130204", "20100053455"]),
  vendorAliases: z.record(z.string(), z.string()).default({}),
  vendorsWithoutOwner: z.array(z.string()).default(["Facturación", "Administrator"]),
});

export type SalesSettings = z.infer<typeof SalesOdooSchema>;

export const DEFAULT_SALES_SETTINGS: SalesSettings = SalesOdooSchema.parse({});

/** config/portal.json → sales (valores por defecto si falta o no se puede leer). */
export function loadSalesSettings(file?: string): SalesSettings {
  let raw: unknown = {};
  try {
    raw = (loadPortalConfig(file ? { file } : {}) as Record<string, unknown>).sales ?? {};
  } catch {
    return DEFAULT_SALES_SETTINGS;
  }
  const parsed = SalesOdooSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`config/portal.json: "sales" inválido: ${parsed.error.message}`);
  return parsed.data;
}

/** true si el rol puede subir ventas según sales.uploadRoles. */
export function roleCanUploadSales(rol: UserRole | string | null | undefined, settings: SalesSettings = loadSalesSettings()): boolean {
  return !!rol && (settings.uploadRoles as string[]).includes(rol);
}
