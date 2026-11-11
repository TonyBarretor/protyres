/**
 * Tablero de cumplimiento y proyección (bloque C2). El vendedor ve lo suyo; supervisor y admin ven el equipo (total y una
 * fila por vendedor) y pueden abrir el de cada vendedor con ?vendedor=<id>. Cifras: src/lib/portal/dashboard/*.
 * "DEMO" donde intervienen ventas demo; "Meta de ejemplo" mientras config/portal.json tenga goals._ejemplo = true.
 */
import Link from "next/link";
import { canSeeAll, requireUser } from "@/lib/portal/auth/session";
import type { ComplianceFigure } from "@/lib/portal/dashboard/compliance";
import { formatInt, formatMoney, formatPct, monthName } from "@/lib/portal/dashboard/format";
import { loadDashboard, type DashboardScope } from "@/lib/portal/dashboard/load";
import { getPortalStore } from "@/lib/portal/store";
import { DemoTag } from "../_components/bits";
import { HBar, Legend, ProgressBar, WeekBars } from "./charts";
import { SurveySummary } from "./SurveySummary";
import "./tablero.css";

export const metadata = { title: "Tablero · Portal 360 Tyres" };

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function ExampleTag() {
  return (
    <span className="pt-tag tb-tag-example" title="Valores de ejemplo en config/portal.json (goals): reemplazar por las metas reales">
      Meta de ejemplo
    </span>
  );
}

function shortDate(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

function ComplianceBlock({ title, f, currency, ejemplo }: { title: string; f: ComplianceFigure; currency: string; ejemplo: boolean }) {
  const label = `${title}: vendido ${formatMoney(f.vendido.monto, currency)}${f.meta !== null ? ` de una meta de ${formatMoney(f.meta, currency)}; esperado a la fecha ${formatMoney(f.esperado ?? 0, currency)}` : ""}`;
  return (
    <div className="tb-compliance">
      <div className="tb-compliance-head">
        <h3>{title}</h3>
        <span className="pt-row" style={{ gap: "0.3rem" }}>
          {f.vendido.demo && <DemoTag />}
          {f.meta !== null && ejemplo && <ExampleTag />}
        </span>
      </div>
      <div className="tb-figure">
        <span className="tb-figure-value">{formatMoney(f.vendido.monto, currency)}</span>
        <span className="pt-muted">{f.meta !== null ? `de ${formatMoney(f.meta, currency)}` : "sin meta definida"}</span>
      </div>
      <ProgressBar real={f.vendido.monto} esperado={f.esperado} meta={f.meta} label={label} />
      <dl className="tb-dl pt-small">
        <div>
          <dt>Avance real</dt>
          <dd>{formatPct(f.avanceReal)}</dd>
        </div>
        <div>
          <dt>Esperado a la fecha</dt>
          <dd>
            {formatPct(f.progress.ratio)}
            {f.esperado !== null && <span className="pt-muted"> · {formatMoney(f.esperado, currency)}</span>}
          </dd>
        </div>
        <div>
          <dt>Días hábiles</dt>
          <dd>
            {f.progress.elapsed} de {f.progress.total}
          </dd>
        </div>
        <div>
          <dt>Neumáticos</dt>
          <dd>{formatInt(f.vendido.cantidad)}</dd>
        </div>
      </dl>
      {f.vendido.sinMonto > 0 && <p className="pt-small pt-muted">{f.vendido.sinMonto} venta(s) sin total ni precio: no suman al monto.</p>}
    </div>
  );
}

export default async function TableroPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const store = await getPortalStore();
  const sp = await searchParams;
  const all = canSeeAll(user);

  const users = all ? (await store.listUsers()).filter((u) => u.activo && u.rol === "vendedor") : [];
  const wanted = Number(str(sp.vendedor));
  const picked = all && Number.isInteger(wanted) ? ((await store.getUser(wanted)) ?? null) : null;
  const scope: DashboardScope = !all ? { kind: "usuario", userId: user.id } : picked ? { kind: "usuario", userId: picked.id } : { kind: "equipo" };
  const d = await loadDashboard(store, { scope, now: new Date() });
  if (picked && !users.some((u) => u.id === picked.id)) users.push(picked);

  const { compliance, projection, goal } = d.figures;
  const cur = d.currency;
  const mes = monthName(d.today);
  const scopeName = d.user ? d.user.nombre : "Equipo";
  const maxPond = Math.max(0, ...projection.porEtapa.map((s) => s.ponderado));
  const maxPart = Math.max(0, ...d.participacion.map((p) => p.cantidad));
  const anyDemo = compliance.anio.vendido.demo || projection.demo || d.participacion.some((p) => p.demo);

  return (
    <div className="pt-stack tb">
      <div className="pt-page-head" style={{ marginBottom: 0 }}>
        <h1>Tablero · {scopeName}</h1>
        <span className="pt-muted pt-small">
          Al {shortDate(d.today)} (Lima) · montos en {cur} sin IGV
        </span>
      </div>

      {all && (
        <form className="tb-picker pt-row" method="get">
          <label className="pt-small" htmlFor="tb-vendedor">
            Ver
          </label>
          <select id="tb-vendedor" name="vendedor" defaultValue={picked ? String(picked.id) : ""}>
            <option value="">Equipo (total)</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.nombre}
              </option>
            ))}
          </select>
          <button className="pt-btn pt-btn-sm" type="submit">
            Ver
          </button>
        </form>
      )}

      {anyDemo && (
        <p className="pt-notice tb-demo-note">
          <DemoTag /> Las cifras marcadas incluyen ventas de demostración. Se borran con <code>npm run portal:clear-demo</code> al cargar las ventas reales.
        </p>
      )}

      {/* ── Cumplimiento ── */}
      <section className="pt-card" aria-labelledby="cumplimiento-title">
        <h2 id="cumplimiento-title">Cumplimiento</h2>
        <div className="tb-grid2">
          <ComplianceBlock title={`Mes (${mes})`} f={compliance.mes} currency={cur} ejemplo={d.ejemplo} />
          <ComplianceBlock title={`Año ${d.today.slice(0, 4)}`} f={compliance.anio} currency={cur} ejemplo={d.ejemplo} />
        </div>
        <Legend>
          <span className="tb-key tb-key-fill" /> Vendido <span className="tb-key tb-key-mark" /> Esperado a la fecha (proporción de días hábiles lun–vie transcurridos)
        </Legend>
        {d.sinVendedor && d.sinVendedor.monto > 0 && (
          <p className="pt-small pt-muted">
            Incluye {formatMoney(d.sinVendedor.monto, cur)} vendidos este mes sin vendedor identificado {d.sinVendedor.demo && <DemoTag />}
          </p>
        )}
      </section>

      {/* ── Equipo: una fila por vendedor ── */}
      {d.scope.kind === "equipo" && d.vendedores.length > 0 && (
        <section className="pt-card" aria-labelledby="vendedores-title">
          <h2 id="vendedores-title">Por vendedor ({mes})</h2>
          <div className="tb-vendors">
            {d.vendedores.map(({ user: u, figures: f }) => (
              <Link key={u.id} className="tb-vendor" href={`/portal/tablero?vendedor=${u.id}`}>
                <div className="tb-vendor-head">
                  <strong>{u.nombre}</strong>
                  <span className="pt-row" style={{ gap: "0.3rem" }}>
                    {f.compliance.mes.vendido.demo && <DemoTag />}
                    {f.goal?.monthly != null && d.ejemplo && <ExampleTag />}
                  </span>
                </div>
                <ProgressBar real={f.compliance.mes.vendido.monto} esperado={f.compliance.mes.esperado} meta={f.compliance.mes.meta} label={`${u.nombre}: vendido ${formatMoney(f.compliance.mes.vendido.monto, cur)}`} />
                <div className="pt-small tb-vendor-nums">
                  <span>Vendido {formatMoney(f.compliance.mes.vendido.monto, cur)}</span>
                  <span>Meta {f.compliance.mes.meta !== null ? formatMoney(f.compliance.mes.meta, cur) : "—"}</span>
                  <span>
                    Avance {formatPct(f.compliance.mes.avanceReal)} (esperado {formatPct(f.compliance.mes.progress.ratio)})
                  </span>
                  <span>Proyección {formatMoney(f.projection.proyeccion, cur)}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* ── Proyección ── */}
      <section className="pt-card" aria-labelledby="proyeccion-title">
        <h2 id="proyeccion-title">Proyección del mes ({mes})</h2>
        <div className="pt-kpis">
          <div className="pt-kpi">
            <div className="pt-kpi-label">Vendido {projection.demo && <DemoTag />}</div>
            <div className="pt-kpi-value">{formatMoney(projection.vendido.monto, cur)}</div>
          </div>
          <div className="pt-kpi">
            <div className="pt-kpi-label">+ Pipeline ponderado</div>
            <div className="pt-kpi-value">{formatMoney(projection.ponderado, cur)}</div>
            <div className="pt-kpi-sub">cierre esperado en {mes}</div>
          </div>
          <div className="pt-kpi">
            <div className="pt-kpi-label">= Proyección {projection.demo && <DemoTag />}</div>
            <div className="pt-kpi-value">{formatMoney(projection.proyeccion, cur)}</div>
            <div className="pt-kpi-sub">
              {goal?.monthly != null ? (
                <>
                  {formatPct(goal.monthly ? projection.proyeccion / goal.monthly : null)} de la meta {d.ejemplo && <ExampleTag />}
                </>
              ) : (
                "sin meta definida"
              )}
            </div>
          </div>
        </div>
        <h3 style={{ marginTop: "1rem" }}>Desglose por etapa</h3>
        <div className="tb-stages">
          <div className="tb-stage tb-stage-head pt-small pt-muted">
            <span>Etapa</span>
            <span className="pt-num">Opor.</span>
            <span className="pt-num">Monto</span>
            <span className="pt-num">Ponderado</span>
          </div>
          {projection.porEtapa.map((s) => (
            <div key={s.etapa} className="tb-stage">
              <span>
                {s.label} <span className="pt-muted pt-small">{s.probabilidad} %</span>
              </span>
              <span className="pt-num">{s.n}</span>
              <span className="pt-num">{formatMoney(s.monto, cur)}</span>
              <span className="pt-num">{formatMoney(s.ponderado, cur)}</span>
              <div className="tb-stage-bar">
                <HBar value={s.ponderado} max={maxPond} title={`${s.label}: ${formatMoney(s.ponderado, cur)} ponderado`} />
              </div>
            </div>
          ))}
        </div>
        <ul className="pt-small pt-muted tb-notes">
          <li>Ponderado = monto estimado × probabilidad de la etapa. Cerrado ganado no suma: su venta real entra por las ventas cargadas.</li>
          {projection.sinFecha > 0 && <li>{projection.sinFecha} oportunidad(es) abierta(s) sin fecha de cierre: no se cuentan.</li>}
          {projection.cierreVencido > 0 && <li>{projection.cierreVencido} con cierre esperado ya pasado: actualiza la fecha para que cuenten.</li>}
          {projection.sinMonto > 0 && <li>{projection.sinMonto} con cierre en {mes} sin monto estimado: no suman.</li>}
        </ul>
      </section>

      {/* ── Actividad y tiempos ── */}
      <section className="pt-card" aria-labelledby="actividad-title">
        <h2 id="actividad-title">Actividad y tiempos</h2>
        <p className="pt-small pt-muted">Últimas 8 semanas (lunes a domingo, hora de Lima); la última está en curso.</p>
        <div className="tb-grid3">
          <WeekBars weeks={d.weeks} field="visitas" title="Visitas" />
          <WeekBars weeks={d.weeks} field="llamadas" title="Llamadas" />
          <WeekBars weeks={d.weeks} field="cotizaciones" title="Cotizaciones" />
        </div>
        <details className="pt-small">
          <summary>Ver tabla por semana</summary>
          <table className="pt-table tb-table">
            <thead>
              <tr>
                <th>Semana</th>
                <th className="pt-num">Visitas</th>
                <th className="pt-num">Llamadas</th>
                <th className="pt-num">Cotiz.</th>
              </tr>
            </thead>
            <tbody>
              {d.weeks.map((w) => (
                <tr key={w.start}>
                  <td>
                    {w.start.slice(8, 10)}/{w.start.slice(5, 7)} – {w.end.slice(8, 10)}/{w.end.slice(5, 7)}
                  </td>
                  <td className="pt-num">{w.visitas}</td>
                  <td className="pt-num">{w.llamadas}</td>
                  <td className="pt-num">{w.cotizaciones}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>

        <div className="tb-grid2" style={{ marginTop: "1rem" }}>
          <div>
            <h3>Días promedio por etapa</h3>
            <ul className="tb-kvlist pt-small">
              {d.stageAvg.map((s) => (
                <li key={s.etapa}>
                  <span>{s.label}</span>
                  <span className="pt-num">{s.dias === null ? "—" : `${s.dias.toLocaleString("es-PE")} d`}</span>
                </li>
              ))}
            </ul>
            <p className="pt-small pt-muted">Solo estancias terminadas (la etapa actual no cuenta hasta que se mueve).</p>
          </div>
          <div>
            <h3>Asignación → primera llamada</h3>
            <p className="tb-figure-value">{d.asignacionLlamada.dias === null ? "—" : `${d.asignacionLlamada.dias.toLocaleString("es-PE")} días`}</p>
            <p className="pt-small pt-muted">
              Promedio de {d.asignacionLlamada.n} oportunidad(es) de los últimos 12 meses con asignación y llamada registradas.
            </p>
            <h3 style={{ marginTop: "0.8rem" }}>Cotizaciones sin respuesta ({d.sinRespuesta.length})</h3>
            {d.sinRespuesta.length === 0 ? (
              <p className="pt-small pt-muted">Ninguna cotización enlazada espera respuesta.</p>
            ) : (
              <ul className="pt-list pt-small">
                {d.sinRespuesta.slice(0, 10).map((q) => (
                  <li key={q.opportunityId}>
                    <Link className="pt-company-link" href={`/portal/empresas/${q.companyId}`}>
                      {q.razonSocial}
                    </Link>{" "}
                    <span className="pt-muted">
                      · {q.quoteNumber} · {q.businessDays} días hábiles
                    </span>
                  </li>
                ))}
                {d.sinRespuesta.length > 10 && <li className="pt-muted">…y {d.sinRespuesta.length - 10} más</li>}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* ── Participación ── */}
      <section className="pt-card" aria-labelledby="participacion-title">
        <h2 id="participacion-title">Participación: top 10 por neumáticos vendidos</h2>
        <p className="pt-small pt-muted">
          Del {shortDate(d.participacionVentana.start)} al {shortDate(d.participacionVentana.end)}. Llantas en piso: padrón MTC.
        </p>
        {d.participacion.length === 0 ? (
          <p className="pt-muted">Sin ventas en los últimos 12 meses.</p>
        ) : (
          <ol className="tb-part">
            <li className="tb-part-row tb-part-head pt-small pt-muted" aria-hidden="true">
              <span>Empresa</span>
              <span />
              <span className="pt-num">Vendidos</span>
              <span className="pt-num">En piso</span>
            </li>
            {d.participacion.map((p) => (
              <li key={p.ruc} className="tb-part-row">
                <span className="tb-part-name">
                  {p.companyId ? (
                    <Link className="pt-company-link" href={`/portal/empresas/${p.companyId}`}>
                      {p.razonSocial}
                    </Link>
                  ) : (
                    p.razonSocial
                  )}{" "}
                  {p.demo && <DemoTag />}
                </span>
                <span className="tb-part-bar">
                  <HBar value={p.cantidad} max={maxPart} title={`${p.razonSocial}: ${p.cantidad} neumáticos`} />
                </span>
                <span className="pt-num">{formatInt(p.cantidad)}</span>
                <span className="pt-num">
                  {p.llantasPiso === null ? <span className="pt-muted" title="No está en el padrón importado">—</span> : formatInt(p.llantasPiso)}
                  {p.ratio !== null && <span className="pt-muted pt-small"> ({formatPct(p.ratio)})</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* C3: resumen de encuestas (no renderiza nada sin datos). */}
      <SurveySummary data={null} />
    </div>
  );
}
