/**
 * Corrida K — ubicación de la empresa en las tarjetas de Match Venta. El padrón del MTC no trae dirección, teléfono ni
 * correo (ver mtc/ubicacion.ts): la dirección se escribe a mano ("Agregar dirección") y "Cómo llegar" abre mapas con la
 * dirección o, sin ella, una búsqueda por razón social + distrito/departamento (aproximada, y se dice).
 */
import type { Company, PortalStore, PortalUser } from "../store/types";

export const MAX_DIRECCION = 200;

/** Quién puede escribir la dirección: el dueño, cualquiera si no tiene dueño, supervisor y admin. */
export function canEditDireccion(user: Pick<PortalUser, "id" | "rol">, company: Pick<Company, "ownerUserId">): boolean {
  if (user.rol === "supervisor" || user.rol === "admin") return true;
  if (user.rol === "tecnico") return false;
  return company.ownerUserId === null || company.ownerUserId === user.id;
}

export type DireccionResult = { ok: true; company: Company } | { ok: false; error: string };

/** "Agregar dirección": guarda la dirección (vacía la borra) y deja una nota en la actividad. */
export async function setCompanyDireccion(store: PortalStore, user: Pick<PortalUser, "id" | "nombre" | "rol">, companyId: number, direccion: string | null, now: Date = new Date()): Promise<DireccionResult> {
  const company = await store.getCompany(companyId);
  if (!company) return { ok: false, error: "No encuentro esa empresa." };
  if (!canEditDireccion(user, company)) return { ok: false, error: "Solo el dueño de la empresa (o el supervisor) puede cambiar su dirección." };
  const value = (direccion ?? "").replace(/\s+/g, " ").trim() || null;
  if (value && value.length > MAX_DIRECCION) return { ok: false, error: `La dirección es muy larga (máximo ${MAX_DIRECCION} caracteres).` };
  const updated = await store.updateCompany(companyId, { direccion: value });
  if (!updated) return { ok: false, error: "No encuentro esa empresa." };
  await store.addActivity({ companyId, userId: user.id, tipo: "nota", texto: value ? `Dirección: ${value}` : "Dirección borrada.", canal: "portal", occurredAt: now, data: { evento: "direccion" } });
  return { ok: true, company: updated };
}

const title = (s: string) => s.toLowerCase().replace(/(^|[\s/-])([a-záéíóúñ])/g, (_m, a: string, b: string) => a + b.toUpperCase());

/** "Ate, Lima" / "Arequipa" / "" (distrito y departamento, en tipo título). */
export function locationText(c: { distrito?: string | null; provincia?: string | null; departamento: string | null }): string {
  return [c.distrito, c.departamento].filter((x): x is string => !!x).filter((x, i, a) => a.indexOf(x) === i).map(title).join(", ");
}

/**
 * "Cómo llegar": enlace de Google Maps. Con dirección, la dirección + distrito + departamento (exacta); sin ella, la razón
 * social + distrito/departamento (`aproximada: true`: la pantalla avisa que es una búsqueda).
 */
export function directionsLink(c: { razonSocial: string; direccion?: string | null; distrito?: string | null; provincia?: string | null; departamento: string | null }): { url: string; aproximada: boolean } {
  const place = [c.distrito, c.departamento, "Perú"].filter(Boolean).join(", ");
  const q = c.direccion ? `${c.direccion}, ${place}` : `${c.razonSocial}, ${place}`;
  return { url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`, aproximada: !c.direccion };
}
