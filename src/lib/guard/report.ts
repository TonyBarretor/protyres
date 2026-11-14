/**
 * Resumen de consumo (corrida E) para `npm run llm:usage` y el bloque "Consumo" del tablero (solo admin): hoy y últimos
 * 7 días (Lima), por usuario y por propósito (llamadas, tokens, minutos de audio, costo estimado) y los topes vigentes
 * con el % usado hoy. Puro salvo la lectura del store.
 */
import type { PortalLimitsConfig } from "../portal/config";
import { addDays, limaStartOfDay } from "../portal/ui/time";
import type { UsageSummaryRow } from "../store/types";
import { SYSTEM_USER, totals } from "./usage";

export interface UsageLine {
  key: string;
  /** Nombre del usuario (si se conoce) o el número / propósito. */
  label: string;
  llmCalls: number;
  tokens: number;
  audioMinutes: number;
  costUsd: number;
}

export interface UsagePeriod {
  title: string;
  byUser: UsageLine[];
  byPurpose: UsageLine[];
  total: UsageLine;
}

export interface CapLine {
  scope: "usuario" | "global";
  /** Usuario (para los topes por usuario) o "Todo el bot". */
  label: string;
  metric: "llmCalls" | "llmTokens" | "audioMinutes";
  used: number;
  limit: number;
  /** used / limit (0..; Infinity si el tope es 0 y hubo uso). */
  pct: number;
}

export interface UsageReport {
  today: UsagePeriod;
  week: UsagePeriod;
  caps: CapLine[];
  blocked: { reason: string; phones: number; messages: number }[];
}

export const METRIC_NAMES: Record<CapLine["metric"], string> = { llmCalls: "llamadas al modelo", llmTokens: "tokens", audioMinutes: "minutos de voz" };

function line(key: string, label: string, rows: UsageSummaryRow[]): UsageLine {
  const t = totals(rows);
  return { key, label, llmCalls: t.llmCalls, tokens: t.llmTokens, audioMinutes: t.audioMinutes, costUsd: t.costUsd };
}

function group(rows: UsageSummaryRow[], by: (r: UsageSummaryRow) => string, label: (k: string) => string): UsageLine[] {
  const m = new Map<string, UsageSummaryRow[]>();
  for (const r of rows) {
    const k = by(r);
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return [...m.entries()].map(([k, rs]) => line(k, label(k), rs)).sort((a, b) => b.costUsd - a.costUsd || b.llmCalls - a.llmCalls);
}

/** Pura: periodo a partir de las filas del resumen. */
export function usagePeriod(title: string, rows: UsageSummaryRow[], names: Map<string, string> = new Map()): UsagePeriod {
  const who = (p: string) => (p === SYSTEM_USER ? "sistema (Drive / CLI)" : names.get(p) ? `${names.get(p)} (${p})` : p);
  return { title, byUser: group(rows, (r) => r.phone, who), byPurpose: group(rows, (r) => r.purpose, (k) => k), total: line("total", "Total", rows) };
}

/** Pura: topes de hoy con el % usado (los por usuario, de quienes usaron algo hoy). */
export function capLines(todayRows: UsageSummaryRow[], cfg: PortalLimitsConfig, names: Map<string, string> = new Map()): CapLine[] {
  const out: CapLine[] = [];
  const add = (scope: CapLine["scope"], label: string, rows: UsageSummaryRow[], caps: PortalLimitsConfig["perUserDaily"]) => {
    const t = totals(rows);
    for (const metric of ["llmCalls", "llmTokens", "audioMinutes"] as const) {
      const used = t[metric];
      const limit = caps[metric];
      out.push({ scope, label, metric, used, limit, pct: limit > 0 ? used / limit : used > 0 ? Infinity : 0 });
    }
  };
  add("global", "Todo el bot", todayRows, cfg.globalDaily);
  const phones = [...new Set(todayRows.map((r) => r.phone))].filter((p) => p !== SYSTEM_USER).sort();
  for (const p of phones) add("usuario", names.get(p) ?? p, todayRows.filter((r) => r.phone === p), cfg.perUserDaily);
  return out;
}

/** Lee el store y arma el resumen (hoy y 7 días, Lima). */
export async function loadUsageReport(
  store: { usageSummary(since: Date): Promise<UsageSummaryRow[]>; blockedSummary(since: Date): Promise<{ reason: string; phones: number; messages: number }[]> },
  cfg: PortalLimitsConfig,
  opts: { now?: Date; names?: Map<string, string> } = {},
): Promise<UsageReport> {
  const now = opts.now ?? new Date();
  const start = limaStartOfDay(now);
  const weekStart = addDays(start, -6);
  const [todayRows, weekRows, blocked] = await Promise.all([store.usageSummary(start), store.usageSummary(weekStart), store.blockedSummary(weekStart)]);
  return {
    today: usagePeriod("Hoy", todayRows, opts.names),
    week: usagePeriod("Últimos 7 días", weekRows, opts.names),
    caps: capLines(todayRows, cfg, opts.names),
    blocked,
  };
}

export const fmtUsd = (n: number) => `US$ ${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
export const fmtPct = (p: number) => (Number.isFinite(p) ? `${Math.round(p * 100)}%` : "—");
