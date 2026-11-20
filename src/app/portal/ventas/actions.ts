"use server";
/**
 * Subir ventas (.xlsx) en dos pasos: `previewSales` lee el archivo y devuelve el mapeo detectado, las filas válidas y los
 * errores por fila sin guardar nada; `confirmSales` recibe el MISMO archivo otra vez (el formulario lo conserva en el
 * navegador), comprueba que su sha256 coincide con el de la vista previa, lo vuelve a leer y guarda las filas válidas.
 * Así no hay estado en el servidor entre pasos y lo que se guarda es exactamente lo que se previsualizó.
 * Formato simple: cada venta guarda `sourceRef = "xlsx:<sha256>"`; el mismo archivo no se puede cargar dos veces (se
 * duplicarían las cifras).
 * ventas-odoo: el reporte de Odoo se reconoce solo (sales/odoo.ts) y se guarda con upsert por clave estable de línea: volver
 * a subirlo, o uno más reciente que incluya el periodo anterior, actualiza sin duplicar ni borrar el cliente final. Cada
 * carga queda en el historial (sales_uploads) y, si sube un vendedor, se avisa al administrador por WhatsApp.
 * Quién sube: config/portal.json → sales.uploadRoles (canUploadSales); se comprueba en cada acción.
 */
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/portal/auth/session";
import { commitOdooUpload, notifyAdminsOfUpload, previewOdooUpload, uploadNoticeText } from "@/lib/portal/sales/import";
import { GraphWhatsAppClient, graphConfigFromEnv } from "@/lib/whatsapp/client";
import { readSalesXlsx, REQUIRED_SALE_FIELDS, SALE_FIELDS, checkUploadMeta, checkXlsxBytes, SalesXlsxLimitError, type SalesXlsxResult } from "@/lib/portal/sales/xlsx";
import { loadPortalConfig } from "@/lib/portal/config";
import { recalcScoresSafely } from "@/lib/portal/scoring/recalc";
import { getPortalStore } from "@/lib/portal/store";
import { priceSizesSource } from "@/lib/store/price-sizes";
import { canUploadSales } from "@/lib/portal/ui/permissions";
import { formatLimaShort, formatLimaTime } from "@/lib/portal/ui/time";
import type { PortalUser } from "@/lib/portal/store/types";
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

type Parsed = { ok: true; name: string; hash: string; result: SalesXlsxResult; user: PortalUser } | { ok: false; error: string };

async function parseUpload(formData: FormData): Promise<Parsed> {
  const user = await requireUser();
  if (!canUploadSales(user)) return { ok: false, error: "Tu rol no puede subir ventas. Envía el reporte a tu supervisor o al administrador." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Elige un archivo .xlsx." };
  // nombre y tamaño antes de leer el archivo; firma ZIP, hojas y tamaño descomprimido antes de abrirlo (corrida E, punto 5)
  const badMeta = checkUploadMeta(file, MAX_UPLOAD_BYTES);
  if (badMeta) return { ok: false, error: badMeta };
  const buf = Buffer.from(await file.arrayBuffer());
  const badBytes = checkXlsxBytes(buf);
  if (badBytes) return { ok: false, error: badBytes };
  try {
    const store = await getPortalStore();
    const result = await readSalesXlsx(buf, { users: await store.listUsers() });
    return { ok: true, name: file.name, hash: createHash("sha256").update(buf).digest("hex"), result, user };
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
  if (r.formato === "odoo" && r.odoo) {
    return {
      ok: true,
      formato: "odoo",
      fileName: p.name,
      hash: p.hash,
      sheet: r.sheet,
      headerRow: r.headerRow,
      stats: await previewOdooUpload(store, r.odoo),
      errorCount: r.errors.length,
      errors: r.errors.slice(0, MAX_ERRORS_SHOWN),
    };
  }
  const rucs = [...new Set(r.rows.map((s) => s.ruc))];
  const found = await store.getCompaniesByRucs(rucs);
  return {
    ok: true,
    formato: "simple",
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
  if (p.result.formato === "odoo" && p.result.odoo) return confirmOdoo(p, p.result.odoo);
  const sourceRef = `xlsx:${p.hash}`;
  const prev = await store.countSalesBySource(sourceRef);
  if (prev.total > 0) {
    const when = prev.firstAt ? `el ${formatLimaShort(prev.firstAt)} a las ${formatLimaTime(prev.firstAt)}` : "antes";
    return { ok: false, error: `Este archivo ya se cargó ${when} (${prev.total.toLocaleString("es-PE")} ventas). No se guardó de nuevo para no duplicar las cifras.` };
  }
  const inserted = await store.insertSales(p.result.rows.map((r) => ({ ...r, sourceRef })));
  // corrida G: las ventas cambian quién es cliente y el espacio por ganar (y con eso los cortes de nivel): todo
  await recalcScoresSafely(store, loadPortalConfig().scoring, { prices: priceSizesSource, why: "subida de ventas" });
  await store.flush();
  revalidatePath("/portal", "layout");
  await store.recordSalesUpload({
    fileName: p.name,
    hash: p.hash,
    formato: "simple",
    userId: p.user.id,
    userName: p.user.nombre,
    userRol: p.user.rol,
    inserted,
    updated: 0,
    stats: { filas: inserted, errores: p.result.errors.length },
  });
  await store.flush();
  if (p.user.rol === "vendedor") await notifyAdmins(store, `${p.user.nombre} subió ventas: ${p.name}, ${inserted} filas.`);
  return { ok: true, formato: "simple", inserted, skippedErrors: p.result.errors.length };
}

async function notifyAdmins(store: Awaited<ReturnType<typeof getPortalStore>>, text: string): Promise<boolean> {
  const cfg = graphConfigFromEnv();
  const res = await notifyAdminsOfUpload(store, cfg ? new GraphWhatsAppClient(cfg) : null, text);
  await store.flush();
  return res.some((r) => r.status !== "error");
}

async function confirmOdoo(p: Extract<Parsed, { ok: true }>, odoo: NonNullable<SalesXlsxResult["odoo"]>): Promise<ConfirmResult> {
  const store = await getPortalStore();
  const stats = await previewOdooUpload(store, odoo);
  const res = await commitOdooUpload({ store, parsed: odoo, fileName: p.name, hash: p.hash, user: p.user, stats, prices: priceSizesSource });
  revalidatePath("/portal", "layout");
  const adminAvisado = p.user.rol === "vendedor" ? await notifyAdmins(store, uploadNoticeText(p.user, p.name, res, stats)) : false;
  return { ok: true, formato: "odoo", inserted: res.inserted, updated: res.updated, skippedErrors: p.result.errors.length, empresasRecalculadas: res.empresasRecalculadas, adminAvisado };
}
