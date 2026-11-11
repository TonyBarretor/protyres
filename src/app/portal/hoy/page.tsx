/**
 * Hoy: próximas acciones del usuario (vencidas o de hoy) y sus citas de hoy y los próximos 7 días, en hora de Lima.
 */
import Link from "next/link";
import { requireUser } from "@/lib/portal/auth/session";
import { stageLabel } from "@/lib/portal/stages";
import { getPortalStore } from "@/lib/portal/store";
import type { Company } from "@/lib/portal/store/types";
import { appointmentWindow, selectToday } from "@/lib/portal/ui/today";
import { formatLimaDateTime, formatLimaDay, formatLimaTime } from "@/lib/portal/ui/time";
import { Flash } from "../_components/bits";

export const metadata = { title: "Hoy · Portal 360 Tyres" };

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function HoyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const store = await getPortalStore();
  const sp = await searchParams;
  const now = new Date();
  const { from, to } = appointmentWindow(now);
  const [opps, appointments] = await Promise.all([store.listOpportunities({ ownerId: user.id, open: true }), store.listAppointments({ userId: user.id, from, to })]);
  const today = selectToday(opps, appointments, now);
  const ids = [...new Set([...today.acciones.map((a) => a.opportunity.companyId), ...today.citas.flatMap((d) => d.citas.map((c) => c.companyId))])];
  const companies = new Map<number, Company>();
  for (const c of await Promise.all(ids.map((id) => store.getCompany(id)))) if (c) companies.set(c.id, c);
  const name = (id: number) => companies.get(id)?.razonSocial ?? `Empresa #${id}`;

  return (
    <div className="pt-stack">
      <div className="pt-page-head" style={{ marginBottom: 0 }}>
        <h1>Hoy</h1>
        <span className="pt-muted pt-small" style={{ textTransform: "capitalize" }}>
          {formatLimaDay(now)}
        </span>
      </div>
      <Flash aviso={str(sp.aviso)} error={str(sp.error)} />

      <div className="pt-today">
        <section className="pt-card" aria-labelledby="acciones-title">
          <h2 id="acciones-title">Próximas acciones</h2>
          {today.acciones.length === 0 ? (
            <p className="pt-muted">Nada pendiente para hoy. Las próximas acciones se fijan en la ficha de cada empresa (o desde el bot).</p>
          ) : (
            <ul className="pt-list">
              {today.acciones.map(({ opportunity: o, vencida }) => (
                <li key={o.id}>
                  <Link className="pt-company-link" href={`/portal/empresas/${o.companyId}`}>
                    {name(o.companyId)}
                  </Link>
                  <div>{o.proximaAccion || "(sin descripción)"}</div>
                  <div className="pt-small">
                    <span className={vencida ? "pt-overdue" : "pt-muted"}>
                      {vencida ? "Vencida · " : ""}
                      {formatLimaDateTime(o.proximaAccionAt!)}
                    </span>
                    <span className="pt-muted"> · {stageLabel(o.etapa)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="pt-card" aria-labelledby="citas-title">
          <h2 id="citas-title">Citas (hoy y próximos 7 días)</h2>
          {today.citas.length === 0 ? (
            <p className="pt-muted">Sin citas agendadas.</p>
          ) : (
            <div className="pt-stack" style={{ gap: "0.8rem" }}>
              {today.citas.map((d) => (
                <div key={d.day}>
                  <h3 style={{ textTransform: "capitalize" }}>
                    {d.esHoy ? "Hoy · " : ""}
                    {formatLimaDay(d.citas[0].startsAt)}
                  </h3>
                  <ul className="pt-list">
                    {d.citas.map((c) => (
                      <li key={c.id}>
                        <strong className="pt-mono">{formatLimaTime(c.startsAt)}</strong>{" "}
                        <Link className="pt-company-link" href={`/portal/empresas/${c.companyId}`}>
                          {name(c.companyId)}
                        </Link>
                        <div className="pt-small pt-muted">
                          {c.lugar ?? "Lugar por confirmar"}
                          {c.conTecnico && " · con técnico"}
                          {c.estado !== "programada" && ` · ${c.estado}`}
                        </div>
                        {c.notas && <div className="pt-small">{c.notas}</div>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
