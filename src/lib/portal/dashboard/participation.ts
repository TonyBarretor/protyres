/**
 * Participación del tablero (pura): top N empresas por neumáticos vendidos en los últimos 12 meses (mismo día de hace un
 * año hasta hoy, Lima), con sus llantas en piso (padrón MTC) al lado. Una empresa que no está en el padrón aparece con
 * llantas en piso null ("no está en el padrón").
 */
import type { Company, SalesAggRow } from "../store/types";
import type { Period } from "./period";

export interface TopCompany {
  ruc: string;
  razonSocial: string;
  companyId: number | null;
  cantidad: number;
  llantasPiso: number | null;
  /** cantidad / llantasPiso (null sin llantas en piso). */
  ratio: number | null;
  demo: boolean;
}

/** Agrupa por RUC las ventas de la ventana y devuelve las `limit` con más neumáticos (empate: RUC). */
export function topByTyres(rows: readonly SalesAggRow[], window: Period, limit = 10): Omit<TopCompany, "companyId" | "llantasPiso" | "ratio">[] {
  const by = new Map<string, { ruc: string; razonSocial: string; cantidad: number; demo: boolean }>();
  for (const r of rows) {
    if (r.fecha < window.start || r.fecha > window.end) continue;
    const g = by.get(r.ruc) ?? { ruc: r.ruc, razonSocial: r.razonSocial ?? "", cantidad: 0, demo: false };
    g.cantidad += r.cantidad;
    g.demo ||= r.demo;
    if (!g.razonSocial && r.razonSocial) g.razonSocial = r.razonSocial;
    by.set(r.ruc, g);
  }
  return [...by.values()]
    .filter((g) => g.cantidad > 0)
    .sort((a, b) => b.cantidad - a.cantidad || a.ruc.localeCompare(b.ruc))
    .slice(0, limit);
}

/** Completa con la empresa del padrón (razón social y llantas en piso). */
export function withFleet(top: ReturnType<typeof topByTyres>, companies: readonly Company[]): TopCompany[] {
  const byRuc = new Map(companies.map((c) => [c.ruc, c]));
  return top.map((t) => {
    const c = byRuc.get(t.ruc);
    const llantasPiso = c ? c.llantasPiso : null;
    return { ...t, razonSocial: c?.razonSocial ?? (t.razonSocial || `RUC ${t.ruc}`), companyId: c?.id ?? null, llantasPiso, ratio: llantasPiso ? t.cantidad / llantasPiso : null };
  });
}
