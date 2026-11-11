/**
 * Llantas/ejes for the current fleet.
 *
 * The carga 2025 cut publishes N_LLANTAS = "ND", so we borrow it from older cuts of the same PLACA, in priority order
 * (by default 20241231 → 20231231 → 20221231). Pasajeros 20251231 carries its own llantas.
 * `llantasFuente` records which cut the number came from (null = unknown).
 */
import type { MtcVehicle } from "./parse";

export interface TyreRecord {
  llantas: number;
  ejes: number | null;
  /** FECHA_CORTE the record came from. */
  corte: string;
}

export type TyreIndex = Map<string, TyreRecord>;

export interface FleetVehicle extends MtcVehicle {
  llantasFuente: string | null;
}

type TyreSource = Pick<MtcVehicle, "placa" | "llantas" | "ejes" | "fechaCorte">;

/**
 * Add one historical row to the index. Only rows with known llantas and a cut listed in `cuts` count; a cut earlier in
 * `cuts` wins over a later one. Incremental so the 1M-row 2022–2024 file can be streamed.
 */
export function addToTyreIndex(index: TyreIndex, v: TyreSource, cuts: string[]): void {
  if (v.llantas == null) return;
  const rank = cuts.indexOf(v.fechaCorte);
  if (rank < 0) return;
  const prev = index.get(v.placa);
  if (prev && cuts.indexOf(prev.corte) <= rank) return;
  index.set(v.placa, { llantas: v.llantas, ejes: v.ejes, corte: v.fechaCorte });
}

export function buildTyreIndex(rows: Iterable<TyreSource>, cuts: string[]): TyreIndex {
  const index: TyreIndex = new Map();
  for (const v of rows) addToTyreIndex(index, v, cuts);
  return index;
}

/** Fill llantas (and missing ejes) for one current-fleet vehicle. */
export function applyTyres(v: MtcVehicle, index: TyreIndex): FleetVehicle {
  // Own data first (pasajeros, or a future carga cut that publishes llantas again).
  if (v.llantas != null) return { ...v, llantasFuente: v.fechaCorte };
  if (v.origen === "carga") {
    const rec = index.get(v.placa);
    if (rec) return { ...v, llantas: rec.llantas, ejes: v.ejes ?? rec.ejes, llantasFuente: rec.corte };
  }
  return { ...v, llantasFuente: null };
}

export function applyTyresAll(vehicles: Iterable<MtcVehicle>, index: TyreIndex): FleetVehicle[] {
  const out: FleetVehicle[] = [];
  for (const v of vehicles) out.push(applyTyres(v, index));
  return out;
}
