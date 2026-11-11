/** Tipos compartidos entre las server actions de "Subir ventas" y el formulario (cliente). */
import type { SaleInput } from "@/lib/portal/store/types";

/** Las server actions de Next aceptan hasta 1 MB por defecto (next.config: serverActions.bodySizeLimit). */
export const MAX_UPLOAD_BYTES = 7_500_000; // next.config.ts: serverActions.bodySizeLimit 8mb

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
