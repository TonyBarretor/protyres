/**
 * Corrida G, punto 6 — validación del ranking con el vendedor. El puntaje no se da por bueno hasta compararlo con el
 * criterio de quien vende.
 *
 *   pickValidationSample  20 empresas para /portal/validar-ranking: mezcla de niveles (config `scoring.validacion`), con
 *                         preferencia por las que el vendedor ya tiene asignadas o a las que les vendió; nunca una que ya
 *                         validó; en orden aleatorio. La pantalla no muestra puntaje ni nivel.
 *   compareValidations    coincidencia de nivel (sin contar "No la conozco"), en cuáles difiere más y las notas.
 *   formatValidationReport  el texto de `npm run score:validation-report`.
 */
import { vendorMatcher } from "../dashboard/vendors";
import { toIsoDate } from "../store/shared";
import type { Company, Nivel, PortalStore, PortalUser, RankingValidation } from "../store/types";
import type { ScoringConfig } from "./config";

export type Rng = () => number;

const NIVELES: Nivel[] = ["A", "B", "C"];

export function shuffle<T>(xs: readonly T[], rng: Rng): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Generador con semilla (mulberry32): misma semilla, misma muestra (pruebas y recargar la página el mismo día). */
export function seededRng(seed: number): Rng {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Semilla por usuario y día de Lima: la muestra no cambia al recargar, sí al día siguiente o tras responder. */
export function dailySeed(userId: number, now: Date, salt = 0): number {
  const day = toIsoDate(new Date(now.getTime() - 5 * 3600_000)).replace(/-/g, "");
  return (Number(day) * 31 + userId * 1009 + salt) >>> 0;
}

/** Empresas "conocidas" por el vendedor: asignadas a él o con ventas reales (no demo) suyas en los últimos 2 años. */
async function knownCompanies(store: PortalStore, user: PortalUser, now: Date): Promise<Company[]> {
  const own = await store.searchCompanies({ ownerUserId: user.id, orderBy: "atractivo", pageSize: 200 });
  const users = await store.listUsers();
  const match = vendorMatcher(users);
  const since = new Date(now.getTime());
  since.setUTCFullYear(since.getUTCFullYear() - 2);
  const sales = await store.salesAggregate(since, now);
  const rucs = [...new Set(sales.filter((s) => !s.demo && match(s.vendedor) === user.id).map((s) => s.ruc))];
  const sold = rucs.length ? await store.getCompaniesByRucs(rucs) : [];
  const out = new Map<number, Company>();
  for (const c of [...own.rows, ...sold]) if (c.score !== null && c.nivel) out.set(c.id, c);
  return [...out.values()];
}

export interface SampleOptions {
  now?: Date;
  rng?: Rng;
}

export async function pickValidationSample(store: PortalStore, user: PortalUser, cfg: ScoringConfig, opts: SampleOptions = {}): Promise<Company[]> {
  const now = opts.now ?? new Date();
  const rng = opts.rng ?? seededRng(dailySeed(user.id, now));
  const total = cfg.validacion.total;
  const done = new Set((await store.listRankingValidations({ userId: user.id })).map((v) => v.companyId));
  const known = shuffle(
    (await knownCompanies(store, user, now)).filter((c) => !done.has(c.id)),
    rng,
  );
  const picked = new Map<number, Company>();
  const take = (c: Company) => {
    if (picked.size < total && !done.has(c.id) && !picked.has(c.id)) picked.set(c.id, c);
  };
  // por nivel: primero las conocidas, luego una página al azar de ese nivel
  const quota = cfg.validacion.porNivel;
  const pools = new Map<Nivel, Company[]>();
  for (const nivel of NIVELES) {
    const pool = await randomPool(store, nivel, rng);
    pools.set(nivel, pool);
    const want = quota[nivel];
    let n = 0;
    for (const c of [...known.filter((k) => k.nivel === nivel), ...pool]) {
      if (n >= want) break;
      const before = picked.size;
      take(c);
      if (picked.size > before) n++;
    }
  }
  // si algún nivel no alcanzó (pocas empresas), se completa con los otros
  for (const nivel of NIVELES) for (const c of pools.get(nivel) ?? []) take(c);
  return shuffle([...picked.values()], rng);
}

async function randomPool(store: PortalStore, nivel: Nivel, rng: Rng): Promise<Company[]> {
  const pageSize = 50;
  const first = await store.searchCompanies({ nivel: [nivel], orderBy: "atractivo", pageSize, page: 1 });
  const pages = Math.max(1, Math.ceil(first.total / pageSize));
  const page = 1 + Math.floor(rng() * pages);
  const rows = page === 1 ? first.rows : (await store.searchCompanies({ nivel: [nivel], orderBy: "atractivo", pageSize, page })).rows;
  return shuffle(rows, rng);
}

// ── comparación ──

const RANK: Record<Nivel, number> = { A: 0, B: 1, C: 2 };

export interface ValidationDiff {
  companyId: number;
  userId: number;
  vendedor: Nivel;
  sistema: Nivel;
  /** 1 = un nivel de diferencia, 2 = A frente a C. */
  distancia: number;
  nota: string | null;
  createdAt: Date;
}

export interface ValidationReport {
  respuestas: number;
  /** Con A/B/C (sin "No la conozco" ni las que no tenían nivel del sistema). */
  comparables: number;
  desconocidas: number;
  coincidencias: number;
  /** 0–100, o null sin comparables. */
  pctCoincidencia: number | null;
  /** Vendedor (fila) frente al sistema (columna). */
  matriz: Record<Nivel, Record<Nivel, number>>;
  /** El sistema puso más alto / más bajo que el vendedor. */
  sistemaMasAlto: number;
  sistemaMasBajo: number;
  /** Las que más difieren primero (A frente a C), luego las más recientes. */
  diferencias: ValidationDiff[];
  notas: { companyId: number; userId: number; vendedor: string; sistema: Nivel | null; nota: string; createdAt: Date }[];
}

/**
 * Compara cada respuesta con el nivel del sistema cuando se respondió. Si el mismo vendedor validó la misma empresa más
 * de una vez, cuenta la respuesta más reciente.
 */
export function compareValidations(rows: readonly RankingValidation[]): ValidationReport {
  const latest = new Map<string, RankingValidation>();
  for (const v of [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id)) latest.set(`${v.userId}|${v.companyId}`, v);
  const matriz = { A: { A: 0, B: 0, C: 0 }, B: { A: 0, B: 0, C: 0 }, C: { A: 0, B: 0, C: 0 } } as Record<Nivel, Record<Nivel, number>>;
  let comparables = 0;
  let desconocidas = 0;
  let coincidencias = 0;
  let masAlto = 0;
  let masBajo = 0;
  const diferencias: ValidationDiff[] = [];
  const notas: ValidationReport["notas"] = [];
  for (const v of latest.values()) {
    if (v.nota?.trim()) notas.push({ companyId: v.companyId, userId: v.userId, vendedor: v.nivelVendedor, sistema: v.nivelSistema, nota: v.nota.trim(), createdAt: v.createdAt });
    if (v.nivelVendedor === "desconocida") {
      desconocidas++;
      continue;
    }
    if (!v.nivelSistema) continue;
    comparables++;
    matriz[v.nivelVendedor][v.nivelSistema]++;
    const d = RANK[v.nivelVendedor] - RANK[v.nivelSistema];
    if (d === 0) coincidencias++;
    else {
      if (d > 0) masAlto++;
      else masBajo++;
      diferencias.push({ companyId: v.companyId, userId: v.userId, vendedor: v.nivelVendedor, sistema: v.nivelSistema, distancia: Math.abs(d), nota: v.nota, createdAt: v.createdAt });
    }
  }
  diferencias.sort((a, b) => b.distancia - a.distancia || b.createdAt.getTime() - a.createdAt.getTime());
  notas.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return {
    respuestas: latest.size,
    comparables,
    desconocidas,
    coincidencias,
    pctCoincidencia: comparables ? Math.round((100 * coincidencias) / comparables) : null,
    matriz,
    sistemaMasAlto: masAlto,
    sistemaMasBajo: masBajo,
    diferencias,
    notas,
  };
}

export function formatValidationReport(r: ValidationReport, names: { company: (id: number) => string; user: (id: number) => string }): string {
  const out: string[] = [];
  out.push(`Respuestas: ${r.respuestas} (comparables ${r.comparables}, "No la conozco" ${r.desconocidas})`);
  if (r.pctCoincidencia === null) {
    out.push("Aún no hay respuestas con nivel para comparar.");
  } else {
    out.push(`Coincidencia de nivel: ${r.pctCoincidencia}% (${r.coincidencias} de ${r.comparables})`);
    out.push(`El sistema puso un nivel más alto que el vendedor en ${r.sistemaMasAlto} y más bajo en ${r.sistemaMasBajo}.`);
    out.push("", "Vendedor (filas) frente al sistema (columnas):", "       A    B    C");
    for (const v of NIVELES) out.push(`  ${v}  ${NIVELES.map((s) => String(r.matriz[v][s]).padStart(4)).join(" ")}`);
  }
  if (r.diferencias.length) {
    out.push("", "Donde más difiere:");
    for (const d of r.diferencias.slice(0, 15)) out.push(`  ${names.company(d.companyId)}: vendedor ${d.vendedor}, sistema ${d.sistema} (${names.user(d.userId)})${d.nota ? ` — «${d.nota}»` : ""}`);
  }
  if (r.notas.length) {
    out.push("", "Notas:");
    for (const n of r.notas.slice(0, 30)) out.push(`  ${names.company(n.companyId)} [${n.vendedor === "desconocida" ? "no la conoce" : n.vendedor}${n.sistema ? ` / sistema ${n.sistema}` : ""}] ${names.user(n.userId)}: ${n.nota}`);
  }
  return out.join("\n");
}
