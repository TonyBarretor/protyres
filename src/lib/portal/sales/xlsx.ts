/**
 * Lector de ventas en .xlsx ("Subir ventas" del portal). Aún no conocemos las columnas del reporte de Odoo, así que el
 * mapeo es configurable: config/portal.json, clave `sales.columnMap` (campo → encabezados posibles). Un encabezado
 * coincide si es igual tras quitar tildes, mayúsculas, espacios sobrantes y ":" final. Para cada campo gana el primer
 * alias de la lista que aparezca; una columna no se asigna a dos campos.
 *
 * La fila de encabezados se busca en las primeras 25 filas (la que más campos reconoce). Obligatorios: fecha, ruc,
 * cantidad. Cada fila de datos se valida por separado: las malas van a `errors` (con su número de fila de Excel) y no
 * frenan a las buenas.
 */
import ExcelJS from "exceljs";
import { z } from "zod";
import { loadPortalConfig } from "../config";
import { digits } from "../store/shared";
import type { IsoDate, SaleInput } from "../store/types";

export const SALE_FIELDS = ["fecha", "ruc", "razonSocial", "medida", "marca", "diseno", "cantidad", "precioUnitario", "total", "vendedor"] as const;
export type SaleField = (typeof SALE_FIELDS)[number];
export const REQUIRED_SALE_FIELDS: SaleField[] = ["fecha", "ruc", "cantidad"];

export type SalesColumnMap = Record<SaleField, string[]>;

export const DEFAULT_SALES_COLUMN_MAP: SalesColumnMap = {
  fecha: ["fecha", "fecha factura", "fecha de factura", "fecha emision", "fecha de emision", "date", "invoice date"],
  ruc: ["ruc", "ruc cliente", "nif", "vat", "nro documento", "numero de documento", "documento"],
  razonSocial: ["razon social", "cliente", "nombre cliente", "customer", "partner", "empresa"],
  medida: ["medida", "medida neumatico", "size", "tamano"],
  marca: ["marca", "brand"],
  diseno: ["diseno", "modelo", "model", "pattern"],
  cantidad: ["cantidad", "cant", "cant.", "unidades", "qty", "quantity"],
  precioUnitario: ["precio unitario", "precio unit", "p. unit", "p unit", "precio", "unit price", "price unit"],
  total: ["total", "importe", "subtotal", "monto", "amount"],
  vendedor: ["vendedor", "comercial", "salesperson", "vendedor/a"],
};

const SalesConfigSchema = z.looseObject({
  columnMap: z.partialRecord(z.enum(SALE_FIELDS), z.array(z.string())).optional(),
});

/** `sales.columnMap` de config/portal.json sobre los valores por defecto (un campo configurado reemplaza su lista). */
export function loadSalesColumnMap(file?: string): SalesColumnMap {
  const cfg = loadPortalConfig(file ? { file } : {}) as Record<string, unknown>;
  const parsed = SalesConfigSchema.safeParse(cfg.sales ?? {});
  if (!parsed.success) throw new Error(`config/portal.json: "sales" inválido: ${parsed.error.message}`);
  return { ...DEFAULT_SALES_COLUMN_MAP, ...(parsed.data.columnMap ?? {}) } as SalesColumnMap;
}

/** Encabezado comparable: minúsculas, sin tildes, espacios simples, sin ":" final. */
export function normalizeHeader(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[\s:]+$/, "")
    .trim();
}

export interface DetectedColumn {
  /** Encabezado tal como viene en el Excel. */
  header: string;
  /** Columna (1 = A). */
  col: number;
}

export type DetectedMapping = Partial<Record<SaleField, DetectedColumn>>;

export interface SaleRowError {
  /** Número de fila en Excel (1 en adelante). */
  row: number;
  error: string;
}

export interface SalesXlsxResult {
  sheet: string | null;
  /** Fila de encabezados (Excel, 1 en adelante); null si no se encontró. */
  headerRow: number | null;
  mapping: DetectedMapping;
  /** Campos obligatorios sin columna (si hay alguno, `rows` viene vacío). */
  missing: SaleField[];
  rows: SaleInput[];
  errors: SaleRowError[];
}

export interface ReadSalesOptions {
  columnMap?: SalesColumnMap;
  /** Nombre de la hoja; por defecto la primera visible cuya cabecera tenga los obligatorios. */
  sheet?: string;
  /** Por defecto "excel". */
  origen?: string;
}

type Raw = ExcelJS.CellValue;

/** Valor "plano" de una celda (fórmulas → resultado, texto enriquecido → texto). */
function plain(v: Raw): string | number | boolean | Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "object") {
    if ("richText" in v && Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if ("result" in v) return plain((v as { result?: Raw }).result ?? null);
    if ("text" in v && typeof (v as { text?: unknown }).text === "string") return (v as { text: string }).text;
    if ("error" in v) return null;
  }
  return String(v);
}

function text(v: Raw): string {
  const p = plain(v);
  if (p === null) return "";
  if (p instanceof Date) return p.toISOString().slice(0, 10);
  return String(p).replace(/\s+/g, " ").trim();
}

const pad = (n: number) => String(n).padStart(2, "0");

function validDate(y: number, m: number, d: number): IsoDate | null {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Serie de Excel (días desde 1899-12-30) → AAAA-MM-DD. */
export function excelSerialToIso(n: number): IsoDate | null {
  if (!Number.isFinite(n) || n < 1 || n > 80000) return null;
  const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
  return validDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** Fecha de una celda: Date, serie de Excel, "dd/mm/aaaa" (o con "-" / "."), "aaaa-mm-dd". null si no es fecha. */
export function parseSaleDate(v: Raw | string | number | Date): IsoDate | null {
  const p = plain(v as Raw);
  if (p === null || typeof p === "boolean") return null;
  // exceljs entrega las fechas como Date en UTC (la hora del Excel no tiene zona).
  if (p instanceof Date) return Number.isNaN(p.getTime()) ? null : validDate(p.getUTCFullYear(), p.getUTCMonth() + 1, p.getUTCDate());
  if (typeof p === "number") return excelSerialToIso(p);
  const s = p.trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s.*)?$/.exec(s);
  if (m) return validDate(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  if (/^\d+(\.\d+)?$/.test(s)) return excelSerialToIso(Number(s));
  return null;
}

/** Número de una celda: 12 · "1,234.50" · "1.234,50" · "S/ 1 200" · "12,5". null si no es número. */
export function parseSaleNumber(v: Raw | string | number): number | null {
  const p = plain(v as Raw);
  if (p === null || typeof p === "boolean" || p instanceof Date) return null;
  if (typeof p === "number") return Number.isFinite(p) ? p : null;
  let s = p.replace(/[^\d,.-]/g, "");
  if (!/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // El separador que aparece al final es el decimal.
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(s)) {
    s = s.replace(/\./g, "");
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Busca la fila de encabezados y asigna columnas a campos. */
export function detectColumns(rows: string[][], columnMap: SalesColumnMap, maxScan = 25): { headerRow: number; mapping: DetectedMapping } | null {
  let best: { headerRow: number; mapping: DetectedMapping; score: number } | null = null;
  for (let r = 0; r < Math.min(rows.length, maxScan); r++) {
    const cells = rows[r] ?? [];
    const norm = cells.map((c) => normalizeHeader(c ?? ""));
    const used = new Set<number>();
    const mapping: DetectedMapping = {};
    for (const field of SALE_FIELDS) {
      for (const alias of columnMap[field] ?? []) {
        const a = normalizeHeader(alias);
        const idx = norm.findIndex((h, i) => h === a && !used.has(i));
        if (idx >= 0) {
          used.add(idx);
          mapping[field] = { header: cells[idx], col: idx + 1 };
          break;
        }
      }
    }
    const score = Object.keys(mapping).length + REQUIRED_SALE_FIELDS.filter((f) => mapping[f]).length * 10;
    if (score > 0 && (!best || score > best.score)) best = { headerRow: r + 1, mapping, score };
  }
  return best && { headerRow: best.headerRow, mapping: best.mapping };
}

/** Lee la hoja como matriz de valores crudos (fila/columna 0 = fila 1 / columna A). */
function sheetMatrix(ws: ExcelJS.Worksheet): Raw[][] {
  const rows: Raw[][] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: Raw[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = cell.value;
    });
    rows[rowNumber - 1] = cells;
  });
  return Array.from(rows, (r) => r ?? []);
}

/** Convierte las filas de datos (ya con el mapeo) en ventas y errores. Puro: lo usa también la vista previa. */
export function rowsToSales(matrix: Raw[][], headerRow: number, mapping: DetectedMapping, origen = "excel"): { rows: SaleInput[]; errors: SaleRowError[] } {
  const rows: SaleInput[] = [];
  const errors: SaleRowError[] = [];
  const cell = (r: Raw[], f: SaleField): Raw => (mapping[f] ? (r[mapping[f]!.col - 1] ?? null) : null);
  const str = (r: Raw[], f: SaleField): string | null => text(cell(r, f)) || null;
  for (let i = headerRow; i < matrix.length; i++) {
    const r = matrix[i] ?? [];
    const rowNum = i + 1;
    if (!SALE_FIELDS.some((f) => mapping[f] && text(cell(r, f)))) continue; // fila vacía
    const problems: string[] = [];
    const rawFecha = cell(r, "fecha");
    const fecha = parseSaleDate(rawFecha);
    if (!fecha) problems.push(text(rawFecha) ? `fecha inválida ("${text(rawFecha)}")` : "sin fecha");
    const rucText = text(cell(r, "ruc"));
    const ruc = digits(rucText);
    if (!ruc) problems.push("sin RUC");
    else if (ruc.length !== 11 && ruc.length !== 8) problems.push(`RUC inválido ("${rucText}")`);
    const rawCant = cell(r, "cantidad");
    const cantidad = parseSaleNumber(rawCant);
    if (cantidad === null) problems.push(text(rawCant) ? `cantidad no numérica ("${text(rawCant)}")` : "sin cantidad");
    else if (cantidad === 0) problems.push("cantidad cero");
    if (problems.length) {
      errors.push({ row: rowNum, error: problems.join("; ") });
      continue;
    }
    const precioUnitario = parseSaleNumber(cell(r, "precioUnitario"));
    let total = parseSaleNumber(cell(r, "total"));
    if (total === null && precioUnitario !== null) total = Math.round(precioUnitario * cantidad! * 100) / 100;
    rows.push({
      fecha: fecha!,
      ruc,
      razonSocial: str(r, "razonSocial"),
      medida: str(r, "medida"),
      marca: str(r, "marca"),
      diseno: str(r, "diseno"),
      cantidad: cantidad!,
      precioUnitario,
      total,
      vendedor: str(r, "vendedor"),
      origen,
      isDemo: false,
    });
  }
  return { rows, errors };
}

/** Lee un .xlsx de ventas. `input`: contenido del archivo. */
export async function readSalesXlsx(input: Buffer | ArrayBuffer | Uint8Array, opts: ReadSalesOptions = {}): Promise<SalesXlsxResult> {
  const columnMap = opts.columnMap ?? loadSalesColumnMap();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(input as unknown as ArrayBuffer);
  const sheets = wb.worksheets.filter((ws) => (opts.sheet ? ws.name === opts.sheet : ws.state !== "hidden" && ws.state !== "veryHidden"));
  if (!sheets.length) {
    return { sheet: null, headerRow: null, mapping: {}, missing: [...REQUIRED_SALE_FIELDS], rows: [], errors: [{ row: 0, error: opts.sheet ? `No existe la hoja "${opts.sheet}"` : "El archivo no tiene hojas" }] };
  }
  let fallback: SalesXlsxResult | null = null;
  for (const ws of sheets) {
    const matrix = sheetMatrix(ws);
    const det = detectColumns(
      matrix.map((r) => Array.from(r, (c) => text(c ?? null))),
      columnMap,
    );
    const mapping = det?.mapping ?? {};
    const missing = REQUIRED_SALE_FIELDS.filter((f) => !mapping[f]);
    if (!det || missing.length) {
      fallback ??= {
        sheet: ws.name,
        headerRow: det?.headerRow ?? null,
        mapping,
        missing,
        rows: [],
        errors: [{ row: det?.headerRow ?? 0, error: `Faltan columnas obligatorias: ${missing.join(", ")}` }],
      };
      continue;
    }
    const { rows, errors } = rowsToSales(matrix, det.headerRow, mapping, opts.origen ?? "excel");
    return { sheet: ws.name, headerRow: det.headerRow, mapping, missing: [], rows, errors };
  }
  return fallback!;
}
