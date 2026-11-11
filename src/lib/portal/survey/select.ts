/**
 * Selección de empresas a encuestar (invitación automática, bloque C3):
 *   - empresas cliente (`es_cliente`),
 *   - cuya última venta REAL (no demo) fue hace `afterSaleDays` días (hasta `windowDays - 1` días más, por si el cron no
 *     corrió algún día; si hubo una venta real más reciente se espera a que cumpla los días),
 *   - sin encuesta en los últimos `cooldownMonths` meses (cuentan todas salvo las que nunca se entregaron).
 * Las ventas demo no cuentan nunca: una empresa con solo ventas demo no se elige.
 */
import { surveyCounts } from "../store/survey-shared";
import type { Company, IsoDate, PortalStore, Sale } from "../store/types";
import { limaDateKey } from "../ui/time";

export interface SurveySelectConfig {
  afterSaleDays: number;
  windowDays: number;
  cooldownMonths: number;
}

export interface SurveyCandidate {
  company: Company;
  /** Última venta real (no demo) de la empresa. */
  lastSale: Sale;
}

export interface SurveySelection {
  candidates: SurveyCandidate[];
  /** Ventana de la última venta (fechas de Lima, inclusive). */
  from: IsoDate;
  until: IsoDate;
  /** Desde cuándo una encuesta previa excluye a la empresa. */
  cooldownSince: Date;
}

export const isRealSale = (s: Pick<Sale, "isDemo" | "origen">): boolean => !s.isDemo && (s.origen ?? "").toLowerCase() !== "demo";

export function isoAddDays(day: IsoDate, n: number): IsoDate {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function monthsBefore(now: Date, months: number): Date {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

/** Última venta real con fecha <= hoy (la más reciente; a igual fecha, la de mayor id). */
export function lastRealSale(sales: Sale[], today: IsoDate): Sale | null {
  let best: Sale | null = null;
  for (const s of sales) {
    if (!isRealSale(s) || s.fecha > today) continue;
    if (!best || s.fecha > best.fecha || (s.fecha === best.fecha && s.id > best.id)) best = s;
  }
  return best;
}

export async function selectSurveyCandidates(store: PortalStore, now: Date, cfg: SurveySelectConfig): Promise<SurveySelection> {
  const today = limaDateKey(now);
  const until = isoAddDays(today, -cfg.afterSaleDays);
  const from = isoAddDays(until, -(Math.max(1, cfg.windowDays) - 1));
  const cooldownSince = monthsBefore(now, cfg.cooldownMonths);
  const out: SurveySelection = { candidates: [], from, until, cooldownSince };

  // RUC con alguna venta desde el inicio de la ventana hasta hoy (luego se mira venta por venta)
  const rucs = [...new Set((await store.salesAggregate(from, today)).map((r) => r.ruc))];
  if (!rucs.length) return out;
  const companies = (await store.getCompaniesByRucs(rucs)).filter((c) => c.esCliente);

  for (const company of companies) {
    const last = lastRealSale(await store.salesByRuc(company.ruc, from), today);
    if (!last || last.fecha > until || last.fecha < from) continue;
    const previous = await store.listSurveys({ companyId: company.id, since: cooldownSince });
    if (previous.some(surveyCounts)) continue;
    out.candidates.push({ company, lastSale: last });
  }
  out.candidates.sort((a, b) => a.company.razonSocial.localeCompare(b.company.razonSocial, "es") || a.company.id - b.company.id);
  return out;
}
