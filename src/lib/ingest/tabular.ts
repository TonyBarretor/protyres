/**
 * Spreadsheet ingestion (Excel / CSV / Google Sheets export / HTML tables saved as .xls).
 *
 * Strategy:
 *  1. Load every sheet as a matrix of cell strings.
 *  2. Find the header row: the first row (within the first 25) with recognised header names.
 *  3. Map columns by header synonyms (Spanish/English) unless an explicit mapping is given.
 *  4. Walk the rows: brand "section" rows (one non-empty cell naming a brand) set the current brand;
 *     every row with a parsable size (or, for own/stock lists, any description) + a price becomes a PriceRow.
 *  5. If no header is recognised, fall back to "scan every cell": size anywhere in the row + a price-looking number.
 */
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { fold, knownBrand, findBrandInText } from "../tyre/brands";
import { findTyreSizes, parseTyreSize } from "../tyre/spec";
import { extractPosition } from "../tyre/attrs";
import type { ColumnKey, IngestOptions, IngestResult, PriceRow } from "./types";
import { buildRow, parseMoney, parseStock, plausiblePrice, stripToModel, todayIso } from "./util";

export type Matrix = string[][];

export interface SheetData {
  name: string;
  rows: Matrix;
}

const HEADER_SYNONYMS: Record<ColumnKey, string[]> = {
  code: ["codigo", "cod", "cod odoo", "codigo odoo", "sku", "ref", "referencia", "item", "n parte", "numero de parte", "material", "clave", "art", "articulo codigo"],
  size: ["medida", "medidas", "dimension", "dimensiones", "tamano", "size", "sizes", "medida llanta", "medida neumatico", "medida de llanta"],
  brand: ["marca", "brand", "fabricante", "make"],
  model: ["modelo", "diseno", "design", "model", "banda", "patron", "pattern", "linea", "serie", "dibujo"],
  price: [
    "precio", "price", "costo", "cost", "pvp", "p unit", "p u", "pu", "unitario", "valor", "precio usd", "precio us", "precio s", "usd", "us", "precio unitario", "precio unit", "precio venta", "precio lista", "lista", "costo unitario", "importe", "monto",
  ],
  stock: ["stock", "cantidad", "cant", "disponible", "disp", "existencia", "existencias", "inventario", "qty", "quantity", "unidades", "und", "cantidad disponible", "cantidad disponible para uso", "disponible para uso"],
  description: ["descripcion", "description", "producto", "articulo", "item", "detalle", "llanta", "neumatico", "nombre", "producto descripcion", "desc"],
  index: ["indice", "indices", "ic iv", "ic", "iv", "carga velocidad", "carga", "velocidad", "li si", "load speed", "indice carga", "indice velocidad"],
  currency: ["moneda", "currency", "mon", "div", "divisa"],
  position: ["aplicacion", "tipo", "posicion", "eje", "uso", "aplicacion eje", "position", "axle"],
  ply: ["ply", "pr", "lonas", "capas", "ply rating"],
  photo: ["foto", "fotos", "photo", "imagen", "image", "picture", "img"],
  sheet: ["ficha", "ficha tecnica", "datasheet", "spec", "especificaciones", "hoja tecnica"],
};

const URL_RE = /https?:\/\/\S+/i;
function cellUrl(s: string): string | undefined {
  const m = s.match(URL_RE);
  return m ? m[0].replace(/[),.;]+$/, "") : undefined;
}

export function headerKey(cell: string): ColumnKey | null {
  const f = fold(cell).replace(/\b(de|del|la|el|en|por)\b/g, " ").replace(/\s+/g, " ").trim();
  if (!f) return null;
  for (const [key, syns] of Object.entries(HEADER_SYNONYMS) as [ColumnKey, string[]][]) {
    if (syns.includes(f)) return key;
  }
  // partial: "precio unitario usd" -> price ; "medida (mm)" -> size ; "precio $" -> price
  for (const [key, syns] of Object.entries(HEADER_SYNONYMS) as [ColumnKey, string[]][]) {
    if (syns.some((s) => s.length >= 4 && (f.startsWith(s + " ") || f.endsWith(" " + s) || f.includes(" " + s + " ")))) return key;
  }
  return null;
}

function columnLetterToIndex(letter: string): number | null {
  if (!/^[A-Za-z]{1,2}$/.test(letter)) return null;
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Column indexes per key; stock may map to several columns (summed). */
export interface ColumnMap extends Partial<Record<ColumnKey, number>> {
  stockCols?: number[];
}

export function detectHeader(rows: Matrix, maxScan = 25): { headerRow: number; map: ColumnMap } | null {
  let best: { headerRow: number; map: ColumnMap; score: number } | null = null;
  for (let r = 0; r < Math.min(rows.length, maxScan); r++) {
    const map: ColumnMap = {};
    let score = 0;
    (rows[r] ?? []).forEach((cell, c) => {
      const key = headerKey(cell);
      if (key && map[key] === undefined) {
        map[key] = c;
        score += key === "size" || key === "price" || key === "description" ? 2 : 1;
      }
    });
    const usable = (map.size !== undefined || map.description !== undefined) && (map.price !== undefined || map.stock !== undefined);
    if (usable && (!best || score > best.score)) best = { headerRow: r, map, score };
  }
  return best ? { headerRow: best.headerRow, map: best.map } : null;
}

function applyExplicitMapping(headerRowCells: string[] | undefined, columns: IngestOptions["columns"]): ColumnMap {
  const map: ColumnMap = {};
  if (!columns) return map;
  const resolve = (ref: string): number | undefined => {
    const idx = columnLetterToIndex(ref.trim());
    if (idx !== null) return idx;
    if (headerRowCells) {
      const i = headerRowCells.findIndex((h) => fold(h) === fold(ref));
      if (i >= 0) return i;
    }
    return undefined;
  };
  for (const [key, ref] of Object.entries(columns) as [ColumnKey, string][]) {
    if (!ref) continue;
    if (key === "stock" && ref.includes(",")) {
      map.stockCols = ref.split(",").map(resolve).filter((i): i is number => i !== undefined);
      map.stock = map.stockCols[0];
      continue;
    }
    const i = resolve(ref);
    if (i !== undefined) map[key] = i;
  }
  return map;
}

/** Place names that lists usually write in capitals without the accent ("LURIN"). */
const WAREHOUSE_ACCENTS: Record<string, string> = { lurin: "Lurín", ancon: "Ancón", huanuco: "Huánuco", junin: "Junín" };

/** Warehouse label from a stock column's header: title-cased, accents kept ("LURÍN" -> "Lurín", "LURIN" -> "Lurín"). */
export function warehouseName(header: string): string {
  const h = header.replace(/\s+/g, " ").trim();
  if (!h) return "";
  const known = WAREHOUSE_ACCENTS[fold(h)];
  if (known) return known;
  return h.toLocaleLowerCase("es").replace(/(^|[\s\-/(])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toLocaleUpperCase("es"));
}

/** Is this a "section" row that only names a brand (e.g. a merged cell "MICHELIN")? */
function sectionBrand(row: string[]): string | null {
  const nonEmpty = row.filter((c) => c && c.trim());
  if (nonEmpty.length === 0 || nonEmpty.length > 2) return null;
  for (const cell of nonEmpty) {
    const b = knownBrand(cell);
    if (b) return b;
    const found = findBrandInText(cell);
    if (found && fold(cell).split(" ").length <= 3) return found.brand;
  }
  return null;
}

export function rowsFromSheet(sheet: SheetData, opts: IngestOptions & { source: PriceRow["source"] }, warnings: string[]): { rows: PriceRow[]; seen: number; method: string } {
  const rows: PriceRow[] = [];
  const matrix = sheet.rows;
  const kind = opts.kind ?? "provider";
  const keepNonTyre = opts.keepNonTyre ?? kind !== "provider";
  let seen = 0;
  const detected = detectHeader(matrix);
  const explicit = applyExplicitMapping(detected ? matrix[detected.headerRow] : matrix[0], opts.columns);
  const map: ColumnMap = { ...(detected?.map ?? {}), ...explicit };
  const start = detected ? detected.headerRow + 1 : 0;
  // header row for the warehouse names: the detected one, else (explicit mapping, e.g. JCH whose price header is a
  // warehouse name) the first row whose stock columns all hold text without digits ("ARRIOLA", "FRUTALES", "LURIN")
  const headerIdx =
    detected?.headerRow ??
    (map.stockCols && map.stockCols.length > 1
      ? matrix.slice(0, 25).findIndex((row) => map.stockCols!.every((i) => !!row?.[i]?.trim() && !/\d/.test(row[i])))
      : -1);
  const headerCells = (headerIdx >= 0 ? matrix[headerIdx] : matrix[0]) ?? [];
  // several stock columns (JCH: ARRIOLA, FRUTALES, LURIN) -> keep the per-warehouse breakdown, named after the headers
  const warehouses =
    map.stockCols && map.stockCols.length > 1 ? map.stockCols.map((i, n) => ({ i, name: warehouseName(headerCells[i] ?? "") || `Almacén ${n + 1}` })) : null;
  const hasMapping = (map.size !== undefined || map.description !== undefined) && (map.price !== undefined || (kind === "stock" && map.stock !== undefined));
  const method = hasMapping ? "header-mapping" : "cell-scan";
  if (!hasMapping) warnings.push(`[${sheet.name}] no recognisable header row; scanning every cell for size + price`);

  const sheetBrand = knownBrand(sheet.name) ?? findBrandInText(sheet.name)?.brand ?? null;
  let currentBrand: string | null = sheetBrand;
  const priceDate = opts.priceDate ?? todayIso();

  for (let r = start; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row || row.every((c) => !c || !c.trim())) continue;
    seen++;
    const section = sectionBrand(row);
    if (section) {
      currentBrand = section;
      continue;
    }
    const cell = (k: ColumnKey) => (map[k] !== undefined ? (row[map[k]!] ?? "").trim() : "");

    let sizeText = cell("size");
    const description = cell("description");
    let brand = cell("brand");
    let model = cell("model");
    let priceText = cell("price");
    let stockValue: number | string | null = cell("stock") || null;
    let stockByWarehouse: Record<string, number> | undefined;
    if (warehouses) {
      const nums = warehouses.map((w) => parseStock(row[w.i] ?? "")).filter((n): n is number => n !== null);
      stockValue = nums.length ? nums.reduce((a, b) => a + b, 0) : null;
      for (const w of warehouses) {
        const n = parseStock(row[w.i] ?? "");
        if (n && n > 0) (stockByWarehouse ??= {})[w.name] = (stockByWarehouse[w.name] ?? 0) + n;
      }
    }
    const indexText = cell("index");
    const currencyText = cell("currency");
    const code = cell("code");
    const positionText = cell("position");
    const plyText = cell("ply");
    const photoUrl = cellUrl(cell("photo"));
    const sheetUrl = cellUrl(cell("sheet"));

    if (!hasMapping) {
      // cell-scan: size = first cell with a size; price = the most price-looking number in the row
      const joined = row.join(" | ");
      const sizes = findTyreSizes(joined);
      if (sizes.length === 0) continue;
      sizeText = sizes[0].raw;
      const nums = row
        .map((c) => parseMoney(c))
        .filter((m): m is { value: number; currency?: string } => !!m && plausiblePrice(m.value) && !findTyreSizes(String(m.value)).length);
      if (nums.length === 0) continue;
      const pick = nums[nums.length - 1];
      priceText = String(pick.value) + (pick.currency ? ` ${pick.currency}` : "");
      const b = findBrandInText(joined);
      brand = b?.brand ?? "";
      model = stripToModel(joined.replace(/\|/g, " "), { sizeRaw: sizes[0].raw, brandAlias: b?.alias, priceText: String(pick.value) });
    }

    // size can live in the description column
    let size = parseTyreSize(sizeText);
    if (!size && description) {
      const found = findTyreSizes(description);
      if (found.length) {
        size = found[0];
        if (!model) model = stripToModel(description, { sizeRaw: found[0].raw, brandAlias: findBrandInText(description)?.alias });
      }
    }
    if (!size && !keepNonTyre) continue;
    if (size && indexText && !size.loadIndex) {
      const m = indexText.toUpperCase().match(/(\d{2,3}(?:\/\d{2,3})?)\s*([A-Z])?/);
      if (m) size = { ...size, loadIndex: m[1], speedIndex: m[2] ?? size.speedIndex };
    }
    if (!brand) brand = findBrandInText(description || model)?.brand ?? currentBrand ?? "";
    if (brand && !model && description && size) model = stripToModel(description, { sizeRaw: size.raw, brandAlias: findBrandInText(description)?.alias });

    const built = buildRow({
      provider: opts.provider,
      kind,
      code: code || undefined,
      description: description || sizeText,
      brand,
      model,
      size,
      cost: priceText,
      priceIncludesTax: opts.priceIncludesTax,
      maxDiscountPct: opts.maxDiscountPct,
      currency: currencyText || undefined,
      stock: stockValue,
      priceDate,
      source: opts.source,
      sourceRef: `${opts.sourceRef}#${sheet.name}!${r + 1}`,
      raw: row.filter(Boolean).join(" | "),
      defaultCurrency: opts.defaultCurrency,
      position: positionText ? (extractPosition(positionText) ?? null) : undefined,
      ply: plyText ? parseInt(plyText, 10) || null : undefined,
      photoUrl,
      sheetUrl,
      keepNonTyre,
      allowNoPrice: kind === "stock",
    });
    if (built) {
      if (stockByWarehouse) built.stockByWarehouse = stockByWarehouse;
      rows.push(built);
    }
  }
  return { rows, seen, method };
}

function cellToString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  if (typeof v === "boolean") return v ? "si" : "no";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("richText" in v && Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if ("result" in v && v.result !== undefined && v.result !== null) return cellToString(v.result as ExcelJS.CellValue);
    if ("text" in v && typeof v.text === "string") return v.text;
    if ("hyperlink" in v && typeof (v as { text?: unknown }).text === "string") return String((v as { text: string }).text);
    if ("error" in v) return "";
  }
  return String(v);
}

export async function loadExcel(buffer: Buffer): Promise<SheetData[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheets: SheetData[] = [];
  wb.eachSheet((ws) => {
    if (ws.state === "hidden" || ws.state === "veryHidden") return;
    const rows: Matrix = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cells[colNumber - 1] = cellToString(cell.value);
      });
      rows[rowNumber - 1] = Array.from(cells, (c) => c ?? "");
    });
    const dense: Matrix = [];
    for (let i = 0; i < rows.length; i++) dense.push(rows[i] ?? []);
    sheets.push({ name: ws.name, rows: dense });
  });
  return sheets;
}

export function loadCsv(text: string, name = "csv"): SheetData[] {
  const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: true });
  return [{ name, rows: parsed.data.map((r) => r.map((c) => (c ?? "").toString())) }];
}

/** Minimal HTML <table> reader for "Excel" files that are really HTML (web exports). */
export function loadHtmlTable(html: string, name = "html"): SheetData[] {
  const sheets: SheetData[] = [];
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  const decode = (s: string) =>
    s
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/\s+/g, " ")
      .trim();
  tables.forEach((table, ti) => {
    const rows: Matrix = [];
    for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(decode);
      if (cells.length) rows.push(cells);
    }
    if (rows.length) sheets.push({ name: tables.length > 1 ? `${name}#${ti + 1}` : name, rows });
  });
  return sheets;
}

export function isHtml(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<html") || head.startsWith("<!doctype html") || head.includes("<table");
}

export async function ingestExcel(buffer: Buffer, opts: IngestOptions): Promise<IngestResult> {
  if (isHtml(buffer)) return ingestSheets(loadHtmlTable(buffer.toString("utf8"), opts.sourceRef), { ...opts, source: "html" });
  const sheets = await loadExcel(buffer);
  return ingestSheets(sheets, { ...opts, source: "excel" });
}

export function ingestCsv(text: string, opts: IngestOptions): IngestResult {
  const sheets = loadCsv(text, opts.sourceRef);
  return ingestSheets(sheets, { ...opts, source: "csv" });
}

export function ingestHtml(html: string, opts: IngestOptions): IngestResult {
  return ingestSheets(loadHtmlTable(html, opts.sourceRef), { ...opts, source: "html" });
}

export function ingestSheets(sheets: SheetData[], opts: IngestOptions & { source: PriceRow["source"] }): IngestResult {
  const warnings: string[] = [];
  const all: PriceRow[] = [];
  let seen = 0;
  const methods = new Set<string>();
  for (const sheet of sheets) {
    if (opts.allSheets === false && sheets.indexOf(sheet) > 0) break;
    const { rows, seen: s, method } = rowsFromSheet(sheet, opts, warnings);
    methods.add(method);
    seen += s;
    all.push(...rows);
    if (s > 0 && rows.length === 0) warnings.push(`[${sheet.name}] ${s} rows seen but none parsed`);
  }
  const deduped = dedupeRows(all);
  return {
    rows: deduped,
    warnings,
    stats: {
      source: opts.source,
      sourceRef: opts.sourceRef,
      provider: opts.provider,
      rowsSeen: seen,
      rowsParsed: deduped.length,
      rowsSkipped: seen - deduped.length,
      method: [...methods].join("+") || "none",
    },
  };
}

/** Same id (provider+code or provider+size+brand+model) -> keep the lowest priced / first row. */
export function dedupeRows(rows: PriceRow[]): PriceRow[] {
  const byId = new Map<string, PriceRow>();
  for (const r of rows) {
    const prev = byId.get(r.id);
    if (!prev || (r.cost !== null && (prev.cost === null || r.cost < prev.cost))) byId.set(r.id, r);
  }
  return [...byId.values()];
}
