/**
 * Bloque "Crédito" de la ficha (C4): estado, calificación, línea y plazo aprobados, fuente, fecha y autor de la consulta,
 * PDF del reporte, notas e historial. Edita el vendedor dueño o supervisor/admin (saveCompanyCredit vuelve a comprobarlo).
 * Aviso visible si la empresa tiene cotizaciones y su crédito está sin evaluar o rechazado.
 * Componente de servidor: lee el crédito y el historial por su cuenta (la ficha solo le pasa la empresa y el usuario).
 */
import { canEditCompany } from "@/lib/portal/auth/permissions";
import { CREDIT_ESTADOS, MAX_CREDIT_PDF_BYTES, MONEDAS, creditEstadoLabel, creditEstadoOf, defaultUpdateTerms, describeCreditChanges, fmtCreditAmount, needsCreditWarning, nextEstados } from "@/lib/portal/credit";
import { getPortalStore } from "@/lib/portal/store";
import type { Company, PortalUser } from "@/lib/portal/store/types";
import { formatLimaDateTime, formatLimaShort, limaDateKey } from "@/lib/portal/ui/time";
import { saveCompanyCredit } from "../actions";

type Props = {
  company: Pick<Company, "id" | "ownerUserId" | "creditTermsDays" | "razonSocial">;
  user: Pick<PortalUser, "id" | "rol" | "activo">;
};

export async function CreditBlock({ company, user }: Props) {
  const store = await getPortalStore();
  const [credit, history, users, opps] = await Promise.all([store.getCredit(company.id), store.creditHistory(company.id), store.listUsers(), store.listOpportunities({ companyId: company.id })]);
  const estado = creditEstadoOf(credit);
  const canEdit = canEditCompany(user, company);
  const userName = (uid: number | null) => (uid === null ? "—" : (users.find((u) => u.id === uid)?.nombre ?? `#${uid}`));
  const quotes = opps.filter((o) => o.quoteNumber && !o.closedAt).map((o) => o.quoteNumber!);
  const warn = needsCreditWarning(estado);
  const pdfHref = `/portal/empresas/${company.id}/credito/pdf`;

  return (
    <section className="pt-card" aria-labelledby="credito-title">
      <div className="pt-section-head">
        <h2 id="credito-title">Crédito</h2>
        <span className={`pt-credit-status pt-credit-${estado}`}>{creditEstadoLabel(estado)}</span>
      </div>

      {warn && (
        <p className={`pt-notice pt-small${estado === "rechazado" ? " pt-error" : ""}`} role="status" style={{ margin: "0 0 0.6rem" }}>
          {estado === "rechazado" ? "⛔ Crédito RECHAZADO" : "⚠️ Crédito sin evaluar"}
          {quotes.length > 0 ? ` y hay cotización${quotes.length === 1 ? "" : "es"} abierta${quotes.length === 1 ? "" : "s"} (${quotes.join(", ")}).` : "."}{" "}
          {estado === "rechazado" ? "No ofrezcas plazo sin revisar las notas." : "Evalúalo antes de dar plazo."}
        </p>
      )}

      <dl className="pt-credit-dl pt-small">
        <dt>Calificación</dt>
        <dd>{credit?.calificacion ?? "—"}</dd>
        <dt>Línea aprobada</dt>
        <dd>{fmtCreditAmount(credit?.linea, credit?.moneda)}</dd>
        <dt>Plazo aprobado</dt>
        <dd>{credit?.plazoDias === null || credit?.plazoDias === undefined ? "—" : `${credit.plazoDias} días`}</dd>
        <dt>Plazo habitual</dt>
        <dd>{company.creditTermsDays ? `${company.creditTermsDays} días` : "—"}</dd>
        <dt>Fuente</dt>
        <dd>{credit?.fuente ?? "—"}</dd>
        <dt>Consulta</dt>
        <dd>{credit?.consultadoAt ? `${formatLimaShort(credit.consultadoAt)} · ${userName(credit.consultadoPor)}` : "—"}</dd>
        <dt>Reporte PDF</dt>
        <dd>
          {!credit?.pdfName ? (
            "—"
          ) : canEdit ? (
            <a href={pdfHref}>{credit.pdfName}</a>
          ) : (
            <span>
              {credit.pdfName} <span className="pt-muted">(lo descarga el dueño o supervisor)</span>
            </span>
          )}
        </dd>
      </dl>
      {credit?.notas && <p className="pt-small" style={{ whiteSpace: "pre-line", margin: "0.5rem 0 0" }}>{credit.notas}</p>}

      {canEdit ? (
        <details style={{ marginTop: "0.7rem" }}>
          <summary className="pt-small">
            <strong>Editar crédito</strong>
          </summary>
          <form action={saveCompanyCredit} className="pt-stack" style={{ gap: "0.5rem", marginTop: "0.5rem" }}>
            <input type="hidden" name="companyId" value={company.id} />
            <div className="pt-form-grid">
              <label className="pt-field">
                Estado
                <select name="estado" defaultValue={estado}>
                  {nextEstados(estado).map((e) => (
                    <option key={e} value={e}>
                      {CREDIT_ESTADOS.find((s) => s.id === e)!.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="pt-field">
                Calificación
                <input type="text" name="calificacion" maxLength={60} defaultValue={credit?.calificacion ?? ""} />
              </label>
              <label className="pt-field">
                Línea aprobada
                <input type="text" name="linea" inputMode="decimal" maxLength={30} defaultValue={credit?.linea ?? ""} />
              </label>
              <label className="pt-field">
                Moneda
                <select name="moneda" defaultValue={credit?.moneda ?? "USD"}>
                  {MONEDAS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="pt-field">
                Plazo aprobado (días)
                <input type="number" name="plazoDias" min={0} max={365} step={1} defaultValue={credit?.plazoDias ?? ""} />
              </label>
              <label className="pt-field">
                Fuente
                <input type="text" name="fuente" maxLength={120} placeholder="manual, Equifax (PDF)…" defaultValue={credit?.fuente ?? "manual"} />
              </label>
              <label className="pt-field">
                Fecha de consulta
                <input type="date" name="consultadoAt" defaultValue={credit?.consultadoAt ? limaDateKey(credit.consultadoAt) : ""} />
              </label>
              <label className="pt-field">
                Reporte PDF (máx. {Math.round(MAX_CREDIT_PDF_BYTES / 1_000_000)} MB)
                <input type="file" name="pdf" accept="application/pdf,.pdf" />
              </label>
              <label className="pt-field" style={{ gridColumn: "1 / -1" }}>
                Notas (obligatorias si queda observado o rechazado)
                <textarea name="notas" maxLength={1000} defaultValue={credit?.notas ?? ""} />
              </label>
            </div>
            {credit?.pdfName && (
              <label className="pt-small">
                <input type="checkbox" name="quitarPdf" /> Quitar el PDF adjunto ({credit.pdfName})
              </label>
            )}
            <label className="pt-small">
              <input type="checkbox" name="actualizarPlazo" defaultChecked={defaultUpdateTerms(company)} /> Si queda aprobado, usar el plazo aprobado como plazo habitual de la
              empresa (lo propone el cotizador){company.creditTermsDays ? ` — hoy ${company.creditTermsDays} días` : ""}
            </label>
            <p className="pt-muted pt-small" style={{ margin: 0 }}>
              Aprobado exige línea y plazo. Rechazado solo vuelve a “en evaluación”.
            </p>
            <div className="pt-row">
              <button className="pt-btn pt-btn-sm pt-btn-dark" type="submit">
                Guardar crédito
              </button>
            </div>
          </form>
        </details>
      ) : (
        <p className="pt-muted pt-small" style={{ marginTop: "0.6rem" }}>
          Solo el dueño de la empresa (o supervisor) puede editar el crédito.
        </p>
      )}

      {history.length > 0 && (
        <details style={{ marginTop: "0.6rem" }}>
          <summary className="pt-small">Historial de crédito ({history.length})</summary>
          <ul className="pt-small" style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>
            {history.map((h) => (
              <li key={h.id}>
                <span className="pt-muted">
                  {formatLimaDateTime(h.createdAt)} · {userName(h.userId)}
                </span>
                <div>{describeCreditChanges(h.cambios, userName).join(" · ")}</div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
