/**
 * Corrida K — stock propio para Match Venta: de las filas de stock de Odoo (kind "stock") a productos con su disponible.
 *
 * Disponible en Lima = suma de los almacenes de config match.almacenesLima (San Luis + Callao) − reserva − lo
 * descontado por pedidos (contador de la corrida H: la misma suma que order/origin.ts committedMap sobre
 * listStockDeductions; no se importa origin.ts para no arrastrar el cotizador a las páginas). El desglose
 * por almacén queda en `warehouses` (se muestra solo al tocar el detalle). Lo que no es neumático (aros, cámaras,
 * servicios: config match.noNeumatico) queda fuera.
 */
import type { PriceRow } from "../../ingest/types";
import { reservedOf } from "../../ingest/stock-warehouses";
import type { StockDeduction } from "../../store/types";
import { fold } from "../../tyre/brands";
import type { MatchConfig } from "./config";

export interface MatchStockProduct {
  code: string;
  rowId: string;
  provider: string;
  /** Medida canónica ("295/80R22.5"). */
  size: string;
  sizeDisplay: string;
  brand: string;
  model: string;
  description: string;
  /** Unidades por almacén tal como vinieron (San Luis, Callao...). */
  warehouses: Record<string, number>;
  /** Suma de los almacenes de Lima. */
  lima: number;
  reserved: number;
  /** En pedidos (contador de stock). */
  committed: number;
  /** lima − reserva − en pedidos (nunca negativo). */
  available: number;
  /** Fecha de la carga de stock (AAAA-MM-DD). */
  loadedAt: string;
}

/** Lo que Match Venta necesita del store de precios (lo cumplen PriceStore y readOwnStock). */
export interface OwnStockSource {
  allRows(): Promise<PriceRow[]>;
  listStockDeductions(): Promise<StockDeduction[]>;
}

/** false para aros, cámaras, servicios, etc. (config match.noNeumatico) y filas sin medida. */
export function isMatchTyre(row: Pick<PriceRow, "isTyre" | "size" | "description" | "code">, cfg: Pick<MatchConfig, "noNeumatico">): boolean {
  if (!row.isTyre || !row.size) return false;
  const text = fold(row.description ?? "").toUpperCase();
  return !cfg.noNeumatico.some((p) => new RegExp(p, "i").test(text));
}

/** Unidades de Lima de una fila: la suma de los almacenes configurados; sin desglose por almacén, el stock + la reserva. */
export function limaUnits(row: Pick<PriceRow, "stock" | "stockByWarehouse" | "notes">, cfg: Pick<MatchConfig, "almacenesLima">): number {
  const by = row.stockByWarehouse;
  if (by && Object.keys(by).length) {
    const lima = new Set(cfg.almacenesLima.map((w) => fold(w)));
    return Object.entries(by).reduce((n, [w, q]) => n + (lima.has(fold(w)) ? q : 0), 0);
  }
  return Math.max(0, (row.stock ?? 0) + reservedOf(row));
}

/** Productos de stock propio (neumáticos con código) con su disponible en Lima; uno por código (la fila más reciente). */
export function ownStockProducts(rows: PriceRow[], deductions: StockDeduction[], cfg: Pick<MatchConfig, "almacenesLima" | "noNeumatico">): MatchStockProduct[] {
  const committed = new Map<string, number>();
  for (const d of deductions) committed.set(d.rowId, (committed.get(d.rowId) ?? 0) + d.quantity);
  const byCode = new Map<string, PriceRow>();
  for (const r of rows) {
    if (r.kind !== "stock" || !r.code) continue;
    const prev = byCode.get(r.code);
    if (!prev || r.priceDate > prev.priceDate) byCode.set(r.code, r);
  }
  const out: MatchStockProduct[] = [];
  for (const r of byCode.values()) {
    if (!isMatchTyre(r, cfg)) continue;
    const lima = limaUnits(r, cfg);
    const reserved = reservedOf(r);
    const c = committed.get(r.id) ?? 0;
    out.push({
      code: r.code!,
      rowId: r.id,
      provider: r.provider,
      size: r.size,
      sizeDisplay: r.sizeDisplay || r.size,
      brand: r.brand,
      model: r.model,
      description: r.description,
      warehouses: { ...(r.stockByWarehouse ?? {}) },
      lima,
      reserved,
      committed: c,
      available: Math.max(0, lima - reserved - c),
      loadedAt: r.priceDate,
    });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

/** "Fenixway Flama 66" (marca y modelo, en tipo título). */
export function productName(p: Pick<MatchStockProduct, "brand" | "model">): string {
  const title = (s: string) => s.toLowerCase().replace(/(^|[\s/-])([a-záéíóúñ])/g, (_m, a: string, b: string) => a + b.toUpperCase());
  return [p.brand, title(p.model)].filter(Boolean).join(" ");
}

/** "295/80R22.5 Fenixway Flama 66" */
export function productLabel(p: Pick<MatchStockProduct, "sizeDisplay" | "brand" | "model">): string {
  return [p.sizeDisplay, productName(p)].filter(Boolean).join(" ");
}
