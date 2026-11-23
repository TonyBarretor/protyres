/**
 * Corrida K, punto 1 — reporte de stock de Odoo con un almacén por columna y la reserva:
 *
 *   CÓDIGO | MEDIDA | MARCA | MODELO | DISPON. ALMACEN SAN LUIS | DISPON. ALMACEN CALLAO | RESERVA
 *
 * El texto plano (pdfToText) pierde las posiciones: una fila con un solo número ("P0949 … 40") no dice si es San Luis,
 * Callao o reserva. Aquí se leen los textos con su X (unpdf getTextContent, transform[4]) y cada uno va a la columna de su
 * encabezado: los de texto (código, medida, marca, modelo) a la columna que empieza a su izquierda; los números, al
 * almacén cuyo encabezado tiene el centro más cerca.
 *
 * Fila guardada: `stockByWarehouse` = unidades por almacén (los de 0 no se listan, como en la lista de JCH), `stock` =
 * suma de almacenes − reserva (lo que se puede usar; el contador de pedidos descuenta de aquí) y la reserva en `notes`
 * ("reserva: 5"; reservedOf la lee), sin columnas nuevas en la tabla de precios. Lo que no es neumático (aros, cámaras,
 * servicios) se guarda igual, como en el diseño anterior; Match Venta lo deja fuera.
 */
import { getDocumentProxy } from "unpdf";
import { findTyreSizes } from "../tyre/spec";
import { knownBrand } from "../tyre/brands";
import type { IngestOptions, IngestResult, PriceRow } from "./types";
import { buildRow, parseDateLoose, stripToModel, todayIso } from "./util";
import { dedupeRows } from "./tabular";

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  page: number;
}

/** Textos del PDF con su posición (sin los vacíos), página por página, de arriba abajo y de izquierda a derecha. */
export async function pdfTextItems(buffer: Buffer): Promise<PdfTextItem[]> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const out: PdfTextItem[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    for (const it of tc.items as { str?: string; transform?: number[]; width?: number }[]) {
      const str = (it.str ?? "").replace(/\s+/g, " ").trim();
      if (!str || !it.transform) continue;
      out.push({ str, x: it.transform[4], y: it.transform[5], width: it.width ?? 0, page: p });
    }
  }
  return out;
}

/** Agrupa en líneas por Y (tolerancia de medio renglón): la medida del real sale 0,2 pt más arriba que el código. */
export function groupLines(items: PdfTextItem[], tolerance = 2): PdfTextItem[][] {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines: PdfTextItem[][] = [];
  for (const it of sorted) {
    const last = lines.at(-1);
    if (last && last[0].page === it.page && Math.abs(last[0].y - it.y) <= tolerance) last.push(it);
    else lines.push([it]);
  }
  for (const l of lines) l.sort((a, b) => a.x - b.x);
  return lines;
}

type ColumnId = "codigo" | "medida" | "marca" | "modelo" | "almacen" | "reserva";

interface Column {
  id: ColumnId;
  /** Nombre del almacén ("San Luis", "Callao") en las columnas de almacén. */
  warehouse?: string;
  x: number;
  center: number;
}

const HEADER_RE: [RegExp, ColumnId][] = [
  [/^C[ÓO]DIGO$/i, "codigo"],
  [/^MEDIDA$/i, "medida"],
  [/^MARCA$/i, "marca"],
  [/^MODELO$/i, "modelo"],
  [/^DISPON\.?\s*ALMAC[EÉ]N\s+(.+)$/i, "almacen"],
  [/^RESERVA$/i, "reserva"],
];

/** "SAN LUIS" -> "San Luis" (así queda en stockByWarehouse y en config/portal.json match.almacenesLima). */
export function warehouseLabel(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Columnas del encabezado (la línea con CÓDIGO y al menos un DISPON. ALMACEN); null si no está. */
export function headerColumns(line: PdfTextItem[]): Column[] | null {
  const cols: Column[] = [];
  for (const it of line) {
    for (const [re, id] of HEADER_RE) {
      const m = re.exec(it.str);
      if (!m) continue;
      cols.push({ id, x: it.x, center: it.x + it.width / 2, ...(id === "almacen" ? { warehouse: warehouseLabel(m[1]) } : {}) });
      break;
    }
  }
  if (!cols.some((c) => c.id === "codigo") || !cols.some((c) => c.id === "almacen")) return null;
  return cols.sort((a, b) => a.x - b.x);
}

/** Columna de un texto: número en la zona de cantidades -> la de centro más cercano; si no, la que empieza a su izquierda. */
function columnOf(it: PdfTextItem, cols: Column[]): Column | null {
  const qty = cols.filter((c) => c.id === "almacen" || c.id === "reserva");
  const firstQtyX = Math.min(...qty.map((c) => c.x));
  if (/^\d{1,6}$/.test(it.str) && it.x >= firstQtyX - 20) {
    const center = it.x + it.width / 2;
    return qty.reduce((best, c) => (Math.abs(c.center - center) < Math.abs(best.center - center) ? c : best), qty[0]);
  }
  let hit: Column | null = null;
  for (const c of cols) if (c.x <= it.x + 1.5) hit = c;
  return hit;
}

const RESERVA_NOTE = /(?:^|;\s*)reserva:\s*(\d+)/i;

/** Unidades reservadas de una fila de stock (0 si no tiene). */
export function reservedOf(row: Pick<PriceRow, "notes">): number {
  const m = RESERVA_NOTE.exec(row.notes ?? "");
  return m ? Number(m[1]) : 0;
}

export function parseOdooStockWarehouses(items: PdfTextItem[], opts: IngestOptions): IngestResult {
  const warnings: string[] = [];
  const rows: PriceRow[] = [];
  const priceDate = opts.priceDate ?? parseDateLoose(opts.sourceRef) ?? todayIso();
  let cols: Column[] | null = null;
  let seen = 0;
  for (const line of groupLines(items)) {
    const header = headerColumns(line);
    if (header) {
      cols = header; // cada página repite el encabezado (y podría moverlo): manda el último visto
      continue;
    }
    if (!cols) continue;
    const parts: Partial<Record<ColumnId, string[]>> = {};
    const byWarehouse: Record<string, number> = {};
    let reserva = 0;
    for (const it of line) {
      const c = columnOf(it, cols);
      if (!c) continue;
      if (c.id === "almacen" && /^\d+$/.test(it.str)) byWarehouse[c.warehouse!] = (byWarehouse[c.warehouse!] ?? 0) + Number(it.str);
      else if (c.id === "reserva" && /^\d+$/.test(it.str)) reserva += Number(it.str);
      else (parts[c.id] ??= []).push(it.str);
    }
    const code = (parts.codigo ?? []).join(" ").trim();
    if (!/^[A-Z]{1,5}\d{2,6}[A-Z]?$/.test(code)) continue;
    seen++;
    const medida = (parts.medida ?? []).join(" ").trim();
    const marca = (parts.marca ?? []).join(" ").trim();
    const size = findTyreSizes(medida)[0] ?? null;
    // sin MODELO (algunas filas lo traen vacío): lo que queda de la medida sin medida, lonas ni índice ("BLADE X/MT")
    const modelo =
      (parts.modelo ?? []).join(" ").trim() ||
      (size
        ? stripToModel(medida, { sizeRaw: size.raw })
            .replace(/\b\d{1,2}\s*PR\b|\b\d{2,3}(?:\/\d{2,3})?[A-Z]\b/gi, " ")
            .replace(/\s+/g, " ")
            .trim()
        : "");
    const loaded = Object.values(byWarehouse).reduce((a, b) => a + b, 0);
    const kept: Record<string, number> = {};
    for (const [w, n] of Object.entries(byWarehouse)) if (n > 0) kept[w] = n;
    if (reserva > loaded) warnings.push(`${code}: reserva ${reserva} mayor que lo de los almacenes (${loaded})`);
    const row = buildRow({
      provider: opts.provider,
      kind: "stock",
      code,
      description: medida || [marca, modelo].filter(Boolean).join(" "),
      brand: knownBrand(marca) ?? marca,
      model: modelo,
      size,
      cost: null,
      allowNoPrice: true,
      currency: opts.defaultCurrency ?? "USD",
      stock: Math.max(0, loaded - reserva),
      priceDate,
      source: "odoo",
      sourceRef: opts.sourceRef,
      notes: reserva ? `reserva: ${reserva}` : undefined,
      raw: line.map((i) => i.str).join(" "),
      keepNonTyre: true,
    });
    if (!row) continue;
    if (Object.keys(kept).length) row.stockByWarehouse = kept;
    rows.push(row);
  }
  const deduped = dedupeRows(rows);
  return {
    rows: deduped,
    warnings,
    stats: { source: "odoo", sourceRef: opts.sourceRef, provider: opts.provider, rowsSeen: seen, rowsParsed: deduped.length, rowsSkipped: seen - deduped.length, method: "odoo-stock-warehouses-pdf" },
  };
}
