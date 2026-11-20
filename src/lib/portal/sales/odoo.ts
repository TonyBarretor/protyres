/**
 * ventas-odoo: lector del "Reporte Ventas" exportado de Odoo (SERCLOUDS) para "Subir ventas".
 *
 * Formato (archivo real de 11/2026): fila 1 con los grupos VENTA / COMPRA, encabezados en la fila 2 (se busca la fila,
 * no se asume), una línea de factura por fila y al final TOTALES (con fórmulas SUM), MARGEN y un pie de texto, que se
 * ignoran. Producto, medida, marca y diseño salen de DESCRIPCIÓN (classify.ts).
 *
 * Reglas de cada línea (todas puras; config en sales/config.ts):
 *  - Nota de crédito: cantidad y montos se guardan con signo negativo (restan). Si el motivo es solo de monto
 *    (DESCUENTO COMERCIAL, AJUSTE DE PRECIO), resta montos pero no neumáticos.
 *  - Nota de débito: no suma neumáticos (son cargos: mora).
 *  - STATUS en sales.excludeStatus (Cancelado, Borrador): se guarda marcada `excluida` y no cuenta en nada. STATUS es una
 *    columna del bloque COMPRA (el estado del lado del proveedor); vacío, Hecho y Compra cuentan.
 *  - Documento del cliente: RUC de 11 dígitos, DNI de 8 (persona natural: venta minorista) u otro largo (advertencia,
 *    se guarda igual).
 *  - Clave estable: tipo de documento + N° + código de producto + n.º de aparición de ese código en el documento. Las
 *    líneas idénticas de una misma factura (hay 3 en el archivo real) quedan con claves distintas: no se fusionan.
 *  - Montos, moneda y tipo de cambio tal como vienen (no se recalcula nada).
 */
import type ExcelJS from "exceljs";
import { foldText, normDocumento, docClienteOf } from "../store/shared";
import type { IsoDate, PortalUser, SaleDocType, SaleInput, SaleLineType, ServiceType } from "../store/types";
import { matchUser, nameTokens } from "../dashboard/vendors";
import { titleCase } from "../../tyre/brands";
import { classifyLine, type LineClass } from "./classify";
import { DEFAULT_SALES_SETTINGS, type SalesSettings } from "./config";
import { normalizeHeader, parseSaleDate, parseSaleNumber } from "./xlsx";

type Raw = ExcelJS.CellValue;

/** Columnas del reporte (encabezado normalizado con normalizeHeader). */
export const ODOO_COLUMNS = {
  fecha: ["fecha"],
  vencimiento: ["vencimiento"],
  tipoDoc: ["tipo doc", "tipo documento"],
  documento: ["n° factura", "nº factura", "no factura", "n factura", "nro factura", "numero factura"],
  moneda: ["moneda fact venta", "moneda"],
  estadoSunat: ["estado sunat"],
  ocOdoo: ["oc odoo"],
  ocProveedor: ["oc proveedor"],
  guia: ["gr. remision", "guia de remision", "gr remision"],
  ruc: ["ruc", "documento cliente"],
  razon: ["razon", "razon social", "cliente"],
  condVenta: ["cond vta", "condicion de venta"],
  descripcion: ["descripcion", "producto"],
  cantidad: ["cantidad"],
  tipoCambio: ["t.c."],
  precioUnitario: ["vta und s/"],
  total: ["total vta s/"],
  totalSinServ: ["total vta s/ sin serv"],
  precioUnitarioUsd: ["vta und $"],
  totalUsd: ["total vta $"],
  vendedor: ["vendedor"],
  costoUnitario: ["costo und s/"],
  costoTotal: ["costo total s/"],
  costoUnitarioUsd: ["costo und $"],
  costoTotalUsd: ["costo total $"],
  facturaProveedor: ["factura proveedor"],
  proveedor: ["nombre proveedor", "proveedor"],
  monedaProveedor: ["moneda fact. prov", "moneda fact prov"],
  tipoCambioProveedor: ["t.c"],
  status: ["status"],
  margen: ["margen"],
} as const;

export type OdooField = keyof typeof ODOO_COLUMNS;
export const REQUIRED_ODOO_FIELDS: OdooField[] = ["fecha", "tipoDoc", "documento", "ruc", "descripcion", "cantidad"];

export type OdooMapping = Partial<Record<OdooField, number>>;

/** Busca la fila de encabezados del reporte de Odoo en las primeras `maxScan` filas. null si no es este formato. */
export function detectOdooHeader(rows: string[][], maxScan = 25): { headerRow: number; mapping: OdooMapping } | null {
  for (let r = 0; r < Math.min(rows.length, maxScan); r++) {
    const norm = (rows[r] ?? []).map((c) => normalizeHeader(c ?? ""));
    const mapping: OdooMapping = {};
    const used = new Set<number>();
    for (const field of Object.keys(ODOO_COLUMNS) as OdooField[]) {
      for (const alias of ODOO_COLUMNS[field]) {
        const idx = norm.findIndex((h, i) => h === alias && !used.has(i));
        if (idx >= 0) {
          used.add(idx);
          mapping[field] = idx;
          break;
        }
      }
    }
    if (REQUIRED_ODOO_FIELDS.every((f) => mapping[f] !== undefined)) return { headerRow: r + 1, mapping };
  }
  return null;
}

export function docTypeOf(s: string): SaleDocType {
  const t = foldText(s);
  if (/credito/.test(t)) return "nota_credito";
  if (/debito/.test(t)) return "nota_debito";
  if (/boleta/.test(t)) return "boleta";
  if (/factura/.test(t)) return "factura";
  return "otro";
}

const DOC_CODE: Record<SaleDocType, string> = { factura: "FA", boleta: "BV", nota_credito: "NC", nota_debito: "ND", otro: "OT" };

/** "Reversión de: F003-4319, AJUSTE DE PRECIO" → { ref: "F003-4319", motivo: "AJUSTE DE PRECIO" }. */
export function creditNoteReason(ocProveedor: string | null | undefined): { ref: string | null; motivo: string | null } {
  const m = /(?:reversi[oó]n de|reversal of)\s*:\s*([^,]+?)\s*(?:,\s*(.*))?$/i.exec(ocProveedor ?? "");
  if (!m) return { ref: null, motivo: null };
  return { ref: m[1].trim() || null, motivo: m[2]?.trim() || null };
}

type UserLike = Pick<PortalUser, "id" | "nombre" | "whatsapp">;

export interface VendorResolution {
  /** Texto que se guarda en `sales.vendedor`: el nombre del usuario si se reconoce; si no, el texto en formato Título. */
  vendedor: string | null;
  userId: number | null;
}

/** VENDEDOR del reporte → usuario del portal (alias de config, luego el cruce por nombre de dashboard/vendors.ts). */
export function vendorResolver(users: readonly UserLike[], settings: SalesSettings): (text: string | null | undefined) => VendorResolution {
  const aliases = new Map(Object.entries(settings.vendorAliases).map(([k, v]) => [nameTokens(k).join(" "), v]));
  const noOwner = new Set(settings.vendorsWithoutOwner.map((v) => nameTokens(v).join(" ")));
  const cache = new Map<string, VendorResolution>();
  return (text) => {
    const raw = (text ?? "").replace(/\s+/g, " ").trim();
    if (!raw) return { vendedor: null, userId: null };
    const key = nameTokens(raw).join(" ");
    let r = cache.get(key);
    if (!r) {
      if (noOwner.has(key)) r = { vendedor: raw, userId: null };
      else {
        const target = aliases.get(key) ?? raw;
        const u = matchUser(target, users);
        r = u ? { vendedor: u.nombre, userId: u.id } : { vendedor: titleCase(target), userId: null };
      }
      cache.set(key, r);
    }
    return r;
  };
}

export interface OdooLineInfo {
  /** Fila de Excel. */
  row: number;
  descripcion: string;
  clase: LineClass;
}

export interface OdooWarning {
  row: number;
  documento: string | null;
  mensaje: string;
}

export interface OdooStats {
  headerRow: number;
  lineas: number;
  desde: IsoDate | null;
  hasta: IsoDate | null;
  /** Líneas por tipo (sin contar las excluidas). */
  porTipo: Record<SaleLineType, number>;
  /** Líneas de servicio por tipo normalizado (sin contar las excluidas). */
  porServicio: Partial<Record<ServiceType, number>>;
  /** Neumáticos netos: facturas y boletas menos notas de crédito (sin excluidas, sin las de solo monto). */
  neumaticosNetos: number;
  neumaticosVendidos: number;
  notasCredito: { documentos: number; lineas: number; neumaticos: number; soloMonto: number; totalSoles: number; totalUsd: number };
  notasDebito: { documentos: number; lineas: number };
  excluidas: { lineas: number; porStatus: Record<string, number>; neumaticos: number; totalSoles: number };
  porStatus: Record<string, number>;
  /** Clientes por tipo de documento (RUC distintos). */
  clientes: { ruc: number; dni: number; otro: number };
  personasNaturales: { lineas: number; neumaticos: number };
  advertencias: OdooWarning[];
  /** Descripciones que no se pudieron clasificar con seguridad (una vez cada una, con cuántas líneas). */
  dudosas: { descripcion: string; tipo: SaleLineType; detalle: string | null; nota: string | null; lineas: number }[];
  /** Suma de TOTAL VTA S/ de todas las líneas tal como vienen (antes de excluir o restar nada). */
  sumaTotalVtaSoles: number;
  /** Valor de TOTAL VTA S/ en la fila TOTALES del archivo (null si no la trae). */
  totalesArchivo: number | null;
  /** Filas del pie ignoradas (TOTALES, MARGEN, texto). */
  filasIgnoradas: number[];
  vendedores: { texto: string; vendedor: string | null; userId: number | null; lineas: number }[];
}

export interface OdooParseResult {
  rows: SaleInput[];
  /** Detalle por línea guardada (mismo orden que `rows`). */
  info: OdooLineInfo[];
  errors: { row: number; error: string }[];
  stats: OdooStats;
}

export interface ParseOdooOptions {
  settings?: SalesSettings;
  users?: readonly UserLike[];
  origen?: string;
}

/** Valor "plano" de una celda (fórmulas → resultado guardado, texto enriquecido → texto). */
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

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Lee las filas de datos del reporte de Odoo (matriz de celdas crudas, fila 0 = fila 1 de Excel). Puro. */
export function parseOdooRows(matrix: Raw[][], headerRow: number, mapping: OdooMapping, opts: ParseOdooOptions = {}): OdooParseResult {
  const settings = opts.settings ?? DEFAULT_SALES_SETTINGS;
  const resolveVendor = vendorResolver(opts.users ?? [], settings);
  const excludeStatus = new Set(settings.excludeStatus.map((s) => foldText(s)));
  const amountOnly = settings.creditNoteAmountOnlyReasons.map((s) => foldText(s));
  const cell = (r: Raw[], f: OdooField): Raw => (mapping[f] === undefined ? null : (r[mapping[f]!] ?? null));
  const str = (r: Raw[], f: OdooField): string | null => text(cell(r, f)) || null;
  const numOf = (r: Raw[], f: OdooField): number | null => parseSaleNumber(cell(r, f));

  const rows: SaleInput[] = [];
  const info: OdooLineInfo[] = [];
  const errors: { row: number; error: string }[] = [];
  const stats: OdooStats = {
    headerRow,
    lineas: 0,
    desde: null,
    hasta: null,
    porTipo: { neumatico: 0, servicio: 0, otro: 0 },
    porServicio: {},
    neumaticosNetos: 0,
    neumaticosVendidos: 0,
    notasCredito: { documentos: 0, lineas: 0, neumaticos: 0, soloMonto: 0, totalSoles: 0, totalUsd: 0 },
    notasDebito: { documentos: 0, lineas: 0 },
    excluidas: { lineas: 0, porStatus: {}, neumaticos: 0, totalSoles: 0 },
    porStatus: {},
    clientes: { ruc: 0, dni: 0, otro: 0 },
    personasNaturales: { lineas: 0, neumaticos: 0 },
    advertencias: [],
    dudosas: [],
    sumaTotalVtaSoles: 0,
    totalesArchivo: null,
    filasIgnoradas: [],
    vendedores: [],
  };
  const occurrences = new Map<string, number>();
  const ncDocs = new Set<string>();
  const ndDocs = new Set<string>();
  const clientDocs = new Map<string, "ruc" | "dni" | "otro">();
  const dudosas = new Map<string, OdooStats["dudosas"][number]>();
  const vendors = new Map<string, OdooStats["vendedores"][number]>();

  for (let i = headerRow; i < matrix.length; i++) {
    const r = matrix[i] ?? [];
    const rowNum = i + 1;
    const first = text(r[0] ?? null);
    const fechaRaw = cell(r, "fecha");
    if (!r.some((c) => text(c ?? null))) continue; // fila vacía
    // pie: TOTALES (con fórmulas), MARGEN y el texto del proveedor del reporte
    if (/^(totales?|margen)$/i.test(first) || (!parseSaleDate(fechaRaw) && !str(r, "documento") && !str(r, "descripcion"))) {
      if (/^totales?$/i.test(first)) stats.totalesArchivo = numOf(r, "total");
      stats.filasIgnoradas.push(rowNum);
      continue;
    }
    const problems: string[] = [];
    const fecha = parseSaleDate(fechaRaw);
    if (!fecha) problems.push(text(fechaRaw) ? `fecha inválida ("${text(fechaRaw)}")` : "sin fecha");
    const documento = str(r, "documento");
    if (!documento) problems.push("sin N° de factura");
    const descripcion = str(r, "descripcion");
    if (!descripcion) problems.push("sin descripción");
    const cantidadRaw = numOf(r, "cantidad");
    if (cantidadRaw === null) problems.push(text(cell(r, "cantidad")) ? `cantidad no numérica ("${text(cell(r, "cantidad"))}")` : "sin cantidad");
    const rucText = str(r, "ruc") ?? "";
    const ruc = rucText.replace(/\D/g, "");
    if (!ruc) problems.push("sin RUC ni DNI");
    const totalVta = numOf(r, "total");
    if (totalVta !== null) stats.sumaTotalVtaSoles += totalVta;
    if (problems.length) {
      errors.push({ row: rowNum, error: problems.join("; ") });
      continue;
    }

    const tipoDoc = docTypeOf(str(r, "tipoDoc") ?? "");
    const clase = classifyLine(descripcion!);
    const status = str(r, "status");
    const excluida = !!status && excludeStatus.has(foldText(status));
    const ocProveedor = str(r, "ocProveedor");
    const nc = tipoDoc === "nota_credito";
    const motivo = nc ? creditNoteReason(ocProveedor).motivo : null;
    const soloMonto = nc && !!motivo && amountOnly.some((m) => foldText(motivo).includes(m));
    const sign = nc ? -1 : 1;
    const signed = (n: number | null) => (n === null ? null : n === 0 ? 0 : sign * n);
    const cantidad = sign * cantidadRaw!;
    const docCliente = docClienteOf(ruc);
    const cuentaUnidades = clase.tipoLinea === "neumatico" && !excluida && tipoDoc !== "nota_debito" && !soloMonto;

    const codeKey = clase.codigo ?? foldText(descripcion).replace(/[^a-z0-9]+/g, "");
    const docKey = `${DOC_CODE[tipoDoc]}|${normDocumento(documento)}|${codeKey.toUpperCase()}`;
    const n = (occurrences.get(docKey) ?? 0) + 1;
    occurrences.set(docKey, n);

    const advertencias: string[] = [];
    if (docCliente === "otro") advertencias.push(`documento del cliente de ${ruc.length} dígitos ("${rucText}"): no es RUC (11) ni DNI (8)`);
    if (tipoDoc === "otro") advertencias.push(`tipo de documento desconocido ("${str(r, "tipoDoc") ?? ""}")`);
    for (const a of advertencias) stats.advertencias.push({ row: rowNum, documento, mensaje: a });

    const vend = resolveVendor(str(r, "vendedor"));
    const vKey = str(r, "vendedor") ?? "";
    const v = vendors.get(vKey) ?? { texto: vKey, vendedor: vend.vendedor, userId: vend.userId, lineas: 0 };
    v.lineas++;
    vendors.set(vKey, v);

    const margen = str(r, "margen");
    const margenNum = margen && /\d/.test(margen) && !/[a-z]{3}/i.test(margen) ? parseSaleNumber(margen) : null;

    rows.push({
      fecha: fecha!,
      ruc,
      razonSocial: str(r, "razon"),
      medida: clase.medida,
      marca: clase.marca,
      diseno: clase.diseno,
      cantidad,
      precioUnitario: numOf(r, "precioUnitario"),
      total: signed(numOf(r, "total")),
      vendedor: vend.vendedor,
      origen: opts.origen ?? "odoo",
      isDemo: false,
      detalle: {
        lineKey: `${docKey}|${n}`,
        tipoDoc,
        documento: documento!,
        vencimiento: parseSaleDate(cell(r, "vencimiento")),
        moneda: str(r, "moneda"),
        tipoCambio: numOf(r, "tipoCambio"),
        estadoSunat: str(r, "estadoSunat"),
        status,
        ocOdoo: str(r, "ocOdoo"),
        ocProveedor,
        guia: str(r, "guia"),
        condVenta: str(r, "condVenta"),
        descripcion: descripcion!,
        codigoProducto: clase.codigo,
        tipoLinea: clase.tipoLinea,
        tipoServicio: clase.tipoServicio,
        docCliente,
        vendedorUserId: vend.userId,
        totalSinServ: signed(numOf(r, "totalSinServ")),
        precioUnitarioUsd: numOf(r, "precioUnitarioUsd"),
        totalUsd: signed(numOf(r, "totalUsd")),
        costoUnitario: numOf(r, "costoUnitario"),
        costoTotal: signed(numOf(r, "costoTotal")),
        costoUnitarioUsd: numOf(r, "costoUnitarioUsd"),
        costoTotalUsd: signed(numOf(r, "costoTotalUsd")),
        facturaProveedor: str(r, "facturaProveedor"),
        proveedor: str(r, "proveedor"),
        monedaProveedor: str(r, "monedaProveedor"),
        tipoCambioProveedor: numOf(r, "tipoCambioProveedor"),
        margen,
        margenPct: margenNum,
        cuentaUnidades,
        excluida,
        advertencia: advertencias.join("; ") || null,
      },
    });
    info.push({ row: rowNum, descripcion: descripcion!, clase });

    // estadísticas
    stats.lineas++;
    const st = status ?? "(vacío)";
    stats.porStatus[st] = (stats.porStatus[st] ?? 0) + 1;
    if (!stats.desde || fecha! < stats.desde) stats.desde = fecha;
    if (!stats.hasta || fecha! > stats.hasta) stats.hasta = fecha;
    if (!clase.seguro) {
      const d = dudosas.get(descripcion!) ?? { descripcion: descripcion!, tipo: clase.tipoLinea, detalle: clase.tipoServicio ?? clase.tipoOtro ?? clase.medida, nota: clase.nota, lineas: 0 };
      d.lineas++;
      dudosas.set(descripcion!, d);
    }
    if (excluida) {
      stats.excluidas.lineas++;
      stats.excluidas.porStatus[status!] = (stats.excluidas.porStatus[status!] ?? 0) + 1;
      if (clase.tipoLinea === "neumatico") stats.excluidas.neumaticos += cantidad;
      stats.excluidas.totalSoles += signed(totalVta) ?? 0;
      continue;
    }
    if (!clientDocs.has(ruc)) clientDocs.set(ruc, docCliente);
    stats.porTipo[clase.tipoLinea]++;
    if (clase.tipoServicio) stats.porServicio[clase.tipoServicio] = (stats.porServicio[clase.tipoServicio] ?? 0) + 1;
    if (cuentaUnidades) {
      stats.neumaticosNetos += cantidad;
      if (cantidad > 0) stats.neumaticosVendidos += cantidad;
      if (docCliente === "dni") stats.personasNaturales.neumaticos += cantidad;
    }
    if (docCliente === "dni") stats.personasNaturales.lineas++;
    if (nc) {
      ncDocs.add(normDocumento(documento));
      stats.notasCredito.lineas++;
      if (cuentaUnidades) stats.notasCredito.neumaticos += -cantidad;
      if (soloMonto) stats.notasCredito.soloMonto++;
      stats.notasCredito.totalSoles += -(signed(totalVta) ?? 0);
      stats.notasCredito.totalUsd += -(signed(numOf(r, "totalUsd")) ?? 0);
    }
    if (tipoDoc === "nota_debito") {
      ndDocs.add(normDocumento(documento));
      stats.notasDebito.lineas++;
    }
  }
  stats.notasCredito.documentos = ncDocs.size;
  stats.notasDebito.documentos = ndDocs.size;
  for (const t of clientDocs.values()) stats.clientes[t]++;
  stats.dudosas = [...dudosas.values()].sort((a, b) => b.lineas - a.lineas || a.descripcion.localeCompare(b.descripcion));
  stats.vendedores = [...vendors.values()].sort((a, b) => b.lineas - a.lineas);
  stats.sumaTotalVtaSoles = round2(stats.sumaTotalVtaSoles);
  stats.notasCredito.totalSoles = round2(stats.notasCredito.totalSoles);
  stats.notasCredito.totalUsd = round2(stats.notasCredito.totalUsd);
  stats.excluidas.totalSoles = round2(stats.excluidas.totalSoles);
  return { rows, info, errors, stats };
}
