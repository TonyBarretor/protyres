/**
 * Sección "Encuestas" de la ficha (bloque C3): resultados (NPS, lo más valorado, comentarios, si autoriza la referencia),
 * últimas encuestas y el botón "Enviar encuesta" en dos pasos (vista previa por GET → confirmar con server action).
 * Funciona sin JavaScript.
 */
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { canEditCompany } from "@/lib/portal/auth/permissions";
import { loadPortalConfig } from "@/lib/portal/config";
import { surveyCounts } from "@/lib/portal/store/survey-shared";
import type { Company, PortalUser, SurveyCanal, SurveyEstado } from "@/lib/portal/store/types";
import { chooseContact, manualSurveyWarnings, previewManualSurvey } from "@/lib/portal/survey/manual";
import { forwardText } from "@/lib/portal/survey/messages";
import { SATISFACCION_LABELS, valoraLabel } from "@/lib/portal/survey/questions";
import { monthsBefore } from "@/lib/portal/survey/select";
import { npsGroup, summarizeSurveys } from "@/lib/portal/survey/summary";
import { surveyUrl } from "@/lib/portal/survey/tokens";
import { getPortalStore } from "@/lib/portal/store";
import { formatLimaShort } from "@/lib/portal/ui/time";
import { sendSurveyAction } from "./survey-actions";
import { parseSurveyLinkCookie, SURVEY_LINK_COOKIE } from "./survey-link";

const ESTADO: Record<SurveyEstado, string> = { pendiente: "pendiente", enviada: "enviada", respondida: "respondida", vencida: "vencida" };
const CANAL: Record<SurveyCanal, string> = { email: "correo", whatsapp_vendedor: "WhatsApp del vendedor", manual: "enlace manual" };
const GROUP: Record<string, string> = { promotor: "promotor", pasivo: "pasivo", detractor: "detractor" };

type Sp = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export async function SurveyBlock({ company, user, searchParams }: { company: Company; user: PortalUser; searchParams: Sp }) {
  const store = await getPortalStore();
  const cfg = loadPortalConfig().surveys;
  const [responses, surveys, contacts] = await Promise.all([store.listSurveyResponses({ companyId: company.id }), store.listSurveys({ companyId: company.id, limit: 5 }), store.listContacts(company.id)]);
  const s = summarizeSurveys(responses, { maxComentarios: 3 });
  const canEdit = canEditCompany(user, company);
  const step = str(searchParams.encuesta);
  const here = `/portal/empresas/${company.id}`;
  const contactName = (id: number | null) => (id === null ? null : (contacts.find((c) => c.id === id)?.nombre ?? null));

  let manual: ReactNode = null;
  if (canEdit && step === "listo") {
    const id = Number(str(searchParams.s));
    const token = Number.isSafeInteger(id) ? parseSurveyLinkCookie((await cookies()).get(SURVEY_LINK_COOKIE)?.value, id) : null;
    const survey = token ? await store.getSurvey(id) : null;
    if (token && survey && survey.companyId === company.id) {
      const url = surveyUrl(token);
      const text = forwardText({ razonSocial: company.razonSocial, url, expiresAt: survey.expiresAt, contactName: contactName(survey.contactId), sellerName: user.nombre });
      manual = (
        <div className="pt-stack" style={{ gap: "0.5rem", marginTop: "0.8rem" }}>
          <strong>Enlace listo para reenviar</strong>
          <label className="pt-field">
            Enlace (vence el {formatLimaShort(survey.expiresAt)})
            <input type="text" readOnly value={url} />
          </label>
          <label className="pt-field">
            Mensaje para el cliente
            <textarea readOnly rows={6} value={text} />
          </label>
          <div className="pt-row">
            <a className="pt-btn pt-btn-primary" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer">
              Abrir en WhatsApp
            </a>
            <a className="pt-btn pt-btn-sm" href={`${here}#encuestas`}>
              Listo
            </a>
          </div>
          <p className="pt-small pt-muted">El enlace solo se muestra ahora (por seguridad no se guarda). Si lo pierdes, crea otra encuesta.</p>
        </div>
      );
    } else {
      manual = <p className="pt-small pt-muted">El enlace ya no está disponible (se muestra 10 minutos). Si no lo copiaste, crea otra encuesta.</p>;
    }
  } else if (canEdit && step === "vista") {
    const wanted = Number(str(searchParams.contacto));
    const contact = chooseContact(contacts, Number.isSafeInteger(wanted) && wanted > 0 ? wanted : null);
    const now = new Date();
    const preview = previewManualSurvey(company, contact, user, cfg.expiresDays, process.env, now);
    const [recent, avisos] = await Promise.all([
      store.listSurveys({ companyId: company.id, since: monthsBefore(now, cfg.cooldownMonths) }).then((l) => l.find((x) => surveyCounts(x, now))),
      manualSurveyWarnings(store, company, now),
    ]);
    manual = (
      <div className="pt-stack" style={{ gap: "0.5rem", marginTop: "0.8rem" }}>
        <strong>Vista previa</strong>
        {avisos.map((a) => (
          <p key={a} className="pt-notice pt-small">
            {a} Puedes enviarla igual.
          </p>
        ))}
        {recent && (
          <p className="pt-notice pt-small">
            Ya hay una encuesta del {formatLimaShort(recent.createdAt)} ({ESTADO[recent.estado]}). La invitación automática no repite antes de {cfg.cooldownMonths} meses.
          </p>
        )}
        {preview.mode === "email" ? (
          <>
            <p className="pt-small">
              Se enviará por <strong>correo</strong> a {preview.contact.nombre} ({preview.to}).
            </p>
            {preview.modoPrueba && <p className="pt-notice pt-small">{preview.modoPrueba}</p>}
            <div className="pt-small pt-muted">Asunto: {preview.email.subject}</div>
            <pre className="pt-small" style={{ whiteSpace: "pre-wrap", background: "var(--bg)", padding: "0.6rem", borderRadius: 8, margin: 0, fontFamily: "inherit" }}>
              {preview.email.text}
            </pre>
          </>
        ) : (
          <>
            <p className="pt-small">
              {preview.motivo} Al confirmar te muestro el <strong>enlace y el texto</strong> para reenviarlo por WhatsApp:
            </p>
            <pre className="pt-small" style={{ whiteSpace: "pre-wrap", background: "var(--bg)", padding: "0.6rem", borderRadius: 8, margin: 0, fontFamily: "inherit" }}>
              {preview.text}
            </pre>
          </>
        )}
        <form action={sendSurveyAction} className="pt-row">
          <input type="hidden" name="companyId" value={company.id} />
          {preview.contact && <input type="hidden" name="contactId" value={preview.contact.id} />}
          <button className="pt-btn pt-btn-primary" type="submit">
            {preview.mode === "email" ? "Confirmar y enviar" : "Confirmar y crear enlace"}
          </button>
          <a className="pt-btn pt-btn-sm" href={`${here}#encuestas`}>
            Cancelar
          </a>
        </form>
      </div>
    );
  } else if (canEdit) {
    const def = chooseContact(contacts, null);
    manual = (
      <form method="get" action={`${here}#encuestas`} className="pt-row" style={{ marginTop: "0.8rem" }}>
        <input type="hidden" name="encuesta" value="vista" />
        {contacts.length > 0 && (
          <select name="contacto" defaultValue={def?.id ?? ""} aria-label="Contacto" style={{ flex: "1 1 180px", width: "auto" }}>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
                {c.email ? ` · ${c.email}` : " · sin correo"}
              </option>
            ))}
          </select>
        )}
        <button className="pt-btn" type="submit">
          Enviar encuesta
        </button>
      </form>
    );
  }

  return (
    <section className="pt-card" id="encuestas" aria-labelledby="encuestas-title">
      <div className="pt-section-head">
        <h2 id="encuestas-title">Encuestas</h2>
        <span className="pt-muted pt-small">
          {s.respuestas} respuesta{s.respuestas === 1 ? "" : "s"}
        </span>
      </div>
      {s.respuestas === 0 ? (
        <p className="pt-muted">Sin respuestas todavía.</p>
      ) : (
        <>
          <p>
            Recomendación promedio <strong>{s.promedio?.toFixed(1)}</strong> / 10 · NPS <strong>{s.nps}</strong>
            <span className="pt-muted pt-small">
              {" "}
              ({s.promotores} promotor{s.promotores === 1 ? "" : "es"}, {s.pasivos} pasivo{s.pasivos === 1 ? "" : "s"}, {s.detractores} detractor{s.detractores === 1 ? "" : "es"})
            </span>
          </p>
          {s.valorado.length > 0 && <p className="pt-small">Lo más valorado: {s.valorado.map((v) => `${v.opcion} (${v.veces})`).join(", ")}</p>}
          <ul className="pt-list">
            {responses.slice(0, 5).map((r) => (
              <li key={r.id}>
                <div className="pt-small pt-muted">
                  {formatLimaShort(r.createdAt)}
                  {contactName(r.contactId) ? ` · ${contactName(r.contactId)}` : ""}
                </div>
                <div>
                  Recomendación <strong>{r.nps}</strong>/10 <span className="pt-muted pt-small">({GROUP[npsGroup(r.nps)]})</span>
                  {r.satisfaccionEntrega !== null && (
                    <>
                      {" "}
                      · Última entrega {r.satisfaccionEntrega}/5 <span className="pt-muted pt-small">({SATISFACCION_LABELS[r.satisfaccionEntrega]})</span>
                    </>
                  )}
                </div>
                {r.valora.length > 0 && <div className="pt-small">Valora: {r.valora.map(valoraLabel).join(", ")}</div>}
                {r.mejorar && <div className="pt-small">Mejorar: «{r.mejorar}»</div>}
                <div className="pt-small pt-muted">Autoriza citarla como referencia: {r.referencia === null ? "—" : r.referencia ? <strong style={{ color: "var(--ok)" }}>sí</strong> : "no"}</div>
              </li>
            ))}
          </ul>
        </>
      )}
      {surveys.length > 0 && (
        <details style={{ marginTop: "0.6rem" }}>
          <summary className="pt-small">Últimas encuestas</summary>
          <ul className="pt-small" style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>
            {surveys.map((sv) => (
              <li key={sv.id}>
                {formatLimaShort(sv.createdAt)} · {ESTADO[sv.estado]} · {CANAL[sv.canal]}
                {contactName(sv.contactId) ? ` · ${contactName(sv.contactId)}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
      {manual}
    </section>
  );
}
