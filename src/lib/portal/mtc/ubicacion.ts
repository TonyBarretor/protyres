/**
 * Corrida K: provincia y distrito principales de cada empresa, sin reimportar la flota (`npm run portal:import-mtc --
 * --ubicacion`). Lo que trae de verdad el padrón del MTC (data/mtc):
 *  - Carga: solo DEPARTAMENTO (ni provincia, ni distrito, ni dirección, teléfono o correo).
 *  - Pasajeros: DEPARTAMENTO, PROVINCIA, DISTRITO y UBIGEO por vehículo (tampoco dirección, teléfono ni correo).
 * Para cada empresa: el par provincia/distrito más frecuente de sus vehículos de pasajeros dentro de su departamento
 * principal (el de la empresa); empate alfabético. Las de solo carga quedan sin provincia ni distrito.
 *
 * El import completo (importMtc) ya guarda los dos campos; esto sirve para completar un padrón importado antes de la
 * corrida K sin tocar la flota (la reimportación sin el archivo de cortes 2022–2024 dejaría la carga sin llantas).
 */
import type { PortalStore } from "../store/types";
import { newStats, streamMtcFile } from "./parse";

export interface UbicacionSummary {
  /** Vehículos de pasajeros leídos (corte vigente). */
  vehiculos: number;
  /** Empresas del store con provincia/distrito en su departamento principal. */
  conUbicacion: number;
  actualizadas: number;
  empresas: number;
}

export async function importUbicaciones(opts: { files: string[]; currentCut: string; store: PortalStore; log?: (m: string) => void }): Promise<UbicacionSummary> {
  // RUC -> departamento -> "PROVINCIA|DISTRITO" -> vehículos
  const places = new Map<string, Map<string, Map<string, number>>>();
  let vehiculos = 0;
  for (const file of opts.files) {
    for await (const v of streamMtcFile(file, newStats(), { cuts: [opts.currentCut] })) {
      if (v.origen !== "pasajeros" || !v.departamento || !v.provincia) continue;
      vehiculos++;
      let byDep = places.get(v.ruc);
      if (!byDep) places.set(v.ruc, (byDep = new Map()));
      let m = byDep.get(v.departamento);
      if (!m) byDep.set(v.departamento, (m = new Map()));
      const k = `${v.provincia}|${v.distrito ?? ""}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
  }
  opts.log?.(`ubicación: ${vehiculos.toLocaleString("es-PE")} vehículos de pasajeros con provincia`);
  const companies = await opts.store.getCompaniesByRucs([...places.keys()]);
  let conUbicacion = 0;
  let actualizadas = 0;
  for (const c of companies) {
    const m = c.departamento ? places.get(c.ruc)?.get(c.departamento) : undefined;
    if (!m) continue;
    let best: string | null = null;
    let bestN = 0;
    for (const [k, n] of m) if (n > bestN || (n === bestN && best !== null && k < best)) [best, bestN] = [k, n];
    if (!best) continue;
    conUbicacion++;
    const [provincia, distrito] = best.split("|");
    if ((c.provincia ?? null) === provincia && (c.distrito ?? null) === (distrito || null)) continue;
    await opts.store.updateCompany(c.id, { provincia, distrito: distrito || null });
    actualizadas++;
  }
  return { vehiculos, conUbicacion, actualizadas, empresas: await opts.store.countCompanies() };
}
