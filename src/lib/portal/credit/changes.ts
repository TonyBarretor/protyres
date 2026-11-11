/**
 * Cálculo puro de lo que cambia al guardar una evaluación de crédito: lo usan los dos stores (JSON y Postgres) para
 * escribir la fila y su historial con el mismo criterio.
 */
import type { CompanyCredit, CreditChanges, CreditSaveInput } from "../store/types";

/** Campos que se comparan para el historial (el PDF va aparte, como "pdf"). */
const FIELDS = ["estado", "calificacion", "linea", "moneda", "plazoDias", "fuente", "consultadoAt", "consultadoPor", "notas"] as const;

const plain = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : (v ?? null));

export interface ResolvedCredit {
  /** La fila que queda (sin el PDF). */
  credit: CompanyCredit;
  /** undefined = no tocar el PDF guardado; null = borrarlo; objeto = reemplazarlo. */
  pdf: CreditSaveInput["pdf"];
  cambios: CreditChanges;
}

/** Fila resultante de aplicar `input` sobre `prev` (o sobre nada) y los cambios campo a campo. */
export function resolveCreditSave(companyId: number, prev: CompanyCredit | null, input: CreditSaveInput, userId: number | null, at: Date): ResolvedCredit {
  const keepPdf = input.pdf === undefined;
  const credit: CompanyCredit = {
    companyId,
    estado: input.estado,
    calificacion: input.calificacion ?? null,
    linea: input.linea ?? null,
    moneda: input.moneda ?? null,
    plazoDias: input.plazoDias ?? null,
    fuente: input.fuente ?? null,
    consultadoAt: input.consultadoAt ?? null,
    consultadoPor: input.consultadoPor ?? null,
    pdfName: keepPdf ? (prev?.pdfName ?? null) : (input.pdf?.name ?? null),
    pdfMime: keepPdf ? (prev?.pdfMime ?? null) : (input.pdf?.mime ?? null),
    notas: input.notas ?? null,
    updatedAt: at,
    updatedBy: userId,
  };
  const cambios: CreditChanges = {};
  for (const f of FIELDS) {
    const before = plain(prev ? prev[f] : f === "estado" ? "sin_evaluar" : null);
    const after = plain(credit[f]);
    if (before !== after) cambios[f] = [before, after];
  }
  // un PDF nuevo cuenta como cambio aunque se llame igual que el anterior
  if (input.pdf === null && prev?.pdfName) cambios.pdf = [prev.pdfName, null];
  else if (input.pdf) cambios.pdf = [prev?.pdfName ?? null, input.pdf.name];
  return { credit, pdf: input.pdf === null && !prev?.pdfName ? undefined : input.pdf, cambios };
}
