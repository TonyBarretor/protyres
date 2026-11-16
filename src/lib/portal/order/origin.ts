/**
 * Corrida H, puntos 3 y 4: de dónde sale cada producto del pedido (stock propio o un proveedor) y cuánto stock queda.
 *
 *  - Stock propio (ítem "own" de la cotización, o un producto que está en el stock de Odoo): su fila de stock (por la
 *    fila de la lista propia, o por medida + marca + modelo) y el almacén propio (config/portal.json orders.ownStock).
 *  - Proveedor (ítem "provider" o con costo de un proveedor): el proveedor de la lista de contactos que le corresponde
 *    (contacto, teléfono, correo; "JCH" -> JCH LLANTAS) y el precio de compra con IGV de la lista usada.
 *  - Ni lo uno ni lo otro (precio de contrato o escrito sin lista): si el producto está en el stock propio, stock; si
 *    está en la lista de un solo proveedor, ese proveedor con su costo; si no, queda `origenDesconocido` y el bot
 *    pregunta antes de armar el Excel (con sugerencias por marca de la lista de proveedores).
 *
 * Disponible = stock cargado − descontado por pedidos desde esa carga (sin contar el mismo pedido: rehacerlo no se
 * descuenta a sí mismo). Nunca se toca la cantidad cargada.
 */
import type { PriceRow } from "../../ingest/types";
import { findStockRow, modelSimilarity } from "../../quote/match";
import { convertCurrency, r2 } from "../../quote/pricing";
import type { PricingSettings } from "../../settings";
import { fold } from "../../tyre/brands";
import { stockOriginKey, type StockDeduction, type StockDeductionInput, type Supplier } from "../../store/types";
import { exactModel } from "./items";
import { pedidoDescription, type OwnStockBlock, type PedidoItem } from "./pedido-xlsx";
import { supplierForProvider } from "./suppliers";

export interface OriginDeps {
  rows: PriceRow[];
  suppliers: Supplier[];
  /** config/portal.json orders.supplierProviders */
  overrides?: Record<string, string>;
  own: OwnStockBlock;
  pricing: PricingSettings;
}

const sizeOf = (it: PedidoItem) => it.size || it.medida.split(/\s+/)[0] || "";

/** ¿La fila es este producto? Misma medida, misma marca y el mismo modelo (con los mismos números: "77" no es "89"). */
function sameProduct(row: PriceRow, it: PedidoItem): boolean {
  const size = sizeOf(it);
  if (!row.size || !size || fold(row.size).replace(/\s+/g, "") !== fold(size).replace(/\s+/g, "")) return false;
  if (it.marca && fold(row.brand) !== fold(it.marca)) return false;
  if (!it.modelo) return true;
  return exactModel(it.modelo, row.model || row.description, modelSimilarity(it.modelo, row.model || row.description));
}

/** La fila de stock (kind "stock") de un ítem de stock propio: por su fila de la lista propia o por el producto. */
export function stockRowFor(it: PedidoItem, rows: PriceRow[]): PriceRow | undefined {
  const stockRows = rows.filter((r) => r.kind === "stock");
  const own = it.rowId ? rows.find((r) => r.id === it.rowId) : undefined;
  if (own?.kind === "stock") return own;
  if (own?.kind === "own") {
    const hit = findStockRow(own, stockRows);
    if (hit) return hit;
  }
  return stockRows.find((r) => sameProduct(r, it));
}

/** Datos del proveedor para el bloque: nombre de la lista de contactos (o el del cotizador), contacto, teléfono, correo. */
function supplierData(provider: string, deps: OriginDeps): Pick<NonNullable<PedidoItem["terceros"]>, "proveedor" | "contacto" | "telefono" | "email"> {
  const x = supplierForProvider(provider, deps.suppliers, deps.overrides);
  if (!x) return { proveedor: provider.trim().toUpperCase() };
  return { proveedor: x.name, contacto: x.contact, telefono: x.phone, email: x.email };
}

/** Precio de compra con IGV de una fila de proveedor, en la moneda del pedido. */
function costWithTax(row: PriceRow, pricing: PricingSettings): number | undefined {
  if (row.cost === null) return undefined;
  const conv = convertCurrency(row.cost, row.currency, pricing);
  if (!conv.ok) return undefined;
  return r2(row.priceIncludesTax ? conv.value : conv.value * (1 + pricing.taxPct / 100));
}

/** Completa el origen de cada ítem (no cambia cantidades ni precios de venta). */
export function resolveOrigins(items: PedidoItem[], deps: OriginDeps): PedidoItem[] {
  return items.map((src) => {
    const it: PedidoItem = { ...src, ...(src.ubs ? { ubs: [...src.ubs] } : {}) };
    if (it.terceros) {
      const sup = supplierData(it.terceros.proveedor, deps);
      it.terceros = { ...it.terceros, ...sup, contacto: it.terceros.contacto ?? sup.contacto, telefono: it.terceros.telefono ?? sup.telefono, email: it.terceros.email ?? sup.email };
      return it;
    }
    if (it.stock || it.origenDesconocido) {
      const row = stockRowFor(it, deps.rows);
      if (row && (it.stock || (row.stock ?? 0) > 0)) {
        it.stock = { rowId: row.id, origin: stockOriginKey(row.provider, row.kind), almacen: deps.own.warehouse };
        delete it.origenDesconocido;
        return it;
      }
      if (it.stock) {
        it.stock = { almacen: deps.own.warehouse }; // de la lista propia sin fila de stock: stock propio, sin contador
        return it;
      }
      const prov = deps.rows.filter((r) => r.kind === "provider" && sameProduct(r, it));
      const names = [...new Set(prov.map((r) => fold(r.provider)))];
      if (names.length === 1) {
        const best = [...prov].sort((a, b) => b.priceDate.localeCompare(a.priceDate))[0];
        it.terceros = { ...supplierData(best.provider, deps), precioCompraConIgv: costWithTax(best, deps.pricing) };
        delete it.origenDesconocido;
      }
    }
    return it;
  });
}

/** Productos sin origen identificable (índices), para preguntar al vendedor. */
export function unknownOrigins(items: PedidoItem[]): number[] {
  return items.map((it, i) => (it.origenDesconocido && !it.terceros && !it.stock ? i : -1)).filter((i) => i >= 0);
}

/** Lo comprometido por pedidos por fila de stock, sin contar `exceptOrderKey` (el pedido que se está rehaciendo). */
export function committedMap(deductions: StockDeduction[], exceptOrderKey?: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of deductions) if (d.orderKey !== exceptOrderKey) out.set(d.rowId, (out.get(d.rowId) ?? 0) + d.quantity);
  return out;
}

export interface StockCheck {
  description: string;
  pedido: number;
  cargadas: number;
  enPedidos: number;
  disponible: number;
}

/** "stock 4 (12 cargadas − 8 en pedidos)" / "stock 12" */
export function availableText(c: Pick<StockCheck, "cargadas" | "enPedidos" | "disponible">): string {
  return c.enPedidos ? `stock ${Math.max(0, c.disponible)} (${c.cargadas} cargadas − ${c.enPedidos} en pedidos)` : `stock ${c.cargadas}`;
}

/** Stock propio del pedido frente al disponible (sumando las líneas del mismo producto). */
export function stockChecks(items: PedidoItem[], rows: PriceRow[], committed: Map<string, number>): StockCheck[] {
  const byRow = new Map<string, StockCheck>();
  for (const it of items) {
    const id = it.stock?.rowId;
    if (!id) continue;
    const row = rows.find((r) => r.id === id);
    if (!row || row.stock === null) continue;
    const c = byRow.get(id) ?? { description: pedidoDescription(it), pedido: 0, cargadas: row.stock, enPedidos: committed.get(id) ?? 0, disponible: row.stock - (committed.get(id) ?? 0) };
    c.pedido += it.cantidad;
    byRow.set(id, c);
  }
  return [...byRow.values()];
}

/** Descuentos de un pedido: unidades de stock propio por fila y almacén. */
export function deductionsFor(items: PedidoItem[]): StockDeductionInput[] {
  const out = new Map<string, StockDeductionInput>();
  for (const it of items) {
    const s = it.stock;
    if (!s?.rowId || !s.origin) continue;
    const key = `${s.rowId}|${s.almacen ?? ""}`;
    const prev = out.get(key);
    if (prev) prev.quantity += it.cantidad;
    else out.set(key, { rowId: s.rowId, origin: s.origin, warehouse: s.almacen ?? "", quantity: it.cantidad, description: pedidoDescription(it) });
  }
  return [...out.values()];
}

/** Clave del pedido para el contador: la misma OC (empresa + número) rehecha reemplaza sus descuentos. */
export function orderStockKey(companyId: number, numero: string | null, orderId: number): string {
  return numero ? `oc:${companyId}:${numero.trim().toUpperCase()}` : `oc:${companyId}:id${orderId}`;
}
