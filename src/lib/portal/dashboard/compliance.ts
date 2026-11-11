/**
 * Cumplimiento (puro): vendido en el mes y en el año contra la meta, y avance esperado a la fecha contra avance real.
 *
 * - Vendido = suma de `monto` de las ventas (SalesAggRow: `total`, o `precioUnitario × cantidad`), en la moneda de las
 *   metas (`goals.currency`; las ventas del piloto están en USD sin IGV). Las ventas sin total ni precio no suman y se
 *   cuentan en `sinMonto`.
 * - Avance real = vendido / meta. Avance esperado = días hábiles transcurridos / días hábiles del periodo (period.ts);
 *   "esperado a la fecha" en dinero = meta × avance esperado.
 * - `demo` = true si alguna venta demo entra en la cifra (la UI y el bot muestran "DEMO").
 */
import type { IsoDate, SalesAggRow } from "../store/types";
import { expectedProgress, monthOf, yearOf, type ExpectedProgress, type Period } from "./period";

export interface Amount {
  monto: number;
  cantidad: number;
  /** Ventas sin total ni precio (no suman monto). */
  sinMonto: number;
  demo: boolean;
}

export const ZERO: Amount = { monto: 0, cantidad: 0, sinMonto: 0, demo: false };

export function sumSales(rows: Iterable<SalesAggRow>, period: Period): Amount {
  const out: Amount = { ...ZERO };
  for (const r of rows) {
    if (r.fecha < period.start || r.fecha > period.end) continue;
    out.monto += r.monto;
    out.cantidad += r.cantidad;
    out.sinMonto += r.sinMonto;
    out.demo ||= r.demo;
  }
  out.monto = Math.round(out.monto * 100) / 100;
  return out;
}

export interface Goal {
  monthly: number | null;
  yearly: number | null;
}

export interface ComplianceFigure {
  period: Period;
  vendido: Amount;
  meta: number | null;
  progress: ExpectedProgress;
  /** Meta × avance esperado (null sin meta). */
  esperado: number | null;
  /** vendido / meta (null sin meta o meta 0). */
  avanceReal: number | null;
}

export interface Compliance {
  mes: ComplianceFigure;
  anio: ComplianceFigure;
}

function figure(rows: readonly SalesAggRow[], period: Period, today: IsoDate, meta: number | null, holidays: readonly string[]): ComplianceFigure {
  // Lo vendido cuenta hasta hoy (una venta con fecha futura no adelanta el avance).
  const vendido = sumSales(rows, { start: period.start, end: today < period.end ? today : period.end });
  const progress = expectedProgress(period, today, holidays);
  return {
    period,
    vendido,
    meta,
    progress,
    esperado: meta === null ? null : Math.round(meta * progress.ratio * 100) / 100,
    avanceReal: meta ? vendido.monto / meta : null,
  };
}

/** `rows` = ventas ya filtradas al alcance (un vendedor o el equipo). */
export function computeCompliance(rows: readonly SalesAggRow[], today: IsoDate, goal: Goal | null, holidays: readonly string[] = []): Compliance {
  return {
    mes: figure(rows, monthOf(today), today, goal?.monthly ?? null, holidays),
    anio: figure(rows, yearOf(today), today, goal?.yearly ?? null, holidays),
  };
}
