/** Textos del bloque Crédito de la ficha (montos, historial). */
import type { CreditChanges } from "../store/types";
import { formatLimaShort } from "../ui/time";
import { creditEstadoLabel, isCreditEstado } from "./states";

const nf = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 });

/** "US$ 50,000" / "S/ 12,500.5" / "—". */
export function fmtCreditAmount(n: number | null | undefined, moneda: string | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${moneda === "PEN" ? "S/" : "US$"} ${nf.format(n)}`;
}

const FIELD_LABELS: Record<string, string> = {
  estado: "estado",
  calificacion: "calificación",
  linea: "línea",
  moneda: "moneda",
  plazoDias: "plazo",
  fuente: "fuente",
  consultadoAt: "fecha de consulta",
  consultadoPor: "consultado por",
  notas: "notas",
  pdf: "PDF",
};

function show(field: string, v: unknown, userName: (id: number | null) => string): string {
  if (v === null || v === undefined || v === "") return "—";
  if (field === "estado" && isCreditEstado(v)) return creditEstadoLabel(v);
  if (field === "consultadoAt" && typeof v === "string") return formatLimaShort(new Date(v));
  if (field === "consultadoPor") return userName(typeof v === "number" ? v : Number(v));
  if (field === "plazoDias") return `${v} días`;
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/** Cambios de una fila del historial, legibles: ["estado: sin evaluar → aprobado", "línea: — → 50000", ...]. */
export function describeCreditChanges(cambios: CreditChanges, userName: (id: number | null) => string = (id) => (id === null ? "—" : `#${id}`)): string[] {
  return Object.entries(cambios).map(([f, [a, b]]) => `${FIELD_LABELS[f] ?? f}: ${show(f, a, userName)} → ${show(f, b, userName)}`);
}
