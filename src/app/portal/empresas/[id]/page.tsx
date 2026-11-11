/**
 * Ficha de empresa: indicadores, flota por marca (dato MTC + medida inferida), dueño (Asignarme), temperatura,
 * oportunidad abierta, contactos, actividad y bloque de crédito.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { canEditCompany, canGeneratePrepropuesta } from "@/lib/portal/auth/permissions";
import { requireUser } from "@/lib/portal/auth/session";
import { STAGES, stageLabel } from "@/lib/portal/stages";
import { getPortalStore } from "@/lib/portal/store";
import { defaultSince } from "@/lib/portal/store/shared";
import type { Contact } from "@/lib/portal/store/types";
import { groupByBrand, yearRange } from "@/lib/portal/ui/fleet";
import { TEMPERATURAS, confianzaLabel, fmtInt, fmtMoney, rolLabel, sectorLabel } from "@/lib/portal/ui/labels";
import { canAssignSelf, canEditOpportunity, canReassign } from "@/lib/portal/ui/permissions";
import { formatLimaDateTime, toLimaLocalInput } from "@/lib/portal/ui/time";
import { addContact, assignCompany, deleteContact, moveOpportunityStage, releaseCompany, setNextAction, setTemperatura, updateContact } from "../../actions";
import { DemoTag, Flash, InferidaTag, MTC_LEGEND, MtcTag, TempChip } from "../../_components/bits";
import { CreditBlock } from "../../_components/CreditBlock";
import { SurveyBlock } from "./SurveyBlock";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export async function generateMetadata({ params }: Props) {
  const id = Number.parseInt((await params).id, 10);
  const company = Number.isSafeInteger(id) ? await (await getPortalStore()).getCompany(id) : null;
  return { title: `${company?.razonSocial ?? "Empresa"} · Portal 360 Tyres` };
}

function ContactFields({ c }: { c?: Contact }) {
  return (
    <div className="pt-form-grid">
      <label className="pt-field">
        Nombre *
        <input type="text" name="nombre" required maxLength={120} defaultValue={c?.nombre ?? ""} />
      </label>
      <label className="pt-field">
        Cargo
        <input type="text" name="cargo" maxLength={120} defaultValue={c?.cargo ?? ""} />
      </label>
      <label className="pt-field">
        Teléfono
        <input type="tel" name="telefono" maxLength={40} defaultValue={c?.telefono ?? ""} />
      </label>
      <label className="pt-field">
        Email
        <input type="email" name="email" maxLength={160} defaultValue={c?.email ?? ""} />
      </label>
      <label className="pt-field" style={{ gridColumn: "1 / -1" }}>
        Notas
        <textarea name="notas" maxLength={500} defaultValue={c?.notas ?? ""} />
      </label>
    </div>
  );
}

export default async function EmpresaPage({ params, searchParams }: Props) {
  const user = await requireUser();
  const id = Number.parseInt((await params).id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  const store = await getPortalStore();
  const company = await store.getCompany(id);
  if (!company) notFound();
  const sp = await searchParams;

  const [fleet, contacts, activities, opp, users, part] = await Promise.all([
    store.fleetByBrand(id),
    store.listContacts(id),
    store.listActivities({ companyId: id, limit: 30 }),
    store.getOpenOpportunity(id),
    store.listUsers(),
    store.participation([company.ruc], defaultSince()),
  ]);
  const history = opp ? await store.stageHistory(opp.id) : [];
  const brands = groupByBrand(fleet);
  const participacion = part[company.ruc] ?? { cantidad: 0, demo: false };
  const userName = (uid: number | null) => (uid === null ? "—" : (users.find((u) => u.id === uid)?.nombre ?? `#${uid}`));
  const canEdit = canEditCompany(user, company);
  const canAssign = canAssignSelf(user, company) && company.ownerUserId !== user.id;
  const reassign = canReassign(user);
  const canOpp = opp ? canEditOpportunity(user, opp, company) : false;
  const back = `/portal/empresas/${id}`;
  const totalLlantasConDato = brands.reduce((n, b) => n + b.unidadesConLlantas, 0);

  return (
    <div className="pt-stack">
      <div>
        <Link href="/portal" className="pt-small pt-muted">
          ← Prospectos
        </Link>
        <div className="pt-page-head" style={{ marginTop: "0.4rem", marginBottom: 0 }}>
          <div>
            <h1>{company.razonSocial}</h1>
            <div className="pt-muted pt-small pt-mono">
              RUC {company.ruc} · {sectorLabel(company.sector)} · {company.departamento ?? "—"} {company.esCliente && <span className="pt-tag pt-tag-client">cliente</span>}
            </div>
          </div>
          <div className="pt-row">
            <TempChip t={company.temperatura} />
            {/* route handler: descarga el PDF (Content-Disposition attachment) o vuelve aquí con ?error= si falta un dato */}
            {canGeneratePrepropuesta(user, company) && (
              <a className="pt-btn pt-btn-primary" href={`/portal/empresas/${company.id}/prepropuesta`}>
                Generar pre-propuesta
              </a>
            )}
          </div>
        </div>
      </div>

      <Flash aviso={str(sp.aviso)} error={str(sp.error)} />

      <div className="pt-kpis">
        <div className="pt-kpi">
          <div className="pt-kpi-label">
            Unidades <MtcTag />
          </div>
          <div className="pt-kpi-value">{fmtInt(company.unidades)}</div>
        </div>
        <div className="pt-kpi">
          <div className="pt-kpi-label">
            Llantas en piso <MtcTag />
          </div>
          <div className="pt-kpi-value">{fmtInt(company.llantasPiso)}</div>
          <div className="pt-kpi-sub">
            {fmtInt(totalLlantasConDato)} de {fmtInt(company.unidades)} unidades con dato
          </div>
        </div>
        <div className="pt-kpi">
          <div className="pt-kpi-label">Antigüedad media</div>
          <div className="pt-kpi-value">{company.antiguedadMedia === null ? "—" : `${fmtInt(Math.round(company.antiguedadMedia))} años`}</div>
        </div>
        <div className="pt-kpi">
          <div className="pt-kpi-label">Participación (12 meses) {participacion.demo && <DemoTag />}</div>
          <div className="pt-kpi-value">{fmtInt(participacion.cantidad)}</div>
          <div className="pt-kpi-sub">neumáticos vendidos · {fmtInt(company.llantasPiso)} llantas en piso</div>
        </div>
      </div>

      <p className="pt-legend">{MTC_LEGEND}</p>

      <div className="pt-ficha">
        <div className="pt-stack">
          <section className="pt-card" aria-labelledby="flota-title">
            <div className="pt-section-head">
              <h2 id="flota-title">Flota por marca</h2>
              <span className="pt-muted pt-small">{brands.length} marca{brands.length === 1 ? "" : "s"}</span>
            </div>
            {brands.length === 0 ? (
              <p className="pt-muted">Sin vehículos en el padrón.</p>
            ) : (
              <div className="pt-table-wrap">
                <table className="pt-table">
                  <thead>
                    <tr>
                      <th>Marca / clase</th>
                      <th>Años</th>
                      <th className="pt-num">Unidades</th>
                      <th className="pt-num">
                        Llantas <MtcTag label="dato MTC" />
                      </th>
                      <th>
                        Medida probable <InferidaTag />
                      </th>
                      <th>Confianza</th>
                    </tr>
                  </thead>
                  <tbody>
                    {brands.map((b) => [
                      <tr className="pt-brand-row" key={b.marca}>
                        <td>{b.marca}</td>
                        <td>{yearRange(b.anioMin, b.anioMax)}</td>
                        <td className="pt-num">{fmtInt(b.unidades)}</td>
                        <td className="pt-num">{fmtInt(b.llantas)}</td>
                        <td />
                        <td />
                      </tr>,
                      ...b.clases.map((g) => (
                        <tr key={`${b.marca}|${g.clase ?? ""}`}>
                          <td style={{ paddingLeft: "1.4rem" }}>{g.clase ?? "Sin clase"}</td>
                          <td>{yearRange(g.anioMin, g.anioMax)}</td>
                          <td className="pt-num">{fmtInt(g.unidades)}</td>
                          <td className="pt-num">
                            {fmtInt(g.llantas)}
                            {g.unidadesConLlantas < g.unidades && <div className="pt-muted pt-small">{fmtInt(g.unidadesConLlantas)} con dato</div>}
                          </td>
                          <td className="pt-mono">{g.medidaProbable ?? "—"}</td>
                          <td>{confianzaLabel(g.confianza)}</td>
                        </tr>
                      )),
                    ])}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="pt-card" aria-labelledby="contactos-title">
            <div className="pt-section-head">
              <h2 id="contactos-title">Contactos</h2>
              {!canEdit && <span className="pt-muted pt-small">Solo el dueño puede editar</span>}
            </div>
            {contacts.length === 0 ? (
              <p className="pt-muted">Sin contactos.</p>
            ) : (
              <ul className="pt-list">
                {contacts.map((c) => (
                  <li key={c.id}>
                    <strong>{c.nombre}</strong>
                    {c.cargo && <span className="pt-muted"> · {c.cargo}</span>}
                    <div className="pt-small">
                      {c.telefono && <a href={`tel:${c.telefono}`}>{c.telefono}</a>}
                      {c.telefono && c.email && " · "}
                      {c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
                    </div>
                    {c.notas && <div className="pt-small pt-muted">{c.notas}</div>}
                    {canEdit && (
                      <details style={{ marginTop: "0.4rem" }}>
                        <summary className="pt-small">Editar</summary>
                        <form action={updateContact} className="pt-stack" style={{ marginTop: "0.5rem", gap: "0.5rem" }}>
                          <input type="hidden" name="companyId" value={company.id} />
                          <input type="hidden" name="contactId" value={c.id} />
                          <ContactFields c={c} />
                          <div className="pt-row">
                            <button className="pt-btn pt-btn-sm pt-btn-dark" type="submit">
                              Guardar
                            </button>
                          </div>
                        </form>
                        <form action={deleteContact} style={{ marginTop: "0.4rem" }}>
                          <input type="hidden" name="companyId" value={company.id} />
                          <input type="hidden" name="contactId" value={c.id} />
                          <button className="pt-btn pt-btn-sm pt-btn-danger" type="submit">
                            Eliminar contacto
                          </button>
                        </form>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <details style={{ marginTop: "0.8rem" }} open={contacts.length === 0}>
                <summary>
                  <strong>Agregar contacto</strong>
                </summary>
                <form action={addContact} className="pt-stack" style={{ marginTop: "0.5rem", gap: "0.5rem" }}>
                  <input type="hidden" name="companyId" value={company.id} />
                  <ContactFields />
                  <div className="pt-row">
                    <button className="pt-btn pt-btn-primary" type="submit">
                      Agregar
                    </button>
                  </div>
                </form>
              </details>
            )}
          </section>

          <SurveyBlock company={company} user={user} searchParams={sp} />

          <section className="pt-card" aria-labelledby="actividad-title">
            <h2 id="actividad-title">Actividad</h2>
            {activities.length === 0 ? (
              <p className="pt-muted">Sin actividad registrada.</p>
            ) : (
              <ul className="pt-list">
                {activities.map((a) => (
                  <li key={a.id}>
                    <div className="pt-small pt-muted">
                      {formatLimaDateTime(a.occurredAt)} · {userName(a.userId)} · {a.tipo}
                      {a.canal ? ` · ${a.canal}` : ""}
                    </div>
                    <div>{a.texto || "—"}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="pt-stack">
          <section className="pt-card" aria-labelledby="dueno-title">
            <h2 id="dueno-title">Dueño</h2>
            <p>
              {company.ownerUserId === null ? <span className="pt-muted">Sin dueño</span> : <strong>{company.ownerUserId === user.id ? `Tú (${user.nombre})` : userName(company.ownerUserId)}</strong>}
            </p>
            {canAssign && (
              <form action={assignCompany}>
                <input type="hidden" name="companyId" value={company.id} />
                <button className="pt-btn pt-btn-primary" type="submit">
                  Asignarme
                </button>
              </form>
            )}
            {!canAssign && company.ownerUserId !== null && company.ownerUserId !== user.id && !reassign && <p className="pt-muted pt-small">Para reasignarla, pídeselo al supervisor.</p>}
            {reassign && (
              <div className="pt-stack" style={{ marginTop: "0.6rem", gap: "0.5rem" }}>
                <form action={assignCompany} className="pt-row">
                  <input type="hidden" name="companyId" value={company.id} />
                  <select name="userId" defaultValue={company.ownerUserId ?? ""} aria-label="Asignar a" style={{ flex: "1 1 160px", width: "auto" }}>
                    <option value="" disabled>
                      Asignar a…
                    </option>
                    {users
                      .filter((u) => u.activo && u.rol !== "tecnico")
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.nombre} ({rolLabel(u.rol)})
                        </option>
                      ))}
                  </select>
                  <button className="pt-btn" type="submit">
                    Asignar
                  </button>
                </form>
                {company.ownerUserId !== null && (
                  <form action={releaseCompany}>
                    <input type="hidden" name="companyId" value={company.id} />
                    <button className="pt-btn pt-btn-sm" type="submit">
                      Liberar (sin dueño)
                    </button>
                  </form>
                )}
              </div>
            )}
          </section>

          <section className="pt-card" aria-labelledby="temp-title">
            <h2 id="temp-title">Temperatura</h2>
            {canEdit ? (
              <form action={setTemperatura} className="pt-row">
                <input type="hidden" name="companyId" value={company.id} />
                <select name="temperatura" defaultValue={company.temperatura ?? ""} aria-label="Temperatura" style={{ flex: "1 1 140px", width: "auto" }}>
                  <option value="">Sin temperatura</option>
                  {TEMPERATURAS.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <button className="pt-btn" type="submit">
                  Guardar
                </button>
              </form>
            ) : (
              <p>
                <TempChip t={company.temperatura} /> <span className="pt-muted pt-small">Solo el dueño puede cambiarla.</span>
              </p>
            )}
          </section>

          <section className="pt-card" aria-labelledby="opp-title">
            <h2 id="opp-title">Oportunidad</h2>
            {!opp ? (
              <p className="pt-muted">Sin oportunidad abierta.{canAssign ? " Se crea al asignarte la empresa." : ""}</p>
            ) : (
              <div className="pt-stack" style={{ gap: "0.6rem" }}>
                <div>
                  <strong>{stageLabel(opp.etapa)}</strong> <span className="pt-muted">· {opp.probabilidad} %</span>
                  <div className="pt-small pt-muted">
                    Dueño: {userName(opp.ownerUserId)}
                    {opp.montoEstimado !== null && ` · ${fmtMoney(opp.montoEstimado)}`}
                    {opp.quoteNumber && ` · cotización ${opp.quoteNumber}`}
                  </div>
                  {opp.proximaAccion && (
                    <div className="pt-small">
                      Próxima acción: {opp.proximaAccion}
                      {opp.proximaAccionAt && ` (${formatLimaDateTime(opp.proximaAccionAt)})`}
                    </div>
                  )}
                </div>
                {canOpp && (
                  <>
                    <form action={moveOpportunityStage} className="pt-row">
                      <input type="hidden" name="opportunityId" value={opp.id} />
                      <input type="hidden" name="volver" value={back} />
                      <select name="etapa" defaultValue={opp.etapa} aria-label="Etapa" style={{ flex: "1 1 160px", width: "auto" }}>
                        {STAGES.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label} ({s.probabilidad} %)
                          </option>
                        ))}
                      </select>
                      <button className="pt-btn" type="submit">
                        Mover
                      </button>
                    </form>
                    <details>
                      <summary className="pt-small">Próxima acción</summary>
                      <form action={setNextAction} className="pt-stack" style={{ gap: "0.5rem", marginTop: "0.5rem" }}>
                        <input type="hidden" name="opportunityId" value={opp.id} />
                        <input type="hidden" name="volver" value={back} />
                        <label className="pt-field">
                          Qué hacer
                          <input type="text" name="proximaAccion" maxLength={300} defaultValue={opp.proximaAccion ?? ""} />
                        </label>
                        <label className="pt-field">
                          Cuándo (hora de Lima)
                          <input type="datetime-local" name="proximaAccionAt" defaultValue={toLimaLocalInput(opp.proximaAccionAt)} />
                        </label>
                        <div className="pt-row">
                          <button className="pt-btn pt-btn-sm pt-btn-dark" type="submit">
                            Guardar
                          </button>
                        </div>
                      </form>
                    </details>
                  </>
                )}
                {history.length > 0 && (
                  <details>
                    <summary className="pt-small">Historial de etapas</summary>
                    <ul className="pt-small" style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>
                      {history.map((h) => (
                        <li key={h.id}>
                          {stageLabel(h.etapa)}: {formatLimaDateTime(h.enteredAt)}
                          {h.leftAt ? ` → ${formatLimaDateTime(h.leftAt)}` : " (actual)"}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </section>

          <CreditBlock company={company} user={user} />
        </div>
      </div>
    </div>
  );
}
