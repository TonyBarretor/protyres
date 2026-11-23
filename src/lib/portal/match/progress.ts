/**
 * Corrida K, punto 6 — avance de Match Venta por producto prioritario:
 *  - disponible (Lima − reserva), pedido (descontado por pedidos: contador de stock), restante (disponible − pedido);
 *  - cotizado: neumáticos de ese producto en cotizaciones desde que se marcó como prioridad (mismo código, o misma
 *    medida + marca + modelo). Solo se cuenta lo que el cotizador ya guarda: el precio y el cotizador no cambian;
 *  - visitas agendadas desde Match Venta por ese producto, hechas (reportadas o cita realizada), con cotización (actividad
 *    de cotización u oportunidad con cotización después de agendar) y con pedido (orden de compra después de agendar).
 */
import type { Quote, QuoteItem } from "../../quote/types";
import { fold } from "../../tyre/brands";
import type { PortalStore } from "../store/types";
import { productLabel, type MatchStockProduct } from "./stock";

export interface MatchProgressRow {
  code: string;
  etiqueta: string;
  disponible: number;
  cotizado: number;
  pedido: number;
  restante: number;
  visitas: { agendadas: number; hechas: number; conCotizacion: number; conPedido: number };
  prioridadDesde: Date | null;
}

/** ¿El ítem de la cotización es este producto? Por código; si no trae, misma medida, marca y modelo (con sus números). */
export function quoteItemIs(it: Pick<QuoteItem, "code" | "size" | "brand" | "model">, p: Pick<MatchStockProduct, "code" | "size" | "brand" | "model">): boolean {
  if (it.code) return it.code.replace(/\s+/g, "").toUpperCase() === p.code;
  if (!it.size || it.size !== p.size) return false;
  if (fold(it.brand) !== fold(p.brand)) return false;
  const nums = (s: string) => (s.match(/\d+/g) ?? []).join(" ");
  const words = (s: string) => fold(s).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  if (nums(it.model) !== nums(p.model)) return false;
  const a = words(it.model);
  return words(p.model).every((w) => a.includes(w));
}

/** Neumáticos cotizados de cada producto desde su fecha de prioridad (cotizaciones no anuladas). */
export function quotedUnits(quotes: Quote[], products: (Pick<MatchStockProduct, "code" | "size" | "brand" | "model"> & { since: Date | null })[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const q of quotes) {
    if (q.status === "cancelled") continue;
    for (const p of products) {
      if (p.since && q.date < p.since.toISOString().slice(0, 10)) continue;
      const n = q.items.filter((it) => quoteItemIs(it, p)).reduce((a, it) => a + it.quantity, 0);
      if (n) out.set(p.code, (out.get(p.code) ?? 0) + n);
    }
  }
  return out;
}

export async function matchProgress(store: PortalStore, opts: { stock: MatchStockProduct[]; quotes?: Quote[] }): Promise<MatchProgressRow[]> {
  const products = await store.listMatchProducts();
  const on = products.filter((p) => p.prioridad || p.sinStockAt);
  const byCode = new Map(opts.stock.map((s) => [s.code, s]));
  const items = on.filter((p) => byCode.has(p.code)).map((p) => ({ ...byCode.get(p.code)!, since: p.prioridadAt }));
  const quoted = quotedUnits(opts.quotes ?? [], items);
  const visits = await store.listMatchVisits({});
  const companies = [...new Set(visits.map((v) => v.companyId))];
  const acts = new Map<number, { tipo: string; at: Date }[]>();
  for (const id of companies) acts.set(id, (await store.listActivities({ companyId: id })).map((a) => ({ tipo: String(a.tipo), at: a.occurredAt })));
  const orders = new Map<number, Date[]>();
  for (const id of companies) orders.set(id, (await store.listPurchaseOrders({ companyId: id })).map((o) => o.createdAt));
  const appts = new Map<number, string>();
  for (const id of companies) for (const a of await store.listAppointments({ companyId: id })) appts.set(a.id, String(a.estado));

  return items.map((p) => {
    const vs = visits.filter((v) => v.productCode === p.code);
    const after = (v: (typeof vs)[number], pred: (x: { tipo: string; at: Date }) => boolean) => (acts.get(v.companyId) ?? []).some((a) => a.at >= v.createdAt && pred(a));
    const disponible = Math.max(0, p.lima - p.reserved);
    return {
      code: p.code,
      etiqueta: productLabel(p),
      disponible,
      cotizado: quoted.get(p.code) ?? 0,
      pedido: p.committed,
      restante: Math.max(0, disponible - p.committed),
      visitas: {
        agendadas: vs.length,
        hechas: vs.filter((v) => v.activityId !== null || appts.get(v.appointmentId) === "realizada").length,
        conCotizacion: vs.filter((v) => after(v, (a) => a.tipo.startsWith("cotizacion"))).length,
        conPedido: vs.filter((v) => after(v, (a) => a.tipo === "oc") || (orders.get(v.companyId) ?? []).some((d) => d >= v.createdAt)).length,
      },
      prioridadDesde: p.since,
    };
  });
}

/** Texto para el bot (`avance match`): una línea por producto. */
export function progressText(rows: MatchProgressRow[]): string {
  if (!rows.length) return "No hay productos prioritarios con stock.";
  return [
    "*Avance Match Venta*",
    ...rows.map(
      (r) =>
        `• *${r.etiqueta}* (${r.code}): disponible ${r.disponible} · cotizado ${r.cotizado} · pedido ${r.pedido} · quedan ${r.restante}\n  Visitas: ${r.visitas.agendadas} agendadas · ${r.visitas.hechas} hechas · ${r.visitas.conCotizacion} con cotización · ${r.visitas.conPedido} con pedido`,
    ),
  ].join("\n");
}
