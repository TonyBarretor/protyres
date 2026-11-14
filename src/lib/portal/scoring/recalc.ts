/**
 * Corrida G — recálculo del puntaje contra el store. Completo (`npm run portal:recalc-score`, al terminar el import del
 * padrón y al confirmar una subida de ventas) o de unas empresas (cambio de crédito). Idempotente: con los mismos datos
 * deja los mismos puntajes y niveles.
 *
 * Completo: lee las entradas de todas las empresas (una consulta por tabla, en serie), calcula, fija los cortes de nivel
 * por percentil, aplica frenos, guarda por lotes y registra el cálculo en score_runs (cortes, conteo, duración).
 * Puntual: usa los cortes del último cálculo completo (si no hay ninguno, hace el completo).
 */
import type { PriceRow } from "../../ingest/types";

/** Lo que el puntaje necesita de las listas de precios (lo cumple PriceStore y src/lib/store/price-sizes.ts). */
export interface PriceSizesSource {
  allRows(): Promise<Pick<PriceRow, "size" | "kind" | "stock" | "isTyre">[]>;
}
import { defaultSince, normMarca } from "../store/shared";
import type { Nivel, PortalStore, ScoreRun, ScoreUpdate } from "../store/types";
import type { ScoringConfig } from "./config";
import { applyBrakes, catalogSizesFromRows, EMPTY_CATALOG, levelCuts, levelFor, scoreCompany, type CatalogSizes, type LevelCuts } from "./score";

export interface RecalcResult {
  empresas: number;
  conteo: Record<Nivel, number>;
  cuts: LevelCuts;
  /** Las primeras por puntaje (solo en el completo). */
  top: { companyId: number; score: number; nivel: Nivel }[];
  durationMs: number;
  /** Cuánto tardó cada parte (lectura, cálculo, escritura). */
  phases: { leer: number; calcular: number; guardar: number };
  full: boolean;
}

export interface RecalcOptions {
  now?: Date;
  /** Solo estas empresas (con los cortes del último cálculo completo). */
  companyIds?: number[];
  /** Catálogo de medidas; si no se pasa, se lee de `prices` (PriceStore) o queda vacío. */
  catalog?: CatalogSizes;
  prices?: PriceSizesSource | null;
  log?: (msg: string) => void;
}

export async function loadCatalogSizes(prices: PriceSizesSource | null | undefined, cfg: ScoringConfig, log?: (m: string) => void): Promise<CatalogSizes> {
  if (!prices) return EMPTY_CATALOG;
  try {
    return catalogSizesFromRows(await prices.allRows(), cfg.encaje.minStock);
  } catch (err) {
    log?.(`puntaje: no pude leer el catálogo (${(err as Error).message}); las medidas no suman`);
    return EMPTY_CATALOG;
  }
}

export async function recalcScores(store: PortalStore, cfg: ScoringConfig, opts: RecalcOptions = {}): Promise<RecalcResult> {
  const t0 = Date.now();
  const now = opts.now ?? new Date();
  const partial = opts.companyIds !== undefined;
  let lastRun: ScoreRun | null = null;
  if (partial) {
    lastRun = await store.latestScoreRun();
    if (!lastRun) return recalcScores(store, cfg, { ...opts, companyIds: undefined });
    if (!opts.companyIds!.length) return emptyResult(lastRun, t0);
  }
  const catalog = opts.catalog ?? (await loadCatalogSizes(opts.prices, cfg, opts.log));
  const lostSince = new Date(now.getTime() - cfg.frenos.perdidaDias * 86_400_000);
  const inputs = await store.scoringInputs({ companyIds: opts.companyIds, marcas: cfg.familiaridad.marcas.map(normMarca), since12m: defaultSince(now), lostSince });
  const t1 = Date.now();

  const scored = inputs.map((i) => ({ i, ...scoreCompany(i, cfg, catalog, now) }));
  const cuts: LevelCuts = partial ? { cutA: lastRun!.cutA, cutB: lastRun!.cutB } : levelCuts(scored.map((s) => s.score), cfg);
  const conteo: Record<Nivel, number> = { A: 0, B: 0, C: 0 };
  const updates: ScoreUpdate[] = scored.map((s) => {
    const nivelBase = levelFor(s.score, cuts);
    const nivel = applyBrakes(nivelBase, s.frenos);
    conteo[nivel]++;
    return { companyId: s.i.companyId, score: s.score, nivel, detalle: { ...s.detalle, frenos: s.frenos, nivelBase } };
  });
  const t2 = Date.now();
  await store.saveScores(updates, now);
  const t3 = Date.now();
  const durationMs = t3 - t0;
  if (!partial) await store.saveScoreRun({ empresas: updates.length, cutA: cuts.cutA, cutB: cuts.cutB, conteo, duracionMs: durationMs, runAt: now });
  const top = partial
    ? []
    : [...updates]
        .sort((a, b) => b.score - a.score || a.companyId - b.companyId)
        .slice(0, 20)
        .map((u) => ({ companyId: u.companyId, score: u.score, nivel: u.nivel }));
  return { empresas: updates.length, conteo, cuts, top, durationMs, phases: { leer: t1 - t0, calcular: t2 - t1, guardar: t3 - t2 }, full: !partial };
}

function emptyResult(run: ScoreRun, t0: number): RecalcResult {
  return { empresas: 0, conteo: { A: 0, B: 0, C: 0 }, cuts: { cutA: run.cutA, cutB: run.cutB }, top: [], durationMs: Date.now() - t0, phases: { leer: 0, calcular: 0, guardar: 0 }, full: false };
}

/**
 * Recálculo que no debe romper a quien lo llama (import, subida de ventas, cambio de crédito): si falla, lo registra y
 * sigue. Devuelve el resultado o null.
 */
export async function recalcScoresSafely(store: PortalStore, cfg: ScoringConfig, opts: RecalcOptions & { why: string }): Promise<RecalcResult | null> {
  try {
    const r = await recalcScores(store, cfg, opts);
    (opts.log ?? console.log)(`[puntaje] recalculado (${opts.why}): ${r.empresas} empresas en ${r.durationMs} ms`);
    return r;
  } catch (err) {
    (opts.log ?? console.error)(`[puntaje] no pude recalcular (${opts.why}): ${(err as Error).message}`);
    return null;
  }
}
