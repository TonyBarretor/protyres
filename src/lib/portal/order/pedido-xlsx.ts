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
 *               · I Precio Unit INC IGV · J =I*E (template formula, kept)
 *   E25 =SUM(E18:E24) · J25 =SUM(J18:J24) (Total $) · K25 =J25/1.18 (total sin IGV, outside the box)
 *   C27 "Observaciones: …"
 *   rows 29..39 PRODUCTOS DE TERCEROS (one block): G29 PROVEEDOR · G30 PERSONA DE CONTACTO · G31 TELEFONO · G32 EMAIL ·
 *               G33 MEDIDA · G34 MARCA · G35 MODELO · G36 PRECIO UNITARIO DE COMPRA INC IGV · G37 CONDICIONES DE PAGO DEL
 *               PROVEEDOR · G38 ENTREGA DE MARCADERIA (dónde se recoge) · C39 "Observaciones: …"
 *   C41 "CONTACTO DE PERSONA EN AGENCIA <AGENCIA>" · C42 contact name · C43 CELULAR / D43 phone
 *
 * Template fixes made when it was sanitized (the client's file had them broken): J19..J24 got the row formula (only J18
 * had it), J25 sums the 7 item rows (it summed J18:J21), rows 22..24 got the same merges and look as row 18, and Frank's
 * scratch cells outside the print area (#REF! chain in L36..O36/M37, 32/3.65 in L26, G36/0.8 in K36) were removed.
 *
 * More than 7 items: an error (PEDIDO_MAX_ITEMS). Inserting rows with ExcelJS does not move merged cells below the
 * insertion point, which would break the totals row and the whole third-party block; the order is split instead.
 * Several third-party items share the single block: their values are joined with " / " in item order.
 */
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { cleanFileName } from "../../quote/files";
import { r2 } from "../../quote/pricing";
import type { Quote, QuoteItem } from "../../quote/types";

export const PEDIDO_TEMPLATE = "config/templates/formato-pedido-atc.xlsx";
export const PEDIDO_SHEET = "Formato de Pedido";
export const PEDIDO_MAX_ITEMS = 7;

/** Every cell the filler touches. Labels are in column C; this map only holds where values go. */
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
  },
  totalCantidad: "E25",
  totalConIgv: "J25",
  totalSinIgv: "K25",
  /** "Observaciones: …" (label and text in the same merged cell C27:J27). */
  observaciones: "C27",
  terceros: {
    proveedor: "G29",
    contacto: "G30",
    telefono: "G31",
    email: "G32",
    medida: "G33",
    marca: "G34",
    modelo: "G35",
    precioCompraConIgv: "G36",
    pagoProveedor: "G37",
    recojo: "G38",
    observaciones: "C39",
  },
  /** "CONTACTO DE PERSONA EN AGENCIA <AGENCIA>" (label + agency name). */
  agencia: "C41",
  agenciaContacto: "C42",
  agenciaTelefono: "D43",
  /** Currency labels, rewritten for orders in soles. */
  monedaLabels: ["I17", "J17", "I25", "C36"],
} as const;

export interface PedidoTerceros {
  proveedor: string;
  /** Unit purchase price including IGV, in the order's currency. */
  precioCompraConIgv?: number;
  contacto?: string;
  telefono?: string;
  email?: string;
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
  /** Bought to order: goes to the "productos de terceros" block. */
  terceros?: PedidoTerceros;
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
  /** Condiciones de pago del proveedor ("LETRAS 90"). */
  pagoProveedor?: string;
  /** Dónde se recoge la mercadería ("ALMACEN 360", "ALMACEN STEEL"). */
  recojo?: string;
}

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
  /** "Observaciones:" of the third-party block. */
  observacionesTerceros?: string;
}

export function pedidoTooManyItems(count: number): string {
  return `El formato de pedido tiene ${PEDIDO_MAX_ITEMS} filas de ítems y este pedido tiene ${count}. Divídelo en dos pedidos.`;
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
/** Joins the third-party values of several items ("STEEL / JCH"); identical values appear once. */
const joinUnique = (vs: (string | undefined)[]): string | null => {
  const out = [...new Set(vs.map((v) => v?.trim()).filter((v): v is string => !!v))];
  return out.length ? out.join(" / ") : null;
};

export async function buildPedidoXlsx(data: PedidoData, opts: { templatePath?: string } = {}): Promise<Buffer> {
  if (!data.items.length) throw new Error("El pedido no tiene ítems.");
  if (data.items.length > PEDIDO_MAX_ITEMS) throw new Error(pedidoTooManyItems(data.items.length));
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
  set(C.observaciones, `Observaciones: ${data.observaciones?.trim() ?? ""}`);

  // detail: input cells only; the J formulas and the totals stay, with their results filled in for viewers that do not recalculate
  const I = C.items;
  let units = 0;
  let total = 0;
  for (let r = I.firstRow, i = 0; r <= I.lastRow; r++, i++) {
    const it = data.items[i];
    set(`${I.codigoSistema}${r}`, null);
    const price = it ? pedidoUnitPrice(it) : null;
    set(`${I.cantidad}${r}`, it ? it.cantidad : null);
    set(`${I.descripcion}${r}`, it ? pedidoDescription(it) : null);
    set(`${I.precioUnitarioConIgv}${r}`, price);
    const lineTotal = it && price != null ? r2(price * it.cantidad) : 0;
    units += it?.cantidad ?? 0;
    total = r2(total + lineTotal);
    setFormulaResult(ws.getCell(`${I.totalConIgv}${r}`), `${I.precioUnitarioConIgv}${r}*${I.cantidad}${r}`, lineTotal);
  }
  setFormulaResult(ws.getCell(C.totalCantidad), `SUM(E${I.firstRow}:E${I.lastRow})`, units);
  setFormulaResult(ws.getCell(C.totalConIgv), `SUM(J${I.firstRow}:J${I.lastRow})`, total);
  setFormulaResult(ws.getCell(C.totalSinIgv), "+J25/1.18", total / 1.18);

  // third-party products: one block, several items joined in item order
  const T = C.terceros;
  const ter = data.items.filter((it) => it.terceros);
  const tp = ter.map((it) => it.terceros!);
  set(T.proveedor, joinUnique(tp.map((t) => t.proveedor.toUpperCase())));
  set(T.contacto, joinUnique(tp.map((t) => t.contacto)));
  set(T.telefono, joinUnique(tp.map((t) => t.telefono)));
  set(T.email, joinUnique(tp.map((t) => t.email)));
  const joinAll = (vs: (string | undefined)[]) => (vs.some((v) => v?.trim()) ? vs.map((v) => v?.trim() || "-").join(" / ") : null);
  set(T.medida, joinAll(ter.map((it) => it.medida.toUpperCase())));
  set(T.marca, joinAll(ter.map((it) => it.marca?.toUpperCase())));
  set(T.modelo, joinAll(ter.map((it) => it.modelo?.toUpperCase())));
  const costs = tp.map((t) => (t.precioCompraConIgv != null ? r2(t.precioCompraConIgv) : undefined));
  set(T.precioCompraConIgv, costs.length === 1 ? (costs[0] ?? null) : joinAll(costs.map((c) => (c != null ? c.toFixed(2) : undefined))));
  set(T.pagoProveedor, text(ent.pagoProveedor));
  set(T.recojo, text(ent.recojo));
  set(T.observaciones, `Observaciones: ${data.observacionesTerceros?.trim() ?? ""}`);

  set(C.agencia, `CONTACTO DE PERSONA EN AGENCIA${cli.agencia?.trim() ? ` ${cli.agencia.trim().toUpperCase()}` : ""}`);
  set(C.agenciaContacto, text(cli.agenciaContacto));
  set(C.agenciaTelefono, text(cli.agenciaTelefono));

  if (data.moneda === "PEN") {
    for (const a of C.monedaLabels) {
      const v = ws.getCell(a).value;
      if (typeof v === "string") set(a, v.replace(/\$/g, "S/").replace(/DOLARES/g, "SOLES"));
    }
  }

  wb.calcProperties.fullCalcOnLoad = true;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function setFormulaResult(cell: ExcelJS.Cell, fallback: string, result: number): void {
  const v = cell.value as ExcelJS.CellFormulaValue | null;
  cell.value = { formula: v && typeof v === "object" && "formula" in v && v.formula ? v.formula : fallback, result: r2(result) };
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
 * Quote → order. Prices: the quote's net unit price plus its IGV. Provider items ("bought to order") go to the
 * third-party block with the provider and the purchase price with IGV (the item's cost, when the quote kept it).
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
    };
    if (it.origin === "provider") {
      const name = it.provider.trim().toUpperCase();
      const contact = Object.entries(extra.proveedores ?? {}).find(([k]) => k.trim().toUpperCase() === name)?.[1];
      item.terceros = { proveedor: name, precioCompraConIgv: it.unitCost != null ? r2(it.unitCost * (1 + taxPct / 100)) : undefined, ...contact };
    }
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
