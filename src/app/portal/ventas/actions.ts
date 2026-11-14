"use server";
/**
 * Subir ventas (.xlsx) en dos pasos: `previewSales` lee el archivo y devuelve el mapeo detectado, las filas válidas y los
 * errores por fila sin guardar nada; `confirmSales` recibe el MISMO archivo otra vez (el formulario lo conserva en el
 * navegador), comprueba que su sha256 coincide con el de la vista previa, lo vuelve a leer y guarda las filas válidas.
 * Así no hay estado en el servidor entre pasos y lo que se guarda es exactamente lo que se previsualizó.
 * Cada venta guarda `sourceRef = "xlsx:<sha256>"`: el mismo archivo no se puede cargar dos veces (se duplicarían las cifras).
 * Solo supervisor/admin (canUploadSales); se comprueba en cada acción.
 */
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/portal/auth/session";
import { readSalesXlsx, REQUIRED_SALE_FIELDS, SALE_FIELDS, checkUploadMeta, checkXlsxBytes, SalesXlsxLimitError, type SalesXlsxResult } from "@/lib/portal/sales/xlsx";
import { getPortalStore } from "@/lib/portal/store";
import { canUploadSales } from "@/lib/portal/ui/permissions";
import { formatLimaShort, formatLimaTime } from "@/lib/portal/ui/time";
import { MAX_UPLOAD_BYTES, type ConfirmResult, type PreviewResult } from "./types";

const FIELD_LABELS: Record<string, string> = {
  fecha: "Fecha",
  ruc: "RUC",
  razonSocial: "Razón social",
  medida: "Medida",
  marca: "Marca",
  diseno: "Diseño",
  cantidad: "Cantidad",
  precioUnitario: "Precio unitario",
  total: "Total",
  vendedor: "Vendedor",
};

const MAX_ERRORS_SHOWN = 100;
const SAMPLE_ROWS = 15;

type Parsed = { ok: true; name: string; hash: string; result: SalesXlsxResult } | { ok: false; error: string };

async function parseUpload(formData: FormData): Promise<Parsed> {
  const user = await requireUser();
  if (!canUploadSales(user)) return { ok: false, error: "Solo supervisor o admin pueden subir ventas." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Elige un archivo .xlsx." };
  // nombre y tamaño antes de leer el archivo; firma ZIP, hojas y tamaño descomprimido antes de abrirlo (corrida E, punto 5)
  const badMeta = checkUploadMeta(file, MAX_UPLOAD_BYTES);
  if (badMeta) return { ok: false, error: badMeta };
  const buf = Buffer.from(await file.arrayBuffer());
  const badBytes = checkXlsxBytes(buf);
  if (badBytes) return { ok: false, error: badBytes };
  try {
    const result = await readSalesXlsx(buf);
    return { ok: true, name: file.name, hash: createHash("sha256").update(buf).digest("hex"), result };
  } catch (err) {
    if (err instanceof SalesXlsxLimitError) return { ok: false, error: err.message };
    return { ok: false, error: `No se pudo leer el Excel: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function previewSales(formData: FormData): Promise<PreviewResult> {
  const p = await parseUpload(formData);
  if (!p.ok) return p;
  const r = p.result;
  const store = await getPortalStore();
  const rucs = [...new Set(r.rows.map((s) => s.ruc))];
  const found = await store.getCompaniesByRucs(rucs);
  return {
    ok: true,
    fileName: p.name,
    hash: p.hash,
    sheet: r.sheet,
    headerRow: r.headerRow,
    mapping: SALE_FIELDS.map((f) => ({ field: f, label: FIELD_LABELS[f] ?? f, header: r.mapping[f]?.header ?? null, required: REQUIRED_SALE_FIELDS.includes(f) })),
    missing: r.missing.map((f) => FIELD_LABELS[f] ?? f),
    validCount: r.rows.length,
    totalCantidad: r.rows.reduce((n, s) => n + s.cantidad, 0),
    rucs: rucs.length,
    rucsEnPadron: found.length,
    errorCount: r.errors.length,
    errors: r.errors.slice(0, MAX_ERRORS_SHOWN),
    sample: r.rows.slice(0, SAMPLE_ROWS),
  };
}

export async function confirmSales(formData: FormData): Promise<ConfirmResult> {
  const p = await parseUpload(formData);
  if (!p.ok) return p;
  const expected = formData.get("hash");
  if (typeof expected !== "string" || expected !== p.hash) return { ok: false, error: "El archivo cambió desde la vista previa. Vuelve a previsualizarlo." };
  if (!p.result.rows.length) return { ok: false, error: "No hay filas válidas para guardar." };
  const store = await getPortalStore();
  const sourceRef = `xlsx:${p.hash}`;
  const prev = await store.countSalesBySource(sourceRef);
  if (prev.total > 0) {
    const when = prev.firstAt ? `el ${formatLimaShort(prev.firstAt)} a las ${formatLimaTime(prev.firstAt)}` : "antes";
    return { ok: false, error: `Este archivo ya se cargó ${when} (${prev.total.toLocaleString("es-PE")} ventas). No se guardó de nuevo para no duplicar las cifras.` };
  }
  const inserted = await store.insertSales(p.result.rows.map((r) => ({ ...r, sourceRef })));
  await store.flush();
  revalidatePath("/portal", "layout");
  return { ok: true, inserted, skippedErrors: p.result.errors.length };
}
