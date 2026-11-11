/**
 * Gráficos del tablero: HTML/CSS y SVG en el servidor, sin dependencias. Una sola serie por gráfico (un solo azul), lo
 * esperado como marca oscura, cifras siempre en texto al lado (no dependen del color) y <title> como ayuda al pasar el
 * cursor. Escalan al ancho disponible: sin scroll horizontal en el celular.
 */
import type { ReactNode } from "react";
import type { WeekActivity } from "@/lib/portal/dashboard/activity";

/** Barra de avance: relleno = real, marca vertical = esperado a la fecha; escala = máximo de meta, real y esperado. */
export function ProgressBar({ real, esperado, meta, label }: { real: number; esperado: number | null; meta: number | null; label: string }) {
  const max = Math.max(meta ?? 0, real, esperado ?? 0) || 1;
  const pct = (v: number) => `${Math.min(100, (v / max) * 100).toFixed(2)}%`;
  return (
    <div className="tb-progress" role="img" aria-label={label}>
      <div className="tb-progress-fill" style={{ width: pct(real) }} />
      {meta !== null && meta < max && <div className="tb-progress-goal" style={{ left: pct(meta) }} title="Meta" />}
      {esperado !== null && <div className="tb-progress-mark" style={{ left: pct(esperado) }} title="Esperado a la fecha" />}
    </div>
  );
}

/** Barra horizontal simple (participación, ponderado por etapa). */
export function HBar({ value, max, title }: { value: number; max: number; title?: string }) {
  const w = max > 0 ? Math.max(value > 0 ? 1.5 : 0, (value / max) * 100) : 0;
  return (
    <div className="tb-hbar" title={title}>
      <div className="tb-hbar-fill" style={{ width: `${w.toFixed(2)}%` }} />
    </div>
  );
}

const W = 320;
const H = 120;
const PAD_TOP = 16;
const PAD_BOTTOM = 18;

function shortDay(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** Barras por semana (SVG que escala con el ancho). Etiqueta el valor de la semana en curso y el máximo. */
export function WeekBars({ weeks, field, title }: { weeks: WeekActivity[]; field: "visitas" | "llamadas" | "cotizaciones"; title: string }) {
  const values = weeks.map((w) => w[field]);
  const max = Math.max(1, ...values);
  const slot = W / weeks.length;
  const bw = Math.min(26, slot - 6);
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const maxIdx = values.lastIndexOf(Math.max(...values));
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <figure className="tb-weeks">
      <figcaption>
        <strong>{title}</strong> <span className="pt-muted pt-small">· {total} en 8 semanas</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${title} por semana: ${weeks.map((w, i) => `${shortDay(w.start)} ${values[i]}`).join(", ")}`}>
        <line x1={0} x2={W} y1={H - PAD_BOTTOM + 0.5} y2={H - PAD_BOTTOM + 0.5} className="tb-axis" />
        {weeks.map((w, i) => {
          const v = values[i];
          const h = v ? Math.max(3, (v / max) * plotH) : 0;
          const x = i * slot + (slot - bw) / 2;
          const y = H - PAD_BOTTOM - h;
          const labelled = v > 0 && (i === weeks.length - 1 || i === maxIdx);
          return (
            <g key={w.start}>
              <title>{`Semana del ${shortDay(w.start)} al ${shortDay(w.end)}: ${v}`}</title>
              <rect x={i * slot} y={PAD_TOP - 4} width={slot} height={plotH + 4} fill="transparent" />
              {h > 0 && <path d={roundedTop(x, y, bw, h, Math.min(4, h))} className="tb-bar" />}
              {labelled && (
                <text x={x + bw / 2} y={y - 4} textAnchor="middle" className="tb-val">
                  {v}
                </text>
              )}
              {(i % 2 === 1 || weeks.length <= 4) && (
                <text x={x + bw / 2} y={H - 4} textAnchor="middle" className="tb-tick">
                  {shortDay(w.start)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

/** Rectángulo con las esquinas de arriba redondeadas (el extremo de datos) y la base recta en el eje. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

export function Legend({ children }: { children: ReactNode }) {
  return <div className="tb-legend pt-small">{children}</div>;
}
