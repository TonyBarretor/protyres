/**
 * Corrida J — formularios del portal para empresas fuera del padrón: "Agregar empresa" (Prospectos) y "Vehículos
 * cargados a mano" (ficha). Lógica sin Next (las server actions solo leen la sesión, llaman aquí y redirigen).
 */
import { canEditCompany } from "../auth/permissions";
import { addVehicle, createCompany, findRuc, removeVehicle, type CreateCompanyResult, type NewCompanyData, type VehicleForm } from "../companies/manual";
import type { PriceSizesSource } from "../scoring/recalc";
import type { Company, PortalStore, PortalUser, Sector } from "../store/types";
import { formText, type FormLike } from "./labels";

type UserLike = Pick<PortalUser, "id" | "nombre" | "rol" | "activo">;

/** Crear empresas a mano: vendedor, supervisor y admin activos (el técnico no trabaja la cartera). */
export function canCreateCompany(user: Pick<PortalUser, "rol" | "activo"> | null | undefined): boolean {
  return !!user && user.activo && (user.rol === "vendedor" || user.rol === "supervisor" || user.rol === "admin");
}

/**
 * Cargar o quitar vehículos a mano: quien puede editar la empresa (dueño, supervisor, admin) y solo en las creadas a mano
 * (la flota de las del padrón viene del MTC).
 */
export function canEditManualFleet(user: UserLike | null | undefined, company: Pick<Company, "ownerUserId" | "origen"> | null | undefined): boolean {
  return !!company && company.origen === "manual" && canEditCompany(user, company);
}

const SECTOR_IDS: Sector[] = ["carga", "pasajeros", "mixto"];

const intOrNull = (raw: string): number | null | "bad" => {
  if (!raw) return null;
  const n = Number(raw.replace(/[\s.,]/g, ""));
  return Number.isInteger(n) && n >= 0 ? n : "bad";
};

/** Lo que se escribió en "Agregar empresa" (para volver a llenar el formulario si hay un error). */
export const NEW_COMPANY_FIELDS = ["ruc", "razonSocial", "sector", "departamento", "unidades", "contactoNombre", "contactoCargo", "contactoTelefono"] as const;

export type NewCompanyForm = { ok: true; data: NewCompanyData } | { ok: false; error: string };

/** Formulario "Agregar empresa" -> datos; la validación de fondo (RUC, departamento) la hace createCompany. */
export function parseNewCompanyForm(f: FormLike): NewCompanyForm {
  const rucRaw = formText(f, "ruc", 30);
  const ruc = findRuc(rucRaw)?.ruc ?? rucRaw.replace(/\D/g, "");
  if (!ruc) return { ok: false, error: "Falta el RUC." };
  const razonSocial = formText(f, "razonSocial", 160);
  if (!razonSocial) return { ok: false, error: "Falta la razón social." };
  const sectorRaw = formText(f, "sector", 20);
  const sector = SECTOR_IDS.find((s) => s === sectorRaw) ?? null;
  if (!sector) return { ok: false, error: "Elige el sector." };
  const departamento = formText(f, "departamento", 40);
  if (!departamento) return { ok: false, error: "Elige el departamento." };
  const unidades = intOrNull(formText(f, "unidades", 10));
  if (unidades === "bad") return { ok: false, error: "Unidades: un número entero." };
  const nombre = formText(f, "contactoNombre", 120);
  const cargo = formText(f, "contactoCargo", 120);
  const telefonoRaw = formText(f, "contactoTelefono", 40);
  const telefono = telefonoRaw.replace(/[^\d+]/g, "");
  if (telefonoRaw && telefono.replace(/\D/g, "").length < 6) return { ok: false, error: "Teléfono del contacto inválido." };
  if (!nombre && (cargo || telefono)) return { ok: false, error: "El contacto necesita un nombre." };
  return { ok: true, data: { ruc, razonSocial, sector, departamento, unidades, contacto: nombre ? { nombre, cargo: cargo || null, telefono: telefono || null } : null } };
}

export type CreateFromFormResult = CreateCompanyResult | { ok: false; error: string; forbidden: true };

/** "Agregar empresa": permiso, formulario y alta (o la empresa que ya tiene ese RUC). */
export async function createCompanyFromForm(store: PortalStore, user: UserLike, f: FormLike, opts: { prices?: PriceSizesSource | null; now?: Date } = {}): Promise<CreateFromFormResult> {
  if (!canCreateCompany(user)) return { ok: false, error: "Tu rol no puede crear empresas.", forbidden: true };
  const parsed = parseNewCompanyForm(f);
  if (!parsed.ok) return parsed;
  // un RUC que ya está en el portal (aunque no cuadre el dígito verificador: el padrón manda) se muestra, no se duplica
  if (/^\d{11}$/.test(parsed.data.ruc ?? "")) {
    const existing = await store.getCompanyByRuc(parsed.data.ruc!);
    if (existing) return { ok: true, company: existing, created: false };
  }
  return createCompany(store, user, parsed.data, { canal: "portal", now: opts.now, prices: opts.prices ?? null });
}

/** Formulario de un vehículo -> campos (los números vacíos quedan null; el resto lo valida checkVehicle). */
export function parseVehicleForm(f: FormLike): VehicleForm | { error: string } {
  const num = (name: string) => intOrNull(formText(f, name, 6));
  const ejes = num("ejes");
  const llantas = num("llantas");
  const anio = num("anio");
  if (ejes === "bad" || llantas === "bad" || anio === "bad") return { error: "Ejes, llantas y año van en números enteros." };
  return { placa: formText(f, "placa", 12), marca: formText(f, "marca", 40) || null, clase: formText(f, "clase", 40) || null, ejes, llantas, anio, medida: formText(f, "medida", 30) || null };
}

export type VehicleActionResult = { ok: true; mensaje: string } | { ok: false; error: string };

/** Agregar (o corregir) un vehículo cargado a mano desde la ficha. */
export async function addVehicleFromForm(store: PortalStore, user: UserLike, company: Company, f: FormLike, opts: { prices?: PriceSizesSource | null } = {}): Promise<VehicleActionResult> {
  if (!canEditManualFleet(user, company)) return { ok: false, error: company.origen === "manual" ? "Solo el dueño de la empresa (o supervisor) puede cargar vehículos." : "La flota de esta empresa viene del padrón del MTC." };
  const form = parseVehicleForm(f);
  if ("error" in form) return { ok: false, error: form.error };
  const r = await addVehicle(store, user, company, form, { prices: opts.prices ?? null });
  if (!r.ok) return r;
  return { ok: true, mensaje: r.updated ? `Vehículo ${r.vehicle.placa} actualizado.` : `Vehículo ${r.vehicle.placa} agregado.` };
}

/** Quitar un vehículo cargado a mano desde la ficha. */
export async function removeVehicleFromForm(store: PortalStore, user: UserLike, company: Company, vehicleId: number | null, opts: { prices?: PriceSizesSource | null } = {}): Promise<VehicleActionResult> {
  if (!canEditManualFleet(user, company)) return { ok: false, error: "Solo el dueño de la empresa (o supervisor) puede quitar vehículos." };
  if (!vehicleId || !(await removeVehicle(store, user, company, vehicleId, { prices: opts.prices ?? null }))) return { ok: false, error: "Vehículo no encontrado." };
  return { ok: true, mensaje: "Vehículo quitado." };
}
