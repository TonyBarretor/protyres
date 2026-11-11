/**
 * Tablero de cumplimiento y proyección (bloque C2): lee del store y arma todas las cifras con las funciones puras de
 * esta carpeta. Lo usan /portal/tablero y el comando `avance` del bot.
 *
 * Alcance: un usuario (sus ventas según el cruce de `sales.vendedor` en vendors.ts, sus oportunidades como dueño y sus
 * actividades) o el equipo (todas las ventas, incluidas las "sin vendedor identificado", todas las oportunidades y
 * actividades; meta = `goals.company`).
 *
 * Lecturas: 1 agregado de ventas (salesAggregate), usuarios, oportunidades del alcance, su historial (stageHistoryFor),
 * actividades de los últimos 12 meses y las empresas del top de participación y de las cotizaciones sin respuesta.
 */
import { loadPortalConfig, type PortalConfig, type PortalGoalsConfig } from "../config";
import type { QuoteFollowUp } from "../quotes/reminders";
import type { IsoDate, PortalStore, PortalUser, SalesAggRow } from "../store/types";
import { assignmentToFirstCall, stageAverages, unansweredQuotes, weeklyActivity, type AverageDays, type StageAverage, type WeekActivity } from "./activity";
import { computeCompliance, sumSales, type Amount, type Compliance, type Goal } from "./compliance";
import { lastWeeks, limaToday, monthOf, twelveMonthsBefore, yearOf, type Period } from "./period";
import { computeProjection, type Projection } from "./projection";
import { topByTyres, withFleet, type TopCompany } from "./participation";
import { matchUser, vendorMatcher } from "./vendors";

export type DashboardScope = { kind: "equipo" } | { kind: "usuario"; userId: number };

export interface ScopeFigures {
  goal: Goal | null;
  compliance: Compliance;
  projection: Projection;
}

export interface VendorSummary {
  user: PortalUser;
  figures: ScopeFigures;
}

export interface Dashboard {
  now: Date;
  today: IsoDate;
  currency: string;
  /** Metas de ejemplo (`goals._ejemplo`): mostrar "Meta de ejemplo". */
  ejemplo: boolean;
  scope: DashboardScope;
  /** Usuario del alcance (null = equipo). */
  user: PortalUser | null;
  figures: ScopeFigures;
  /** Equipo: ventas del mes cuyo vendedor no se pudo cruzar con un usuario. */
  sinVendedor: Amount | null;
  /** Equipo: una fila por vendedor. */
  vendedores: VendorSummary[];
  /** Equipo: claves de meta (`goals.users`) que coinciden con varios usuarios y no se asignaron a ninguno. */
  metasAmbiguas: AmbiguousGoalKey[];
  weeks: WeekActivity[];
  stageAvg: StageAverage[];
  asignacionLlamada: AverageDays;
  sinRespuesta: (QuoteFollowUp & { razonSocial: string })[];
  participacion: TopCompany[];
  participacionVentana: Period;
}

type GoalUser = Pick<PortalUser, "id" | "nombre" | "whatsapp">;

/** Usuarios con los que coincide una clave de `goals.users` (WhatsApp o nombre, cruce tolerante de vendors.ts). */
function goalKeyMatches<U extends GoalUser>(key: string, users: readonly U[]): U[] {
  return users.filter((u) => matchUser(key, [u]) !== null);
}

/**
 * Meta del usuario en `goals.users`: la clave tiene que coincidir con exactamente un usuario de `users` (y ser este). Una
 * clave que coincide con varios no se asigna a ninguno (ver ambiguousGoalKeys). null si no tiene.
 */
export function goalForUser(goals: PortalGoalsConfig, user: GoalUser, users: readonly GoalUser[]): Goal | null {
  const all = users.some((u) => u.id === user.id) ? users : [...users, user];
  for (const [key, goal] of Object.entries(goals.users)) {
    const m = goalKeyMatches(key, all);
    if (m.length === 1 && m[0].id === user.id) return goal;
  }
  return null;
}

export interface AmbiguousGoalKey {
  clave: string;
  usuarios: string[];
}

/** Claves de `goals.users` que coinciden con más de un usuario: no se asignan (se avisa en el tablero del equipo). */
export function ambiguousGoalKeys(goals: PortalGoalsConfig, users: readonly GoalUser[]): AmbiguousGoalKey[] {
  const out: AmbiguousGoalKey[] = [];
  for (const key of Object.keys(goals.users)) {
    const m = goalKeyMatches(key, users);
    if (m.length > 1) out.push({ clave: key, usuarios: m.map((u) => u.nombre) });
  }
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function figuresFor(rows: readonly SalesAggRow[], opps: Parameters<typeof computeProjection>[0], today: IsoDate, goal: Goal | null, holidays: readonly string[]): ScopeFigures {
  const compliance = computeCompliance(rows, today, goal, holidays);
  return { goal, compliance, projection: computeProjection(opps, monthOf(today), compliance.mes.vendido) };
}

export interface LoadDashboardOptions {
  scope: DashboardScope;
  now?: Date;
  config?: PortalConfig;
  /** false = solo cumplimiento y proyección (comando `avance`): no lee actividades ni participación. */
  details?: boolean;
}

export async function loadDashboard(store: PortalStore, opts: LoadDashboardOptions): Promise<Dashboard> {
  const now = opts.now ?? new Date();
  const cfg = opts.config ?? loadPortalConfig();
  const details = opts.details ?? true;
  const today = limaToday(now);
  const year = yearOf(today);
  const partWindow: Period = { start: twelveMonthsBefore(today), end: today };
  const since = partWindow.start < year.start ? partWindow.start : year.start;

  const [rows, users] = await Promise.all([store.salesAggregate(since, today), store.listUsers()]);
  const vendorOf = vendorMatcher(users);
  const team = opts.scope.kind === "equipo";
  const userId = opts.scope.kind === "usuario" ? opts.scope.userId : null;
  const user = userId === null ? null : (users.find((u) => u.id === userId) ?? (await store.getUser(userId)));
  if (!team && !user) throw new Error(`Usuario ${userId} no encontrado`);

  const allOpps = await store.listOpportunities(team ? {} : { ownerId: userId! });
  const scopeRows = team ? rows : rows.filter((r) => vendorOf(r.vendedor) === userId);
  const goal = team ? cfg.goals.company : goalForUser(cfg.goals, user!, users);
  const figures = figuresFor(scopeRows, allOpps, today, goal, cfg.holidays);

  let sinVendedor: Amount | null = null;
  const vendedores: VendorSummary[] = [];
  if (team) {
    sinVendedor = sumSales(
      rows.filter((r) => vendorOf(r.vendedor) === null),
      monthOf(today),
    );
    const withSales = new Set(rows.map((r) => vendorOf(r.vendedor)));
    for (const u of users) {
      if (!u.activo || !(u.rol === "vendedor" || withSales.has(u.id))) continue;
      const uRows = rows.filter((r) => vendorOf(r.vendedor) === u.id);
      const uOpps = allOpps.filter((o) => o.ownerUserId === u.id);
      vendedores.push({ user: u, figures: figuresFor(uRows, uOpps, today, goalForUser(cfg.goals, u, users), cfg.holidays) });
    }
  }

  const weeks = lastWeeks(now, 8);
  const base: Dashboard = {
    now,
    today,
    currency: cfg.goals.currency,
    ejemplo: cfg.goals._ejemplo,
    scope: opts.scope,
    user,
    figures,
    sinVendedor,
    vendedores,
    metasAmbiguas: team ? ambiguousGoalKeys(cfg.goals, users) : [],
    weeks: weeks.map((w) => ({ start: w.start, end: w.end, visitas: 0, llamadas: 0, cotizaciones: 0 })),
    stageAvg: stageAverages([]),
    asignacionLlamada: { dias: null, n: 0 },
    sinRespuesta: [],
    participacion: [],
    participacionVentana: partWindow,
  };
  if (!details) return base;

  const yearAgo = new Date(now.getTime() - 365 * DAY_MS);
  const actSince = weeks[0].from.getTime() < yearAgo.getTime() ? weeks[0].from : yearAgo;
  const [history, activities] = await Promise.all([store.stageHistoryFor(allOpps.map((o) => o.id)), store.listActivities({ since: actSince })]);
  const scopeActs = team ? activities : activities.filter((a) => a.userId === userId);
  const recentOpps = allOpps.filter((o) => o.createdAt.getTime() >= yearAgo.getTime());
  const unanswered = unansweredQuotes({ opportunities: allOpps, activities, stageHistory: history, now, businessDays: cfg.quotes.followUpBusinessDays, holidays: cfg.holidays });

  const top = topByTyres(scopeRows, partWindow, 10);
  const companies = await store.getCompaniesByRucs(top.map((t) => t.ruc));
  const names = new Map<number, string>();
  for (const id of new Set(unanswered.map((q) => q.companyId))) names.set(id, (await store.getCompany(id))?.razonSocial ?? `Empresa #${id}`);

  return {
    ...base,
    weeks: weeklyActivity(scopeActs, weeks),
    stageAvg: stageAverages(history),
    asignacionLlamada: assignmentToFirstCall(recentOpps, history, activities, now),
    sinRespuesta: unanswered.map((q) => ({ ...q, razonSocial: names.get(q.companyId) ?? `Empresa #${q.companyId}` })),
    participacion: withFleet(top, companies),
  };
}
