/**
 * Flota de la ficha: los grupos (marca, clase) del store se juntan por marca con subtotales. Puro.
 */
import type { FleetGroup } from "../store/types";

export interface BrandBlock {
  marca: string;
  unidades: number;
  llantas: number;
  unidadesConLlantas: number;
  anioMin: number | null;
  anioMax: number | null;
  clases: FleetGroup[];
}

const SIN_MARCA = "Sin marca";

export function groupByBrand(groups: FleetGroup[]): BrandBlock[] {
  const m = new Map<string, BrandBlock>();
  for (const g of groups) {
    const marca = g.marca?.trim() || SIN_MARCA;
    let b = m.get(marca);
    if (!b) m.set(marca, (b = { marca, unidades: 0, llantas: 0, unidadesConLlantas: 0, anioMin: null, anioMax: null, clases: [] }));
    b.unidades += g.unidades;
    b.llantas += g.llantas;
    b.unidadesConLlantas += g.unidadesConLlantas;
    if (g.anioMin !== null) b.anioMin = b.anioMin === null ? g.anioMin : Math.min(b.anioMin, g.anioMin);
    if (g.anioMax !== null) b.anioMax = b.anioMax === null ? g.anioMax : Math.max(b.anioMax, g.anioMax);
    b.clases.push(g);
  }
  return [...m.values()].sort((a, b) => b.unidades - a.unidades || a.marca.localeCompare(b.marca));
}

/** "2012–2019", "2015" o "—". */
export function yearRange(min: number | null, max: number | null): string {
  if (min === null && max === null) return "—";
  if (min === null || max === null || min === max) return String(min ?? max);
  return `${min}–${max}`;
}
