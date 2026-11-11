"use server";
/**
 * Subir ventas (.xlsx) en dos pasos: `previewSales` lee el archivo y devuelve el mapeo detectado, las filas válidas y los
 * errores por fila sin guardar nada; `confirmSales` recibe el MISMO archivo otra vez (el formulario lo conserva en el
 * navegador), comprueba que su sha256 coincide con el de la vista previa, lo vuelve a leer y guarda las filas válidas.
 * Así no hay estado en el servidor entre pasos y lo que se guarda es exactamente lo que se previsualizó.
 * Solo supervisor/admin (canUploadSales); se comprueba en cada acción.
 */
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/portal/auth/session";
import { readSalesXlsx, REQUIRED_SALE_FIELDS, SALE_FIELDS, type SalesXlsxResult } from "@/lib/portal/sales/xlsx";
import { getPortalStore } from "@/lib/portal/store";
import { canUploadSales } from "@/lib/portal/ui/permissions";
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
const MAX_RUC_LOOKUPS = 1000;

type Parsed = { ok: true; name: string; hash: string; result: SalesXlsxResult } | { ok: false; error: string };

async function parseUpload(formData: FormData): Promise<Parsed> {
  const user = await requireUser();
  if (!canUploadSales(user)) return { ok: false, error: "Solo supervisor o admin pueden subir ventas." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Elige un archivo .xlsx." };
  if (!/\.xlsx$/i.test(file.name)) return { ok: false, error: "El archivo debe ser .xlsx (Excel). Si es .xls o .csv, ábrelo en Excel y guárdalo como .xlsx." };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: "El archivo pesa más de 7 MB. Divídelo en partes (por ejemplo, por mes)." };
  const buf = Buffer.from(await file.arrayBuffer());
  try {
    const result = await readSalesXlsx(buf);
    return { ok: true, name: file.name, hash: createHash("sha256").update(buf).digest("hex"), result };
  } catch (err) {
    return { ok: false, error: `No se pudo leer el Excel: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function previewSales(formData: FormData): Promise<PreviewResult> {
  const p = await parseUpload(formData);
  if (!p.ok) return p;
  const r = p.result;
  const store = await getPortalStore();
  const rucs = [...new Set(r.rows.map((s) => s.ruc))];
  const found = await Promise.all(rucs.slice(0, MAX_RUC_LOOKUPS).map((ruc) => store.getCompanyByRuc(ruc)));
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
    rucsEnPadron: found.filter(Boolean).length,
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
  const inserted = await store.insertSales(p.result.rows);
  await store.flush();
  revalidatePath("/portal", "layout");
  return { ok: true, inserted, skippedErrors: p.result.errors.length };
}
