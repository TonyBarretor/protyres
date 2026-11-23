/**
 * Corrida K — productos prioritarios de Match Venta: siembra, prender/quitar la prioridad (con registro de quién), la
 * aplicación y el apagado automático al llegar a 0 (con aviso al vendedor). Encontrar un producto por lo que escribe o
 * dicta el vendedor: resolve.ts.
 *
 * La prioridad vive en la tabla match_products ligada al CÓDIGO de Odoo: una carga nueva de stock no la toca. Solo se
 * puede prender en neumáticos del stock propio con disponible > 0.
 */
import { addNotice } from "../bot/state";
import { matchCode } from "../store/shared";
import type { MatchProduct, PortalStore, PortalUser } from "../store/types";
import type { MatchConfig } from "./config";
import { productLabel, type MatchStockProduct } from "./stock";

/** Siembra idempotente desde config match.productos: solo agrega códigos nuevos (una prioridad quitada no vuelve). */
export async function seedPriorityProducts(store: PortalStore, cfg: Pick<MatchConfig, "productos">, at: Date = new Date()): Promise<string[]> {
  if (!cfg.productos.length) return [];
  return store.seedMatchProducts(
    cfg.productos.map((p) => ({ code: p.codigo, aplicacion: p.aplicacion, prioridad: p.prioridad })),
    at,
  );
}

export type PriorityResult =
  | { ok: true; product: MatchProduct; stock: MatchStockProduct | null; changed: boolean; text: string }
  | { ok: false; reason: "no_existe" | "sin_stock" | "sin_permiso"; text: string };

/** Quién puede marcar prioridades: vendedor, supervisor y administrador (el técnico no). */
export function canSetPriority(user: Pick<PortalUser, "rol">): boolean {
  return user.rol === "vendedor" || user.rol === "supervisor" || user.rol === "admin";
}

/**
 * Prende o quita la prioridad de un producto del stock propio. `stock`: productos del stock actual (ownStockProducts);
 * prender exige que el código esté en el stock y tenga disponible. Quitar funciona aunque el código ya no esté.
 * No recalcula: quien llama corre recalcMatchSafely (setPriorityAndRecalc lo hace todo).
 */
export async function setPriority(store: PortalStore, input: { code: string; on: boolean; user: Pick<PortalUser, "id" | "nombre" | "rol">; stock: MatchStockProduct[]; now?: Date }): Promise<PriorityResult> {
  const code = matchCode(input.code);
  if (!canSetPriority(input.user)) return { ok: false, reason: "sin_permiso", text: "Tu rol no puede marcar prioridades." };
  const st = input.stock.find((p) => p.code === code) ?? null;
  const products = await store.listMatchProducts();
  const current = products.find((p) => p.code === code) ?? null;
  if (input.on) {
    if (!st) return { ok: false, reason: "no_existe", text: `No encuentro *${code}* entre las llantas del stock propio.` };
    if (st.available <= 0) return { ok: false, reason: "sin_stock", text: `*${productLabel(st)}* (${code}) no tiene disponible en Lima: no la marco como prioridad.` };
    if (current?.prioridad) return { ok: true, product: current, stock: st, changed: false, text: `*${productLabel(st)}* (${code}) ya era prioridad.` };
  } else if (!current?.prioridad) {
    if (!current) return { ok: false, reason: "no_existe", text: `*${st ? productLabel(st) : code}* no es un producto prioritario.` };
    return { ok: true, product: current, stock: st, changed: false, text: `*${st ? productLabel(st) : code}* no era prioridad.` };
  }
  const product = await store.setMatchPriority(code, input.on, { userId: input.user.id, accion: input.on ? "activar" : "quitar", detalle: input.user.nombre, at: input.now });
  const label = st ? productLabel(st) : code;
  return {
    ok: true,
    product: product!,
    stock: st,
    changed: true,
    text: input.on ? `✔ *${label}* (${code}) es prioridad: ${st!.available} disponibles en Lima.` : `✔ Quité la prioridad de *${label}* (${code}).`,
  };
}

/** Aviso que deja el apagado automático. */
export function soldOutNotice(p: MatchStockProduct): string {
  return `📦 *${productLabel(p)}* (${p.code}) llegó a 0 disponibles en Lima: le quité la prioridad en Match Venta.`;
}

/**
 * Apaga las prioridades sin disponible (o que ya no están en el stock) y deja un aviso a los vendedores (y a quien la
 * prendió). Atómico por producto (setMatchPriority con onlyIfOn): aunque dos cálculos corran a la vez, un solo aviso.
 */
export async function switchOffSoldOut(store: PortalStore, stock: MatchStockProduct[], opts: { now?: Date; log?: (m: string) => void } = {}): Promise<string[]> {
  const now = opts.now ?? new Date();
  const byCode = new Map(stock.map((p) => [p.code, p]));
  // Solo cuenta una carga de stock del día en que se marcó la prioridad o posterior: al migrar, el primer cálculo corre
  // con el stock viejo y no debe apagar la siembra (que no vuelve a prender lo apagado). Sin ninguna carga, no hay prueba.
  const newestLoad = stock.reduce((m, p) => (p.loadedAt > m ? p.loadedAt : m), "");
  const limaDay = (d: Date) => new Date(d.getTime() - 5 * 3600_000).toISOString().slice(0, 10);
  const off: string[] = [];
  const users = await store.listUsers();
  for (const prod of await store.listMatchProducts()) {
    if (!prod.prioridad) continue;
    const st = byCode.get(prod.code);
    if (st && st.available > 0) continue;
    const evidence = st ? st.loadedAt : newestLoad;
    if (!evidence || (prod.prioridadAt && evidence < limaDay(prod.prioridadAt))) continue;
    const done = await store.setMatchPriority(prod.code, false, { userId: null, accion: "sin_stock", detalle: st ? "disponible 0" : "ya no está en el stock", at: now, onlyIfOn: true });
    if (!done) continue;
    off.push(prod.code);
    const text = st ? soldOutNotice(st) : `📦 *${prod.code}* ya no está en el stock cargado: le quité la prioridad en Match Venta.`;
    const to = users.filter((u) => u.activo && u.whatsapp && (u.rol === "vendedor" || u.id === prod.prioridadBy));
    for (const u of to) {
      try {
        await addNotice(store, u.whatsapp!, { text, createdAt: now.toISOString(), kind: "match_sin_stock" });
      } catch (err) {
        opts.log?.(`match: no pude dejar el aviso a ${u.nombre}: ${(err as Error).message}`);
      }
    }
  }
  return off;
}
