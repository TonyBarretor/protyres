/**
 * Corrida J, punto 5 — pantalla general de ventas (/portal/ventas/lista): todas las líneas importadas del reporte de Odoo
 * (y las del formato simple), con filtros combinables en la dirección, resumen del filtro y vista "Por cliente".
 *
 * Todo se filtra, suma, ordena y pagina en la base (PortalStore.listSalesLines / salesListSummary / salesListByClient):
 * aquí solo se leen los parámetros de la URL y se da formato. Precio, costo, proveedor y margen son internos: la pantalla
 * la ven vendedor, supervisor y admin (canSeeSalesHistory), igual que el historial de la ficha.
 *
 * Las ventas demo nunca se mezclan con las reales: con ?demo=1 se ven solas, con la etiqueta DEMO.
 */
import { canonicalMedida, fmtFecha, fmtMoney } from "../sales/history";
import { LINE_TYPE_LABELS } from "../sales/classify";
import { loadSalesSettings } from "../sales/config";
import { digits } from "../store/shared";
import type { Company, PortalStore, PortalUser, SaleLineType, SalesClientSort, SalesListFilter, SalesListSummary } from "../store/types";
import { canSeeSalesHistory } from "./permissions";
import { saleRowView, type SaleRowView } from "./ventas";

export const SALES_LIST_PATH = "/portal/ventas/lista";
export const SALES_LIST_PAGE_SIZE = 50;
/** Tope de páginas que se aceptan en ?p= (una URL manipulada no pide el offset 10⁹). */
const MAX_PAGE = 10_000;

export type SalesListVista = "lineas" | "clientes";

/** Parámetros de la URL ya validados (lo que la página pone de vuelta en el formulario). */
export interface SalesListParams {
  q: string;
  /** Lo que escribió el vendedor en "Medida" (se filtra por su forma canónica). */
  medida: string;
  marca: string;
  tipo: SaleLineType | "";
  vendedor: string;
  desde: string;
  hasta: string;
  leasing: boolean;
  demo: boolean;
  vista: SalesListVista;
  orden: SalesClientSort;
  dir: "asc" | "desc";
  page: number;
}

export const CLIENT_SORTS: { id: SalesClientSort; label: string; dir: "asc" | "desc" }[] = [
  { id: "neumaticos", label: "Neumáticos", dir: "desc" },
  { id: "total", label: "Total S/", dir: "desc" },
  { id: "margen", label: "Margen", dir: "desc" },
  { id: "ultima", label: "Última compra", dir: "desc" },
  { id: "cliente", label: "Cliente", dir: "asc" },
];

export const LINE_TYPES: { id: SaleLineType; label: string }[] = [
  { id: "neumatico", label: "Neumáticos" },
  { id: "servicio", label: LINE_TYPE_LABELS.servicio },
  { id: "otro", label: LINE_TYPE_LABELS.otro },
];

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const text = (v: string | string[] | undefined, max: number) => one(v).trim().replace(/\s+/g, " ").slice(0, max);
const isoDate = (v: string | string[] | undefined): string => {
  const t = one(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return "";
  const d = new Date(`${t}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? "" : t;
};

export function parseSalesListParams(sp: SP): SalesListParams {
  const tipo = one(sp.tipo);
  const orden = CLIENT_SORTS.find((s) => s.id === one(sp.orden));
  const dirRaw = one(sp.dir);
  let desde = isoDate(sp.desde);
  let hasta = isoDate(sp.hasta);
  if (desde && hasta && desde > hasta) [desde, hasta] = [hasta, desde];
  const page = Math.trunc(Number(one(sp.p)));
  return {
    q: text(sp.q, 80),
    medida: text(sp.medida, 40),
    marca: text(sp.marca, 60),
    tipo: tipo === "neumatico" || tipo === "servicio" || tipo === "otro" ? tipo : "",
    vendedor: text(sp.vendedor, 80),
    desde,
    hasta,
    leasing: one(sp.leasing) === "1",
    demo: one(sp.demo) === "1",
    vista: one(sp.vista) === "clientes" ? "clientes" : "lineas",
    orden: orden?.id ?? "neumaticos",
    dir: dirRaw === "asc" || dirRaw === "desc" ? dirRaw : (orden?.dir ?? "desc"),
    page: Number.isFinite(page) && page >= 1 ? Math.min(page, MAX_PAGE) : 1,
  };
}

/** Filtro del store a partir de los parámetros. `medidaNoReconocida`: el texto de "Medida" que no se entendió (no filtra). */
export function salesListFilter(p: SalesListParams, leasingRucs: string[] = loadSalesSettings().leasingRucs): { filter: SalesListFilter; medidaNoReconocida: string | null } {
  const medida = p.medida ? canonicalMedida(p.medida) : null;
  const filter: SalesListFilter = { demo: p.demo };
  if (p.q) filter.q = p.q;
  if (medida) filter.medida = medida;
  if (p.marca) filter.marca = p.marca;
  if (p.tipo) filter.tipoLinea = p.tipo;
  if (p.vendedor) filter.vendedor = p.vendedor;
  if (p.desde) filter.desde = p.desde;
  if (p.hasta) filter.hasta = p.hasta;
  if (p.leasing) {
    filter.docRucs = leasingRucs;
    filter.sinClienteFinal = true;
  }
  return { filter, medidaNoReconocida: p.medida && !medida ? p.medida : null };
}

const DEFAULTS = parseSalesListParams({});

/** Dirección de la pantalla con estos parámetros (solo los que no son el valor por defecto). */
export function salesListHref(p: SalesListParams, over: Partial<SalesListParams> = {}): string {
  const v = { ...p, ...over };
  const q = new URLSearchParams();
  const put = (k: string, val: string) => {
    if (val) q.set(k, val);
  };
  put("q", v.q);
  put("medida", v.medida);
  put("marca", v.marca);
  put("tipo", v.tipo);
  put("vendedor", v.vendedor);
  put("desde", v.desde);
  put("hasta", v.hasta);
  if (v.leasing) q.set("leasing", "1");
  if (v.demo) q.set("demo", "1");
  if (v.vista !== DEFAULTS.vista) q.set("vista", v.vista);
  if (v.vista === "clientes" && (v.orden !== DEFAULTS.orden || v.dir !== DEFAULTS.dir)) {
    q.set("orden", v.orden);
    q.set("dir", v.dir);
  }
  if (v.page > 1) q.set("p", String(v.page));
  const s = q.toString();
  return `${SALES_LIST_PATH}${s ? `?${s}` : ""}`;
}

export function hasSalesListFilters(p: SalesListParams): boolean {
  return !!(p.q || p.medida || p.marca || p.tipo || p.vendedor || p.desde || p.hasta || p.leasing);
}

const pct = new Intl.NumberFormat("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 });

/** "21.90 %" o "—". */
export function fmtPct(n: number | null): string {
  return n === null ? "—" : `${pct.format(n)} %`;
}

/** Neumáticos con signo ("−4" en negativo). */
export function fmtUnits(n: number): string {
  return n < 0 ? `−${int.format(-n)}` : int.format(n);
}

export interface SalesListSummaryView extends SalesListSummary {
  neumaticosText: string;
  totalPenText: string;
  totalUsdText: string;
  margenText: string;
  notasCreditoText: string | null;
}

export function summaryView(s: SalesListSummary): SalesListSummaryView {
  return {
    ...s,
    neumaticosText: fmtUnits(s.neumaticos),
    totalPenText: fmtMoney("S/", s.totalPen),
    totalUsdText: fmtMoney("US$", s.totalUsd),
    margenText: fmtPct(s.margenPct),
    notasCreditoText: s.notasCredito ? `${int.format(s.notasCredito)} línea${s.notasCredito === 1 ? "" : "s"} de nota de crédito (${fmtMoney("S/", s.notasCreditoPen)}) ya restadas` : null,
  };
}

export interface PartyView {
  ruc: string;
  nombre: string;
  /** Ficha del padrón, o null si el RUC no está. */
  companyId: number | null;
}

export interface SalesListRowView extends SaleRowView {
  cliente: PartyView;
  clienteFinal: PartyView | null;
  vendedor: string;
  totalPen: string;
  demo: boolean;
}

export interface SalesListClientView {
  cliente: PartyView;
  neumaticos: string;
  neumaticosNegativos: boolean;
  totalPen: string;
  totalUsd: string;
  margen: string;
  ultimaCompra: string;
  lineas: number;
  /** Líneas de este cliente con los mismos filtros. */
  href: string;
}

export interface SalesListView {
  params: SalesListParams;
  medidaNoReconocida: string | null;
  summary: SalesListSummaryView;
  lineas: SalesListRowView[];
  clientes: SalesListClientView[];
  /** Filas de la vista activa (líneas o clientes) con el filtro. */
  total: number;
  pages: number;
  from: number;
  to: number;
  options: { marcas: string[]; vendedores: string[] };
  /** Ventas demo guardadas (para el enlace a verlas aparte); 0 si no hay. */
  demoCount: number;
  hasFilters: boolean;
}

/**
 * Lee la pantalla. null si el usuario no puede verla (técnico, inactivo): la página responde "no encontrada". Las
 * consultas corren en paralelo y cada una pagina o agrega en la base.
 */
export async function loadSalesListView(store: PortalStore, user: Pick<PortalUser, "id" | "rol" | "activo"> | null | undefined, sp: SP, leasingRucs?: string[]): Promise<SalesListView | null> {
  if (!canSeeSalesHistory(user)) return null;
  const params = parseSalesListParams(sp);
  const { filter, medidaNoReconocida } = salesListFilter(params, leasingRucs);
  const size = SALES_LIST_PAGE_SIZE;
  const offset = (params.page - 1) * size;
  const [summary, options, counts, lines, byClient] = await Promise.all([
    store.salesListSummary(filter),
    store.salesFilterOptions(params.demo),
    store.countSales(),
    params.vista === "lineas" ? store.listSalesLines(filter, { limit: size, offset }) : Promise.resolve([]),
    params.vista === "clientes" ? store.salesListByClient(filter, { sort: params.orden, dir: params.dir, limit: size, offset }) : Promise.resolve({ rows: [], total: 0 }),
  ]);
  const total = params.vista === "lineas" ? summary.lineas : byClient.total;
  // nombres y fichas del padrón de los RUC de la página (documento y cliente final): una consulta de ≤ 100 RUC
  const rucs = new Set<string>();
  for (const s of lines) {
    rucs.add(s.ruc);
    if (s.detalle?.clienteFinalRuc) rucs.add(s.detalle.clienteFinalRuc);
  }
  const companies = new Map<string, Company>();
  if (rucs.size) for (const c of await store.getCompaniesByRucs([...rucs])) companies.set(digits(c.ruc), c);
  const party = (ruc: string, nombre: string | null): PartyView => {
    const c = companies.get(ruc);
    return { ruc, nombre: nombre ?? c?.razonSocial ?? `RUC ${ruc}`, companyId: c?.id ?? null };
  };
  const pages = Math.max(1, Math.ceil(total / size));
  return {
    params,
    medidaNoReconocida,
    summary: summaryView(summary),
    lineas: lines.map((s) => {
      const cf = s.detalle?.clienteFinalRuc ?? null;
      return {
        ...saleRowView(s),
        cliente: party(s.ruc, s.razonSocial),
        clienteFinal: cf ? party(cf, companies.get(cf)?.razonSocial ?? null) : null,
        vendedor: s.vendedor ?? "—",
        totalPen: fmtMoney("S/", s.total),
        demo: s.isDemo,
      };
    }),
    clientes: byClient.rows.map((r) => ({
      cliente: { ruc: r.ruc, nombre: r.razonSocial ?? `RUC ${r.ruc}`, companyId: r.companyId },
      neumaticos: fmtUnits(r.neumaticos),
      neumaticosNegativos: r.neumaticos < 0,
      totalPen: fmtMoney("S/", r.totalPen),
      totalUsd: fmtMoney("US$", r.totalUsd),
      margen: fmtPct(r.margenPct),
      ultimaCompra: fmtFecha(r.ultimaFecha),
      lineas: r.lineas,
      href: salesListHref(params, { q: r.ruc, vista: "lineas", page: 1 }),
    })),
    total,
    pages,
    from: total ? offset + 1 : 0,
    to: Math.min(offset + size, total),
    options,
    demoCount: counts.demo,
    hasFilters: hasSalesListFilters(params),
  };
}
