/**
 * Filtros de "Prospectos" (/portal): searchParams de la URL <-> CompanySearch del store, y enlaces que conservan los
 * filtros (paginación, accesos rápidos de marca). Puro: sin Next ni store.
 *
 * Parámetros: q, dep, sector, flota (rango), marca (repetible), tipo (cliente|prospecto), orden, p (página).
 */
import type { CompanyOrder, CompanySearch, Sector } from "../store/types";

export type SearchParamsLike = Record<string, string | string[] | undefined>;

export const PAGE_SIZE = 50;

export const FLEET_RANGES = [
  { id: "10-19", label: "10–19 unidades", min: 10, max: 19 },
  { id: "20-49", label: "20–49 unidades", min: 20, max: 49 },
  { id: "50-99", label: "50–99 unidades", min: 50, max: 99 },
  { id: "100-299", label: "100–299 unidades", min: 100, max: 299 },
  { id: "300+", label: "300 o más", min: 300, max: undefined },
] as const;

export type FleetRangeId = (typeof FLEET_RANGES)[number]["id"];

export const SECTORS: { id: Sector; label: string }[] = [
  { id: "carga", label: "Carga" },
  { id: "pasajeros", label: "Pasajeros" },
  { id: "mixto", label: "Mixto" },
];

export const ORDERS: { id: CompanyOrder; label: string }[] = [
  { id: "unidades", label: "Unidades" },
  { id: "llantas", label: "Llantas en piso" },
  { id: "participacion", label: "Participación" },
];

/**
 * Accesos rápidos de marca: cada uno selecciona exactamente esas marcas. El padrón registra algunas con el nombre del
 * fabricante: CNHTC (China National Heavy Duty Truck) = Sinotruk/Howo/Sitrak; SHAANQI = Shacman.
 */
export const BRAND_SHORTCUTS: { label: string; marcas: string[] }[] = [
  { label: "Scania", marcas: ["SCANIA"] },
  { label: "Hino", marcas: ["HINO"] },
  { label: "Shacman", marcas: ["SHACMAN", "SHAANQI"] },
  { label: "Sinotruk/Howo/Sitrak", marcas: ["SINOTRUK", "HOWO", "SITRAK", "CNHTC"] },
];

export interface ProspectFilters {
  q: string;
  departamento: string | null;
  sector: Sector | null;
  flota: FleetRangeId | null;
  /** Mayúsculas, sin repetir, en el orden recibido. */
  marcas: string[];
  tipo: "cliente" | "prospecto" | null;
  orden: CompanyOrder;
  page: number;
}

function all(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map((s) => s.trim()).filter(Boolean);
}

function one(v: string | string[] | undefined): string {
  return all(v)[0] ?? "";
}

/** Marca comparable (igual que el store): mayúsculas y espacios simples. Acepta "a, b" en un solo valor. */
export function parseMarcas(v: string | string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of all(v)) {
    for (const part of raw.split(",")) {
      const m = part.trim().replace(/\s+/g, " ").toUpperCase();
      if (m && !out.includes(m)) out.push(m);
    }
  }
  return out;
}

export function parseProspectFilters(sp: SearchParamsLike): ProspectFilters {
  const sector = one(sp.sector);
  const flota = one(sp.flota);
  const tipo = one(sp.tipo);
  const orden = one(sp.orden);
  const page = Number.parseInt(one(sp.p), 10);
  return {
    q: one(sp.q).slice(0, 100),
    departamento: one(sp.dep) || null,
    sector: SECTORS.some((s) => s.id === sector) ? (sector as Sector) : null,
    flota: FLEET_RANGES.some((r) => r.id === flota) ? (flota as FleetRangeId) : null,
    marcas: parseMarcas(sp.marca),
    tipo: tipo === "cliente" || tipo === "prospecto" ? tipo : null,
    orden: ORDERS.some((o) => o.id === orden) ? (orden as CompanyOrder) : "unidades",
    page: Number.isFinite(page) && page >= 1 ? page : 1,
  };
}

export function toCompanySearch(f: ProspectFilters, now?: Date): CompanySearch {
  const range = f.flota ? FLEET_RANGES.find((r) => r.id === f.flota) : undefined;
  const s: CompanySearch = { orderBy: f.orden, page: f.page, pageSize: PAGE_SIZE };
  if (f.q) s.q = f.q;
  if (f.departamento) s.departamento = [f.departamento];
  if (f.sector) s.sector = [f.sector];
  if (range) {
    s.minUnits = range.min;
    if (range.max !== undefined) s.maxUnits = range.max;
  }
  if (f.marcas.length) s.marcas = f.marcas;
  if (f.tipo) s.esCliente = f.tipo === "cliente";
  if (now) s.now = now;
  return s;
}

/** Query string ("?..." o "") de los filtros; `patch` cambia campos (cambiar filtros vuelve a la página 1 salvo que se pase `page`). */
export function filtersQuery(f: ProspectFilters, patch: Partial<ProspectFilters> = {}): string {
  const g: ProspectFilters = { ...f, page: 1, ...patch };
  const p = new URLSearchParams();
  if (g.q) p.set("q", g.q);
  if (g.departamento) p.set("dep", g.departamento);
  if (g.sector) p.set("sector", g.sector);
  if (g.flota) p.set("flota", g.flota);
  for (const m of g.marcas) p.append("marca", m);
  if (g.tipo) p.set("tipo", g.tipo);
  if (g.orden !== "unidades") p.set("orden", g.orden);
  if (g.page > 1) p.set("p", String(g.page));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** true si el acceso rápido es exactamente la selección actual. */
export function isShortcutActive(f: ProspectFilters, marcas: string[]): boolean {
  return f.marcas.length === marcas.length && marcas.every((m) => f.marcas.includes(m));
}

export function hasActiveFilters(f: ProspectFilters): boolean {
  return !!(f.q || f.departamento || f.sector || f.flota || f.marcas.length || f.tipo);
}

export function pageCount(total: number, pageSize = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
