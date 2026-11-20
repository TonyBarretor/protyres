/**
 * ventas-odoo, puntos 4, 8 y 9: lecturas del historial de ventas para la ficha de la empresa, el bot ("ultima venta",
 * "cliente final") y la referencia al cotizar. Comparten aquí el formato de precio, costo y margen.
 *
 * Costos, proveedor y margen son internos: los ve el vendedor, el supervisor y el administrador (ficha, bot), nunca un
 * documento para el cliente (PDF de la cotización, prepropuesta, encuesta). Nada de este módulo se usa en esos documentos.
 *
 * Moneda: cada línea se muestra en la moneda de su factura, con los montos tal como vienen del reporte (US$ en las
 * facturas en dólares, S/ en las de soles). No se convierte ni se recalcula nada.
 */
import { foldText, saleCountRuc, saleUnits } from "../store/shared";
import type { Company, IsoDate, PortalStore, Sale, ServiceType } from "../store/types";
import { parseTyreSize } from "../../tyre/spec";
import { CONTRACT_SERVICE_TYPES, SERVICE_LABELS, saleMedida } from "./classify";
import { loadSalesSettings } from "./config";

export interface SaleMoney {
  /** "US$" o "S/". */
  simbolo: string;
  precioUnitario: number | null;
  costoUnitario: number | null;
}

/** Precio y costo unitarios en la moneda de la factura (tal como vienen). */
export function saleMoney(s: Sale): SaleMoney {
  const d = s.detalle;
  if (d?.moneda === "USD") return { simbolo: "US$", precioUnitario: d.precioUnitarioUsd, costoUnitario: d.costoUnitarioUsd };
  return { simbolo: "S/", precioUnitario: s.precioUnitario, costoUnitario: d?.costoUnitario ?? null };
}

const money = new Intl.NumberFormat("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "US$ 255.00" (o "—"). */
export function fmtMoney(simbolo: string, n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `${simbolo} ${money.format(n)}`;
}

/** Margen tal como viene ("19.68%", "SERVICIO SIN COSTO") o "—". */
export function fmtMargen(s: Sale): string {
  return s.detalle?.margen ?? "—";
}

/** "12/09/2026". */
export function fmtFecha(iso: IsoDate): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** Nombre corto del producto: "Fenixway Valor 89 295/80R22.5", o la descripción sin el código. */
export function productLabel(s: Sale): string {
  if (s.diseno || s.marca) return [s.marca, s.diseno, s.medida].filter(Boolean).join(" ");
  return (s.detalle?.descripcion ?? s.medida ?? "—").replace(/^\s*\[[^\]]*\]\s*/, "");
}

/** Medida canónica de un texto ("295/80 R 22.5" → "295/80R22.5"), o null. */
export function canonicalMedida(text: string | null | undefined): string | null {
  return text ? saleMedida(parseTyreSize(text)?.canonical) : null;
}

export interface ServiceSummaryRow {
  tipo: ServiceType;
  label: string;
  /** Líneas de factura (una nota de crédito resta una). */
  veces: number;
  cantidad: number;
  /** Fecha de la última línea (AAAA-MM-DD). */
  ultimaFecha: IsoDate;
}

/** Resumen de servicios por tipo (las notas de crédito restan). */
export function serviceSummary(lines: Sale[]): ServiceSummaryRow[] {
  const by = new Map<ServiceType, ServiceSummaryRow>();
  for (const s of lines) {
    const d = s.detalle;
    if (!d || d.tipoLinea !== "servicio" || d.excluida) continue;
    const tipo = d.tipoServicio ?? "otros";
    const r = by.get(tipo) ?? { tipo, label: SERVICE_LABELS[tipo], veces: 0, cantidad: 0, ultimaFecha: s.fecha };
    r.veces += d.tipoDoc === "nota_credito" ? -1 : 1;
    r.cantidad += s.cantidad;
    if (s.fecha > r.ultimaFecha) r.ultimaFecha = s.fecha;
    by.set(tipo, r);
  }
  return [...by.values()].filter((r) => r.veces > 0 || r.cantidad !== 0).sort((a, b) => b.veces - a.veces || a.label.localeCompare(b.label));
}

/** true si la empresa compra algún componente del contrato de neumáticos (neto positivo). */
export function hasServiceContract(lines: Sale[]): boolean {
  return serviceSummary(lines).some((r) => CONTRACT_SERVICE_TYPES.includes(r.tipo) && r.veces > 0);
}

export interface LeasingNote {
  /** Línea con cliente final, vista desde la empresa: "vía leasing con BANCO DE CREDITO DEL PERU". */
  viaLeasing: string | null;
  /** Vista desde el banco: "cliente final: TRANSPORTES X". */
  clienteFinal: string | null;
}

export interface CompanySalesView {
  /** Todas las líneas que tocan a la empresa (como cliente del documento o como cliente final), la más reciente primero. */
  lineas: Sale[];
  neumaticos: Sale[];
  servicios: Sale[];
  otros: Sale[];
  serviciosPorTipo: ServiceSummaryRow[];
  tieneContrato: boolean;
  /** Neumáticos netos que cuentan para ESTA empresa (las de leasing con cliente final cuentan para el cliente final). */
  neumaticosNetos: number;
  /** Medidas vendidas (para el filtro), de más a menos unidades. */
  medidas: string[];
  /** id de línea → nota de leasing. */
  leasing: Map<number, LeasingNote>;
  /** true si el RUC de la empresa está marcado como entidad de leasing (sales.leasingRucs). */
  esLeasing: boolean;
}

/** Historial de ventas de una empresa (ficha). `medida` filtra por medida canónica. */
export async function companySalesView(store: PortalStore, company: Pick<Company, "ruc">, opts: { medida?: string | null; limit?: number } = {}): Promise<CompanySalesView> {
  const lineas = await store.querySales({ companyRucs: [company.ruc], medida: opts.medida ?? undefined, limit: opts.limit });
  const leasingRucs = new Set(loadSalesSettings().leasingRucs);
  const leasing = new Map<number, LeasingNote>();
  const otherCompanyIds = new Set<number>();
  for (const s of lineas) if (s.detalle?.clienteFinalCompanyId && s.ruc === company.ruc) otherCompanyIds.add(s.detalle.clienteFinalCompanyId);
  const names = new Map<number, string>();
  for (const id of otherCompanyIds) {
    const c = await store.getCompany(id);
    if (c) names.set(id, c.razonSocial);
  }
  for (const s of lineas) {
    const d = s.detalle;
    if (!d?.clienteFinalRuc) continue;
    if (s.ruc === company.ruc) leasing.set(s.id, { viaLeasing: null, clienteFinal: `cliente final: ${names.get(d.clienteFinalCompanyId ?? -1) ?? d.clienteFinalRuc}` });
    else leasing.set(s.id, { viaLeasing: `vía leasing con ${s.razonSocial ?? s.ruc}`, clienteFinal: null });
  }
  const tipo = (s: Sale) => s.detalle?.tipoLinea ?? "neumatico";
  const neumaticos = lineas.filter((s) => tipo(s) === "neumatico");
  const servicios = lineas.filter((s) => tipo(s) === "servicio");
  const unidades = new Map<string, number>();
  for (const s of neumaticos) if (s.medida) unidades.set(s.medida, (unidades.get(s.medida) ?? 0) + Math.abs(s.cantidad));
  return {
    lineas,
    neumaticos,
    servicios,
    otros: lineas.filter((s) => tipo(s) === "otro"),
    serviciosPorTipo: serviceSummary(servicios),
    tieneContrato: hasServiceContract(servicios),
    neumaticosNetos: neumaticos.filter((s) => saleCountRuc(s) === company.ruc).reduce((n, s) => n + saleUnits(s), 0),
    medidas: [...unidades].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m]) => m),
    leasing,
    esLeasing: leasingRucs.has(company.ruc),
  };
}

/**
 * Últimas ventas de neumáticos a una empresa (las que cuentan para ella: como cliente del documento o como cliente final),
 * opcionalmente de una medida. Sin notas de crédito ni excluidas.
 */
export async function lastTyreSales(store: PortalStore, ruc: string, opts: { medida?: string | null; limit?: number } = {}): Promise<Sale[]> {
  const lines = await store.querySales({ companyRucs: [ruc], medida: opts.medida ?? undefined, tipoLinea: ["neumatico"] });
  return lines.filter((s) => saleCountRuc(s) === ruc && s.cantidad > 0 && s.detalle?.tipoDoc !== "nota_credito").slice(0, opts.limit ?? 3);
}

/** Una línea del bot: "12/09/2026 · Fenixway Valor 89 295/80R22.5 · 8 u. · precio US$ 255.00 · costo US$ 199.15 · margen 21.90%". */
export function saleLineText(s: Sale): string {
  const m = saleMoney(s);
  const parts = [fmtFecha(s.fecha), productLabel(s), `${s.cantidad} u.`, `precio ${fmtMoney(m.simbolo, m.precioUnitario)}`, `costo ${fmtMoney(m.simbolo, m.costoUnitario)}`, `margen ${fmtMargen(s)}`];
  if (s.detalle?.clienteFinalRuc && s.ruc !== s.detalle.clienteFinalRuc) parts.push(`vía leasing con ${s.razonSocial ?? s.ruc}`);
  return parts.join(" · ");
}

/**
 * Referencia para el "Entendí" del cotizador (punto 8): "Última venta a este cliente: Valor 89 a US$ 255 el 12/09/2026".
 * Solo informativa (no toca el precio). null si nunca se le vendió esa medida.
 */
export async function lastSaleReference(store: PortalStore, ruc: string, medidaText: string): Promise<string | null> {
  const medida = canonicalMedida(medidaText);
  if (!medida) return null;
  const [s] = await lastTyreSales(store, ruc, { medida, limit: 1 });
  if (!s) return null;
  const m = saleMoney(s);
  if (m.precioUnitario === null) return null;
  const nombre = s.diseno ?? s.marca ?? productLabel(s);
  const precio = Number.isInteger(m.precioUnitario) ? String(m.precioUnitario) : money.format(m.precioUnitario);
  return `Última venta a este cliente: ${nombre} a ${m.simbolo} ${precio} el ${fmtFecha(s.fecha)}`;
}

/** Documentos de un banco (entidad de leasing) sin cliente final asignado, agrupados por factura. */
export interface LeasingPendingDoc {
  bankRuc: string;
  bankName: string | null;
  documento: string;
  fecha: IsoDate;
  neumaticos: number;
  lineas: number;
  productos: string[];
  vendedor: string | null;
}

export async function leasingPending(store: PortalStore, opts: { bankRucs?: string[] } = {}): Promise<LeasingPendingDoc[]> {
  const rucs = opts.bankRucs ?? loadSalesSettings().leasingRucs;
  if (!rucs.length) return [];
  const lines = await store.querySales({ docRucs: rucs, tipoLinea: ["neumatico"], sinClienteFinal: true, onlyDetailed: true });
  const by = new Map<string, LeasingPendingDoc>();
  for (const s of lines) {
    const doc = s.detalle!.documento;
    const key = `${s.ruc}|${doc}`;
    const r = by.get(key) ?? { bankRuc: s.ruc, bankName: s.razonSocial, documento: doc, fecha: s.fecha, neumaticos: 0, lineas: 0, productos: [], vendedor: s.vendedor };
    r.neumaticos += saleUnits(s);
    r.lineas++;
    const p = productLabel(s);
    if (!r.productos.includes(p)) r.productos.push(p);
    by.set(key, r);
  }
  // una factura anulada por completo con su nota de crédito no queda "por asignar"
  return [...by.values()].filter((d) => d.neumaticos > 0).sort((a, b) => b.fecha.localeCompare(a.fecha) || a.documento.localeCompare(b.documento));
}

/** Busca una empresa del padrón por RUC o por nombre (para asignar el cliente final). */
export async function findCompanyForClienteFinal(store: PortalStore, query: string): Promise<Company[]> {
  const q = query.trim();
  if (!q) return [];
  const ruc = q.replace(/\D/g, "");
  if (ruc.length === 11) {
    const [c] = await store.getCompaniesByRucs([ruc]);
    return c ? [c] : [];
  }
  const res = await store.searchCompanies({ q, pageSize: 10 });
  return res.rows;
}

/** N° de factura escrito a mano → forma del reporte: "f003 4050" → "F003-4050", "b bol 1" → "B BOL-1" (luego normDocumento). */
export function normalizeDocInput(s: string): string {
  return foldText(s)
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s-]+(\d+)$/, "-$1");
}
