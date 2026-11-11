/**
 * Utilidades comunes a las dos implementaciones de PortalStore (mismo comportamiento en Postgres y JSON).
 */
import type { Confianza, FleetGroup, IsoDate } from "./types";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

export const digits = (s: string | null | undefined): string => (s ?? "").replace(/\D/g, "");

/** Minúsculas y sin tildes, para buscar por razón social. */
export function foldText(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

/** Marca de vehículo comparable: mayúsculas, sin espacios sobrantes. */
export function normMarca(s: string | null | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

/** Date | "AAAA-MM-DD..." -> "AAAA-MM-DD" (fecha UTC). */
export function toIsoDate(d: Date | IsoDate): IsoDate {
  if (typeof d === "string") return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** Inicio de la ventana de participación: 12 meses antes de `now`. */
export function defaultSince(now: Date = new Date()): IsoDate {
  const d = new Date(now.getTime());
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return toIsoDate(d);
}

export function pageOf(page: number | undefined, pageSize: number | undefined): { page: number; pageSize: number; offset: number } {
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize ?? DEFAULT_PAGE_SIZE)));
  const p = Math.max(1, Math.floor(page ?? 1));
  return { page: p, pageSize: size, offset: (p - 1) * size };
}

const CONF_RANK: Record<string, number> = { alta: 3, media: 2, baja: 1 };

/** Fila agregada por (marca, clase, medida, confianza): la producen los dos stores y la reduce `groupFleet`. */
export interface FleetAggRow {
  marca: string | null;
  clase: string | null;
  medida: string | null;
  confianza: Confianza | null;
  unidades: number;
  anioMin: number | null;
  anioMax: number | null;
  llantas: number;
  unidadesConLlantas: number;
}

/**
 * Agrupa por marca y clase. Medida probable = la más frecuente entre las unidades con medida (empate: mayor confianza,
 * luego orden alfabético); su confianza = la más frecuente para esa medida (empate: la más alta).
 * Orden: más unidades primero, luego marca y clase.
 */
export function groupFleet(rows: FleetAggRow[]): FleetGroup[] {
  const groups = new Map<string, { g: FleetGroup; medidas: Map<string, Map<string, number>> }>();
  for (const r of rows) {
    const key = `${r.marca ?? ""}\u0000${r.clase ?? ""}`;
    let entry = groups.get(key);
    if (!entry) {
      entry = { g: { marca: r.marca, clase: r.clase, anioMin: null, anioMax: null, unidades: 0, llantas: 0, unidadesConLlantas: 0, medidaProbable: null, confianza: null }, medidas: new Map() };
      groups.set(key, entry);
    }
    const g = entry.g;
    g.unidades += r.unidades;
    g.llantas += r.llantas;
    g.unidadesConLlantas += r.unidadesConLlantas;
    if (r.anioMin !== null) g.anioMin = g.anioMin === null ? r.anioMin : Math.min(g.anioMin, r.anioMin);
    if (r.anioMax !== null) g.anioMax = g.anioMax === null ? r.anioMax : Math.max(g.anioMax, r.anioMax);
    if (r.medida) {
      const byConf = entry.medidas.get(r.medida) ?? new Map<string, number>();
      byConf.set(r.confianza ?? "", (byConf.get(r.confianza ?? "") ?? 0) + r.unidades);
      entry.medidas.set(r.medida, byConf);
    }
  }
  const out: FleetGroup[] = [];
  for (const { g, medidas } of groups.values()) {
    let best: { medida: string; total: number; conf: string; confCount: number } | null = null;
    for (const [medida, byConf] of medidas) {
      let total = 0;
      let conf = "";
      let confCount = -1;
      for (const [c, n] of byConf) {
        total += n;
        if (n > confCount || (n === confCount && (CONF_RANK[c] ?? 0) > (CONF_RANK[conf] ?? 0))) {
          conf = c;
          confCount = n;
        }
      }
      const better =
        !best ||
        total > best.total ||
        (total === best.total && (CONF_RANK[conf] ?? 0) > (CONF_RANK[best.conf] ?? 0)) ||
        (total === best.total && (CONF_RANK[conf] ?? 0) === (CONF_RANK[best.conf] ?? 0) && medida < best.medida);
      if (better) best = { medida, total, conf, confCount };
    }
    if (best) {
      g.medidaProbable = best.medida;
      g.confianza = (best.conf || null) as Confianza | null;
    }
    out.push(g);
  }
  out.sort((a, b) => b.unidades - a.unidades || (a.marca ?? "").localeCompare(b.marca ?? "") || (a.clase ?? "").localeCompare(b.clase ?? ""));
  return out;
}

/** Último gana: evita "ON CONFLICT ... cannot affect row a second time" y deja el mismo resultado en JSON. */
export function dedupeBy<T>(rows: T[], key: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(key(r), r);
  return [...m.values()];
}
