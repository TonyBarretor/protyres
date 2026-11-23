/**
 * Corrida K, punto 6 — Tablero (supervisor y admin): avance de Match Venta por producto prioritario: disponible,
 * cotizado, en pedidos, restante y visitas (agendadas, hechas, con cotización, con pedido). Nada si no hay productos.
 */
import Link from "next/link";
import type { MatchProgressRow } from "@/lib/portal/match";
import { fmtInt } from "@/lib/portal/ui/labels";
import "../match/match.css";

export function MatchSummary({ rows }: { rows: MatchProgressRow[] | null }) {
  if (!rows || !rows.length) return null;
  const tot = rows.reduce(
    (a, r) => ({ disp: a.disp + r.disponible, cot: a.cot + r.cotizado, ped: a.ped + r.pedido, vis: a.vis + r.visitas.agendadas, hechas: a.hechas + r.visitas.hechas }),
    { disp: 0, cot: 0, ped: 0, vis: 0, hechas: 0 },
  );
  return (
    <section className="pt-card" aria-labelledby="match-title">
      <div className="pt-section-head">
        <h2 id="match-title" style={{ margin: 0 }}>
          Match Venta: avance por producto prioritario
        </h2>
        <Link className="pt-small" href="/portal/match">
          Abrir Match Venta
        </Link>
      </div>
      <p className="pt-small pt-muted">
        {fmtInt(tot.disp)} llantas prioritarias · {fmtInt(tot.cot)} cotizadas · {fmtInt(tot.ped)} en pedidos · {fmtInt(tot.vis)} visitas agendadas ({fmtInt(tot.hechas)} hechas). Cotizado: desde que se
        marcó la prioridad.
      </p>
      <ul className="mv-progress-list">
        {rows.map((r) => (
          <li key={r.code}>
            <Link className="pt-company-link" href={`/portal/match?p=${r.code}`}>
              {r.etiqueta}
            </Link>
            <dl className="pt-kv">
              <div>
                <dt>Disponible</dt>
                <dd>{fmtInt(r.disponible)}</dd>
              </div>
              <div>
                <dt>Cotizado</dt>
                <dd>{fmtInt(r.cotizado)}</dd>
              </div>
              <div>
                <dt>En pedidos</dt>
                <dd>{fmtInt(r.pedido)}</dd>
              </div>
              <div>
                <dt>Restante</dt>
                <dd>
                  <b>{fmtInt(r.restante)}</b>
                </dd>
              </div>
              <div className="pt-kv-wide">
                <dt>Visitas</dt>
                <dd>
                  {fmtInt(r.visitas.agendadas)} agendadas · {fmtInt(r.visitas.hechas)} hechas · {fmtInt(r.visitas.conCotizacion)} con cotización · {fmtInt(r.visitas.conPedido)} con pedido
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
