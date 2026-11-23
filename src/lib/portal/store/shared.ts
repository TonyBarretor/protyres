/**
 * Utilidades comunes a las dos implementaciones de PortalStore (mismo comportamiento en Postgres y JSON).
 */
import type { Confianza, FleetGroup, IsoDate } from "./types";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

export const digits = (s: string | null | undefined): string => (s ?? "").replace(/\D/g, "");

/** Corrida K: código de producto de Odoo comparable ("p0433 " -> "P0433"). */
export const matchCode = (s: string): string => s.replace(/\s+/g, "").toUpperCase();

/** Correo de un usuario: recortado y en minúsculas; vacío o sin forma de correo -> null. */
export function normEmail(s: string | null | undefined): string | null {
  const t = (s ?? "").trim().toLowerCase();
  return /^[^\s@"<>:;,\\]+@[^\s@"<>:;,\\]+\.[^\s@"<>:;,\\]+$/.test(t) ? t : null;
}

/** Minúsculas y sin tildes, para buscar por razón social. */
export function foldText(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

/**
 * Clave de búsqueda de una razón social (corrida F): foldText y sin espacios ni signos, "Z-BUSS S.A.C." -> "zbusssac".
 * En Postgres es la columna generada companies.razon_norm (misma regla: src/cli/migrate.ts).
 */
export function companyNameKey(s: string | null | undefined): string {
  return foldText(s).replace(/[^a-z0-9]+/g, "");
}

/**
 * Texto buscado -> palabras (cada una con companyNameKey) y todas juntas. Una empresa coincide si su clave contiene
 * todas las palabras o el texto junto: "z buss", "zbuss" y "Z-Buss" encuentran "ZBUSS E.I.R.L." y "Z BUSS S.A.C.".
 * Una letra suelta va pegada a la palabra siguiente (o a la anterior si es la última): sola coincidiría con casi todo
 * ("z" + "buss" encontraba "BUS SERVICE AUTOMOTRIZ").
 */
export function searchTerms(q: string | null | undefined): { compact: string; words: string[] } {
  const tokens = foldText(q)
    .split(/\s+/)
    .map(companyNameKey)
    .filter(Boolean);
  const words: string[] = [];
  let pending = "";
  for (const t of tokens) {
    const w = pending + t;
    if (w.length === 1) pending = w;
    else {
      words.push(w);
      pending = "";
    }
  }
  if (pending) {
    if (words.length) words[words.length - 1] += pending;
    else words.push(pending);
  }
  return { compact: tokens.join(""), words: [...new Set(words)] };
}

/** RUC buscado: solo dígitos (se aceptan espacios, puntos y guiones entre ellos); "" si el texto no es un número. */
export function searchRucPrefix(q: string | null | undefined): string {
  const t = (q ?? "").trim();
  return /^[\d][\d\s.\-]*$/.test(t) ? digits(t) : "";
}

/** true si la clave de la razón social coincide con el texto buscado (ver searchTerms). */
export function nameMatches(nameKey: string, terms: { compact: string; words: string[] }): boolean {
  if (!terms.compact) return true;
  return nameKey.includes(terms.compact) || terms.words.every((w) => nameKey.includes(w));
}

/** Medidas probables más frecuentes de una flota (de más a menos unidades; empate: orden alfabético). */
export function topMedidas(counts: Map<string, number>, limit = 3): { medida: string; unidades: number }[] {
  return [...counts.entries()]
    .map(([medida, unidades]) => ({ medida, unidades }))
    .sort((a, b) => b.unidades - a.unidades || a.medida.localeCompare(b.medida))
    .slice(0, limit);
}

/** Marca de vehículo comparable: mayúsculas, sin espacios sobrantes. */
export function normMarca(s: string | null | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

/** Date | "AAAA-MM-DD..." -> "AAAA-MM-DD" (fecha UTC). */
export function toIsoDate(d: Date | IsoDate): IsoDate {
  if (typeof d === "string") return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** Inicio de la ventana de participación: 12 meses antes de `now`. */
export function defaultSince(now: Date = new Date()): IsoDate {
  const d = new Date(now.getTime());
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return toIsoDate(d);
}

export function pageOf(page: number | undefined, pageSize: number | undefined): { page: number; pageSize: number; offset: number } {
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize ?? DEFAULT_PAGE_SIZE)));
  const p = Math.max(1, Math.floor(page ?? 1));
  return { page: p, pageSize: size, offset: (p - 1) * size };
}

const CONF_RANK: Record<string, number> = { alta: 3, media: 2, baja: 1 };

/** Fila agregada por (marca, clase, medida, confianza): la producen los dos stores y la reduce `groupFleet`. */
export interface FleetAggRow {
  marca: string | null;
  clase: string | null;
  medida: string | null;
  confianza: Confianza | null;
  unidades: number;
  anioMin: number | null;
  anioMax: number | null;
  llantas: number;
  unidadesConLlantas: number;
}

/**
 * Agrupa por marca y clase. Medida probable = la más frecuente entre las unidades con medida (empate: mayor confianza,
 * luego orden alfabético); su confianza = la más frecuente para esa medida (empate: la más alta).
 * Orden: más unidades primero, luego marca y clase.
 */
export function groupFleet(rows: FleetAggRow[]): FleetGroup[] {
  const groups = new Map<string, { g: FleetGroup; medidas: Map<string, Map<string, number>> }>();
  for (const r of rows) {
    const key = `${r.marca ?? ""}\u0000${r.clase ?? ""}`;
    let entry = groups.get(key);
    if (!entry) {
      entry = { g: { marca: r.marca, clase: r.clase, anioMin: null, anioMax: null, unidades: 0, llantas: 0, unidadesConLlantas: 0, medidaProbable: null, confianza: null }, medidas: new Map() };
      groups.set(key, entry);
    }
    const g = entry.g;
    g.unidades += r.unidades;
    g.llantas += r.llantas;
    g.unidadesConLlantas += r.unidadesConLlantas;
    if (r.anioMin !== null) g.anioMin = g.anioMin === null ? r.anioMin : Math.min(g.anioMin, r.anioMin);
    if (r.anioMax !== null) g.anioMax = g.anioMax === null ? r.anioMax : Math.max(g.anioMax, r.anioMax);
    if (r.medida) {
      const byConf = entry.medidas.get(r.medida) ?? new Map<string, number>();
      byConf.set(r.confianza ?? "", (byConf.get(r.confianza ?? "") ?? 0) + r.unidades);
      entry.medidas.set(r.medida, byConf);
    }
  }
  const out: FleetGroup[] = [];
  for (const { g, medidas } of groups.values()) {
    let best: { medida: string; total: number; conf: string; confCount: number } | null = null;
    for (const [medida, byConf] of medidas) {
      let total = 0;
      let conf = "";
      let confCount = -1;
      for (const [c, n] of byConf) {
        total += n;
        if (n > confCount || (n === confCount && (CONF_RANK[c] ?? 0) > (CONF_RANK[conf] ?? 0))) {
          conf = c;
          confCount = n;
        }
      }
      const better =
        !best ||
        total > best.total ||
        (total === best.total && (CONF_RANK[conf] ?? 0) > (CONF_RANK[best.conf] ?? 0)) ||
        (total === best.total && (CONF_RANK[conf] ?? 0) === (CONF_RANK[best.conf] ?? 0) && medida < best.medida);
      if (better) best = { medida, total, conf, confCount };
    }
    if (best) {
      g.medidaProbable = best.medida;
      g.confianza = (best.conf || null) as Confianza | null;
    }
    out.push(g);
  }
  out.sort((a, b) => b.unidades - a.unidades || (a.marca ?? "").localeCompare(b.marca ?? "") || (a.clase ?? "").localeCompare(b.clase ?? ""));
  return out;
}

/** Último gana: evita "ON CONFLICT ... cannot affect row a second time" y deja el mismo resultado en JSON. */
export function dedupeBy<T>(rows: T[], key: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(key(r), r);
  return [...m.values()];
}

/**
 * Valor calculado que se reutiliza durante `ttlMs` (por instancia). Las peticiones simultáneas comparten la misma
 * promesa; un fallo no se guarda. Lo usa PgPortalStore para listas que solo cambian con el import del MTC.
 */
export function ttlCache<T>(load: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T> {
  let entry: { at: number; value: Promise<T> } | null = null;
  return () => {
    const t = now();
    if (entry && t - entry.at <= ttlMs) return entry.value;
    const value = load();
    const mine = { at: t, value };
    entry = mine;
    value.catch(() => {
      if (entry === mine) entry = null;
    });
    return value;
  };
}

// ── ventas-odoo: a quién y cuánto cuenta una línea de venta (misma regla en Postgres: pg-portal-store.ts, SALE_RUC / SALE_UNITS) ──

type SaleLike = { ruc: string; cantidad: number; detalle?: { cuentaUnidades: boolean; excluida: boolean; clienteFinalRuc?: string | null } | null };

/** RUC al que cuenta la línea: el del cliente final (leasing) si se asignó; si no, el del documento. */
export function saleCountRuc(s: SaleLike): string {
  return s.detalle?.clienteFinalRuc || s.ruc;
}

/** true si la línea suma neumáticos (las ventas del formato simple y las demo siempre suman). */
export function saleCountsUnits(s: SaleLike): boolean {
  return !s.detalle || s.detalle.cuentaUnidades;
}

/** Neumáticos que suma la línea (negativo en una nota de crédito; 0 si no cuenta). */
export function saleUnits(s: SaleLike): number {
  return saleCountsUnits(s) ? s.cantidad : 0;
}

/** false si la línea está excluida (venta anulada según ESTADO SUNAT / TIPO DOC): no cuenta en nada. */
export function saleActive(s: SaleLike): boolean {
  return !s.detalle?.excluida;
}

/** N° de documento comparable: "F003-4050", "f003 4050" y "F003-04050" son el mismo (mayúsculas, sin espacios, sin ceros a la izquierda del correlativo). */
export function normDocumento(s: string | null | undefined): string {
  return (s ?? "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/-0+(?=\d)/, "-");
}

/** Tipo de documento del cliente por su número: 11 dígitos RUC, 8 DNI, otro largo "otro". */
export function docClienteOf(doc: string): "ruc" | "dni" | "otro" {
  const n = digits(doc).length;
  return n === 11 ? "ruc" : n === 8 ? "dni" : "otro";
}

// ── Corrida J, punto 5: pantalla general de ventas (la misma regla en Postgres: pg-portal-store.ts, SALES_HAYSTACK_SQL) ──

/** Letras con tilde que se pliegan al buscar (translate() de Postgres usa las mismas dos listas). */
export const SALES_FOLD_FROM = "áàäâãéèëêíìïîóòöôõúùüûñç";
export const SALES_FOLD_TO = "aaaaaeeeeiiiiooooouuuunc";
const FOLD_MAP = new Map([...SALES_FOLD_FROM].map((c, i) => [c, SALES_FOLD_TO[i]]));

/** btrim() de Postgres: quita solo espacios al inicio y al final (trim() de JS quita también saltos de línea). */
export const btrim = (s: string): string => s.replace(/^ +| +$/g, "");

/** lower() + translate() como en Postgres: el texto donde se busca y las palabras buscadas pasan por aquí. */
export function salesFold(s: string): string {
  return [...s.toLowerCase()].map((c) => FOLD_MAP.get(c) ?? c).join("");
}

/**
 * Palabras del texto libre de la pantalla de ventas, plegadas y sin comodines de LIKE (% _ \). Cada una va con su forma de
 * N° de documento (sin ceros a la izquierda del correlativo: "f003-0100" → "f003-100"), que también vale. Máximo 8.
 */
export function salesSearchWords(q: string | null | undefined): { word: string; doc: string }[] {
  return salesFold(q ?? "")
    .replace(/[%_\\]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((word) => ({ word, doc: salesFold(normDocumento(word)) }));
}

/**
 * Texto donde busca la pantalla de ventas (mismo orden que SALES_HAYSTACK_SQL; los nulos no entran, como concat_ws):
 * razón social, RUC, RUC del cliente final, razón social del cliente final (padrón), documento tal cual y normalizado,
 * descripción, marca, diseño, medida y código del producto.
 */
export function salesHaystack(s: { ruc: string; razonSocial: string | null; marca: string | null; diseno: string | null; medida: string | null; detalle: { documento: string; descripcion: string; codigoProducto: string | null; clienteFinalRuc: string | null } | null }, clienteFinalNombre: string | null): string {
  const d = s.detalle;
  const parts = [s.razonSocial, s.ruc, d?.clienteFinalRuc ?? null, clienteFinalNombre, d?.documento ?? null, d ? normDocumento(d.documento) : "", d?.descripcion ?? null, s.marca, s.diseno, s.medida, d?.codigoProducto ?? null];
  return salesFold(parts.filter((p): p is string => p !== null).join(" "));
}

/** Montos en diezmilésimos (entero): las sumas del store JSON dan exactamente lo mismo que las de numeric en Postgres. */
export const toTenThousandths = (n: number | null | undefined): number => (n === null || n === undefined ? 0 : Math.round(n * 10_000));

/** Diezmilésimos → número con 2 decimales. */
export const fromTenThousandths = (n: number): number => Math.round(n / 100) / 100;

type SaleMoneyLike = SaleLike & {
  total: number | null;
  precioUnitario: number | null;
  detalle?: { cuentaUnidades: boolean; excluida: boolean; tipoDoc: string; totalUsd: number | null; costoTotal: number | null; margenPct: number | null } | null;
};

/** Venta en soles de una línea en diezmilésimos: `total` o, si falta, precio × cantidad (redondeado a 2 decimales). */
export function saleSolesTT(s: SaleMoneyLike): number {
  if (s.total !== null) return toTenThousandths(s.total);
  if (s.precioUnitario !== null) return Math.round(s.precioUnitario * s.cantidad * 100) * 100;
  return 0;
}

/** true si la línea entra en el margen ponderado: margen numérico en el reporte, o nota de crédito (ver SalesListSummary). */
export function saleInMargin(s: SaleMoneyLike): boolean {
  return !!s.detalle && (s.detalle.margenPct !== null || s.detalle.tipoDoc === "nota_credito");
}

/** Sumas de la pantalla de ventas (en diezmilésimos los montos). Misma cuenta que SALES_TOTALS_SQL en Postgres. */
export function salesTotals(lines: SaleMoneyLike[]): { lineas: number; neumaticos: number; pen: number; usd: number; mVenta: number; mCosto: number; nc: number; ncPen: number } {
  const t = { lineas: 0, neumaticos: 0, pen: 0, usd: 0, mVenta: 0, mCosto: 0, nc: 0, ncPen: 0 };
  let units = 0;
  for (const s of lines) {
    const pen = saleSolesTT(s);
    t.lineas++;
    units += toTenThousandths(saleUnits(s));
    t.pen += pen;
    t.usd += toTenThousandths(s.detalle?.totalUsd);
    if (saleInMargin(s)) {
      t.mVenta += pen;
      t.mCosto += toTenThousandths(s.detalle?.costoTotal);
    }
    if (s.detalle?.tipoDoc === "nota_credito") {
      t.nc++;
      t.ncPen += pen;
    }
  }
  t.neumaticos = units / 10_000;
  return t;
}

/** Margen ponderado en % (2 decimales) a partir de las sumas de venta y costo (en diezmilésimos); null si la venta no es positiva. */
export function weightedMarginPct(venta: number, costo: number): number | null {
  if (venta <= 0) return null;
  return Math.round(((venta - costo) / venta) * 10_000) / 100;
}
