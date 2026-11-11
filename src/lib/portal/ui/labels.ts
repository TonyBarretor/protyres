/**
 * Etiquetas y formatos de la UI del portal, y lectura de los formularios (FormData) a datos validados. Puro.
 */
import type { Confianza, ContactPatch, Sector, Temperatura, UserRole } from "../store/types";

export const TEMPERATURAS: { id: Temperatura; label: string }[] = [
  { id: "caliente", label: "Caliente" },
  { id: "tibio", label: "Tibio" },
  { id: "frio", label: "Frío" },
];

export function temperaturaLabel(t: Temperatura | null | undefined): string {
  return TEMPERATURAS.find((x) => x.id === t)?.label ?? "Sin temperatura";
}

export function isTemperatura(v: unknown): v is Temperatura {
  return typeof v === "string" && TEMPERATURAS.some((t) => t.id === v);
}

export function sectorLabel(s: Sector | null | undefined): string {
  return s === "carga" ? "Carga" : s === "pasajeros" ? "Pasajeros" : s === "mixto" ? "Mixto" : "—";
}

export function confianzaLabel(c: Confianza | null | undefined): string {
  return c === "alta" ? "alta" : c === "media" ? "media" : c === "baja" ? "baja" : "—";
}

export function rolLabel(r: UserRole): string {
  return r === "vendedor" ? "Vendedor" : r === "supervisor" ? "Supervisor" : r === "tecnico" ? "Técnico" : "Admin";
}

const nf = new Intl.NumberFormat("es-PE");
const money = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 0 });

export function fmtInt(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : nf.format(n);
}

export function fmtMoney(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `US$ ${money.format(n)}`;
}

/** Lo mínimo de FormData que usamos (FormData real o un Map en tests). */
export interface FormLike {
  get(name: string): FormDataEntryValue | null;
}

export function formText(f: FormLike, name: string, max = 200): string {
  const v = f.get(name);
  return typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

export function formId(f: FormLike, name: string): number | null {
  const n = Number.parseInt(formText(f, name, 20), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export type ContactForm = { ok: true; data: Required<ContactPatch> } | { ok: false; error: string };

/** Contacto desde el formulario: nombre obligatorio; teléfono solo dígitos y "+"; email con forma básica. */
export function parseContactForm(f: FormLike): ContactForm {
  const nombre = formText(f, "nombre", 120);
  if (!nombre) return { ok: false, error: "El contacto necesita un nombre." };
  const telefonoRaw = formText(f, "telefono", 40);
  const telefono = telefonoRaw.replace(/[^\d+]/g, "");
  if (telefonoRaw && telefono.replace(/\D/g, "").length < 6) return { ok: false, error: "Teléfono inválido." };
  const email = formText(f, "email", 160).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Email inválido." };
  return {
    ok: true,
    data: { nombre, cargo: formText(f, "cargo", 120) || null, telefono: telefono || null, email: email || null, notas: formText(f, "notas", 500) || null },
  };
}
