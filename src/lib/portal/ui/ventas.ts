/**
 * ventas-odoo (puntos 8, 9 y 11), pantallas del portal:
 *  - fichaSalesView: el modelo del bloque "Historial de ventas" de la ficha (neumáticos con precio, costo, proveedor y
 *    margen; servicios por tipo; otros productos) y, en la ficha de un banco, sus facturas para asignar el cliente final.
 *  - assignClienteFinal: asigna (o quita) el cliente final de una o varias facturas del banco, con su permiso, y recalcula
 *    el puntaje del banco, del cliente final nuevo y del anterior. Las notas de crédito que revierten esas facturas
 *    ("Reversión de: F003-…") siguen a su factura: si no, el banco quedaría con neumáticos negativos.
 *  - clientsOutsidePadron: clientes con RUC que compran pero no están en el padrón.
 *
 * Costos, proveedor y margen son internos (ver sales/history.ts): este módulo solo alimenta pantallas del portal que ve
 * el vendedor, el supervisor y el administrador (canSeeSalesHistory), nunca documentos para el cliente.
 */
import { loadPortalConfig } from "../config";
import { canonicalMedida, companySalesView, fmtFecha, fmtMargen, fmtMoney, normalizeDocInput, productLabel, saleMoney, type ServiceSummaryRow } from "../sales/history";
import { loadSalesSettings } from "../sales/config";
import { creditNoteReason } from "../sales/odoo";
import { recalcScoresSafely, type PriceSizesSource } from "../scoring/recalc";
import { digits, normDocumento, saleUnits } from "../store/shared";
import type { Company, IsoDate, PortalStore, PortalUser, Sale, SaleDocType, SalesClientRow } from "../store/types";
import { canAssignClienteFinal } from "./permissions";

type UserLike = Pick<PortalUser, "id" | "rol" | "activo">;

/** Líneas de neumáticos que se muestran sin pedir "ver todas". */
export const SALES_HISTORY_LIMIT = 40;
const OTHERS_LIMIT = 30;
/** Facturas por asignación (un formulario manipulado no manda miles). */
const MAX_DOCS_PER_ASSIGN = 200;

const DOC_LABELS: Record<SaleDocType, string> = { factura: "Factura", boleta: "Boleta", nota_credito: "Nota de crédito", nota_debito: "Nota de débito", otro: "Documento" };

export interface SaleRowView {
  id: number;
  fecha: string;
  documento: string;
  tipoDoc: string;
  notaCredito: boolean;
  /** Nota de crédito que solo corrige el monto (no resta neumáticos). */
  soloMonto: boolean;
  /** Factura que revierte la nota de crédito ("F003-5001"). */
  revierte: string | null;
  producto: string;
  medida: string | null;
  cantidad: number;
  precio: string;
  costo: string;
  proveedor: string;
  margen: string;
  /** "vía leasing con BANCO …" (ficha del cliente final) o "cliente final: EMPRESA" (ficha del banco). */
  leasing: string | null;
}

export interface ServiceRowView extends ServiceSummaryRow {
  ultimoMes: string;
}

export interface ClienteFinalDoc {
  documento: string;
  fecha: string;
  neumaticos: number;
  lineas: number;
  productos: string[];
  /** Notas de crédito del banco que revierten esta factura (se asignan con ella). */
  notas: string[];
  /** true si el documento es una nota de crédito sin su factura en el banco. */
  notaCredito: boolean;
  clienteFinal: { id: number | null; ruc: string; razonSocial: string } | null;
}

export interface FichaSalesView {
  medida: string | null;
  medidas: string[];
  /** Líneas de neumáticos (filtradas por medida), la más reciente primero. */
  neumaticos: SaleRowView[];
  /** Cuántas hay en total con el filtro (las mostradas pueden ser menos sin "ver todas"). */
  neumaticosTotal: number;
  neumaticosNetos: number;
  servicios: ServiceRowView[];
  tieneContrato: boolean;
  otros: SaleRowView[];
  otrosTotal: number;
  /** Facturas del banco para el cliente final (null si la empresa no es una entidad de leasing ni tiene asignaciones). */
  clienteFinal: ClienteFinalDocs | null;
  sinVentas: boolean;
}

const monthFmt = new Intl.DateTimeFormat("es-PE", { month: "short", year: "numeric", timeZone: "UTC" });

/** "2026-09-13" → "sept 2026". */
export function fmtMes(iso: IsoDate): string {
  return monthFmt.format(new Date(`${iso}T12:00:00Z`)).replace(/\./g, "").replace(/\s+de\s+/, " ");
}

/** Valor de ?medida= → medida canónica (o null si no se reconoce). */
export function parseMedidaParam(v: string | null | undefined): string | null {
  const t = (v ?? "").trim().slice(0, 40);
  return t ? canonicalMedida(t) : null;
}

export function saleRowView(s: Sale, leasing: string | null = null): SaleRowView {
  const d = s.detalle;
  const m = saleMoney(s);
  const nc = d?.tipoDoc === "nota_credito";
  return {
    id: s.id,
    fecha: fmtFecha(s.fecha),
    documento: d?.documento ?? "—",
    tipoDoc: d ? DOC_LABELS[d.tipoDoc] : "Venta",
    notaCredito: nc,
    soloMonto: nc && !!d && !d.cuentaUnidades,
    revierte: nc ? creditNoteReason(d?.ocProveedor).ref : null,
    producto: productLabel(s),
    medida: s.medida,
    cantidad: s.cantidad,
    precio: fmtMoney(m.simbolo, m.precioUnitario),
    costo: fmtMoney(m.simbolo, m.costoUnitario),
    proveedor: d?.proveedor ?? "—",
    margen: fmtMargen(s),
    leasing,
  };
}

/** Facturas de neumáticos del banco agrupadas por documento; las notas de crédito se cuelgan de la factura que revierten. */
async function bankDocs(store: PortalStore, bankRuc: string, lines: Sale[]): Promise<ClienteFinalDoc[]> {
  const own = lines.filter((s) => s.ruc === bankRuc && s.detalle);
  const ids = [...new Set(own.map((s) => s.detalle!.clienteFinalCompanyId).filter((x): x is number => x !== null))];
  const names = new Map<number, string>();
  for (const id of ids) {
    const c = await store.getCompany(id);
    if (c) names.set(id, c.razonSocial);
  }
  const by = new Map<string, ClienteFinalDoc>();
  const invoiceKey = new Map<string, string>();
  for (const s of own) if (s.detalle!.tipoDoc !== "nota_credito") invoiceKey.set(normDocumento(s.detalle!.documento), s.detalle!.documento);
  // de la más antigua a la más reciente: la factura existe antes que su nota
  for (const s of [...own].reverse()) {
    const d = s.detalle!;
    const nc = d.tipoDoc === "nota_credito";
    const ref = nc ? creditNoteReason(d.ocProveedor).ref : null;
    const parent = ref ? invoiceKey.get(normDocumento(ref)) : undefined;
    const key = parent ?? d.documento;
    let doc = by.get(key);
    if (!doc) {
      const cf = d.clienteFinalRuc ? { id: d.clienteFinalCompanyId, ruc: d.clienteFinalRuc, razonSocial: names.get(d.clienteFinalCompanyId ?? -1) ?? d.clienteFinalRuc } : null;
      doc = { documento: key, fecha: fmtFecha(s.fecha), neumaticos: 0, lineas: 0, productos: [], notas: [], notaCredito: nc && !parent, clienteFinal: cf };
      by.set(key, doc);
    }
    if (parent && !doc.notas.includes(d.documento)) doc.notas.push(d.documento);
    doc.neumaticos += saleUnits(s);
    doc.lineas++;
    const p = productLabel(s);
    if (!doc.productos.includes(p)) doc.productos.push(p);
  }
  return [...by.values()].reverse();
}

export interface ClienteFinalDocs {
  pendientes: ClienteFinalDoc[];
  asignadas: ClienteFinalDoc[];
}

function splitDocs(docs: ClienteFinalDoc[]): ClienteFinalDocs {
  return { pendientes: docs.filter((d) => !d.clienteFinal && (d.neumaticos > 0 || d.notaCredito)), asignadas: docs.filter((d) => d.clienteFinal) };
}

export interface LeasingBankView {
  ruc: string;
  /** Razón social del padrón o, si el banco no está en el padrón, la de sus facturas. */
  nombre: string;
  /** Empresa del padrón (para enlazar su ficha), o null. */
  companyId: number | null;
  esLeasing: boolean;
  docs: ClienteFinalDocs;
}

/**
 * Facturas de un banco para asignar el cliente final, esté o no en el padrón (los bancos de leasing no tienen flota en el
 * MTC: en la base real no tienen ficha). null si el RUC no tiene facturas de neumáticos ni está en sales.leasingRucs.
 */
export async function leasingBankView(store: PortalStore, rucText: string): Promise<LeasingBankView | null> {
  const ruc = digits(rucText);
  if (ruc.length !== 11) return null;
  const lines = await store.querySales({ docRucs: [ruc], tipoLinea: ["neumatico"], onlyDetailed: true });
  const esLeasing = loadSalesSettings().leasingRucs.includes(ruc);
  if (!lines.length && !esLeasing) return null;
  const [company] = await store.getCompaniesByRucs([ruc]);
  return { ruc, nombre: company?.razonSocial ?? lines.find((s) => s.razonSocial)?.razonSocial ?? `RUC ${ruc}`, companyId: company?.id ?? null, esLeasing, docs: splitDocs(await bankDocs(store, ruc, lines)) };
}

/** Historial de ventas de la ficha (punto 8) y facturas del banco para el cliente final (punto 9). */
export async function fichaSalesView(store: PortalStore, company: Pick<Company, "ruc">, opts: { medida?: string | null; todas?: boolean } = {}): Promise<FichaSalesView> {
  const view = await companySalesView(store, company);
  const ruc = digits(company.ruc);
  const medida = opts.medida ? canonicalMedida(opts.medida) : null;
  const note = (s: Sale) => {
    const n = view.leasing.get(s.id);
    return n?.viaLeasing ?? n?.clienteFinal ?? null;
  };
  const tyres = medida ? view.neumaticos.filter((s) => s.medida === medida) : view.neumaticos;
  const shown = opts.todas ? tyres : tyres.slice(0, SALES_HISTORY_LIMIT);
  const docs = await bankDocs(store, ruc, view.neumaticos);
  const showCf = view.esLeasing || docs.some((d) => d.clienteFinal);
  const split = splitDocs(docs);
  return {
    medida,
    medidas: view.medidas,
    neumaticos: shown.map((s) => saleRowView(s, note(s))),
    neumaticosTotal: tyres.length,
    neumaticosNetos: view.neumaticosNetos,
    servicios: view.serviciosPorTipo.map((r) => ({ ...r, ultimoMes: fmtMes(r.ultimaFecha) })),
    tieneContrato: view.tieneContrato,
    otros: view.otros.slice(0, opts.todas ? undefined : OTHERS_LIMIT).map((s) => saleRowView(s, note(s))),
    otrosTotal: view.otros.length,
    clienteFinal: showCf ? split : null,
    sinVentas: view.lineas.length === 0,
  };
}

export type AssignClienteFinalResult =
  | { ok: true; mensaje: string; documentos: string[]; lineas: number; companyIds: number[] }
  | { ok: false; error: string };

export interface AssignClienteFinalInput {
  user: UserLike | null | undefined;
  /** RUC del banco (documento de las facturas): puede no estar en el padrón. */
  bankRuc: string;
  documentos: string[];
  /** null: quitar el cliente final. */
  targetCompanyId: number | null;
  prices?: PriceSizesSource | null;
  log?: (m: string) => void;
}

/**
 * Asigna (o quita) el cliente final de facturas del banco. Comprueba el rol, que la empresa exista, que cada factura sea
 * del banco y que el cliente final no sea el mismo banco. Arrastra las notas de crédito del banco que revierten esas
 * facturas, registra la actividad en ambas fichas y recalcula el puntaje de las empresas afectadas. No hace flush.
 */
export async function assignClienteFinal(store: PortalStore, input: AssignClienteFinalInput): Promise<AssignClienteFinalResult> {
  const user = input.user;
  if (!user || !canAssignClienteFinal(user)) return { ok: false, error: "Tu rol no puede asignar el cliente final." };
  const bankRuc = digits(input.bankRuc);
  if (bankRuc.length !== 11) return { ok: false, error: "Banco no encontrado." };
  const [bankCompany] = await store.getCompaniesByRucs([bankRuc]);
  // "f003 5005" escrito a mano o "F003-5005" del formulario: el mismo documento
  const wanted = [...new Set(input.documentos.map((d) => normalizeDocInput(d)).filter(Boolean))];
  if (!wanted.length) return { ok: false, error: "Marca al menos una factura." };
  if (wanted.length > MAX_DOCS_PER_ASSIGN) return { ok: false, error: `Son demasiadas facturas a la vez (máximo ${MAX_DOCS_PER_ASSIGN}).` };
  let target: Company | null = null;
  if (input.targetCompanyId !== null) {
    target = await store.getCompany(input.targetCompanyId);
    if (!target) return { ok: false, error: "No encontré la empresa del cliente final. Búscala de nuevo." };
    if (digits(target.ruc) === bankRuc) return { ok: false, error: "El cliente final no puede ser la misma empresa de la factura." };
  }
  const lines = await store.querySales({ docRucs: [bankRuc], onlyDetailed: true, includeExcluded: true });
  const bank = { id: bankCompany?.id ?? null, razonSocial: bankCompany?.razonSocial ?? lines.find((s) => s.razonSocial)?.razonSocial ?? `RUC ${bankRuc}` };
  if (!lines.length) return { ok: false, error: `${bank.razonSocial} no tiene facturas guardadas.` };
  const byDoc = new Map<string, string>();
  for (const s of lines) byDoc.set(normDocumento(s.detalle!.documento), s.detalle!.documento);
  const missing = wanted.filter((d) => !byDoc.has(normDocumento(d)));
  if (missing.length) return { ok: false, error: `${missing.slice(0, 3).join(", ")} no ${missing.length === 1 ? "es una factura" : "son facturas"} de ${bank.razonSocial}.` };
  const chosen = new Set(wanted.map(normDocumento));
  const docs = new Set(wanted.map((d) => byDoc.get(normDocumento(d))!));
  for (const s of lines) {
    const d = s.detalle!;
    const ref = d.tipoDoc === "nota_credito" ? creditNoteReason(d.ocProveedor).ref : null;
    if (ref && chosen.has(normDocumento(ref))) docs.add(d.documento);
  }
  const affected = lines.filter((s) => docs.has(s.detalle!.documento));
  const before = new Set(affected.map((s) => s.detalle!.clienteFinalCompanyId).filter((x): x is number => x !== null));
  const n = await store.setClienteFinal({ bankRuc, documentos: [...docs], company: target ? { id: target.id, ruc: digits(target.ruc) } : null, userId: user.id });
  const lista = [...docs].join(", ");
  const texto = target ? `Cliente final de ${lista} (${bank.razonSocial}): ${target.razonSocial}.` : `Se quitó el cliente final de ${lista} (${bank.razonSocial}).`;
  const companyIds = [...new Set([...(bank.id ? [bank.id] : []), ...(target ? [target.id] : []), ...before])];
  for (const id of companyIds) await store.addActivity({ companyId: id, opportunityId: null, userId: user.id, tipo: "nota", texto, canal: "portal" });
  await recalcScoresSafely(store, loadPortalConfig().scoring, { companyIds, prices: input.prices ?? null, why: "cliente final de leasing", log: input.log });
  const facturas = `${docs.size} documento${docs.size === 1 ? "" : "s"}`;
  const lineas = `${n} línea${n === 1 ? "" : "s"}`;
  const mensaje = target ? `Cliente final asignado: ${target.razonSocial} en ${facturas} (${lineas}).` : `Cliente final quitado de ${facturas} (${lineas}).`;
  return { ok: true, mensaje, documentos: [...docs], lineas: n, companyIds };
}

export interface OutsidePadronRow extends SalesClientRow {
  ultimaVenta: string;
}

/** Clientes con RUC (11 dígitos) que compran y no están en el padrón, de más a menos neumáticos netos. */
export async function clientsOutsidePadron(store: PortalStore): Promise<OutsidePadronRow[]> {
  const rows = (await store.salesByClient()).filter((r) => r.docCliente === "ruc");
  if (!rows.length) return [];
  const known = new Set((await store.getCompaniesByRucs(rows.map((r) => r.ruc))).map((c) => digits(c.ruc)));
  return rows
    .filter((r) => !known.has(r.ruc))
    .sort((a, b) => b.neumaticos - a.neumaticos || b.ultimaFecha.localeCompare(a.ultimaFecha) || a.ruc.localeCompare(b.ruc))
    .map((r) => ({ ...r, ultimaVenta: fmtFecha(r.ultimaFecha) }));
}
