/**
 * Corrida K, punto 4 — "Planificar visitas" (/portal/match/planificar?v=<empresa>:<código>&v=…): reparto propuesto por
 * día (proposeVisitPlan: agrupa por departamento, provincia y distrito, match.visitasPorDia por día, lunes a sábado sin
 * feriados; no calcula rutas). Cada visita se puede mover de día y ponerle hora antes de confirmar; al confirmar se
 * agenda cada una con scheduleMatchVisit (confirmPlan). Sin JavaScript.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/portal/auth/session";
import { loadPortalConfig } from "@/lib/portal/config";
import { loadMatchStock, productLabel, proposeVisitPlan, zoneLabel, type PlanCompany } from "@/lib/portal/match";
import { getPortalStore } from "@/lib/portal/store";
import type { Company } from "@/lib/portal/store/types";
import { canUseMatch, dayLabel, MATCH_PATH, MAX_PLAN, parsePlanPicks, planDayChoices, safeMatchBack, titleCase } from "@/lib/portal/ui/match";
import { addDays } from "@/lib/portal/ui/time";
import { Flash } from "../../_components/bits";
import { confirmPlan } from "../actions";
import "../match.css";

export const metadata = { title: "Planificar visitas · Portal 360 Tyres" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const all = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function PlanificarPage({ searchParams }: Props) {
  const user = await requireUser();
  if (!canUseMatch(user)) notFound();
  const sp = await searchParams;
  const back = safeMatchBack(str(sp.volver) ?? MATCH_PATH);
  const picks = parsePlanPicks(all(sp.v));
  const tooMany = picks.length >= MAX_PLAN;
  const store = await getPortalStore();
  const cfg = loadPortalConfig();
  const now = new Date();
  const companies = (await Promise.all(picks.map((p) => store.getCompany(p.companyId)))).filter((c): c is Company => !!c);
  // un vendedor no planifica empresas de otro vendedor (no las ve en Match Venta)
  const visible = companies.filter((c) => user.rol !== "vendedor" || c.ownerUserId === null || c.ownerUserId === user.id);
  const codeOf = new Map(picks.map((p) => [p.companyId, p.code]));
  const { stock } = await loadMatchStock({ store, prices: null });
  const label = new Map(stock.map((s) => [s.code, productLabel(s)]));
  const plan = proposeVisitPlan(
    visible.map((c): PlanCompany => ({ companyId: c.id, razonSocial: c.razonSocial, departamento: c.departamento, provincia: c.provincia ?? null, distrito: c.distrito ?? null, productCode: codeOf.get(c.id) })),
    { start: addDays(now, 1), perDay: cfg.match.visitasPorDia, holidays: cfg.holidays },
  );
  const days = planDayChoices(now, cfg.holidays, 14);
  const dayKeys = new Set(days.map((d) => d.key));
  const extra = plan.map((d) => d.fecha).filter((k) => !dayKeys.has(k));
  const choices = [...days, ...extra.map((k) => ({ key: k, label: dayLabel(k) }))];

  return (
    <div className="pt-stack mv-page" style={{ maxWidth: 760 }}>
      <Link href={back} className="pt-small pt-muted">
        ← Volver a Match Venta
      </Link>
      <div>
        <h1 style={{ marginBottom: "0.2rem" }}>Planificar visitas</h1>
        <p className="pt-small pt-muted" style={{ margin: 0 }}>
          Reparto propuesto: {cfg.match.visitasPorDia} visitas por día, juntando las empresas de la misma zona (departamento y distrito). No calcula rutas. Mueve cada visita
          al día que quieras y ponle hora si ya la sabes (sin hora, 9:00); luego confirma.
        </p>
      </div>
      <Flash error={str(sp.error)} />
      {tooMany && <p className="pt-notice">Se planifican hasta {MAX_PLAN} empresas a la vez.</p>}
      {companies.length > visible.length && <p className="pt-notice">{companies.length - visible.length} empresas ya son de otro vendedor: no entran en tu plan.</p>}
      {!plan.length ? (
        <p className="pt-notice">
          No hay empresas marcadas. Vuelve a la lista, marca las que quieras visitar con «Planificar» y toca <b>Planificar visitas</b>.
        </p>
      ) : (
        <form action={confirmPlan} className="mv-plan">
          <input type="hidden" name="volver" value={`${MATCH_PATH}/planificar?${new URLSearchParams([...picks.map((p): [string, string] => ["v", `${p.companyId}:${p.code}`]), ["volver", back]]).toString()}`} />
          {plan.map((d) => (
            <section key={d.fecha} className="pt-card mv-plan-day" aria-label={dayLabel(d.fecha)}>
              <h2>{dayLabel(d.fecha)}</h2>
              <p className="pt-small pt-muted" style={{ margin: 0 }}>
                {d.zonas.map(titleCase).join(" · ")}
              </p>
              {d.visitas.map((v) => (
                <div key={v.companyId} className="mv-plan-item">
                  <input type="hidden" name="v" value={`${v.companyId}:${v.productCode}`} />
                  <div>
                    <strong>{v.razonSocial}</strong>
                    <div className="pt-small pt-muted">
                      {titleCase(zoneLabel(v))} · ofrecer {label.get(v.productCode ?? "") ?? v.productCode}
                    </div>
                  </div>
                  <div className="mv-plan-fields">
                    <label className="pt-field">
                      Día
                      <select name={`d${v.companyId}`} defaultValue={d.fecha}>
                        {choices.map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="pt-field">
                      Hora (opcional)
                      <input type="time" name={`h${v.companyId}`} step={900} />
                    </label>
                  </div>
                </div>
              ))}
            </section>
          ))}
          <div className="pt-row">
            <button type="submit" className="pt-btn pt-btn-primary">
              Confirmar {plan.reduce((n, d) => n + d.visitas.length, 0)} visitas
            </button>
            <Link className="pt-btn" href={back}>
              Cancelar
            </Link>
          </div>
          <p className="pt-small pt-muted" style={{ margin: 0 }}>
            Al confirmar, las empresas sin dueño quedan asignadas a ti y cada visita aparece en Hoy con su motivo.
          </p>
        </form>
      )}
    </div>
  );
}
