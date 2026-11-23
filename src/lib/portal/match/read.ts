/**
 * Corrida K — lo que muestran la pantalla Match Venta, la ficha, Hoy y el bot. Lee lo guardado por el cálculo por lotes
 * (match_results + la foto del stock del último cálculo); no calcula el cruce.
 *
 * Reglas de lectura:
 *  - Un vendedor no ve empresas de otro vendedor (supervisor y admin ven todas).
 *  - Entidades del Estado y bancos de leasing sin cliente final, ocultas por defecto (`incluirExcluidas` las muestra).
 *  - Lista por producto: directos y migraciones con porcentaje (de mayor a menor; empate: más llantas en piso), y aparte
 *    "Clientes que ya compraron esta medida" (sin padrón, sin porcentaje).
 *  - Vista por empresa: una sola vez cada empresa con todos sus matches; cada match adicional la sube (match.bonusPorMatchExtra).
 *  - Crédito observado o rechazado: aviso en la tarjeta, nunca se oculta.
 */
import { loadPortalConfig } from "../config";
import type { CreditEstado, MatchResultSummary, MatchResultView, MatchRun, PortalStore, PortalUser } from "../store/types";
import type { MatchConfig } from "./config";
import type { MatchRunData } from "./recalc";
import { productLabel, productName, type MatchStockProduct } from "./stock";
import { estadoLabel, podriaLlevarText, purchaseText, type MatchEstado } from "./text";

export type MatchViewer = Pick<PortalUser, "id" | "rol">;

/** Filtros de la lista (van en la dirección: parseMatchFilters / matchFiltersQuery). */
export interface MatchFilters {
  /** Ya me compraron (la medida). */
  yaCompraron?: boolean;
  /** Flota con la medida (match directo, sin migraciones ni solo ventas). */
  conFlota?: boolean;
  sinDueno?: boolean;
  mias?: boolean;
  /** Lima y Callao: provincia Lima o Callao si se conoce; si no, departamento Lima o Callao. */
  limaCallao?: boolean;
  departamento?: string;
  /** Índice del corte de tamaño de flota (0: 10 a 29, 1: 30 a 99, 2: 100 o más con los cortes por defecto). */
  tamano?: number;
  /** Incluir Estado y bancos de leasing. */
  incluirExcluidas?: boolean;
}

// Las listas muestran desde match.minPctLista (30%); las que ya compraron la medida salen siempre.

/** Tarjeta de empresa en la lista de un producto. */
export interface MatchCard extends MatchResultView {
  estado: MatchEstado;
  /** Insignia "Ya te compró esta medida" (dato real), o null. */
  compraTexto: string | null;
  /** Etiqueta "Migración posible desde 245/70R17: confirmar con el área técnica", o null. */
  migracionTexto: string | null;
  /** "podría llevar ~24" ("" si no se estima). */
  podriaLlevarTexto: string;
  /** "Crédito observado" / "Crédito rechazado": aviso, no se oculta. */
  avisoCredito: string | null;
  /** "10 a 29 unidades" */
  tamanoTexto: string;
  limaCallao: boolean;
}

export interface MatchProductCard {
  code: string;
  medida: string;
  marca: string;
  modelo: string;
  /** "Fenixway Flama 66" */
  nombre: string;
  /** "295/80R22.5 Fenixway Flama 66" */
  etiqueta: string;
  aplicacion: string | null;
  /** Disponible en Lima (San Luis + Callao − reserva − en pedidos). */
  disponible: number;
  /** Desglose (se ve al tocar el detalle). */
  almacenes: Record<string, number>;
  reserva: number;
  enPedidos: number;
  /** Empresas que hacen match (visibles para quien mira, sin excluidas) y cuántas ya compraron la medida. */
  empresas: number;
  yaCompraron: number;
  /** Aviso para el vendedor si el padrón no permite inferir la medida (lista basada en ventas reales). */
  notas: string[];
}

export interface MatchOverview {
  /** "636 llantas prioritarias · N empresas" */
  totalLlantas: number;
  empresas: number;
  productos: MatchProductCard[];
  calculadoAt: Date | null;
  /** No hay cálculo todavía o no hay productos prioritarios con stock: qué hacer. */
  vacio: string | null;
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .trim();

/** Cortes de tamaño: [10, 30, 100] -> ["10 a 29", "30 a 99", "100 o más"]. */
export function sizeBuckets(cortes: number[]): { min: number; max: number | null; label: string }[] {
  const c = [...cortes].sort((a, b) => a - b);
  return c.map((min, i) => {
    const max = i + 1 < c.length ? c[i + 1] - 1 : null;
    return { min, max, label: max === null ? `${min} o más` : `${min} a ${max}` };
  });
}

export function sizeBucketOf(unidades: number, cortes: number[]): number | null {
  const b = sizeBuckets(cortes);
  for (let i = b.length - 1; i >= 0; i--) if (unidades >= b[i].min) return i;
  return null;
}

export function isLimaCallao(r: { departamento: string | null; provincia: string | null }): boolean {
  if (r.provincia) return ["LIMA", "CALLAO"].includes(fold(r.provincia));
  return !!r.departamento && ["LIMA", "CALLAO"].includes(fold(r.departamento));
}

/** ¿Lo ve quien mira? (empresas de otro vendedor: no, para un vendedor). */
export function visibleTo(r: Pick<MatchResultSummary, "ownerUserId">, viewer: MatchViewer): boolean {
  if (viewer.rol === "supervisor" || viewer.rol === "admin") return true;
  return r.ownerUserId === null || r.ownerUserId === viewer.id;
}

export function creditWarning(estado: CreditEstado | null): string | null {
  if (estado === "observado") return "⚠️ Crédito observado: confirma condiciones antes de ofrecer";
  if (estado === "rechazado") return "⛔ Crédito rechazado: solo al contado";
  return null;
}

export function applyFilters<T extends MatchResultSummary>(rows: T[], f: MatchFilters, viewer: MatchViewer, cfg: Pick<MatchConfig, "cortesFlota" | "minPctLista">): T[] {
  return rows.filter((r) => {
    if (!visibleTo(r, viewer)) return false;
    if (r.pct !== null && r.pct < cfg.minPctLista && !r.yaCompro) return false;
    if (!f.incluirExcluidas && r.excluida) return false;
    if (f.yaCompraron && !r.yaCompro) return false;
    if (f.conFlota && !(r.tipo === "directo" && r.unidadesMedida > 0)) return false;
    if (f.sinDueno && r.ownerUserId !== null) return false;
    if (f.mias && r.ownerUserId !== viewer.id) return false;
    if (f.limaCallao && !isLimaCallao(r)) return false;
    if (f.departamento && fold(r.departamento ?? "") !== fold(f.departamento)) return false;
    if (f.tamano !== undefined && sizeBucketOf(r.unidades, cfg.cortesFlota) !== f.tamano) return false;
    return true;
  });
}

/** Mayor porcentaje primero; empate: más llantas en piso, luego lo que podría llevar (sin flota: su última compra); razón social. */
export function byMatch(a: MatchResultSummary, b: MatchResultSummary): number {
  return (b.pct ?? -1) - (a.pct ?? -1) || b.llantasMedida - a.llantasMedida || (b.podriaLlevar ?? 0) - (a.podriaLlevar ?? 0) || a.razonSocial.localeCompare(b.razonSocial);
}

export function toCard(r: MatchResultView, viewer: MatchViewer, cfg: Pick<MatchConfig, "cortesFlota">, now: Date = new Date()): MatchCard {
  const b = sizeBucketOf(r.unidades, cfg.cortesFlota);
  const buckets = sizeBuckets(cfg.cortesFlota);
  return {
    ...r,
    estado: estadoLabel(r, viewer.id),
    compraTexto: r.detalle.compra ? purchaseText(r.detalle.compra, now) : null,
    migracionTexto: r.detalle.etiquetaMigracion ?? null,
    podriaLlevarTexto: podriaLlevarText(r.podriaLlevar),
    avisoCredito: creditWarning(r.credito),
    tamanoTexto: r.companyId === null ? "" : b === null ? `${r.unidades} unidades` : `${buckets[b].label} unidades`,
    limaCallao: isLimaCallao(r),
  };
}

function runData(run: MatchRun | null): MatchRunData | null {
  return run ? (run.data as unknown as MatchRunData) : null;
}

type PriorityStock = MatchStockProduct & { aplicacion: string | null };

/** Productos prioritarios con stock (de la foto del último cálculo, o el stock vivo si se pasa). */
async function priorityStock(store: PortalStore, run: MatchRun | null, live?: MatchStockProduct[] | null): Promise<PriorityStock[]> {
  const products = await store.listMatchProducts();
  const on = new Map(products.filter((p) => p.prioridad).map((p) => [p.code, p]));
  const stock = live ?? runData(run)?.stock ?? [];
  return stock.filter((s) => on.has(s.code) && s.available > 0).map((s) => ({ ...s, aplicacion: on.get(s.code)!.aplicacion }));
}

function productCard(s: PriorityStock, rows: MatchResultSummary[], notas: Record<string, string[]>): MatchProductCard {
  const mine = rows.filter((r) => r.productCode === s.code);
  return {
    code: s.code,
    medida: s.sizeDisplay,
    marca: s.brand,
    modelo: s.model,
    nombre: productName(s),
    etiqueta: productLabel(s),
    aplicacion: s.aplicacion,
    disponible: s.available,
    almacenes: s.warehouses,
    reserva: s.reserved,
    enPedidos: s.committed,
    empresas: mine.length,
    yaCompraron: mine.filter((r) => r.yaCompro).length,
    notas: notas[s.code] ?? [],
  };
}

/** Las filas completas (con detalle) de unas filas resumidas, en el mismo orden. */
async function withDetail(store: PortalStore, rows: MatchResultSummary[]): Promise<MatchResultView[]> {
  if (!rows.length) return [];
  const full = new Map((await store.listMatchResults({ ids: rows.map((r) => r.id) })).map((r) => [r.id, r]));
  return rows.map((r) => full.get(r.id)).filter((r): r is MatchResultView => !!r);
}

export interface MatchPage {
  /** Filas por página (por defecto 50). */
  limit?: number;
  offset?: number;
}

/** Vista 1 — "¿Qué tengo que vender?": una tarjeta por producto prioritario, ordenadas por disponible. */
export async function matchOverview(store: PortalStore, viewer: MatchViewer, opts: { cfg?: MatchConfig; liveStock?: MatchStockProduct[] | null } = {}): Promise<MatchOverview> {
  const cfg = opts.cfg ?? loadPortalConfig().match;
  const run = await store.latestMatchRun();
  const stock = await priorityStock(store, run, opts.liveStock);
  const rows = stock.length ? applyFilters(await store.listMatchSummaries({ productCodes: stock.map((s) => s.code), minPct: cfg.minPctLista }), {}, viewer, cfg) : [];
  const notas = runData(run)?.notas ?? {};
  const productos = stock.map((s) => productCard(s, rows, notas)).sort((a, b) => b.disponible - a.disponible || a.code.localeCompare(b.code));
  const companies = new Set(rows.map((r) => String(r.companyId ?? r.ruc)));
  const vacio = !run ? "Aún no se calculó Match Venta: carga el stock o pide al administrador que lo recalcule." : !productos.length ? "No hay llantas prioritarias con stock. Marca un producto como prioridad para ver a quién ofrecérselo." : null;
  return { totalLlantas: productos.reduce((n, p) => n + p.disponible, 0), empresas: companies.size, productos, calculadoAt: run?.runAt ?? null, vacio };
}

export interface ProductMatches {
  product: MatchProductCard | null;
  /** Directos y migraciones, ordenadas (la página pedida). */
  empresas: MatchCard[];
  /** Total de empresas con los filtros (todas las páginas). */
  total: number;
  /** "Clientes que ya compraron esta medida" (no están en el padrón; sin porcentaje). Siempre completas. */
  soloVentas: MatchCard[];
  /** Cuántas quedaron fuera por los filtros (para el estado vacío). */
  ocultasPorFiltro: number;
  /** Estado vacío con explicación y siguiente paso (null si hay algo que mostrar). */
  vacio: string | null;
  notas: string[];
}

/** Vista 2 — "¿A quién se la ofrezco?": empresas de un producto con los filtros, por páginas (50 por defecto). */
export async function matchesForProduct(
  store: PortalStore,
  viewer: MatchViewer,
  code: string,
  filters: MatchFilters = {},
  opts: { cfg?: MatchConfig; liveStock?: MatchStockProduct[] | null; now?: Date } & MatchPage = {},
): Promise<ProductMatches> {
  const cfg = opts.cfg ?? loadPortalConfig().match;
  const run = await store.latestMatchRun();
  const stock = await priorityStock(store, run, opts.liveStock);
  const want = code.replace(/\s+/g, "").toUpperCase();
  const st = stock.find((s) => s.code === want);
  if (!st) {
    const vacio = !run ? "Aún no se calculó Match Venta: carga el stock o pide al administrador que lo recalcule." : "Ese producto no es prioritario o ya no tiene stock. Vuelve a la lista de productos prioritarios.";
    return { product: null, empresas: [], total: 0, soloVentas: [], ocultasPorFiltro: 0, vacio, notas: [] };
  }
  const all = await store.listMatchSummaries({ productCodes: [st.code], minPct: cfg.minPctLista });
  const product = productCard(st, applyFilters(all, {}, viewer, cfg), runData(run)?.notas ?? {});
  const base = applyFilters(all, { incluirExcluidas: filters.incluirExcluidas }, viewer, cfg);
  const rows = applyFilters(all, filters, viewer, cfg).sort(byMatch);
  const companies = rows.filter((r) => r.tipo !== "solo_ventas");
  const offset = Math.max(0, opts.offset ?? 0);
  const page = companies.slice(offset, offset + Math.max(1, opts.limit ?? 50));
  const [pageFull, soloFull] = [await withDetail(store, page), await withDetail(store, rows.filter((r) => r.tipo === "solo_ventas"))];
  const empresas = pageFull.map((r) => toCard(r, viewer, cfg, opts.now));
  const soloVentas = soloFull.map((r) => toCard(r, viewer, cfg, opts.now));
  const ocultas = base.length - rows.length;
  let vacio: string | null = null;
  if (!empresas.length && !soloVentas.length) {
    vacio = ocultas
      ? `Ninguna empresa cumple los filtros (${ocultas} quedan fuera). Quita algún filtro para verlas.`
      : product.notas[0] ?? "Ninguna empresa del padrón usa esta medida y nadie te la ha comprado todavía. Prueba con otro producto o revisa si hay flotas que podrían migrar.";
  }
  return { product, empresas, total: companies.length, soloVentas, ocultasPorFiltro: ocultas, vacio, notas: product.notas };
}

/** Una empresa con todos sus matches (vista general y ficha). */
export interface CompanyMatches {
  companyId: number;
  ruc: string;
  razonSocial: string;
  /** Orden: mayor porcentaje + bonus por cada match adicional (tope 100). */
  orden: number;
  matches: MatchCard[];
  estado: MatchEstado;
  avisoCredito: string | null;
}

/** "Ver por empresa": cada empresa una sola vez con todos sus matches, por páginas (50 por defecto). `total` = todas. */
export async function matchesByCompany(
  store: PortalStore,
  viewer: MatchViewer,
  filters: MatchFilters = {},
  opts: { cfg?: MatchConfig; liveStock?: MatchStockProduct[] | null; now?: Date } & MatchPage = {},
): Promise<CompanyMatches[] & { total?: number }> {
  const cfg = opts.cfg ?? loadPortalConfig().match;
  const run = await store.latestMatchRun();
  const stock = await priorityStock(store, run, opts.liveStock);
  if (!stock.length) return Object.assign([], { total: 0 });
  const rows = applyFilters(await store.listMatchSummaries({ productCodes: stock.map((s) => s.code), tipos: ["directo", "migracion"], minPct: cfg.minPctLista }), filters, viewer, cfg);
  const by = new Map<number, MatchResultSummary[]>();
  for (const r of rows) {
    if (r.companyId === null) continue;
    const list = by.get(r.companyId);
    if (list) list.push(r);
    else by.set(r.companyId, [r]);
  }
  const groups = [...by].map(([companyId, list]) => {
    list.sort(byMatch);
    return { companyId, list, orden: Math.min(100, (list[0].pct ?? 0) + cfg.bonusPorMatchExtra * (new Set(list.map((r) => r.productCode)).size - 1)) };
  });
  groups.sort((a, b) => b.orden - a.orden || b.list[0].llantasMedida - a.list[0].llantasMedida || a.list[0].razonSocial.localeCompare(b.list[0].razonSocial));
  const offset = Math.max(0, opts.offset ?? 0);
  const page = groups.slice(offset, offset + Math.max(1, opts.limit ?? 50));
  const full = new Map((await withDetail(store, page.flatMap((g) => g.list))).map((r) => [r.id, r]));
  const out = page.map((g) => {
    const cards = g.list.map((r) => toCard(full.get(r.id)!, viewer, cfg, opts.now));
    return { companyId: g.companyId, ruc: g.list[0].ruc, razonSocial: g.list[0].razonSocial, orden: g.orden, matches: cards, estado: cards[0].estado, avisoCredito: cards[0].avisoCredito };
  });
  return Object.assign(out, { total: groups.length });
}

/** Ficha de empresa: bloque "Match con tu stock" (productos prioritarios que le sirven y por qué). */
export async function companyMatchBlock(store: PortalStore, viewer: MatchViewer, companyId: number, opts: { cfg?: MatchConfig; now?: Date } = {}): Promise<MatchCard[]> {
  const cfg = opts.cfg ?? loadPortalConfig().match;
  const run = await store.latestMatchRun();
  const stock = await priorityStock(store, run);
  const codes = new Set(stock.map((s) => s.code));
  const rows = applyFilters(await store.listMatchResults({ companyIds: [companyId], minPct: cfg.minPctLista }), { incluirExcluidas: true }, viewer, cfg).filter((r) => codes.has(r.productCode));
  return (rows as MatchResultView[]).sort(byMatch).map((r) => toCard(r, viewer, cfg, opts.now));
}

/** Hoy: "Tienes 636 llantas prioritarias: N empresas sin contactar hacen match" (null si no hay prioridades). */
export async function todayMatchLine(store: PortalStore, viewer: MatchViewer, opts: { cfg?: MatchConfig } = {}): Promise<{ text: string; llantas: number; empresasSinContactar: number } | null> {
  const cfg = opts.cfg ?? loadPortalConfig().match;
  const run = await store.latestMatchRun();
  const stock = await priorityStock(store, run);
  if (!stock.length) return null;
  const rows = applyFilters(await store.listMatchSummaries({ productCodes: stock.map((s) => s.code), tipos: ["directo", "migracion"], minPct: cfg.minPctLista }), {}, viewer, cfg);
  const sinContactar = new Set(rows.filter((r) => r.companyId !== null && r.lastActivityAt === null).map((r) => r.companyId));
  const llantas = stock.reduce((n, s) => n + s.available, 0);
  return { text: `Tienes ${llantas.toLocaleString("es-PE")} llantas prioritarias: ${sinContactar.size.toLocaleString("es-PE")} empresas sin contactar hacen match`, llantas, empresasSinContactar: sinContactar.size };
}

// ── filtros en la dirección ──

const FLAG_KEYS: [keyof MatchFilters, string][] = [
  ["yaCompraron", "compraron"],
  ["conFlota", "flota"],
  ["sinDueno", "sindueno"],
  ["mias", "mias"],
  ["limaCallao", "lima"],
  ["incluirExcluidas", "todas"],
];

/** ?compraron=1&flota=1&sindueno=1&mias=1&lima=1&dep=AREQUIPA&tam=1&todas=1 -> filtros. */
export function parseMatchFilters(params: URLSearchParams | Record<string, string | string[] | undefined>): MatchFilters {
  const get = (k: string): string | undefined => {
    if (params instanceof URLSearchParams) return params.get(k) ?? undefined;
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const f: MatchFilters = {};
  for (const [key, q] of FLAG_KEYS) if (get(q) === "1") (f as Record<string, unknown>)[key] = true;
  const dep = get("dep");
  if (dep) f.departamento = dep;
  const tam = get("tam");
  if (tam !== undefined && /^\d$/.test(tam)) f.tamano = Number(tam);
  return f;
}

export function matchFiltersQuery(f: MatchFilters): string {
  const p = new URLSearchParams();
  for (const [key, q] of FLAG_KEYS) if (f[key]) p.set(q, "1");
  if (f.departamento) p.set("dep", f.departamento);
  if (f.tamano !== undefined) p.set("tam", String(f.tamano));
  return p.toString();
}
