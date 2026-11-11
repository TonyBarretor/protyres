/** Tipos compartidos entre las server actions de "Subir ventas" y el formulario (cliente). */
import type { SaleInput } from "@/lib/portal/store/types";

/**
 * Vercel corta los cuerpos de más de 4,5 MB en las funciones (y Next acepta 1 MB por defecto en server actions; se subió a
 * 4.5mb en next.config.ts). 4 MB deja margen para el resto del multipart.
 */
export const MAX_UPLOAD_BYTES = 4_000_000;

export interface SalesPreview {
  ok: true;
  fileName: string;
  /** sha256 del archivo: confirmar exige que sea el mismo que se previsualizó. */
  hash: string;
  sheet: string | null;
  headerRow: number | null;
  mapping: { field: string; label: string; header: string | null; required: boolean }[];
  missing: string[];
  validCount: number;
  totalCantidad: number;
  rucs: number;
  rucsEnPadron: number;
  errorCount: number;
  /** Primeros errores (fila de Excel + motivo). */
  errors: { row: number; error: string }[];
  /** Primeras filas válidas. */
  sample: SaleInput[];
}

export type PreviewResult = SalesPreview | { ok: false; error: string };

export type ConfirmResult = { ok: true; inserted: number; skippedErrors: number } | { ok: false; error: string };
