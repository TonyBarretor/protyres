/**
 * Datos variables de la pre-propuesta: la empresa (padrón MTC del store del portal), su flota por marca, las medidas
 * probables (inferidas), la participación si hay ventas (marcada DEMO si alguna es demo) y el vendedor que la genera
 * (config/pilot.json `salespeople`, cruzado por el número de WhatsApp del usuario del portal).
 *
 * Nada se inventa: un dato opcional que falta se deja en null y su bloque o fila no se dibuja; si falta uno obligatorio
 * (razón social, RUC, unidades, contacto del vendedor), validatePrepropuesta() lo lista y el generador no hace el PDF.
 */
import { loadSettings, type Settings } from "../../settings";
import { probableSizes } from "../bot/companies";
import { defaultSince, digits } from "../store/shared";
import type { Confianza, PortalStore, PortalUser } from "../store/types";
import { yearRange } from "../ui/fleet";
import { sectorLabel } from "../ui/labels";
import { limaDateKey } from "../ui/time";

/** Filas de flota por marca y clase que entran en la tabla (el resto va en una fila "Otras"). */
export const TOP_FLEET_ROWS = 6;
export const TOP_SIZES = 3;

export interface FleetRow {
  marca: string;
  clase: string;
  /** "2008–2025"; null si el padrón no trae años. */
  anios: string | null;
  unidades: number;
  /** Suma de llantas (MTC) de las unidades con dato; null si ninguna lo tiene. */
  llantas: number | null;
}

export interface SizeRow {
  medida: string;
  unidades: number;
  confianza: Confianza | null;
}

export interface PrepropuestaData {
  /** "AAAA-MM-DD" (Lima). */
  fecha: string;
  /** "11 de noviembre de 2026". */
  fechaTexto: string;
  empresa: {
    id: number;
    razonSocial: string;
    ruc: string;
    sector: string | null;
    departamento: string | null;
    unidades: number;
    llantasPiso: number | null;
    antiguedadMedia: number | null;
    /** Primer contacto de la ficha ("Carlos Quispe, jefe de flota"). */
    atencion: string | null;
  };
  flota: {
    filas: FleetRow[];
    /** Lo que no entra en las filas: grupos, unidades y llantas; null si no sobra nada. */
    otras: { grupos: number; unidades: number; llantas: number | null } | null;
    medidas: SizeRow[];
  };
  participacion: { cantidad: number; demo: boolean } | null;
  vendedor: {
    nombre: string;
    cargo: string | null;
    telefono: string;
    email: string;
    direccion: string | null;
  };
}

export class PrepropuestaError extends Error {
  constructor(
    message: string,
    readonly missing: string[] = [],
  ) {
    super(message);
    this.name = "PrepropuestaError";
  }
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** "2026-11-11" -> "11 de noviembre de 2026". */
export function fechaLarga(key: string): string {
  const [y, m, d] = key.split("-").map((s) => Number.parseInt(s, 10));
  return `${d} de ${MESES[m - 1]} de ${y}`;
}

type SalespeopleMap = Settings["salespeople"];

/** Vendedor de config/pilot.json por número de WhatsApp (sin "default": la firma es de quien la genera). */
export function salespersonForUser(salespeople: SalespeopleMap, user: Pick<PortalUser, "whatsapp">): PrepropuestaData["vendedor"] {
  const key = digits(user.whatsapp ?? "");
  const sp = key ? salespeople[key] : undefined;
  const v = sp && typeof sp === "object" ? sp : null;
  const clean = (s: string | undefined | null) => (s ?? "").trim();
  return {
    nombre: clean(v?.name),
    cargo: clean(v?.title) || null,
    telefono: clean(v?.phone),
    email: clean(v?.email),
    direccion: clean(v?.address) || null,
  };
}

export interface BuildOptions {
  /** `salespeople` de config/pilot.json (por defecto loadSettings()). */
  salespeople?: SalespeopleMap;
}

export async function buildPrepropuestaData(store: PortalStore, companyId: number, user: PortalUser, now: Date, opts: BuildOptions = {}): Promise<PrepropuestaData> {
  const company = await store.getCompany(companyId);
  if (!company) throw new PrepropuestaError("La empresa ya no está en el padrón.");
  const [groups, contacts, part] = await Promise.all([store.fleetByBrand(company.id), store.listContacts(company.id), store.participation([company.ruc], defaultSince(now))]);

  const sorted = [...groups].sort((a, b) => b.unidades - a.unidades || (a.marca ?? "").localeCompare(b.marca ?? ""));
  const filas: FleetRow[] = sorted.slice(0, TOP_FLEET_ROWS).map((g) => ({
    marca: g.marca?.trim() || "Sin marca",
    clase: g.clase?.trim() || "Sin clase",
    anios: g.anioMin === null && g.anioMax === null ? null : yearRange(g.anioMin, g.anioMax),
    unidades: g.unidades,
    llantas: g.unidadesConLlantas > 0 ? g.llantas : null,
  }));
  const rest = sorted.slice(TOP_FLEET_ROWS);
  const restLlantas = rest.filter((g) => g.unidadesConLlantas > 0);
  const otras = rest.length
    ? { grupos: rest.length, unidades: rest.reduce((n, g) => n + g.unidades, 0), llantas: restLlantas.length ? restLlantas.reduce((n, g) => n + g.llantas, 0) : null }
    : null;

  const p = part[company.ruc];
  const c = contacts[0];
  const salespeople = opts.salespeople ?? loadSettings().salespeople;
  const fecha = limaDateKey(now);
  return {
    fecha,
    fechaTexto: fechaLarga(fecha),
    empresa: {
      id: company.id,
      razonSocial: company.razonSocial.trim(),
      ruc: company.ruc.trim(),
      sector: company.sector ? sectorLabel(company.sector) : null,
      departamento: company.departamento?.trim() || null,
      unidades: company.unidades,
      llantasPiso: company.llantasPiso > 0 ? company.llantasPiso : null,
      antiguedadMedia: company.antiguedadMedia !== null && Number.isFinite(company.antiguedadMedia) && company.antiguedadMedia > 0 ? Math.round(company.antiguedadMedia) : null,
      atencion: c ? `${c.nombre}${c.cargo ? `, ${c.cargo}` : ""}` : null,
    },
    flota: { filas, otras, medidas: probableSizes(groups, TOP_SIZES) },
    participacion: p && p.cantidad > 0 ? { cantidad: p.cantidad, demo: p.demo } : null,
    vendedor: salespersonForUser(salespeople, user),
  };
}

const LABELS: Record<string, string> = {
  "empresa.razonSocial": "razón social",
  "empresa.ruc": "RUC",
  "empresa.unidades": "unidades",
  "vendedor.nombre": "nombre del vendedor",
  "vendedor.telefono": "teléfono del vendedor",
  "vendedor.email": "correo del vendedor",
};

export function missingLabel(field: string): string {
  return LABELS[field] ?? field;
}

const empty = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === "string" && (v.trim() === "" || /^(undefined|null|nan)$/i.test(v.trim()))) || (typeof v === "number" && !Number.isFinite(v));

/**
 * Campos que se verían vacíos en el PDF. Obligatorios: razón social, RUC (11 dígitos), unidades (> 0), nombre, teléfono y
 * correo del vendedor. De lo opcional se revisa lo que sí se dibuja (filas de flota y medidas, participación): un null
 * opcional no cuenta porque su bloque se omite.
 */
export function validatePrepropuesta(data: PrepropuestaData): string[] {
  const out: string[] = [];
  const check = (field: string, v: unknown) => {
    if (empty(v)) out.push(field);
  };
  check("empresa.razonSocial", data.empresa.razonSocial);
  if (empty(data.empresa.ruc) || !/^\d{11}$/.test(data.empresa.ruc)) out.push("empresa.ruc");
  if (empty(data.empresa.unidades) || data.empresa.unidades <= 0) out.push("empresa.unidades");
  check("vendedor.nombre", data.vendedor.nombre);
  check("vendedor.telefono", data.vendedor.telefono);
  check("vendedor.email", data.vendedor.email);
  for (const k of ["sector", "departamento", "atencion"] as const) if (data.empresa[k] !== null) check(`empresa.${k}`, data.empresa[k]);
  for (const k of ["llantasPiso", "antiguedadMedia"] as const) if (data.empresa[k] !== null) check(`empresa.${k}`, data.empresa[k]);
  if (data.vendedor.cargo !== null) check("vendedor.cargo", data.vendedor.cargo);
  data.flota.filas.forEach((f, i) => {
    check(`flota.filas[${i}].marca`, f.marca);
    check(`flota.filas[${i}].clase`, f.clase);
    check(`flota.filas[${i}].unidades`, f.unidades);
    if (f.anios !== null) check(`flota.filas[${i}].anios`, f.anios);
    if (f.llantas !== null) check(`flota.filas[${i}].llantas`, f.llantas);
  });
  if (data.flota.otras) check("flota.otras.unidades", data.flota.otras.unidades);
  data.flota.medidas.forEach((m, i) => {
    check(`flota.medidas[${i}].medida`, m.medida);
    check(`flota.medidas[${i}].unidades`, m.unidades);
  });
  if (data.participacion) check("participacion.cantidad", data.participacion.cantidad);
  return out;
}

/** Lanza PrepropuestaError con un mensaje claro si falta algo visible. */
export function assertPrepropuesta(data: PrepropuestaData): void {
  const missing = validatePrepropuesta(data);
  if (!missing.length) return;
  const vendor = missing.some((m) => m.startsWith("vendedor."));
  const what = missing.map(missingLabel).join(", ");
  const hint = vendor ? " Los datos del vendedor salen de config/pilot.json (salespeople) por su número de WhatsApp." : "";
  throw new PrepropuestaError(`Faltan datos para la pre-propuesta: ${what}.${hint}`, missing);
}
