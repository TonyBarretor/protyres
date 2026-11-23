/**
 * Corrida K — análisis de ventas reales frente al padrón (`npm run match:analisis-flotas`), antes de fijar el peso del
 * Volumen. Por tamaño de flota (cortes de match.cortesFlota), por sector y por departamento: empresas del padrón,
 * clientes (con neumáticos comprados), conversión, neumáticos en total y por cliente, facturas y margen promedio
 * (ponderado por venta). Cada grupo lleva su muestra; con menos de 5 clientes no se saca conclusión.
 *
 * La recomendación sobre el peso de Volumen se calcula con las cifras y se imprime: NO se aplica (lo decide el
 * administrador en config/portal.json match.pesos).
 */
import type { MatchCompanyInput } from "../store/types";
import type { MatchConfig } from "./config";
import type { MatchSaleLine } from "./compute";
import { sizeBuckets } from "./read";

export const MIN_CLIENTES = 5;

export interface AnalysisGroup {
  grupo: string;
  empresas: number;
  clientes: number;
  /** clientes / empresas (0–1). */
  conversion: number;
  neumaticos: number;
  porCliente: number | null;
  facturas: number;
  /** Margen ponderado por venta (%), de las líneas con margen. */
  margenPct: number | null;
  /** Al menos MIN_CLIENTES clientes: se puede concluir. */
  concluyente: boolean;
}

export interface FleetAnalysis {
  porTamano: AnalysisGroup[];
  porSector: AnalysisGroup[];
  porDepartamento: AnalysisGroup[];
  /** Ventas a RUC que no están en el padrón (sin datos de flota). */
  fueraDelPadron: { clientes: number; neumaticos: number; facturas: number };
  recomendacion: string;
  periodo: { desde: string | null; hasta: string | null };
}

interface Acc {
  empresas: number;
  clientes: number;
  neumaticos: number;
  facturas: Set<string>;
  venta: number;
  margenVenta: number;
}

const acc = (): Acc => ({ empresas: 0, clientes: 0, neumaticos: 0, facturas: new Set(), venta: 0, margenVenta: 0 });

function accOf(m: Map<string, Acc>, key: string): Acc {
  let a = m.get(key);
  if (!a) m.set(key, (a = acc()));
  return a;
}

function finish(grupo: string, a: Acc): AnalysisGroup {
  return {
    grupo,
    empresas: a.empresas,
    clientes: a.clientes,
    conversion: a.empresas ? a.clientes / a.empresas : 0,
    neumaticos: a.neumaticos,
    porCliente: a.clientes ? Math.round((a.neumaticos / a.clientes) * 10) / 10 : null,
    facturas: a.facturas.size,
    margenPct: a.venta > 0 ? Math.round((a.margenVenta / a.venta) * 10) / 10 : null,
    concluyente: a.clientes >= MIN_CLIENTES,
  };
}

export function analyzeFleets(companies: MatchCompanyInput[], sales: MatchSaleLine[], cfg: Pick<MatchConfig, "cortesFlota" | "pesos">): FleetAnalysis {
  const byRuc = new Map<string, MatchSaleLine[]>();
  for (const s of sales) {
    const l = byRuc.get(s.ruc);
    if (l) l.push(s);
    else byRuc.set(s.ruc, [s]);
  }
  const buckets = sizeBuckets(cfg.cortesFlota);
  const size = new Map<string, Acc>(buckets.map((b) => [b.label, acc()]));
  const below = acc();
  const sector = new Map<string, Acc>();
  const dep = new Map<string, Acc>();
  const inPadron = new Set<string>();
  for (const c of companies) {
    inPadron.add(c.ruc);
    const lines = byRuc.get(c.ruc) ?? [];
    const units = lines.reduce((n, l) => n + l.cantidad, 0);
    const cliente = units > 0;
    let bi = -1;
    for (let i = buckets.length - 1; i >= 0; i--)
      if (c.unidades >= buckets[i].min) {
        bi = i;
        break;
      }
    const targets = [bi >= 0 ? size.get(buckets[bi].label)! : below, accOf(sector, c.sector ?? "sin sector"), accOf(dep, c.departamento ?? "SIN DEPARTAMENTO")];
    for (const a of targets) {
      a.empresas++;
      if (!cliente) continue;
      a.clientes++;
      a.neumaticos += units;
      for (const l of lines) {
        if (l.cantidad > 0 && l.documento) a.facturas.add(l.documento);
        if (l.total !== null && l.total > 0) {
          a.venta += l.total;
          if (l.margenPct !== null) a.margenVenta += l.margenPct * l.total;
          else a.venta -= l.total; // sin margen: fuera del promedio
        }
      }
    }
  }
  const out: FleetAnalysis = {
    porTamano: [...buckets.map((b) => finish(`${b.label} unidades`, size.get(b.label)!)), ...(below.empresas ? [finish(`menos de ${buckets[0].min}`, below)] : [])],
    porSector: [...sector].map(([k, a]) => finish(k, a)).sort((a, b) => b.empresas - a.empresas),
    porDepartamento: [...dep].map(([k, a]) => finish(k, a)).sort((a, b) => b.clientes - a.clientes || b.empresas - a.empresas),
    fueraDelPadron: { clientes: 0, neumaticos: 0, facturas: 0 },
    recomendacion: "",
    periodo: { desde: null, hasta: null },
  };
  const outside = [...byRuc].filter(([r]) => !inPadron.has(r));
  const units = outside.map(([, l]) => l.reduce((n, x) => n + x.cantidad, 0));
  out.fueraDelPadron = {
    clientes: units.filter((u) => u > 0).length,
    neumaticos: units.filter((u) => u > 0).reduce((a, b) => a + b, 0),
    facturas: new Set(outside.flatMap(([, l]) => l.filter((x) => x.cantidad > 0 && x.documento).map((x) => x.documento!))).size,
  };
  const dates = sales.map((s) => s.fecha).sort();
  out.periodo = { desde: dates[0] ?? null, hasta: dates.at(-1) ?? null };
  out.recomendacion = volumeRecommendation(out.porTamano, cfg);
  return out;
}

/** Texto con la recomendación (no se aplica): compara neumáticos por cliente y conversión entre tamaños concluyentes. */
export function volumeRecommendation(groups: AnalysisGroup[], cfg: Pick<MatchConfig, "pesos">): string {
  const ok = groups.filter((g) => g.concluyente && g.porCliente !== null);
  if (ok.length < 2) return `No hay suficientes clientes por tamaño de flota (se necesitan ${MIN_CLIENTES} por grupo en al menos dos grupos): se mantiene Volumen en ${cfg.pesos.volumen}.`;
  const small = ok[0];
  const big = ok[ok.length - 1];
  const ratio = big.porCliente! / small.porCliente!;
  const conv = small.conversion > 0 ? big.conversion / small.conversion : Infinity;
  const fmt = (g: AnalysisGroup) => `${g.grupo}: ${g.clientes} clientes de ${g.empresas} (${(g.conversion * 100).toFixed(1)}%), ${g.porCliente} neumáticos por cliente`;
  if (ratio >= 3 && conv >= 1) {
    const v = Math.min(50, cfg.pesos.volumen + 10);
    return `Las flotas grandes compran claramente más (${fmt(big)} frente a ${fmt(small)}: ${ratio.toFixed(1)} veces por cliente y conversión ${conv.toFixed(1)} veces). Propuesta (no aplicada): subir Volumen de ${cfg.pesos.volumen} a ${v} y bajar Encaje a ${cfg.pesos.encaje - (v - cfg.pesos.volumen)}.`;
  }
  if (ratio >= 3) {
    return `Por cliente, las flotas grandes compran ${ratio.toFixed(1)} veces más (${fmt(big)} frente a ${fmt(small)}), pero convierten ${conv < 1 ? "menos" : "igual"}: el Volumen actual (${cfg.pesos.volumen}) ya las sube cuando tienen la medida; propuesta (no aplicada): mantenerlo y revisar con más ventas.`;
  }
  return `Sin diferencia clara por tamaño (${fmt(big)} frente a ${fmt(small)}: ${ratio.toFixed(1)} veces): se mantiene Volumen en ${cfg.pesos.volumen}.`;
}

/** Tabla de texto para el comando. */
export function formatAnalysis(a: FleetAnalysis): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const row = (g: AnalysisGroup) =>
    `${g.grupo.padEnd(22)} ${String(g.empresas).padStart(6)} ${String(g.clientes).padStart(8)} ${pct(g.conversion).padStart(10)} ${String(g.neumaticos).padStart(10)} ${String(g.porCliente ?? "—").padStart(9)} ${String(g.facturas).padStart(8)} ${(g.margenPct === null ? "—" : `${g.margenPct}%`).padStart(8)}  ${g.concluyente ? "" : "(muestra chica: sin conclusión)"}`;
  const head = `${"grupo".padEnd(22)} ${"empr.".padStart(6)} ${"clientes".padStart(8)} ${"conversión".padStart(10)} ${"neumát.".padStart(10)} ${"x cliente".padStart(9)} ${"facturas".padStart(8)} ${"margen".padStart(8)}`;
  return [
    `Ventas reales ${a.periodo.desde ?? "?"} a ${a.periodo.hasta ?? "?"} cruzadas con el padrón (clientes = empresas con neumáticos comprados; margen ponderado por venta).`,
    "",
    "Por tamaño de flota",
    head,
    ...a.porTamano.map(row),
    "",
    "Por sector",
    head,
    ...a.porSector.map(row),
    "",
    "Por departamento (con clientes)",
    head,
    ...a.porDepartamento.filter((g) => g.clientes > 0).map(row),
    "",
    `Fuera del padrón (sin datos de flota): ${a.fueraDelPadron.clientes} clientes, ${a.fueraDelPadron.neumaticos} neumáticos, ${a.fueraDelPadron.facturas} facturas.`,
    "",
    `Recomendación sobre el peso de Volumen: ${a.recomendacion}`,
  ].join("\n");
}
