/**
 * Participación = neumáticos vendidos a la empresa en los últimos 12 meses (suma de `cantidad`). Si alguna venta demo
 * entra en la cifra, `demo` = true y la UI la etiqueta "DEMO". Cálculo puro: lo usan el portal (ficha, prospectos) y el
 * tablero sobre ventas ya leídas; los stores hacen lo mismo en `participation()` para listas grandes.
 */
import { defaultSince, digits, toIsoDate } from "../store/shared";
import type { IsoDate, Participation, Sale } from "../store/types";

/** Sirve tanto `Sale` (leída del store) como `SaleInput` (recién generada o leída del Excel). */
export type ParticipationSale = Pick<Sale, "ruc" | "fecha" | "cantidad"> & { isDemo?: boolean | null };

export interface ParticipationWindow {
  /** Inclusive. */
  since: IsoDate;
  /** Inclusive. */
  until: IsoDate;
}

/** Ventana por defecto: desde el mismo día de hace 12 meses hasta hoy (UTC). */
export function participationWindow(now: Date = new Date()): ParticipationWindow {
  return { since: defaultSince(now), until: toIsoDate(now) };
}

export interface ParticipationOptions {
  now?: Date;
  /** Sustituye el inicio de la ventana. */
  since?: Date | IsoDate;
  /** Sustituye el fin de la ventana (inclusive). */
  until?: Date | IsoDate;
  /** false = ignora las ventas demo (cifras "reales"). Por defecto se incluyen y se marcan. */
  includeDemo?: boolean;
}

/** RUC -> participación; solo trae los RUC con ventas en la ventana. */
export function computeParticipation(sales: Iterable<ParticipationSale>, opts: ParticipationOptions = {}): Record<string, Participation> {
  const win = participationWindow(opts.now);
  const since = opts.since !== undefined ? toIsoDate(opts.since) : win.since;
  const until = opts.until !== undefined ? toIsoDate(opts.until) : win.until;
  const includeDemo = opts.includeDemo ?? true;
  const out: Record<string, Participation> = {};
  for (const s of sales) {
    if (s.isDemo && !includeDemo) continue;
    const fecha = s.fecha.slice(0, 10);
    if (fecha < since || fecha > until) continue;
    const ruc = digits(s.ruc);
    const p = (out[ruc] ??= { cantidad: 0, demo: false });
    p.cantidad += s.cantidad;
    if (s.isDemo) p.demo = true;
  }
  return out;
}

/** Participación de una empresa (0 si no hay ventas). */
export function participationFor(ruc: string, sales: Iterable<ParticipationSale>, opts: ParticipationOptions = {}): Participation {
  return computeParticipation(sales, opts)[digits(ruc)] ?? { cantidad: 0, demo: false };
}

/** Totales de un conjunto (tablero): neumáticos, empresas con ventas y si hay demo. */
export function participationTotals(byRuc: Record<string, Participation>): { cantidad: number; empresas: number; demo: boolean } {
  let cantidad = 0;
  let demo = false;
  const rucs = Object.keys(byRuc);
  for (const r of rucs) {
    cantidad += byRuc[r].cantidad;
    demo ||= byRuc[r].demo;
  }
  return { cantidad, empresas: rucs.length, demo };
}

/** Texto corto para UI/bot: "120 neumáticos" o "120 neumáticos (DEMO)". */
export function formatParticipation(p: Participation): string {
  return `${p.cantidad.toLocaleString("es-PE")} neumático${p.cantidad === 1 ? "" : "s"}${p.demo ? " (DEMO)" : ""}`;
}
