/** Textos del tablero y del comando `avance` (puros). */
import type { Dashboard } from "./load";

const fmt0 = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 0 });

/** "US$ 12,345" (sin decimales). */
export function formatMoney(n: number, currency = "USD"): string {
  const sym = currency === "USD" ? "US$" : currency === "PEN" ? "S/" : currency;
  return `${sym} ${fmt0.format(Math.round(n))}`;
}

/** 0.4567 -> "46 %" */
export function formatPct(ratio: number | null): string {
  return ratio === null ? "—" : `${fmt0.format(Math.round(ratio * 100))} %`;
}

export function formatInt(n: number): string {
  return fmt0.format(n);
}

const fmtMonth = new Intl.DateTimeFormat("es-PE", { month: "long", timeZone: "UTC" });

/** "2026-11-11" -> "noviembre" */
export function monthName(day: string): string {
  return fmtMonth.format(new Date(`${day.slice(0, 7)}-01T12:00:00Z`)).toLowerCase();
}

/**
 * Comando `avance`: tres líneas (vendido, meta y proyección del mes). "· DEMO" si intervienen ventas demo y
 * "(meta de ejemplo)" mientras `goals._ejemplo` sea true. En el alcance equipo dice "del equipo".
 */
export function avanceLines(d: Dashboard): [string, string, string] {
  const mes = monthName(d.today);
  const who = d.scope.kind === "equipo" ? " del equipo" : "";
  const { compliance, projection, goal } = d.figures;
  const vendido = compliance.mes.vendido;
  const demo = vendido.demo ? " · DEMO" : "";
  const meta = goal?.monthly ?? null;
  const pct = compliance.mes.avanceReal === null ? "" : ` (${formatPct(compliance.mes.avanceReal)} de la meta)`;
  return [
    `💰 *Vendido${who} (${mes}):* ${formatMoney(vendido.monto, d.currency)}${pct}${demo}`,
    `🎯 *Meta${who} (${mes}):* ${meta === null ? "sin meta definida" : formatMoney(meta, d.currency)}${meta !== null && d.ejemplo ? " (meta de ejemplo)" : ""}`,
    `📈 *Proyección${who} (${mes}):* ${formatMoney(projection.proyeccion, d.currency)}${projection.demo ? " · DEMO" : ""}`,
  ];
}
