/**
 * ventas-odoo, punto 11: cifras de la vista previa del reporte de Odoo listas para mostrar. Puro y sin dependencias de
 * servidor (lo usa el formulario de "Subir ventas", que corre en el navegador).
 */
import { SERVICE_LABELS } from "../sales/classify";
import type { OdooPreviewStats } from "../sales/import";
import type { ServiceType } from "../store/types";

export type TotalsCheck = { estado: "cuadra" | "no_cuadra"; archivo: number; suma: number; diferencia: number } | { estado: "sin_totales"; suma: number };

/** Tolerancia del cuadre: redondeos de céntimos entre la fila TOTALES y la suma de las líneas. */
const TOTALS_TOLERANCE = 0.5;

/** Suma de TOTAL VTA S/ de las líneas frente a la fila TOTALES del archivo. */
export function totalsCheck(stats: Pick<OdooPreviewStats, "sumaTotalVtaSoles" | "totalesArchivo">): TotalsCheck {
  const suma = stats.sumaTotalVtaSoles;
  if (stats.totalesArchivo === null || stats.totalesArchivo === undefined) return { estado: "sin_totales", suma };
  const diferencia = Math.round((suma - stats.totalesArchivo) * 100) / 100;
  return { estado: Math.abs(diferencia) <= TOTALS_TOLERANCE ? "cuadra" : "no_cuadra", archivo: stats.totalesArchivo, suma, diferencia };
}

/** Líneas de servicio por tipo, de más a menos, con su nombre. */
export function serviceRows(stats: Pick<OdooPreviewStats, "porServicio">): { tipo: ServiceType; label: string; lineas: number }[] {
  return (Object.entries(stats.porServicio) as [ServiceType, number | undefined][])
    .filter(([, n]) => !!n)
    .map(([tipo, n]) => ({ tipo, label: SERVICE_LABELS[tipo] ?? tipo, lineas: n ?? 0 }))
    .sort((a, b) => b.lineas - a.lineas || a.label.localeCompare(b.label));
}

/** { "Cancelado": 3, "Borrador": 1 } → [["Cancelado", 3], ["Borrador", 1]], de más a menos. */
export function countRows(rec: Record<string, number>): [string, number][] {
  return Object.entries(rec)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export interface VendorRow {
  nombre: string;
  lineas: number;
  /** Textos del archivo que se juntaron ("FRANK RODRIGUEZ", "Frank Rodriguez"). */
  textos: string[];
}

/**
 * Vendedores del archivo: los reconocidos (usuario del portal; las variantes del texto que apuntan al mismo usuario se
 * juntan) y los textos sin dueño (las variantes que solo difieren en mayúsculas o tildes se juntan).
 */
export function vendorSummary(stats: Pick<OdooPreviewStats, "vendedores">): { reconocidos: VendorRow[]; sinDueno: VendorRow[] } {
  const fold = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const group = (rows: OdooPreviewStats["vendedores"], key: (v: OdooPreviewStats["vendedores"][number]) => string, name: (v: OdooPreviewStats["vendedores"][number]) => string) => {
    const by = new Map<string, VendorRow>();
    for (const v of rows) {
      const k = key(v);
      const r = by.get(k) ?? { nombre: name(v), lineas: 0, textos: [] };
      r.lineas += v.lineas;
      if (!r.textos.includes(v.texto)) r.textos.push(v.texto);
      by.set(k, r);
    }
    return [...by.values()].sort((a, b) => b.lineas - a.lineas || a.nombre.localeCompare(b.nombre));
  };
  return {
    reconocidos: group(stats.vendedores.filter((v) => v.userId !== null), (v) => `u${v.userId}`, (v) => v.vendedor ?? v.texto),
    sinDueno: group(stats.vendedores.filter((v) => v.userId === null), (v) => fold(v.texto), (v) => v.texto),
  };
}

/** "2026-09-12" → "12/09/2026" (o "—"). */
export function fmtIsoDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
