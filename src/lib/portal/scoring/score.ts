/**
 * Corrida G — puntaje de atractivo de una flota (0–100): suma ponderada de seis factores normalizados de 0 a 1 (pesos y
 * parámetros en config/portal.json, clave `scoring`). Puro: sin store ni Next.
 *
 *   potencial     llantas en piso, en escala logarítmica (las flotas gigantes no aplastan al resto)
 *   encaje        parte de las unidades cuya medida probable está en el catálogo; vale más si hay stock propio
 *   espacio       1 si no es cliente; si lo es, 1 − vendidos en 12 meses / consumo anual estimado (ventas demo no cuentan)
 *   familiaridad  parte de las unidades de las marcas de vehículo preferidas
 *   cercania      tabla por departamento (Lima y Callao 1)
 *   antiguedad    antigüedad media de la flota, lineal entre `mejor` (1) y `peor` (0)
 *
 * Si falta un dato, el factor vale 0 y queda `sinDato` (la explicación lo dice). Niveles: A/B/C por percentil del
 * puntaje (assignLevels); los frenos no restan puntos, limitan el nivel (applyBrakes).
 */
import type { PriceRow } from "../../ingest/types";
import { normMarca } from "../store/shared";
import type { Nivel, ScoreBrake, ScoreDetail, ScoreFactor, ScoreFactorId, ScoreInput } from "../store/types";
import { FACTOR_IDS, type ScoringConfig } from "./config";

/** Medidas del catálogo en tres grados (canónicas, "295/80R22.5"). */
export interface CatalogSizes {
  /** Stock propio de al menos `minStock` unidades. */
  stock: Set<string>;
  /** Lista propia o stock propio (aunque sin stock suficiente). */
  propio: Set<string>;
  /** Listas de proveedores. */
  proveedor: Set<string>;
}

export const EMPTY_CATALOG: CatalogSizes = { stock: new Set(), propio: new Set(), proveedor: new Set() };

/** Catálogo a partir de las filas de precios del cotizador (lista propia "own", stock de Odoo "stock", proveedores). */
export function catalogSizesFromRows(rows: Pick<PriceRow, "size" | "kind" | "stock" | "isTyre">[], minStock: number): CatalogSizes {
  const stockBySize = new Map<string, number>();
  const out: CatalogSizes = { stock: new Set(), propio: new Set(), proveedor: new Set() };
  for (const r of rows) {
    const size = r.size?.trim();
    if (!r.isTyre || !size) continue;
    if (r.kind === "own" || r.kind === "stock") {
      out.propio.add(size);
      if (r.stock && r.stock > 0) stockBySize.set(size, (stockBySize.get(size) ?? 0) + r.stock);
    } else out.proveedor.add(size);
  }
  for (const [size, n] of stockBySize) if (n >= minStock) out.stock.add(size);
  return out;
}

export type SizeTier = "stock" | "catalogo" | "proveedor" | "no";

export function sizeTier(medida: string, cat: CatalogSizes): SizeTier {
  if (cat.stock.has(medida)) return "stock";
  if (cat.propio.has(medida)) return "catalogo";
  if (cat.proveedor.has(medida)) return "proveedor";
  return "no";
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

function tierValue(t: SizeTier, cfg: ScoringConfig): number {
  return t === "stock" ? cfg.encaje.conStock : t === "catalogo" ? cfg.encaje.enCatalogo : t === "proveedor" ? cfg.encaje.soloProveedor : 0;
}

/** true si se trata como cliente: ventas reales (las demo no cuentan) o marcada como cliente en el portal. */
export function isClient(i: Pick<ScoreInput, "ventasReales" | "esClienteMarcado">): boolean {
  return i.ventasReales || i.esClienteMarcado;
}

type Raw = { valor: number; sinDato: boolean; dato: ScoreFactor["dato"] };

function potencial(i: ScoreInput, cfg: ScoringConfig): Raw {
  const dato = { unidades: i.unidades, llantas: i.llantasPiso, sector: i.sector };
  if (!(i.llantasPiso > 0)) return { valor: 0, sinDato: true, dato };
  return { valor: clamp01(Math.log1p(i.llantasPiso) / Math.log1p(cfg.potencial.llantasRef)), sinDato: false, dato };
}

function encaje(i: ScoreInput, cfg: ScoringConfig, cat: CatalogSizes): Raw {
  const conMedida = Object.values(i.medidas).reduce((a, n) => a + n, 0);
  const total = Math.max(i.unidades, conMedida);
  if (conMedida <= 0 || total <= 0) return { valor: 0, sinDato: true, dato: { unidades: i.unidades } };
  let sum = 0;
  let enCatalogo = 0;
  let top: { medida: string; n: number } | null = null;
  for (const [medida, n] of Object.entries(i.medidas)) {
    const v = tierValue(sizeTier(medida, cat), cfg);
    sum += n * v;
    if (v > 0) enCatalogo += n;
    if (!top || n > top.n || (n === top.n && medida < top.medida)) top = { medida, n };
  }
  return {
    valor: clamp01(sum / total),
    sinDato: false,
    dato: { medida: top!.medida, unidadesMedida: top!.n, unidades: total, nivelMedida: sizeTier(top!.medida, cat), unidadesEnCatalogo: enCatalogo },
  };
}

function espacio(i: ScoreInput, cfg: ScoringConfig): Raw {
  const cliente = isClient(i);
  const consumo = i.llantasPiso * cfg.espacio.consumoAnualPorLlanta;
  const dato = { cliente, soloDemo: !cliente && i.ventasDemo, vendidos12m: i.vendidos12m, consumoAnual: Math.round(consumo) };
  if (!cliente) return { valor: 1, sinDato: false, dato };
  // cliente sin llantas en piso: no hay con qué comparar lo vendido
  if (!(consumo > 0)) return { valor: 0, sinDato: true, dato };
  return { valor: clamp01(1 - i.vendidos12m / consumo), sinDato: false, dato };
}

function familiaridad(i: ScoreInput, cfg: ScoringConfig): Raw {
  if (!(i.unidades > 0)) return { valor: 0, sinDato: true, dato: { unidades: 0 } };
  const prefs = new Set(cfg.familiaridad.marcas.map(normMarca));
  const byName = new Map<string, number>();
  let n = 0;
  for (const [marca, u] of Object.entries(i.marcasPreferidas)) {
    const m = normMarca(marca);
    if (!prefs.has(m) || !(u > 0)) continue;
    n += u;
    const name = cfg.familiaridad.nombres[m] ?? titleCase(m);
    byName.set(name, (byName.get(name) ?? 0) + u);
  }
  const marcas = [...byName.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
  return { valor: clamp01(n / i.unidades), sinDato: false, dato: { unidadesPreferidas: n, unidades: i.unidades, marcas: marcas.slice(0, 3).join(", ") } };
}

function cercania(i: ScoreInput, cfg: ScoringConfig): Raw {
  const dep = i.departamento?.trim().toUpperCase() || null;
  if (!dep) return { valor: 0, sinDato: true, dato: { departamento: null } };
  const v = cfg.cercania.departamentos[dep] ?? cfg.cercania.otros;
  return { valor: clamp01(v), sinDato: false, dato: { departamento: dep } };
}

function antiguedad(i: ScoreInput, cfg: ScoringConfig): Raw {
  const a = i.antiguedadMedia;
  if (a === null || !Number.isFinite(a)) return { valor: 0, sinDato: true, dato: { anios: null } };
  const { mejor, peor } = cfg.antiguedad;
  const valor = mejor === peor ? (a <= mejor ? 1 : 0) : clamp01((peor - a) / (peor - mejor));
  return { valor, sinDato: false, dato: { anios: round(a, 1) } };
}

/** Puntaje (0–100, un decimal) y detalle de una empresa. El nivel lo ponen assignLevels/applyBrakes. */
export function scoreCompany(i: ScoreInput, cfg: ScoringConfig, cat: CatalogSizes, now: Date = new Date()): { score: number; detalle: Omit<ScoreDetail, "nivelBase">; frenos: ScoreBrake[] } {
  const raws: Record<ScoreFactorId, Raw> = {
    potencial: potencial(i, cfg),
    encaje: encaje(i, cfg, cat),
    espacio: espacio(i, cfg),
    familiaridad: familiaridad(i, cfg),
    cercania: cercania(i, cfg),
    antiguedad: antiguedad(i, cfg),
  };
  const totalWeight = FACTOR_IDS.reduce((a, id) => a + cfg.weights[id], 0) || 1;
  const scale = 100 / totalWeight;
  const factores: ScoreFactor[] = FACTOR_IDS.map((id) => {
    const r = raws[id];
    const max = round(cfg.weights[id] * scale, 2);
    return { id, valor: round(r.valor, 3), puntos: round(r.valor * max, 2), max, sinDato: r.sinDato, dato: r.dato };
  });
  const score = round(
    factores.reduce((a, f) => a + f.puntos, 0),
    1,
  );
  return { score: Math.min(100, score), detalle: { v: 1, factores, frenos: [] }, frenos: brakesOf(i, cfg, now) };
}

export function brakesOf(i: Pick<ScoreInput, "credito" | "perdidaAt">, cfg: ScoringConfig, now: Date = new Date()): ScoreBrake[] {
  const out: ScoreBrake[] = [];
  if (i.credito && cfg.frenos.creditoTopeC.includes(i.credito)) out.push({ id: "credito", estado: i.credito });
  if (i.perdidaAt) {
    const dias = Math.max(0, Math.floor((now.getTime() - i.perdidaAt.getTime()) / 86_400_000));
    if (dias <= cfg.frenos.perdidaDias) out.push({ id: "perdida", dias });
  }
  return out;
}

export interface LevelCuts {
  /** Puntaje mínimo de A y de B (null = nadie en ese nivel). */
  cutA: number | null;
  cutB: number | null;
}

/**
 * Cortes por percentil: A = el `niveles.a` superior del ranking, B = el `niveles.b` siguiente, C = el resto. Un empate en
 * el corte queda en el nivel más alto (misma puntuación, mismo nivel).
 */
export function levelCuts(scores: number[], cfg: ScoringConfig): LevelCuts {
  const sorted = [...scores].filter(Number.isFinite).sort((a, b) => b - a);
  const n = sorted.length;
  if (!n) return { cutA: null, cutB: null };
  const nA = Math.max(1, Math.round(n * cfg.niveles.a));
  const nB = Math.round(n * (cfg.niveles.a + cfg.niveles.b));
  return { cutA: sorted[nA - 1], cutB: nB > nA ? sorted[Math.min(n, nB) - 1] : null };
}

export function levelFor(score: number, cuts: LevelCuts): Nivel {
  if (cuts.cutA !== null && score >= cuts.cutA) return "A";
  if (cuts.cutB !== null && score >= cuts.cutB) return "B";
  return "C";
}

const DOWN: Record<Nivel, Nivel> = { A: "B", B: "C", C: "C" };

/** Frenos: crédito observado/rechazado deja el nivel en C como máximo; una oportunidad perdida reciente baja un nivel. */
export function applyBrakes(base: Nivel, frenos: ScoreBrake[]): Nivel {
  let n = base;
  if (frenos.some((f) => f.id === "perdida")) n = DOWN[n];
  if (frenos.some((f) => f.id === "credito")) n = "C";
  return n;
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
}

