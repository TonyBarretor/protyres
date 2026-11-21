/**
 * Importa el padrón MTC al store del portal (lo usa `npm run portal:import-mtc`).
 *
 * Pasos:
 *  1. Lee cada CSV en streaming (el formato se reconoce por la cabecera). De carga, las filas de los cortes de
 *     `tyreCuts` alimentan el índice de llantas por placa; de carga y pasajeros, las del corte `currentCut` son la
 *     flota vigente.
 *  2. Deduplica la flota vigente por (placa, origen): se queda con la primera fila y cuenta las demás.
 *  3. Llantas de carga desde el índice (applyTyres), medida probable (config/tyre-inference.json).
 *  4. Agrega por empresa y deja solo las que tienen `minUnits` unidades o más.
 *  5. Escribe por lotes con upsertCompanies + upsertFleet (idempotente: RUC y (placa, origen) son claves únicas).
 *  6. Poda la flota: a cada empresa importada se le borran los vehículos que ya no figuran en su flota vigente
 *     (pruneFleet, por lotes). Va después del upsert, que ya movió a su nueva empresa las placas que cambiaron de dueño.
 *
 * Resultado: la flota de cada empresa importada queda exactamente igual a la del padrón vigente.
 *
 * Empresas que bajan del umbral (o dejan de figurar en el padrón): NO se borran ni se tocan, porque pueden tener trabajo
 * comercial (dueño, contactos, oportunidades, actividades). Quedan con sus cifras y su flota de la última importación en
 * que pasaron el umbral; limpiarlas es una decisión manual.
 *
 * Corrida J: las empresas creadas a mano (origen "manual") que no están en el padrón no se tocan; si su RUC llega en el
 * padrón se fusionan (upsertCompanies: pasan a origen "mtc" con los datos del padrón; dueño, contactos, actividad,
 * oportunidades y vehículos cargados a mano se conservan: la poda nunca borra los de origen "manual") y queda una
 * actividad que lo dice. Con `onlyRucs` (`npm run portal:import-ruc`) se importan solo esas empresas, aunque tengan
 * menos de `minUnits` unidades.
 */
import path from "node:path";
import type { PortalImportConfig } from "../config";
import type { CompanyInput, FleetKey, FleetVehicleInput, PortalStore } from "../store/types";
import { aggregateCompanies, type CompanyAggregate } from "./aggregate";
import { inferTyreSize, type Confianza, type TyreRule } from "./inference";
import { newStats, streamMtcFile, type MtcOrigin, type MtcVehicle, type ParseStats } from "./parse";
import { addToTyreIndex, applyTyres, type TyreIndex } from "./tyres";

export const VERIFY_RUC = "20602221505";

export interface ImportMtcOptions {
  /** CSV del padrón (carga y pasajeros, en cualquier orden). */
  files: string[];
  config: PortalImportConfig;
  rules: TyreRule[];
  /** Obligatorio salvo en dryRun. */
  store?: PortalStore | null;
  dryRun?: boolean;
  /** Tamaño de lote para escribir (por defecto 2000). */
  batchSize?: number;
  /** RUC cuya ficha se devuelve en `verificacion` (por defecto ZBUSS 20602221505). */
  verifyRuc?: string;
  /** Corrida J: solo estas empresas (por RUC), aunque tengan menos de `minUnits` unidades. */
  onlyRucs?: string[];
  log?: (msg: string) => void;
}

export interface FileSummary {
  file: string;
  origen: MtcOrigin | null;
  stats: ParseStats;
  /** Filas usadas para el índice de llantas (carga, cortes tyreCuts, con N_LLANTAS). */
  paraIndice: number;
  /** Filas del corte vigente. */
  vigentes: number;
}

export interface VerifySummary {
  ruc: string;
  razonSocial: string | null;
  unidades: number;
  omnibus: number;
  sector: string | null;
  /** Pasa el umbral (se importa). */
  importada: boolean;
}

export interface ImportMtcSummary {
  dryRun: boolean;
  files: FileSummary[];
  vigente: { carga: number; pasajeros: number };
  /** Filas vigentes repetidas por (placa, origen) que se descartaron. */
  duplicadas: number;
  indiceLlantas: number;
  minUnits: number;
  empresasTotal: number;
  empresas: number;
  vehiculos: number;
  /** Sobre los vehículos importados. */
  conLlantas: number;
  conMedida: number;
  porConfianza: Record<Confianza, number>;
  /** Sobre toda la flota vigente de carga (antes del umbral). */
  cargaConLlantas: number;
  written: { companiesInserted: number; companiesUpdated: number; fleetInserted: number; fleetUpdated: number; fleetRemoved: number } | null;
  verificacion: VerifySummary | null;
  /** Corrida J: RUC pedidos con `onlyRucs` (null si es el import completo). */
  pedidas: string[] | null;
  /** Corrida J: de los pedidos, los que no están en el padrón vigente. */
  faltantes: string[];
  /** Corrida J: RUC de empresas creadas a mano que llegaron en el padrón y se fusionaron. */
  fusionadas: string[];
}

type Current = MtcVehicle & { llantasFuente: string | null; medidaProbable: string | null; confianza: Confianza | null };

export async function importMtc(opts: ImportMtcOptions): Promise<ImportMtcSummary> {
  const { config, rules } = opts;
  const dryRun = !!opts.dryRun;
  if (!dryRun && !opts.store) throw new Error("importMtc: falta el store (o usa dryRun)");
  const log = opts.log ?? (() => {});
  const batchSize = opts.batchSize ?? 2000;
  const tyreCuts = config.tyreCuts;
  const currentCut = config.currentCut;
  const only = opts.onlyRucs ? new Set(opts.onlyRucs.map((r) => r.replace(/\D/g, "")).filter(Boolean)) : null;
  const verifyRuc = opts.verifyRuc ?? (only ? [...only][0] : VERIFY_RUC);

  // 1. Lectura en streaming.
  const index: TyreIndex = new Map();
  const seen = new Set<string>();
  const current: MtcVehicle[] = [];
  let duplicadas = 0;
  const files: FileSummary[] = [];
  for (const file of opts.files) {
    const stats = newStats();
    const fsum: FileSummary = { file: path.basename(file), origen: null, stats, paraIndice: 0, vigentes: 0 };
    files.push(fsum);
    log(`Leyendo ${fsum.file}…`);
    for await (const v of streamMtcFile(file, stats)) {
      fsum.origen ??= v.origen;
      if (v.origen === "carga" && v.llantas != null && tyreCuts.includes(v.fechaCorte)) {
        addToTyreIndex(index, v, tyreCuts);
        fsum.paraIndice++;
      }
      if (v.fechaCorte !== currentCut) continue;
      fsum.vigentes++;
      const key = `${v.origen}|${v.placa}`;
      if (seen.has(key)) {
        duplicadas++;
        continue;
      }
      seen.add(key);
      current.push(v);
    }
  }
  seen.clear();

  // 2–3. Llantas y medida probable.
  const fleet: Current[] = current.map((v) => {
    const withTyres = applyTyres(v, index);
    const inf = inferTyreSize(withTyres, rules);
    return { ...withTyres, medidaProbable: inf.medida, confianza: inf.confianza };
  });
  current.length = 0;
  const vigente = { carga: 0, pasajeros: 0 };
  let cargaConLlantas = 0;
  for (const v of fleet) {
    vigente[v.origen]++;
    if (v.origen === "carga" && v.llantas != null) cargaConLlantas++;
  }

  // 4. Agregado por empresa y umbral.
  const all = aggregateCompanies(fleet, { sectorMajority: config.sectorMajority });
  // corrida J: con `onlyRucs`, solo esas (sin umbral de unidades)
  const companies = all.filter((c) => (only ? only.has(c.ruc) : c.unidades >= config.minUnits));
  const passing = new Set(companies.map((c) => c.ruc));
  const imported = fleet.filter((v) => passing.has(v.ruc));

  const porConfianza: Record<Confianza, number> = { alta: 0, media: 0, baja: 0 };
  let conLlantas = 0;
  let conMedida = 0;
  for (const v of imported) {
    if (v.llantas != null) conLlantas++;
    if (v.medidaProbable) conMedida++;
    if (v.confianza) porConfianza[v.confianza]++;
  }

  const verifyAgg: CompanyAggregate | undefined = all.find((c) => c.ruc === verifyRuc);
  const verificacion: VerifySummary | null = verifyAgg
    ? {
        ruc: verifyRuc,
        razonSocial: verifyAgg.razonSocial,
        unidades: verifyAgg.unidades,
        omnibus: fleet.filter((v) => v.ruc === verifyRuc && v.clase === "OMNIBUS").length,
        sector: verifyAgg.sector,
        importada: passing.has(verifyRuc),
      }
    : null;

  const summary: ImportMtcSummary = {
    dryRun,
    files,
    vigente,
    duplicadas,
    indiceLlantas: index.size,
    minUnits: config.minUnits,
    empresasTotal: all.length,
    empresas: companies.length,
    vehiculos: imported.length,
    conLlantas,
    conMedida,
    porConfianza,
    cargaConLlantas,
    written: null,
    verificacion,
    pedidas: only ? [...only] : null,
    faltantes: only ? [...only].filter((r) => !passing.has(r)) : [],
    fusionadas: [],
  };
  if (dryRun) return summary;

  // 5. Escritura por lotes.
  const store = opts.store!;
  const written = { companiesInserted: 0, companiesUpdated: 0, fleetInserted: 0, fleetUpdated: 0, fleetRemoved: 0 };
  const ids: Record<string, number> = {};
  for (let i = 0; i < companies.length; i += batchSize) {
    const batch: CompanyInput[] = companies.slice(i, i + batchSize).map((c) => ({
      ruc: c.ruc,
      razonSocial: c.razonSocial,
      sector: c.sector,
      departamento: c.departamento,
      unidades: c.unidades,
      llantasPiso: c.llantasEnPiso,
      antiguedadMedia: c.antiguedadMedia,
    }));
    const r = await store.upsertCompanies(batch);
    written.companiesInserted += r.inserted;
    written.companiesUpdated += r.updated;
    Object.assign(ids, r.ids);
    // corrida J: creadas a mano que llegaron en el padrón: queda dicho en su actividad
    for (const ruc of r.merged ?? []) {
      summary.fusionadas.push(ruc);
      await store.addActivity({
        companyId: r.ids[ruc],
        userId: null,
        tipo: "nota",
        texto: "La empresa apareció en el padrón del MTC: se completó con sus datos y su flota; se conservó lo cargado a mano (vehículos, contactos, oportunidades y dueño).",
        canal: "portal",
        data: { evento: "fusion_padron" },
      });
    }
  }
  log(`Empresas escritas: ${companies.length}`);
  for (let i = 0; i < imported.length; i += batchSize) {
    const batch: FleetVehicleInput[] = [];
    for (const v of imported.slice(i, i + batchSize)) {
      const companyId = ids[v.ruc];
      if (companyId === undefined) continue;
      batch.push({
        companyId,
        placa: v.placa,
        marca: v.marca,
        clase: v.clase,
        anio: v.anio,
        ejes: v.ejes,
        llantas: v.llantas,
        llantasFuente: v.llantasFuente,
        pesoBruto: v.pesoBruto,
        chasis: v.chasis,
        departamento: v.departamento,
        origen: v.origen,
        medidaProbable: v.medidaProbable,
        confianza: v.confianza,
      });
    }
    const r = await store.upsertFleet(batch);
    written.fleetInserted += r.inserted;
    written.fleetUpdated += r.updated;
    if ((i / batchSize) % 20 === 19) log(`Vehículos escritos: ${Math.min(i + batchSize, imported.length)} / ${imported.length}`);
  }

  // 6. Poda: por lotes de empresas (y de placas a conservar, para que cada llamada lleve un parámetro de tamaño acotado).
  const keepByCompany = new Map<number, FleetKey[]>();
  for (const v of imported) {
    const companyId = ids[v.ruc];
    if (companyId === undefined) continue;
    const list = keepByCompany.get(companyId);
    if (list) list.push({ placa: v.placa, origen: v.origen });
    else keepByCompany.set(companyId, [{ placa: v.placa, origen: v.origen }]);
  }
  let pruneIds: number[] = [];
  let pruneKeep: FleetKey[] = [];
  const prune = async () => {
    if (pruneIds.length) written.fleetRemoved += await store.pruneFleet(pruneIds, pruneKeep);
    pruneIds = [];
    pruneKeep = [];
  };
  for (const c of companies) {
    const companyId = ids[c.ruc];
    if (companyId === undefined) continue;
    pruneIds.push(companyId);
    for (const k of keepByCompany.get(companyId) ?? []) pruneKeep.push(k);
    if (pruneIds.length >= batchSize || pruneKeep.length >= batchSize * 5) await prune();
  }
  await prune();
  if (written.fleetRemoved) log(`Vehículos que ya no figuran en la flota vigente, borrados: ${written.fleetRemoved}`);
  summary.written = written;
  return summary;
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)} %` : "—");
const fmt = (n: number) => n.toLocaleString("es-PE");

/** Resumen legible para la consola. */
export function formatImportSummary(s: ImportMtcSummary): string {
  const out: string[] = [];
  out.push(s.dryRun ? "== Padrón MTC (simulación, no se escribió nada) ==" : "== Padrón MTC importado ==");
  out.push("", "Archivos:");
  for (const f of s.files) {
    const d = f.stats.descartadas;
    const motivos = Object.entries(d)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${fmt(n)}`)
      .join(", ");
    out.push(
      `  ${f.file} (${f.origen ?? "?"}): leídas ${fmt(f.stats.leidas)}, válidas ${fmt(f.stats.validas)}, descartadas ${fmt(f.stats.leidas - f.stats.validas)}${motivos ? ` (${motivos})` : ""}`,
    );
    const cortes = Object.entries(f.stats.porCorte)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([c, n]) => `${c}: ${fmt(n)}`)
      .join(", ");
    out.push(`    por corte: ${cortes || "—"}; vigentes ${fmt(f.vigentes)}; para índice de llantas ${fmt(f.paraIndice)}`);
  }
  out.push("");
  out.push(`Flota vigente: carga ${fmt(s.vigente.carga)}, pasajeros ${fmt(s.vigente.pasajeros)} (placas duplicadas descartadas: ${fmt(s.duplicadas)})`);
  out.push(`Índice de llantas: ${fmt(s.indiceLlantas)} placas; carga vigente con llantas: ${pct(s.cargaConLlantas, s.vigente.carga)}`);
  out.push(`Empresas con flota vigente: ${fmt(s.empresasTotal)}; ${s.pedidas ? "importadas por RUC" : `con ${s.minUnits} o más unidades`}: ${fmt(s.empresas)} (${fmt(s.vehiculos)} vehículos)`);
  out.push(`Vehículos importados con llantas (dato MTC): ${fmt(s.conLlantas)} (${pct(s.conLlantas, s.vehiculos)})`);
  out.push(
    `Con medida inferida: ${fmt(s.conMedida)} (${pct(s.conMedida, s.vehiculos)}) — alta ${fmt(s.porConfianza.alta)} (${pct(s.porConfianza.alta, s.vehiculos)}), media ${fmt(s.porConfianza.media)} (${pct(s.porConfianza.media, s.vehiculos)}), baja ${fmt(s.porConfianza.baja)} (${pct(s.porConfianza.baja, s.vehiculos)})`,
  );
  if (s.written) {
    const w = s.written;
    out.push(`Escrito: empresas ${fmt(w.companiesInserted)} nuevas / ${fmt(w.companiesUpdated)} actualizadas; vehículos ${fmt(w.fleetInserted)} nuevos / ${fmt(w.fleetUpdated)} actualizados / ${fmt(w.fleetRemoved)} borrados (ya no figuran)`);
  }
  if (s.pedidas) out.push(`Empresas pedidas por RUC: ${s.pedidas.join(", ")} (sin umbral de unidades)`);
  if (s.faltantes.length) out.push(`No están en el padrón vigente: ${s.faltantes.join(", ")}`);
  if (s.fusionadas.length) out.push(`Empresas creadas a mano que llegaron en el padrón (fusionadas): ${s.fusionadas.join(", ")}`);
  out.push("");
  const v = s.verificacion;
  out.push(
    v
      ? `Verificación ${v.ruc}: ${v.razonSocial} — ${fmt(v.unidades)} unidades, ${fmt(v.omnibus)} ómnibus, sector ${v.sector}${v.importada ? "" : " (NO pasa el umbral)"}`
      : "Verificación: el RUC de control no está en la flota vigente",
  );
  return out.join("\n");
}
