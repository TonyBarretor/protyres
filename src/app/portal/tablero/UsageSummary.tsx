/**
 * "Consumo" del tablero (corrida E): gasto del modelo de lenguaje y de la voz, solo para el administrador (page.tsx lo
 * carga con loadUsageForDashboard, que devuelve null para los demás roles). Hoy y 7 días, por usuario y por propósito, y
 * el % de cada tope de hoy (config/portal.json, `limits`). Costos estimados.
 */
import { fmtPct, fmtUsd, METRIC_NAMES, type UsageLine, type UsagePeriod, type UsageReport } from "@/lib/guard/report";
import { formatInt } from "@/lib/portal/dashboard/format";

function Lines({ caption, lines }: { caption: string; lines: UsageLine[] }) {
  return (
    <div className="pt-table-wrap">
      <table className="pt-table">
        <caption className="pt-small pt-muted" style={{ textAlign: "left", padding: "0.4rem 0.7rem" }}>
          {caption}
        </caption>
        <thead>
          <tr>
            <th scope="col">{caption === "Por usuario" ? "Usuario" : "Propósito"}</th>
            <th scope="col" className="pt-num">
              Llamadas
            </th>
            <th scope="col" className="pt-num">
              Tokens
            </th>
            <th scope="col" className="pt-num">
              Min. voz
            </th>
            <th scope="col" className="pt-num">
              Costo est.
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td colSpan={5} className="pt-muted">
                Sin uso.
              </td>
            </tr>
          ) : (
            lines.map((l) => (
              <tr key={l.key}>
                <td>{l.label}</td>
                <td className="pt-num">{formatInt(l.llmCalls)}</td>
                <td className="pt-num">{formatInt(l.tokens)}</td>
                <td className="pt-num">{l.audioMinutes.toFixed(1)}</td>
                <td className="pt-num">{fmtUsd(l.costUsd)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Period({ p }: { p: UsagePeriod }) {
  return (
    <div className="pt-stack">
      <h3>
        {p.title}{" "}
        <span className="pt-muted pt-small">
          · {formatInt(p.total.llmCalls)} llamadas · {formatInt(p.total.tokens)} tokens · {p.total.audioMinutes.toFixed(1)} min de voz · {fmtUsd(p.total.costUsd)}
        </span>
      </h3>
      <Lines caption="Por usuario" lines={p.byUser} />
      <Lines caption="Por propósito" lines={p.byPurpose} />
    </div>
  );
}

const BLOCKED: Record<string, string> = { no_registrado: "número no registrado", rafaga: "ráfaga", viejo: "viejo (reintento de Meta)" };

export function UsageSummary({ data }: { data: UsageReport | null }) {
  if (!data) return null;
  const top = [...data.caps].sort((a, b) => b.pct - a.pct);
  return (
    <section className="pt-card" aria-labelledby="consumo-title">
      <h2 id="consumo-title">Consumo del asistente</h2>
      <p className="pt-small pt-muted">Solo lo ve el administrador. Costos estimados (config/portal.json, limits.prices); detalle con npm run llm:usage.</p>
      <div className="tb-grid2">
        <Period p={data.today} />
        <Period p={data.week} />
      </div>
      <h3>Topes de hoy</h3>
      <ul className="pt-list pt-small">
        {top.map((c) => (
          <li key={`${c.scope}-${c.label}-${c.metric}`}>
            <strong>{fmtPct(c.pct)}</strong> · {c.label}: {METRIC_NAMES[c.metric]} {c.metric === "audioMinutes" ? c.used.toFixed(1) : formatInt(c.used)} de {formatInt(c.limit)}
            {c.scope === "usuario" ? " (por usuario)" : ""}
          </li>
        ))}
      </ul>
      {data.blocked.length > 0 && (
        <p className="pt-small pt-muted">
          No procesados en 7 días: {data.blocked.map((b) => `${BLOCKED[b.reason] ?? b.reason} ${b.messages} (${b.phones} número${b.phones === 1 ? "" : "s"})`).join(" · ")}
        </p>
      )}
    </section>
  );
}
