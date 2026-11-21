/**
 * "FORMATO PEDIDO ATC´S": the order sheet the salesman (ATC) sends to Patricia when a customer's purchase order arrives.
 * The template (config/templates/formato-pedido-atc.xlsx) is the client's own "Formato de Pedido" sheet with the
 * customer's values removed; it is loaded with ExcelJS and only values are written, so its layout, borders, merged
 * cells, widths and formulas stay as they are. Pure library: no store, no WhatsApp (the `oc` command lives elsewhere).
 *
 * Template (sheet "Formato de Pedido", columns C..J; labels in C, values in the merged box G:J):
 *   G4  FECHA (=TODAY() in the template; replaced by the order date)     G10 FECHA DE ENTREGA
 *   G5  ATC                                                             G11 PLAZOS DE CREDITO NEGOCIADO ("CREDITO 60 DÍAS")
 *   G6  RAZON SOCIAL                                                    G12 SERVICIO DE ENLLANTE (SI / NO)
 *   G7  RUC (a number, as the client types it)                          G13 SERVICIO DE MARCADO (SI / NO)
 *   G8  DIRECCION FISCAL                                                G14 PERSONA DE CONTACTO EN PROVINCIA
 *   G9  DIRECCION DE ENTREGA                                            G15 FLETE POR CUENTA DE (G15:I15) · J15 "VALOR FLETE: …"
 *   rows 18..24 DETALLE DE VENTA: C:D CODIGO DE SISTEMA (always blank) · E Cantidad · F:H Descripción (medida, marca y modelo)
 *               · I Precio Unit INC IGV (=+K*1.18, as the salesman writes it) · J =I*E · K precio sin IGV (outside the box)
 *   E25 =SUM(E18:E24) · J25 =SUM(J18:J24) (Total $) · K25 =J25/1.18 (total sin IGV, outside the box)
 *   C27 "Observaciones: …"
 *   rows 28..39 PRODUCTOS DE TERCEROS (one block per product): G29 PROVEEDOR · G30 PERSONA DE CONTACTO · G31 TELEFONO ·
 *               G32 EMAIL · G33 MEDIDA · G34 MARCA · G35 MODELO · G36 PRECIO UNITARIO DE COMPRA INC IGV · G37 CONDICIONES
 *               DE PAGO DEL PROVEEDOR · G38 ENTREGA DE MARCADERIA (dónde se recoge) · C39 "Observaciones: …"
 *   C41 "CONTACTO DE PERSONA EN AGENCIA <AGENCIA>" · C42 contact name · C43 CELULAR / D43 phone
 *
 * Template fixes made when it was sanitized (the client's file had them broken): J19..J24 got the row formula (only J18
 * had it), J25 sums the 7 item rows (it summed J18:J21), rows 22..24 got the same merges and look as row 18, and Frank's
 * scratch cells outside the print area (#REF! chain in L36..O36/M37, 32/3.65 in L26, G36/0.8 in K36) were removed.
 *
 * Corrida H, punto 3 (the salesman's real order, "Venta 009" for Prosegur Juliaca, is the reference):
 *  - The detail is grouped by product: quote lines of the same product and price become one line (5 lines -> 6 and 12).
 *    With a net price the unit price is the original's formula =+K{r}*1.18 with the net price in K{r}.
 *  - The third-party block is repeated once per product (size + brand + model), one under the other with a blank row in
 *    between, own stock included (PROVEEDOR "STOCK 360PT", CONTACTO "PATRICIA", EMAIL "-", PRECIO 0, "contado",
 *    "SAN LUIS STOCK": config/portal.json orders.ownStock). Each copy keeps the template block's values, styles and merges;
 *    whatever was below (agency contact) moves down. Every block ends with the same "Observaciones:" line.
 *  - More detail lines than the template's 7: rows are inserted after row 24 with row 24's look and formula, and the
 *    totals move down (ExcelJS's own row insertion does not move merged cells; shiftRows below does it by hand).
 */
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { cleanFileName } from "../../quote/files";
import { r2 } from "../../quote/pricing";
import type { Quote, QuoteItem } from "../../quote/types";
import { loadPortalConfig, type PortalOrdersConfig } from "../config";

export const PEDIDO_TEMPLATE = "config/templates/formato-pedido-atc.xlsx";
export const PEDIDO_SHEET = "Formato de Pedido";
/** Detail rows in the template; more are inserted (keeping row 24's look) up to PEDIDO_MAX_ITEMS. */
export const PEDIDO_TEMPLATE_ROWS = 7;
export const PEDIDO_MAX_ITEMS = 40;

/** Every cell the filler touches in the template (before rows are inserted). Labels are in column C. */
export const PEDIDO_CELLS = {
  fecha: "G4",
  atc: "G5",
  razonSocial: "G6",
  ruc: "G7",
  direccionFiscal: "G8",
  direccionEntrega: "G9",
  fechaEntrega: "G10",
  plazoCredito: "G11",
  enllante: "G12",
  marcado: "G13",
  contacto: "G14",
  flete: "G15",
  /** "VALOR FLETE: 20 SOLES X LLANTA" (free text after the prefix). */
  valorFlete: "J15",
  items: {
    firstRow: 18,
    lastRow: 24,
    /** CODIGO DE SISTEMA (C:D merged): Patricia fills it in the ERP; always left blank. */
    codigoSistema: "C",
    cantidad: "E",
    descripcion: "F",
    precioUnitarioConIgv: "I",
    /** =I{r}*E{r}: template formula, never overwritten (only its cached result is set). */
    totalConIgv: "J",
    /** Unit price without IGV, outside the box: =+K{r}*1.18 in I (as in the salesman's file). */
    precioUnitarioSinIgv: "K",
  },
  /** Totals row (moves down when detail rows are inserted). */
  totalsRow: 25,
  /** "Observaciones: …" (label and text in the same merged cell C27:J27). */
  observaciones: "C27",
  /** Third-party block: rows 28 (title) .. 39 (observaciones); copies every BLOCK_STRIDE rows. */
  terceros: { firstRow: 28, lastRow: 39 },
  /** Agency contact rows (move down with the inserted rows and blocks). */
  agenciaRow: 41,
} as const;

/** Third-party block rows (offset from its title row); the value goes in G (G:J merged), observaciones in C. */
const BLOCK = { proveedor: 1, contacto: 2, telefono: 3, email: 4, medida: 5, marca: 6, modelo: 7, precio: 8, pago: 9, entrega: 10, observaciones: 11 } as const;
/** 12 rows of block + 1 blank row, as in the salesman's file (block 1 at rows 28..39, block 2 at 41..52). */
export const BLOCK_STRIDE = 13;
const LAST_COL = 12;

export interface PedidoTerceros {
  proveedor: string;
  /** Unit purchase price including IGV, in the order's currency. */
  precioCompraConIgv?: number;
  contacto?: string;
  telefono?: string;
  email?: string;
  /** Condiciones de pago de este proveedor ("LETRAS 90"); sin dato, las de `entrega.pagoProveedor`. */
  pago?: string;
  /** Dónde se recoge lo de este proveedor ("ALMACEN LURIN"); sin dato, `entrega.recojo`. */
  entrega?: string;
}

/** Own stock line: which stock row and warehouse it is deducted from (the counter of corrida H, punto 4). */
export interface PedidoStock {
  /** Stock row (kind "stock") id; missing when the own list has no inventory row for it. */
  rowId?: string;
  /** stockOriginKey of the row. */
  origin?: string;
  /** "SAN LUIS" */
  almacen?: string;
}

export interface PedidoItem {
  cantidad: number;
  /** "215/75R17.5 18PR" */
  medida: string;
  marca?: string;
  modelo?: string;
  /** Overrides "medida marca modelo" in the detail (non-tyre items: "ARO 22.5X8.25"). */
  descripcion?: string;
  /** Unit sale price with IGV; if missing it is computed from `precioUnitarioSinIgv` and `igvPct`. */
  precioUnitarioConIgv?: number;
  precioUnitarioSinIgv?: number;
  /** Default 18. */
  igvPct?: number;
  /** Bought to order: its block names the supplier. Without it the item is own stock. */
  terceros?: PedidoTerceros;
  /** Own stock (stock row and warehouse), when known. */
  stock?: PedidoStock;
  /** The quote line had no identifiable origin (neither own stock nor a supplier): the bot asks before building. */
  origenDesconocido?: boolean;
  /** Price row the quote line came from (own list or provider) and its canonical size: to find the stock row. */
  rowId?: string;
  size?: string;
  /** Prosegur: armoured units (UB) of the quote lines summed in this line. */
  ubs?: string[];
  /**
   * Corrida J: vehicle plates of the quote lines summed in this line, with how many tyres each (lines of the same product
   * stay one detail line; the plates go to the observaciones: pedidoPlatesNote).
   */
  placas?: { placa: string; cantidad: number }[];
  /** Branch (sucursal) of the quote line ("JULIACA"). */
  sucursal?: string;
}

export interface PedidoCliente {
  razonSocial: string;
  ruc: string;
  direccionFiscal?: string;
  direccionEntrega?: string;
  /** "Katerini Hernández - Cel. 940 973 833" */
  contacto?: string;
  /** Transport agency ("ANDESKAR"). */
  agencia?: string;
  agenciaContacto?: string;
  agenciaTelefono?: string;
}

export interface PedidoEntrega {
  /** yyyy-mm-dd (written as a date) or free text ("48 h post OC"). */
  fecha?: string;
  /** true/false → SI/NO; text as given. */
  enllante?: boolean | string;
  marcado?: boolean | string;
  /** Flete por cuenta de: "360TYRES", "CLIENTE". */
  flete?: string;
  /** "20 SOLES X LLANTA" */
  valorFlete?: string;
  /** Condiciones de pago del proveedor ("LETRAS 90"): default for suppliers without their own. */
  pagoProveedor?: string;
  /** Dónde se recoge la mercadería ("ALMACEN 360", "ALMACEN STEEL"): default for suppliers without their own. */
  recojo?: string;
}

export type OwnStockBlock = PortalOrdersConfig["ownStock"];

export interface PedidoData {
  /** yyyy-mm-dd */
  fecha: string;
  /** Salesman (ATC) name. */
  atc: string;
  /** Default USD (the format's labels say $ / DOLARES); PEN rewrites them to S/ / SOLES. */
  moneda?: "USD" | "PEN";
  cliente: PedidoCliente;
  /** 0 = CONTADO; n → "CREDITO n DÍAS". */
  plazoCreditoDias?: number | null;
  /** Free text for the credit box; overrides plazoCreditoDias. */
  plazoCredito?: string;
  items: PedidoItem[];
  entrega?: PedidoEntrega;
  observaciones?: string;
  /** "Observaciones:" at the foot of every third-party block (one text per order). */
  observacionesTerceros?: string;
  /** Own stock block values; default config/portal.json orders.ownStock. */
  stockPropio?: OwnStockBlock;
}

export function pedidoTooManyItems(count: number): string {
  return `El pedido admite hasta ${PEDIDO_MAX_ITEMS} productos distintos y este tiene ${count}. Divídelo en dos pedidos.`;
}

/** Unit price with IGV, rounded to cents. */
export function pedidoUnitPrice(it: PedidoItem): number {
  if (it.precioUnitarioConIgv != null) return r2(it.precioUnitarioConIgv);
  if (it.precioUnitarioSinIgv != null) return r2(it.precioUnitarioSinIgv * (1 + (it.igvPct ?? 18) / 100));
  throw new Error(`Falta el precio de ${pedidoDescription(it)}.`);
}

/** "215/75R17.5 18PR CARLEO DH56" */
export function pedidoDescription(it: PedidoItem): string {
  const text = it.descripcion?.trim() || [it.medida, it.marca, it.modelo].filter(Boolean).join(" ");
  return text.replace(/\s+/g, " ").trim().toUpperCase();
}

/** Product of a line (size + brand + model) and where it comes from ("stock" or the supplier). */
export function pedidoOrigin(it: PedidoItem): string {
  return it.terceros ? `prov:${it.terceros.proveedor.trim().toUpperCase()}` : "stock";
}

/**
 * Detail grouped by product (corrida H): lines with the same description, origin and unit price are summed, in order of
 * first appearance; their UBs are joined (in order, without repeats). Prices never change: different prices stay apart.
 */
export function groupPedidoItems(items: PedidoItem[]): PedidoItem[] {
  const out: PedidoItem[] = [];
  const byKey = new Map<string, PedidoItem>();
  for (const it of items) {
    const price = it.precioUnitarioSinIgv != null ? `n${r2(it.precioUnitarioSinIgv)}|${it.igvPct ?? 18}` : `g${it.precioUnitarioConIgv ?? ""}`;
    const key = [pedidoDescription(it), pedidoOrigin(it), price, it.sucursal ?? ""].join("|");
    const prev = byKey.get(key);
    if (!prev) {
      const copy: PedidoItem = { ...it, ...(it.ubs ? { ubs: [...it.ubs] } : {}), ...(it.placas ? { placas: it.placas.map((p) => ({ ...p })) } : {}) };
      byKey.set(key, copy);
      out.push(copy);
      continue;
    }
    // a line without plate next to lines with one keeps its tyres counted ("sin placa" in the note)
    if ((prev.placas || it.placas) && !(prev.placas && it.placas)) {
      if (!prev.placas) prev.placas = [{ placa: "", cantidad: prev.cantidad }];
      if (!it.placas) prev.placas.push({ placa: "", cantidad: it.cantidad });
    }
    prev.cantidad += it.cantidad;
    for (const ub of it.ubs ?? []) if (!(prev.ubs ??= []).includes(ub)) prev.ubs.push(ub);
    for (const p of it.placas ?? []) {
      const same = prev.placas!.find((x) => x.placa === p.placa);
      if (same) same.cantidad += p.cantidad;
      else prev.placas!.push({ ...p });
    }
  }
  return out;
}

/**
 * Corrida J: the plates for Patricia's observaciones, one group per detail line that has any (lines already grouped by
 * product): "Placas: 295/80R22.5 FENIXWAY VALOR 99: ABC-123 (8), DEF-456 (2); 11R22.5 …: ABC-123 (4), sin placa (2)".
 * "" when no line has a plate.
 */
export function pedidoPlatesNote(lines: PedidoItem[]): string {
  const parts = lines
    .filter((it) => it.placas?.some((p) => p.placa))
    .map((it) => {
      const merged = new Map<string, number>();
      for (const p of it.placas ?? []) merged.set(p.placa, (merged.get(p.placa) ?? 0) + p.cantidad);
      const list = [...merged].sort(([a], [b]) => (a ? 0 : 1) - (b ? 0 : 1)).map(([placa, n]) => `${placa || "sin placa"} (${n})`);
      return `${pedidoDescription(it)}: ${list.join(", ")}`;
    });
  return parts.length ? `Placas: ${parts.join("; ")}` : "";
}

/** One third-party block per product and origin (the price does not split a block), in detail order. */
export function pedidoBlocks(items: PedidoItem[]): PedidoItem[] {
  const seen = new Set<string>();
  const out: PedidoItem[] = [];
  for (const it of items) {
    const key = `${[it.medida, it.marca, it.modelo, it.descripcion].map((v) => (v ?? "").trim().toUpperCase()).join("|")}|${pedidoOrigin(it)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

export function plazoCreditoText(d: Pick<PedidoData, "plazoCredito" | "plazoCreditoDias">): string | null {
  if (d.plazoCredito?.trim()) return d.plazoCredito.trim().toUpperCase();
  if (d.plazoCreditoDias == null) return null;
  return d.plazoCreditoDias <= 0 ? "CONTADO" : `CREDITO ${d.plazoCreditoDias} DÍAS`;
}

/** "Pedido ATC - JJD CONTRATISTAS - 03-08-2026.xlsx" (razón social without the company-type suffix). */
export function formatPedidoFileName(data: Pick<PedidoData, "cliente" | "fecha">): string {
  const short =
    data.cliente.razonSocial
      .toUpperCase()
      .replace(/[.,]/g, " ")
      .replace(/\b(S\s*A\s*C|S\s*A\s*A|S\s*R\s*L|E\s*I\s*R\s*L|S\s*A|SOCIEDAD ANONIMA CERRADA|SOCIEDAD ANONIMA)\s*$/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40)
      .trim() || "CLIENTE";
  const [y, m, d] = data.fecha.split("-");
  return cleanFileName(`Pedido ATC - ${short} - ${d}-${m}-${y}`) + ".xlsx";
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const siNo = (v: boolean | string | undefined): string | null => (v === undefined ? null : typeof v === "boolean" ? (v ? "SI" : "NO") : v.trim() || null);
const text = (v: string | undefined | null): string | null => v?.trim() || null;

// ---------- moving rows (values, formulas, styles, heights and merges) ----------

interface CellSnap {
  row: number;
  col: number;
  /** Only for cells that are not merge slaves. */
  value?: ExcelJS.CellValue;
  style: Partial<ExcelJS.Style>;
}
interface Snapshot {
  cells: CellSnap[];
  heights: Map<number, number | undefined>;
  merges: { top: number; left: number; bottom: number; right: number }[];
}

type MergeRange = { model: { top: number; left: number; bottom: number; right: number } };
const mergesOf = (ws: ExcelJS.Worksheet) => Object.values((ws as unknown as { _merges: Record<string, MergeRange> })._merges).map((m) => ({ ...m.model }));

/** Shifts the row numbers of A1 references inside [lo, hi] by `d` ("I24*E24" -> "I25*E25"). */
function shiftFormula(f: string, lo: number, hi: number, d: number): string {
  return f.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(])/g, (all, c1: string, col: string, c2: string, row: string) => {
    const n = Number(row);
    return n >= lo && n <= hi ? `${c1}${col}${c2}${n + d}` : all;
  });
}

function snapshot(ws: ExcelJS.Worksheet, top: number, bottom: number): Snapshot {
  const cells: CellSnap[] = [];
  const heights = new Map<number, number | undefined>();
  for (let r = top; r <= bottom; r++) {
    const row = ws.getRow(r);
    heights.set(r, row.height);
    for (let c = 1; c <= LAST_COL; c++) {
      const cell = row.getCell(c);
      const slave = cell.isMerged && cell.master !== cell;
      let value: ExcelJS.CellValue | undefined;
      if (!slave) value = cell.formula ? { formula: cell.formula, result: cell.result } as ExcelJS.CellFormulaValue : cell.value;
      cells.push({ row: r, col: c, value, style: JSON.parse(JSON.stringify(cell.style ?? {})) });
    }
  }
  const merges = mergesOf(ws).filter((m) => m.top >= top && m.bottom <= bottom);
  return { cells, heights, merges };
}

/** Writes a snapshot `d` rows lower; formulas pointing inside the snapshot follow it (like copying the rows in Excel). */
function paste(ws: ExcelJS.Worksheet, snap: Snapshot, d: number, lo: number, hi: number): void {
  for (const [r, h] of snap.heights) ws.getRow(r + d).height = h as number;
  for (const c of snap.cells) {
    const cell = ws.getRow(c.row + d).getCell(c.col);
    if (c.value !== undefined) {
      const v = c.value;
      cell.value = v && typeof v === "object" && "formula" in v && typeof v.formula === "string" ? { formula: shiftFormula(v.formula, lo, hi, d), result: v.result } as ExcelJS.CellFormulaValue : v;
    }
    cell.style = JSON.parse(JSON.stringify(c.style));
  }
  for (const m of snap.merges) {
    ws.mergeCellsWithoutStyle(m.top + d, m.left, m.bottom + d, m.right);
  }
}

/** Moves every row from `from` down by `n` (values, formulas, styles, heights and merges); the freed rows stay empty. */
export function shiftRows(ws: ExcelJS.Worksheet, from: number, n: number): void {
  if (n <= 0) return;
  const last = Math.max(ws.rowCount, from);
  const snap = snapshot(ws, from, last);
  for (const m of snap.merges) ws.unMergeCells(m.top, m.left, m.bottom, m.right);
  for (let r = from; r <= last; r++) {
    const row = ws.getRow(r);
    row.height = undefined as unknown as number;
    for (let c = 1; c <= LAST_COL; c++) {
      const cell = row.getCell(c);
      cell.value = null;
      cell.style = {};
    }
  }
  paste(ws, snap, n, from, Number.MAX_SAFE_INTEGER);
}

/** Copies rows top..bottom so they start at `dest` (formulas inside the copied rows follow them). */
export function copyRows(ws: ExcelJS.Worksheet, top: number, bottom: number, dest: number): void {
  paste(ws, snapshot(ws, top, bottom), dest - top, top, bottom);
}

// ---------- building the order ----------

export async function buildPedidoXlsx(data: PedidoData, opts: { templatePath?: string } = {}): Promise<Buffer> {
  if (!data.items.length) throw new Error("El pedido no tiene ítems.");
  const lines = groupPedidoItems(data.items);
  if (lines.length > PEDIDO_MAX_ITEMS) throw new Error(pedidoTooManyItems(lines.length));
  const blocks = pedidoBlocks(lines);
  const own = data.stockPropio ?? loadPortalConfig().orders.ownStock;
  const templatePath = path.resolve(process.cwd(), opts.templatePath ?? PEDIDO_TEMPLATE);
  if (!fs.existsSync(/* turbopackIgnore: true */ templatePath)) throw new Error(`No encuentro la plantilla del pedido: ${templatePath}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fs.readFileSync(/* turbopackIgnore: true */ templatePath) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet(PEDIDO_SHEET) ?? wb.worksheets[0];
  const C = PEDIDO_CELLS;
  const set = (addr: string, v: ExcelJS.CellValue) => {
    ws.getCell(addr).value = v;
  };
  const cli = data.cliente;
  const ent = data.entrega ?? {};

  // layout: extra detail rows after row 24, then one block per product (the agency rows move below the last one)
  const I = C.items;
  const extra = Math.max(0, lines.length - PEDIDO_TEMPLATE_ROWS);
  if (extra) {
    shiftRows(ws, I.lastRow + 1, extra);
    for (let k = 1; k <= extra; k++) copyRows(ws, I.lastRow, I.lastRow, I.lastRow + k);
  }
  const lastDetail = I.lastRow + extra;
  const totals = C.totalsRow + extra;
  const blockTop = C.terceros.firstRow + extra;
  const nBlocks = Math.max(1, blocks.length);
  if (nBlocks > 1) {
    shiftRows(ws, C.terceros.lastRow + extra + 1, BLOCK_STRIDE * (nBlocks - 1));
    for (let k = 1; k < nBlocks; k++) copyRows(ws, blockTop, blockTop + (C.terceros.lastRow - C.terceros.firstRow), blockTop + BLOCK_STRIDE * k);
  }
  const agencia = C.agenciaRow + extra + BLOCK_STRIDE * (nBlocks - 1);

  if (!ISO_DATE.test(data.fecha)) throw new Error(`Fecha del pedido inválida: ${data.fecha} (aaaa-mm-dd).`);
  set(C.fecha, asDate(data.fecha)); // replaces =TODAY(); the cell keeps its date format
  set(C.atc, text(data.atc));
  set(C.razonSocial, text(cli.razonSocial)?.toUpperCase() ?? null);
  const ruc = cli.ruc.replace(/\D/g, "");
  set(C.ruc, /^[12]\d{10}$/.test(ruc) ? Number(ruc) : text(cli.ruc));
  set(C.direccionFiscal, text(cli.direccionFiscal));
  set(C.direccionEntrega, text(cli.direccionEntrega));
  set(C.fechaEntrega, ent.fecha && ISO_DATE.test(ent.fecha) ? asDate(ent.fecha) : text(ent.fecha));
  set(C.plazoCredito, plazoCreditoText(data));
  set(C.enllante, siNo(ent.enllante));
  set(C.marcado, siNo(ent.marcado));
  set(C.contacto, text(cli.contacto));
  set(C.flete, text(ent.flete));
  set(C.valorFlete, ent.valorFlete?.trim() ? `VALOR FLETE: ${ent.valorFlete.trim()}` : null);
  set(C.observaciones.replace("27", String(27 + extra)), `Observaciones: ${data.observaciones?.trim() ?? ""}`);

  // detail: input cells; I = +K*1.18 when the net price is known (as the salesman writes it); J and the totals keep the
  // template's formulas, with their results filled in for viewers that do not recalculate
  let units = 0;
  let total = 0;
  for (let r = I.firstRow, i = 0; r <= lastDetail; r++, i++) {
    const it = lines[i];
    set(`${I.codigoSistema}${r}`, null);
    set(`${I.cantidad}${r}`, it ? it.cantidad : null);
    set(`${I.descripcion}${r}`, it ? pedidoDescription(it) : null);
    let unit = 0;
    if (it && it.precioUnitarioConIgv == null && it.precioUnitarioSinIgv != null) {
      const factor = 1 + (it.igvPct ?? 18) / 100;
      unit = it.precioUnitarioSinIgv * factor;
      set(`${I.precioUnitarioSinIgv}${r}`, it.precioUnitarioSinIgv);
      set(`${I.precioUnitarioConIgv}${r}`, { formula: `+${I.precioUnitarioSinIgv}${r}*${Number(factor.toFixed(4))}`, result: Math.round(unit * 1e6) / 1e6 } as ExcelJS.CellFormulaValue);
    } else {
      unit = it ? pedidoUnitPrice(it) : 0;
      set(`${I.precioUnitarioSinIgv}${r}`, null);
      set(`${I.precioUnitarioConIgv}${r}`, it ? unit : null);
    }
    const lineTotal = it ? unit * it.cantidad : 0;
    units += it?.cantidad ?? 0;
    total += lineTotal;
    setFormula(ws.getCell(`${I.totalConIgv}${r}`), `${I.precioUnitarioConIgv}${r}*${I.cantidad}${r}`, lineTotal);
  }
  setFormula(ws.getCell(`E${totals}`), `SUM(E${I.firstRow}:E${lastDetail})`, units, true);
  setFormula(ws.getCell(`J${totals}`), `SUM(J${I.firstRow}:J${lastDetail})`, total, true);
  setFormula(ws.getCell(`K${totals}`), `+J${totals}/1.18`, r2(total / 1.18), true);

  // one block per product: own stock (config) or its supplier
  for (let k = 0; k < nBlocks; k++) {
    const top = blockTop + BLOCK_STRIDE * k;
    const it = blocks[k];
    const g = (off: number, v: ExcelJS.CellValue) => set(`G${top + off}`, v);
    if (!it) {
      for (const off of [BLOCK.proveedor, BLOCK.contacto, BLOCK.telefono, BLOCK.email, BLOCK.medida, BLOCK.marca, BLOCK.modelo, BLOCK.precio, BLOCK.pago, BLOCK.entrega]) g(off, null);
    } else if (it.terceros) {
      const t = it.terceros;
      g(BLOCK.proveedor, t.proveedor.trim().toUpperCase());
      g(BLOCK.contacto, text(t.contacto)?.toUpperCase() ?? null);
      g(BLOCK.telefono, text(t.telefono));
      g(BLOCK.email, text(t.email) ?? "-");
      g(BLOCK.precio, t.precioCompraConIgv != null ? r2(t.precioCompraConIgv) : null);
      g(BLOCK.pago, text(t.pago) ?? text(ent.pagoProveedor));
      g(BLOCK.entrega, text(t.entrega) ?? text(ent.recojo));
    } else {
      g(BLOCK.proveedor, own.proveedor);
      g(BLOCK.contacto, own.contacto);
      g(BLOCK.telefono, text(own.telefono));
      g(BLOCK.email, own.email);
      g(BLOCK.precio, own.precioCompra);
      g(BLOCK.pago, own.pago);
      g(BLOCK.entrega, own.entrega);
    }
    if (it) {
      g(BLOCK.medida, it.descripcion?.trim() && !it.medida ? it.descripcion.trim().toUpperCase() : text(it.medida)?.toUpperCase() ?? null);
      g(BLOCK.marca, text(it.marca)?.toUpperCase() ?? null);
      g(BLOCK.modelo, text(it.modelo)?.toUpperCase() ?? null);
    }
    set(`C${top + BLOCK.observaciones}`, `Observaciones: ${data.observacionesTerceros?.trim() ?? ""}`);
    if (data.moneda === "PEN") relabel(ws, `C${top + BLOCK.precio}`);
  }

  set(`C${agencia}`, `CONTACTO DE PERSONA EN AGENCIA${cli.agencia?.trim() ? ` ${cli.agencia.trim().toUpperCase()}` : ""}`);
  set(`C${agencia + 1}`, text(cli.agenciaContacto));
  set(`D${agencia + 2}`, text(cli.agenciaTelefono));

  if (data.moneda === "PEN") for (const a of ["I17", "J17", `I${totals}`]) relabel(ws, a);

  wb.calcProperties.fullCalcOnLoad = true;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** "$" / "DOLARES" -> "S/" / "SOLES" in a label. */
function relabel(ws: ExcelJS.Worksheet, addr: string): void {
  const v = ws.getCell(addr).value;
  if (typeof v === "string") ws.getCell(addr).value = v.replace(/\$/g, "S/").replace(/DOLARES/g, "SOLES");
}

/** Keeps the template's formula (or writes `formula` when `force` or there is none) and sets its cached result. */
function setFormula(cell: ExcelJS.Cell, formula: string, result: number, force = false): void {
  const v = cell.value as ExcelJS.CellFormulaValue | null;
  const keep = !force && v && typeof v === "object" && "formula" in v && v.formula ? v.formula : formula;
  cell.value = { formula: keep, result: Math.round(result * 1e6) / 1e6 } as ExcelJS.CellFormulaValue;
}

// ---------- from a quote ----------

/** Everything the quote does not know: the customer's data (remembered per customer) and the salesman's answers. */
export interface PedidoExtra {
  cliente?: Partial<PedidoCliente>;
  /** Default: today in Lima. */
  fecha?: string;
  /** Default: the quote's salesperson. */
  atc?: string;
  plazoCreditoDias?: number | null;
  plazoCredito?: string;
  entrega?: PedidoEntrega;
  observaciones?: string;
  observacionesTerceros?: string;
  /** Third-party contact data per provider name ("STEEL" → contact, phone, email). */
  proveedores?: Record<string, Omit<PedidoTerceros, "proveedor" | "precioCompraConIgv">>;
}

const limaToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());

/** Size as the format writes it: "215/75R17.5 18PR" (ply) or "205/55R16 91V" (load and speed index). */
export function quoteItemMedida(it: QuoteItem): string {
  const size = it.sizeDisplay || it.size;
  if (!size) return "";
  const extra = it.ply ? `${it.ply}PR` : it.loadIndex ? `${it.loadIndex}${it.speedIndex ?? ""}` : "";
  return [size, extra].filter(Boolean).join(" ");
}

/** "45 días" / "crédito 60 dias" → 45 / 60; "contado" → 0; anything else → undefined. */
export function plazoDiasFromTerm(term: string | undefined): number | undefined {
  if (!term) return undefined;
  if (/contado/i.test(term)) return 0;
  const m = term.match(/(\d{1,3})\s*d[ií]as?\b/i);
  return m ? Number(m[1]) : undefined;
}

/**
 * Quote → order. Prices: the quote's net unit price plus its IGV. Provider items ("bought to order", also a provider's
 * row quoted at a price the salesman typed) go to the third-party block with the provider and the purchase price with IGV (the item's cost, when the quote kept it).
 */
export function pedidoFromQuote(quote: Quote, extra: PedidoExtra = {}): PedidoData {
  const taxPct = quote.taxPct ?? 18;
  const items: PedidoItem[] = quote.items.map((it) => {
    const medida = quoteItemMedida(it);
    const item: PedidoItem = {
      cantidad: it.quantity,
      medida,
      marca: it.brand || undefined,
      modelo: it.model || undefined,
      descripcion: medida ? undefined : it.description,
      precioUnitarioSinIgv: it.unitPrice,
      igvPct: taxPct,
      ...(it.rowId ? { rowId: it.rowId } : {}),
      ...(it.size ? { size: it.size } : {}),
    };
    // de un proveedor: "provider", o un ítem de su lista con precio escrito ("manual" con el costo del proveedor)
    if (it.origin === "provider" || (it.origin === "manual" && it.unitCost != null && !!it.provider && it.provider !== "manual")) {
      const name = it.provider.trim().toUpperCase();
      const contact = Object.entries(extra.proveedores ?? {}).find(([k]) => k.trim().toUpperCase() === name)?.[1];
      item.terceros = { proveedor: name, precioCompraConIgv: it.unitCost != null ? r2(it.unitCost * (1 + taxPct / 100)) : undefined, ...contact };
    } else if (it.origin === "own") {
      item.stock = {}; // stock propio (la fila de stock y el almacén los resuelve order/origin.ts)
    } else {
      item.origenDesconocido = true; // contrato o precio escrito sin lista: se identifica con las listas o se pregunta
    }
    const ub = it.ub ?? quote.ub;
    if (ub) item.ubs = [ub];
    if (it.plate) item.placas = [{ placa: it.plate, cantidad: it.quantity }];
    if (quote.unit) item.sucursal = quote.unit.toUpperCase();
    return item;
  });
  const plazoCreditoDias = extra.plazoCreditoDias !== undefined ? extra.plazoCreditoDias : plazoDiasFromTerm(quote.paymentTerm);
  return {
    fecha: extra.fecha ?? limaToday(),
    atc: extra.atc ?? quote.salesperson.name,
    moneda: quote.currency === "PEN" ? "PEN" : "USD",
    cliente: {
      ...extra.cliente,
      razonSocial: extra.cliente?.razonSocial ?? quote.customer.company ?? quote.customer.name ?? "",
      ruc: extra.cliente?.ruc ?? "",
      direccionFiscal: extra.cliente?.direccionFiscal ?? quote.customer.address,
    },
    plazoCreditoDias,
    plazoCredito: extra.plazoCredito ?? (plazoCreditoDias === undefined && quote.paymentTerm ? quote.paymentTerm : undefined),
    items,
    entrega: extra.entrega,
    observaciones: extra.observaciones,
    observacionesTerceros: extra.observacionesTerceros,
  };
}
