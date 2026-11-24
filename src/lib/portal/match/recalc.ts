/**
 * Corrida K — cálculo por lotes de Match Venta. Se corre al cargar stock, al subir ventas (o asignar un cliente final),
 * al importar el padrón y al cambiar una prioridad, y con `npm run portal:recalc-match`. Las vistas leen lo guardado
 * (match_results + la foto del stock en match_runs.data): nunca calculan al abrir la página.
 *
 * Pasos: siembra de productos (idempotente) -> stock propio con su disponible -> apaga las prioridades sin disponible
 * (con aviso) -> empresas del padrón (flota por medida) y ventas reales de neumáticos -> computeMatches -> guarda.
 */
import { loadPortalConfig } from "../config";
import { loadSalesSettings } from "../sales/config";
import { saleActive, saleCountRuc, saleUnits } from "../store/shared";
import type { MatchRun, PortalStore, Sale } from "../store/types";
import type { MatchConfig } from "./config";
import { computeMatches, type MatchProductInput, type MatchSaleLine } from "./compute";
import { seedPriorityProducts, switchOffSoldOut } from "./products";
import { canonicalSize } from "./sizes";
import { ownStockProducts, type MatchStockProduct, type OwnStockSource } from "./stock";

export interface MatchDeps {
  store: PortalStore;
  /** Stock propio (filas de Odoo y descuentos por pedidos). null: se usa la foto del último cálculo y no se apaga nada. */
  prices?: OwnStockSource | null;
  cfg?: MatchConfig;
  /** config sales.leasingRucs */
  leasingRucs?: string[];
  now?: Date;
  log?: (msg: string) => void;
}

/** Lo que el cálculo deja en match_runs.data (la vista lo lee sin ir a la tabla de precios). */
export interface MatchRunData {
  /** Stock de los productos prioritarios (y de los que se apagaron en este cálculo). */
  stock: MatchStockProduct[];
  /** Aplicación por código (de match_products). */
  aplicaciones: Record<string, string | null>;
  notas: Record<string, string[]>;
  equivalencias: Record<string, unknown>;
  /** Apagados en este cálculo por llegar a 0. */
  apagados: string[];
  /** El stock vino de la tabla de precios (true) o de la foto anterior (false). */
  stockVivo: boolean;
}

export interface RecalcMatchResult {
  run: MatchRun;
  productos: number;
  filas: number;
  empresas: number;
  apagados: string[];
  durationMs: number;
  phases: { leer: number; calcular: number; guardar: number };
}

/** Ventas de neumáticos reales -> líneas del cruce (atribuidas al cliente final en leasing). */
export function saleLines(sales: Sale[], leasingRucs: string[]): MatchSaleLine[] {
  const banks = new Set(leasingRucs);
  const out: MatchSaleLine[] = [];
  for (const s of sales) {
    if (s.isDemo || !saleActive(s)) continue;
    if ((s.detalle?.tipoLinea ?? "neumatico") !== "neumatico") continue;
    const cantidad = saleUnits(s);
    if (!cantidad) continue;
    const d = s.detalle;
    const usd = d?.precioUnitarioUsd ?? null;
    out.push({
      ruc: saleCountRuc(s),
      docRuc: s.ruc,
      razonSocial: s.razonSocial,
      medida: canonicalSize(s.medida) ?? canonicalSize(d?.descripcion),
      fecha: s.fecha,
      cantidad,
      precioUnitario: usd ?? s.precioUnitario,
      moneda: usd !== null ? "USD" : d ? "PEN" : null,
      total: d?.totalUsd ?? s.total,
      margenPct: d?.margenPct ?? null,
      documento: d?.documento ?? null,
      codigoProducto: d?.codigoProducto ?? null,
      bancoSinClienteFinal: banks.has(s.ruc) && !d?.clienteFinalRuc,
    });
  }
  return out;
}

/** Stock propio vivo (tabla de precios) o la foto del último cálculo. */
export async function loadMatchStock(deps: MatchDeps): Promise<{ stock: MatchStockProduct[]; live: boolean }> {
  const cfg = deps.cfg ?? loadPortalConfig().match;
  if (deps.prices) {
    const rows = deps.prices.stockRows ? await deps.prices.stockRows() : await deps.prices.allRows();
    const deductions = await deps.prices.listStockDeductions();
    return { stock: ownStockProducts(rows, deductions, cfg), live: true };
  }
  const run = await deps.store.latestMatchRun();
  return { stock: ((run?.data as Partial<MatchRunData> | undefined)?.stock ?? []) as MatchStockProduct[], live: false };
}

export async function recalcMatch(deps: MatchDeps, motivo: string): Promise<RecalcMatchResult> {
  const t0 = Date.now();
  const portalCfg = loadPortalConfig();
  const cfg = deps.cfg ?? portalCfg.match;
  const leasingRucs = deps.leasingRucs ?? loadSalesSettings().leasingRucs;
  const now = deps.now ?? new Date();
  const { store } = deps;

  await seedPriorityProducts(store, cfg, now);
  const { stock, live } = await loadMatchStock({ ...deps, cfg });
  const apagados = live ? await switchOffSoldOut(store, stock, { now, log: deps.log }) : [];
  const products = await store.listMatchProducts();
  const priority = new Map(products.filter((p) => p.prioridad).map((p) => [p.code, p]));
  const active: MatchProductInput[] = stock.filter((s) => priority.has(s.code) && s.available > 0).map((s) => ({ ...s, aplicacion: priority.get(s.code)!.aplicacion }));
  // sin productos prioritarios activos no hay nada que cruzar: no se leen empresas ni ventas (3–5 s contra la base)
  const companies = active.length ? await store.matchInputs() : [];
  const sales = active.length ? saleLines(await store.querySales({ tipoLinea: ["neumatico"] }), leasingRucs) : [];
  const t1 = Date.now();

  const computed = computeMatches({ companies, products: active, sales, cfg, leasingRucs, now });
  // se guarda lo que las vistas pueden mostrar: desde match.minPctLista, las que ya compraron y las de solo ventas
  const out = { ...computed, rows: computed.rows.filter((r) => r.pct === null || r.pct >= cfg.minPctLista || r.yaCompro) };
  const t2 = Date.now();

  const keep = new Set([...active.map((a) => a.code), ...apagados]);
  const data: MatchRunData = {
    stock: stock.filter((s) => keep.has(s.code) || priority.has(s.code)),
    aplicaciones: Object.fromEntries(products.map((p) => [p.code, p.aplicacion])),
    notas: out.notas,
    equivalencias: out.equivalencias,
    apagados,
    stockVivo: live,
  };
  const empresas = new Set(out.rows.map((r) => r.companyId ?? r.ruc)).size;
  const run = await store.saveMatchRun({ motivo, productos: active.length, empresas, filas: out.rows.length, duracionMs: t2 - t0, data: data as unknown as Record<string, unknown>, runAt: now }, out.rows);
  const t3 = Date.now();
  return { run, productos: active.length, filas: out.rows.length, empresas, apagados, durationMs: t3 - t0, phases: { leer: t1 - t0, calcular: t2 - t1, guardar: t3 - t2 } };
}

/** Recálculo que nunca rompe a quien lo llama (carga de stock, ventas, padrón, prioridad): si falla, lo registra y sigue. */
export async function recalcMatchSafely(deps: MatchDeps & { why: string }): Promise<RecalcMatchResult | null> {
  try {
    const r = await recalcMatch(deps, deps.why);
    deps.log?.(`[match] recalculado (${deps.why}): ${r.productos} productos, ${r.filas} filas en ${r.durationMs} ms${r.apagados.length ? `; sin stock: ${r.apagados.join(", ")}` : ""}`);
    return r;
  } catch (err) {
    (deps.log ?? console.error)(`[match] no pude recalcular (${deps.why}): ${(err as Error).message}`);
    return null;
  }
}

/**
 * Tras cargar stock (WhatsApp, Drive, CLI): recalcula con el stock nuevo. El store del portal se pide recién aquí y
 * cualquier error se registra sin afectar la carga (el cotizador sigue igual).
 */
export async function recalcMatchAfterStockLoad(portal: PortalStore | (() => Promise<PortalStore>), prices: OwnStockSource, log?: (m: string) => void): Promise<RecalcMatchResult | null> {
  try {
    const store = typeof portal === "function" ? await portal() : portal;
    return await recalcMatchSafely({ store, prices, why: "carga de stock", log });
  } catch (err) {
    log?.(`[match] no pude recalcular tras la carga de stock: ${(err as Error).message}`);
    return null;
  }
}
