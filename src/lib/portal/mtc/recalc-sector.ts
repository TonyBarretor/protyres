/**
 * Recalcula el sector de todas las empresas desde su flota guardada (vehículos por origen), sin reimportar el padrón.
 * Usa la misma regla que el import (classifySector), así un reimport futuro da lo mismo. Lo usa `npm run portal:recalc-sector`.
 *
 * Solo escribe las empresas cuyo sector cambia. Las empresas sin flota guardada no se tocan.
 */
import type { CompanyRepo, FleetRepo, Sector } from "../store/types";
import { classifySector } from "./aggregate";

export interface SectorChange {
  companyId: number;
  ruc: string;
  razonSocial: string;
  from: Sector | null;
  to: Sector;
  carga: number;
  pasajeros: number;
}

export interface RecalcSectorSummary {
  dryRun: boolean;
  majority: number;
  empresas: number;
  /** Empresas sin vehículos guardados (no se tocan). */
  sinFlota: number;
  cambios: SectorChange[];
  /** "mixto → pasajeros" → cantidad. */
  transiciones: Record<string, number>;
}

export async function recalcSectors(opts: { store: Pick<FleetRepo, "companyOriginCounts"> & Pick<CompanyRepo, "updateCompany">; majority: number; dryRun?: boolean }): Promise<RecalcSectorSummary> {
  const dryRun = !!opts.dryRun;
  const rows = await opts.store.companyOriginCounts();
  const summary: RecalcSectorSummary = { dryRun, majority: opts.majority, empresas: rows.length, sinFlota: 0, cambios: [], transiciones: {} };
  for (const r of rows) {
    const to = classifySector(r.carga, r.pasajeros, opts.majority);
    if (to === null) {
      summary.sinFlota++;
      continue;
    }
    if (to === r.sector) continue;
    summary.cambios.push({ companyId: r.companyId, ruc: r.ruc, razonSocial: r.razonSocial, from: r.sector, to, carga: r.carga, pasajeros: r.pasajeros });
    const key = `${r.sector ?? "sin sector"} → ${to}`;
    summary.transiciones[key] = (summary.transiciones[key] ?? 0) + 1;
  }
  if (!dryRun) for (const c of summary.cambios) await opts.store.updateCompany(c.companyId, { sector: c.to });
  return summary;
}

/** Resumen legible para la consola. */
export function formatRecalcSummary(s: RecalcSectorSummary, opts: { maxList?: number } = {}): string {
  const fmt = (n: number) => n.toLocaleString("es-PE");
  const out: string[] = [];
  out.push(s.dryRun ? "== Sector por mayoría (simulación, no se escribió nada) ==" : "== Sector por mayoría recalculado ==");
  out.push(`Umbral: ${(s.majority * 100).toLocaleString("es-PE", { maximumFractionDigits: 2 })} % de las unidades de un origen; por debajo, mixto.`);
  out.push(`Empresas: ${fmt(s.empresas)}; sin flota guardada (no se tocan): ${fmt(s.sinFlota)}`);
  out.push(`${s.dryRun ? "Cambiarían" : "Cambiaron"}: ${fmt(s.cambios.length)}`);
  for (const [k, n] of Object.entries(s.transiciones).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) out.push(`  ${k}: ${fmt(n)}`);
  const max = opts.maxList ?? 20;
  if (s.cambios.length) {
    out.push("", `Mayores (${Math.min(max, s.cambios.length)} de ${fmt(s.cambios.length)}):`);
    const top = [...s.cambios].sort((a, b) => b.carga + b.pasajeros - (a.carga + a.pasajeros) || a.ruc.localeCompare(b.ruc)).slice(0, max);
    for (const c of top) out.push(`  ${c.ruc} ${c.razonSocial}: ${c.from ?? "sin sector"} → ${c.to} (carga ${fmt(c.carga)}, pasajeros ${fmt(c.pasajeros)})`);
  }
  return out.join("\n");
}
