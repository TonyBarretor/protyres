/**
 * Pipeline: tablero por etapa. El vendedor ve las suyas; supervisor/admin todas (filtro por vendedor con ?vendedor=id).
 * Mover de etapa = server action moveOpportunityStage (guarda historial con moveStage).
 */
import Link from "next/link";
import { canSeeAll } from "@/lib/portal/auth/permissions";
import { requireUser } from "@/lib/portal/auth/session";
import { STAGES } from "@/lib/portal/stages";
import { getPortalStore } from "@/lib/portal/store";
import type { Company } from "@/lib/portal/store/types";
import { fmtInt, fmtMoney } from "@/lib/portal/ui/labels";
import { canEditOpportunity } from "@/lib/portal/ui/permissions";
import { CLOSED_WINDOW_DAYS, groupPipeline, pipelineTotals } from "@/lib/portal/ui/pipeline";
import { formatLimaDateTime } from "@/lib/portal/ui/time";
import { moveOpportunityStage } from "../actions";
import { Flash, TempChip } from "../_components/bits";

export const metadata = { title: "Pipeline · Portal 360 Tyres" };

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function PipelinePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const store = await getPortalStore();
  const sp = await searchParams;
  const all = canSeeAll(user);
  const vendedorParam = Number.parseInt(str(sp.vendedor) ?? "", 10);
  const ownerId = all ? (Number.isSafeInteger(vendedorParam) && vendedorParam > 0 ? vendedorParam : undefined) : user.id;

  const [opps, users] = await Promise.all([store.listOpportunities(ownerId === undefined ? {} : { ownerId }), store.listUsers()]);
  const cols = groupPipeline(opps, { ownerId });
  const shownCompanyIds = [...new Set(cols.flatMap((c) => c.items.map((o) => o.companyId)))];
  const companies = new Map<number, Company>();
  for (const c of await Promise.all(shownCompanyIds.map((id) => store.getCompany(id)))) if (c) companies.set(c.id, c);
  const totals = pipelineTotals(cols);
  const userName = (uid: number | null) => (uid === null ? "Sin dueño" : (users.find((u) => u.id === uid)?.nombre ?? `#${uid}`));
  const back = `/portal/pipeline${ownerId !== undefined && all ? `?vendedor=${ownerId}` : ""}`;

  return (
    <div className="pt-stack">
      <div className="pt-page-head" style={{ marginBottom: 0 }}>
        <h1>Pipeline</h1>
        <span className="pt-muted pt-small">
          {fmtInt(totals.abiertas)} abiertas{totals.monto > 0 && ` · ${fmtMoney(totals.monto)} estimado · ${fmtMoney(totals.ponderado)} ponderado`}
        </span>
      </div>

      {all && (
        <form method="get" action="/portal/pipeline" className="pt-row">
          <label className="pt-field" style={{ minWidth: 220 }}>
            Vendedor
            <select name="vendedor" defaultValue={ownerId ?? ""}>
              <option value="">Todos</option>
              {users
                .filter((u) => u.rol !== "tecnico")
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.nombre}
                  </option>
                ))}
            </select>
          </label>
          <button className="pt-btn" type="submit" style={{ alignSelf: "end" }}>
            Ver
          </button>
        </form>
      )}

      <Flash aviso={str(sp.aviso)} error={str(sp.error)} />

      {opps.length === 0 && (
        <p className="pt-notice">
          {all ? "No hay oportunidades." : "Aún no tienes oportunidades."} Se crean al pulsar <strong>Asignarme</strong> en la ficha de una empresa (
          <Link href="/portal">Prospectos</Link>).
        </p>
      )}

      <div className="pt-board">
        {cols.map((col) => (
          <section className="pt-col" key={col.id} aria-label={col.label}>
            <div className="pt-col-head">
              <h2>{col.label}</h2>
              <span className="pt-col-prob">{col.probabilidad} %</span>
            </div>
            <div className="pt-small pt-muted">
              {fmtInt(col.items.length)} oportunidad{col.items.length === 1 ? "" : "es"}
              {col.monto > 0 && ` · ${fmtMoney(col.monto)}`}
              {col.closed && ` · últimos ${CLOSED_WINDOW_DAYS} días`}
            </div>
            {col.items.map((o) => {
              const company = companies.get(o.companyId);
              const editable = canEditOpportunity(user, o, company);
              return (
                <article className="pt-opp" key={o.id}>
                  <div className="pt-row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                    <Link className="pt-company-link" href={`/portal/empresas/${o.companyId}`}>
                      {company?.razonSocial ?? `Empresa #${o.companyId}`}
                    </Link>
                    {company && <TempChip t={company.temperatura} />}
                  </div>
                  <div className="pt-small pt-muted">
                    {all && `${userName(o.ownerUserId)} · `}
                    {company ? `${fmtInt(company.unidades)} unidades` : ""}
                    {o.montoEstimado !== null && ` · ${fmtMoney(o.montoEstimado)}`}
                  </div>
                  {o.proximaAccion && (
                    <div className="pt-small">
                      → {o.proximaAccion}
                      {o.proximaAccionAt && <span className="pt-muted"> ({formatLimaDateTime(o.proximaAccionAt)})</span>}
                    </div>
                  )}
                  {editable && (
                    <form action={moveOpportunityStage}>
                      <input type="hidden" name="opportunityId" value={o.id} />
                      <input type="hidden" name="volver" value={back} />
                      <select name="etapa" defaultValue={o.etapa} aria-label="Mover a etapa">
                        {STAGES.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                      <button className="pt-btn pt-btn-sm" type="submit">
                        Mover
                      </button>
                    </form>
                  )}
                </article>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
