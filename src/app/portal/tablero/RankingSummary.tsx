/**
 * "Validación del ranking" del tablero (corrida G, punto 6): solo el administrador (page.tsx lo carga con
 * loadRankingForDashboard, que devuelve null para los demás). Coincidencia de nivel entre el sistema y los vendedores,
 * la tabla vendedor × sistema, en cuáles difiere más (con enlace a la ficha) y las notas. Con esto se ajustan los pesos
 * (config/portal.json, `scoring`). Lo mismo en texto: `npm run score:validation-report`.
 */
import Link from "next/link";
import { RANKING_DIFFS_SHOWN, RANKING_NOTES_SHOWN, type RankingDashboard } from "@/lib/portal/dashboard/ranking";
import { formatInt } from "@/lib/portal/dashboard/format";
import type { Nivel } from "@/lib/portal/store/types";
import { formatLimaDateTime } from "@/lib/portal/ui/time";

const NIVELES: Nivel[] = ["A", "B", "C"];

function CompanyLink({ id, names }: { id: number; names: Record<number, string> }) {
  return (
    <Link className="pt-company-link" href={`/portal/empresas/${id}`}>
      {names[id] ?? `Empresa #${id}`}
    </Link>
  );
}

export function RankingSummary({ data }: { data: RankingDashboard | null }) {
  if (!data) return null;
  const { report: r, companyName, userName } = data;
  const who = (id: number) => userName[id] ?? `#${id}`;
  return (
    <section className="pt-card" aria-labelledby="ranking-title">
      <h2 id="ranking-title">Validación del ranking</h2>
      <p className="pt-small pt-muted">
        Solo lo ve el administrador. Compara el nivel estimado por el sistema con el que marcan los vendedores en «Validar». Con esto se ajustan los pesos (config/portal.json,
        scoring).
      </p>
      {r.respuestas === 0 ? (
        <p className="pt-muted">Aún no hay respuestas. Los vendedores validan desde la pestaña «Validar».</p>
      ) : (
        <div className="pt-stack" style={{ gap: "0.8rem" }}>
          <div className="pt-kpis">
            <div className="pt-kpi">
              <div className="pt-kpi-label">Coincidencia de nivel</div>
              <div className="pt-kpi-value">{r.pctCoincidencia === null ? "—" : `${r.pctCoincidencia}%`}</div>
              <div className="pt-kpi-sub">
                {formatInt(r.coincidencias)} de {formatInt(r.comparables)} con A, B o C
              </div>
            </div>
            <div className="pt-kpi">
              <div className="pt-kpi-label">Respuestas</div>
              <div className="pt-kpi-value">{formatInt(r.respuestas)}</div>
              <div className="pt-kpi-sub">{formatInt(r.desconocidas)} «No la conozco»</div>
            </div>
            <div className="pt-kpi">
              <div className="pt-kpi-label">El sistema puso</div>
              <div className="pt-kpi-sub">
                más alto en <strong>{formatInt(r.sistemaMasAlto)}</strong> · más bajo en <strong>{formatInt(r.sistemaMasBajo)}</strong>
              </div>
            </div>
          </div>

          {r.comparables > 0 && (
            <div className="pt-table-wrap" style={{ maxWidth: 320 }}>
              <table className="pt-table">
                <caption className="pt-small pt-muted" style={{ textAlign: "left", padding: "0.4rem 0.7rem" }}>
                  Vendedor (filas) frente al sistema (columnas)
                </caption>
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="pt-sr-only">Vendedor</span>
                    </th>
                    {NIVELES.map((n) => (
                      <th key={n} scope="col" className="pt-num">
                        {n}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {NIVELES.map((v) => (
                    <tr key={v}>
                      <th scope="row">{v}</th>
                      {NIVELES.map((s) => (
                        <td key={s} className="pt-num" style={v === s ? { fontWeight: 700 } : undefined}>
                          {formatInt(r.matriz[v][s])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="tb-grid2">
            <div>
              <h3>Donde más difiere</h3>
              {r.diferencias.length === 0 ? (
                <p className="pt-small pt-muted">Ninguna diferencia por ahora.</p>
              ) : (
                <ul className="pt-list pt-small">
                  {r.diferencias.slice(0, RANKING_DIFFS_SHOWN).map((d) => (
                    <li key={`${d.userId}|${d.companyId}`}>
                      <CompanyLink id={d.companyId} names={companyName} />
                      <div>
                        Vendedor <strong>{d.vendedor}</strong> · sistema <strong>{d.sistema}</strong> <span className="pt-muted">· {who(d.userId)}</span>
                      </div>
                      {d.nota && <div className="pt-muted">«{d.nota}»</div>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3>Notas</h3>
              {r.notas.length === 0 ? (
                <p className="pt-small pt-muted">Sin notas.</p>
              ) : (
                <ul className="pt-list pt-small">
                  {r.notas.slice(0, RANKING_NOTES_SHOWN).map((n) => (
                    <li key={`${n.userId}|${n.companyId}`}>
                      <CompanyLink id={n.companyId} names={companyName} />{" "}
                      <span className="pt-muted">
                        · {n.vendedor === "desconocida" ? "no la conoce" : `vendedor ${n.vendedor}`}
                        {n.sistema ? ` · sistema ${n.sistema}` : ""} · {who(n.userId)} · {formatLimaDateTime(n.createdAt)}
                      </span>
                      <div>{n.nota}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
