/**
 * Proyección del mes (pura): lo vendido en el mes + el pipeline ponderado por la probabilidad de su etapa.
 *
 * Reglas (decisiones C2):
 * - Entran las oportunidades **abiertas** con `cierreEsperado` dentro del mes (Lima). Monto = `montoEstimado`;
 *   ponderado = monto × `probabilidad` / 100 (la de la etapa, que moveStage fija en la oportunidad).
 * - Sin `cierreEsperado`: no se cuentan (regla conservadora) y se informan como "sin fecha de cierre".
 * - Cierre esperado anterior al mes y aún abiertas: no se cuentan ("cierre vencido"; hay que actualizar la fecha).
 * - Sin `montoEstimado`: no suman; se informa cuántas son.
 * - Cerrado ganado no suma: su venta real llegará (o ya llegó) en `sales` y se contaría dos veces. Cerrado perdido
 *   tampoco (probabilidad 0). El desglose muestra solo etapas abiertas.
 */
import { STAGES, isClosedStage, type StageId } from "../stages";
import type { Opportunity } from "../store/types";
import type { Amount } from "./compliance";
import type { Period } from "./period";

export interface StageSlice {
  etapa: StageId;
  label: string;
  probabilidad: number;
  /** Oportunidades con monto que cierran en el mes. */
  n: number;
  monto: number;
  ponderado: number;
}

export interface Projection {
  vendido: Amount;
  ponderado: number;
  /** vendido.monto + ponderado. */
  proyeccion: number;
  /** Lo vendido incluye ventas demo. */
  demo: boolean;
  porEtapa: StageSlice[];
  /** Abiertas sin fecha de cierre (no se cuentan). */
  sinFecha: number;
  /** Abiertas con cierre en el mes pero sin monto estimado (no suman). */
  sinMonto: number;
  /** Abiertas con cierre esperado anterior al mes (no se cuentan). */
  cierreVencido: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** `opps` = oportunidades ya filtradas al alcance; `vendido` = lo vendido en el mes (compliance.mes.vendido). */
export function computeProjection(opps: readonly Opportunity[], month: Period, vendido: Amount): Projection {
  const slices = new Map<StageId, StageSlice>();
  for (const s of STAGES) if (!isClosedStage(s.id)) slices.set(s.id, { etapa: s.id, label: s.label, probabilidad: s.probabilidad, n: 0, monto: 0, ponderado: 0 });
  let sinFecha = 0;
  let sinMonto = 0;
  let cierreVencido = 0;
  for (const o of opps) {
    if (o.closedAt || isClosedStage(o.etapa)) continue;
    const slice = slices.get(o.etapa);
    if (!slice) continue;
    if (!o.cierreEsperado) {
      sinFecha++;
      continue;
    }
    const cierre = o.cierreEsperado.slice(0, 10);
    if (cierre < month.start) {
      cierreVencido++;
      continue;
    }
    if (cierre > month.end) continue;
    if (o.montoEstimado === null || o.montoEstimado === undefined) {
      sinMonto++;
      continue;
    }
    slice.n++;
    slice.monto += o.montoEstimado;
    slice.ponderado += (o.montoEstimado * o.probabilidad) / 100;
  }
  const porEtapa = [...slices.values()].map((s) => ({ ...s, monto: round2(s.monto), ponderado: round2(s.ponderado) }));
  const ponderado = round2(porEtapa.reduce((a, s) => a + s.ponderado, 0));
  return { vendido, ponderado, proyeccion: round2(vendido.monto + ponderado), demo: vendido.demo, porEtapa, sinFecha, sinMonto, cierreVencido };
}
