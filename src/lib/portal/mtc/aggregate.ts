/** Per-company aggregates over the current fleet (pure). */
import type { MtcOrigin, MtcVehicle } from "./parse";

export type Sector = "carga" | "pasajeros" | "mixto";

export interface CompanyAggregate {
  ruc: string;
  /** Most frequent razón social among the company's rows. */
  razonSocial: string;
  sector: Sector;
  /** Most frequent departamento (ties → alphabetical). */
  departamento: string | null;
  unidades: number;
  unidadesCarga: number;
  unidadesPasajeros: number;
  /** Sum of known llantas (vehicles without llantas add 0). */
  llantasEnPiso: number;
  /** Vehicles whose llantas are known. */
  unidadesConLlantas: number;
  /** Mean of (year of FECHA_CORTE − año de fabricación), 1 decimal; null if no year is known. */
  antiguedadMedia: number | null;
}

type AggInput = Pick<MtcVehicle, "ruc" | "razonSocial" | "origen" | "departamento" | "llantas" | "anio" | "fechaCorte">;

interface Acc {
  ruc: string;
  names: Map<string, number>;
  deps: Map<string, number>;
  byOrigin: Record<MtcOrigin, number>;
  llantas: number;
  conLlantas: number;
  ageSum: number;
  ageN: number;
}

function mode(m: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of m) if (n > bestN || (n === bestN && best != null && k < best)) [best, bestN] = [k, n];
  return best;
}

function bump(m: Map<string, number>, k: string | null): void {
  if (k) m.set(k, (m.get(k) ?? 0) + 1);
}

export function aggregateCompanies(vehicles: Iterable<AggInput>, opts: { minUnits?: number } = {}): CompanyAggregate[] {
  const accs = new Map<string, Acc>();
  for (const v of vehicles) {
    let a = accs.get(v.ruc);
    if (!a) {
      a = { ruc: v.ruc, names: new Map(), deps: new Map(), byOrigin: { carga: 0, pasajeros: 0 }, llantas: 0, conLlantas: 0, ageSum: 0, ageN: 0 };
      accs.set(v.ruc, a);
    }
    bump(a.names, v.razonSocial);
    bump(a.deps, v.departamento);
    a.byOrigin[v.origen]++;
    if (v.llantas != null) {
      a.llantas += v.llantas;
      a.conLlantas++;
    }
    const refYear = Number(v.fechaCorte.slice(0, 4));
    if (v.anio != null && v.anio <= refYear) {
      a.ageSum += refYear - v.anio;
      a.ageN++;
    }
  }
  const min = opts.minUnits ?? 1;
  const out: CompanyAggregate[] = [];
  for (const a of accs.values()) {
    const unidades = a.byOrigin.carga + a.byOrigin.pasajeros;
    if (unidades < min) continue;
    out.push({
      ruc: a.ruc,
      razonSocial: mode(a.names) ?? "",
      sector: a.byOrigin.carga && a.byOrigin.pasajeros ? "mixto" : a.byOrigin.pasajeros ? "pasajeros" : "carga",
      departamento: mode(a.deps),
      unidades,
      unidadesCarga: a.byOrigin.carga,
      unidadesPasajeros: a.byOrigin.pasajeros,
      llantasEnPiso: a.llantas,
      unidadesConLlantas: a.conLlantas,
      antiguedadMedia: a.ageN ? Math.round((a.ageSum / a.ageN) * 10) / 10 : null,
    });
  }
  return out.sort((x, y) => y.unidades - x.unidades || x.ruc.localeCompare(y.ruc));
}
