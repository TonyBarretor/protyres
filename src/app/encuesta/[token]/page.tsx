/**
 * Encuesta de satisfacción pública: /encuesta/<token>. Sin sesión (el token de 32 bytes es la credencial; en la base solo
 * su sha256), una sola respuesta, apta para celular y sin JavaScript (formulario + server action). Un script mínimo solo
 * desactiva las casillas de la pregunta 2 al llegar a 3; el límite real lo valida el servidor.
 */
import { getPortalStore } from "@/lib/portal/store";
import { MAX_MEJORAR, MAX_VALORA, SATISFACCION_LABELS, SURVEY_ERROR_TEXT, SURVEY_QUESTIONS, VALORA_OPTIONS, type SurveyFieldError } from "@/lib/portal/survey/questions";
import { openSurvey } from "@/lib/portal/survey/service";
import { submitSurveyAction } from "./actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const LIMIT_SCRIPT = `(function(){var f=document.getElementById("sv-valora");if(!f)return;var b=f.querySelectorAll("input[type=checkbox]");function u(){var n=0;b.forEach(function(x){if(x.checked)n++});b.forEach(function(x){x.disabled=!x.checked&&n>=${MAX_VALORA}})}b.forEach(function(x){x.addEventListener("change",u)});u()})();`;

function Done({ title, text }: { title: string; text: string }) {
  return (
    <div className="sv-card sv-done">
      <div className="sv-done-mark" aria-hidden="true">
        ✓
      </div>
      <h1>{title}</h1>
      <p className="sv-muted">{text}</p>
    </div>
  );
}

export default async function EncuestaPage({ params, searchParams }: Props) {
  const { token } = await params;
  const sp = await searchParams;
  const store = await getPortalStore();
  const open = await openSurvey(store, token);

  if (open.status === "invalida") {
    return (
      <div className="sv-card">
        <h1>Enlace no válido</h1>
        <p className="sv-muted">Revise que el enlace esté completo. Si el problema sigue, pida uno nuevo a su ejecutivo de 360 Tyres.</p>
      </div>
    );
  }
  const razonSocial = open.company?.razonSocial ?? "";
  if (open.status === "respondida") {
    const recien = str(sp.r) === "ok";
    return <Done title={recien ? "¡Gracias por su respuesta!" : "Gracias, ya recibimos su respuesta"} text={recien ? "Ya recibimos su respuesta. Nos ayuda a atenderle mejor." : `La encuesta${razonSocial ? ` de ${razonSocial}` : ""} ya fue respondida. No hace falta enviarla de nuevo.`} />;
  }
  if (open.status === "vencida") {
    return (
      <div className="sv-card">
        <h1>Este enlace venció</h1>
        <p className="sv-muted">Si desea darnos su opinión, escriba a su ejecutivo de 360 Tyres y le enviaremos un enlace nuevo.</p>
      </div>
    );
  }

  const errors = (str(sp.error) ?? "")
    .split(",")
    .filter((e): e is SurveyFieldError => e in SURVEY_ERROR_TEXT);

  return (
    <>
      <div className="sv-card">
        <h1>¿Cómo le fue con 360 Tyres?</h1>
        {razonSocial && <p className="sv-company">{razonSocial}</p>}
        <p className="sv-muted sv-small">5 preguntas · menos de 2 minutos. Sus respuestas solo las ve el equipo de 360 Tyres.</p>
      </div>

      {errors.length > 0 && (
        <div className="sv-notice sv-error" role="alert">
          Revise su respuesta:
          <ul>
            {errors.map((e) => (
              <li key={e}>{SURVEY_ERROR_TEXT[e]}</li>
            ))}
          </ul>
        </div>
      )}

      <form action={submitSurveyAction}>
        <input type="hidden" name="token" value={token} />

        <div className="sv-card">
          <fieldset className="sv-q">
            <legend>
              <span className="sv-num">1</span>
              {SURVEY_QUESTIONS.nps}
            </legend>
            <div className="sv-scale">
              {Array.from({ length: 11 }, (_, n) => (
                <label className="sv-opt" key={n}>
                  <input type="radio" name="nps" value={n} required aria-label={`${n}`} />
                  <span>{n}</span>
                </label>
              ))}
            </div>
            <div className="sv-scale-ends">
              <span>0 · Nada probable</span>
              <span>10 · Muy probable</span>
            </div>
          </fieldset>
        </div>

        <div className="sv-card">
          <fieldset className="sv-q" id="sv-valora">
            <legend>
              <span className="sv-num">2</span>
              {SURVEY_QUESTIONS.valora}
            </legend>
            <div className="sv-checks">
              {VALORA_OPTIONS.map((o) => (
                <label className="sv-check" key={o.id}>
                  <input type="checkbox" name="valora" value={o.id} />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="sv-card">
          <fieldset className="sv-q">
            <legend>
              <span className="sv-num">3</span>
              {SURVEY_QUESTIONS.satisfaccion}
            </legend>
            <div className="sv-scale sv-scale-5">
              {[1, 2, 3, 4, 5].map((n) => (
                <label className="sv-opt" key={n}>
                  <input type="radio" name="satisfaccion" value={n} required aria-label={`${n} · ${SATISFACCION_LABELS[n]}`} />
                  <span>{n}</span>
                </label>
              ))}
            </div>
            <div className="sv-scale-ends">
              <span>1 · {SATISFACCION_LABELS[1]}</span>
              <span>5 · {SATISFACCION_LABELS[5]}</span>
            </div>
          </fieldset>
        </div>

        <div className="sv-card">
          <label className="sv-q" htmlFor="sv-mejorar">
            <span className="sv-label">
              <span className="sv-num">4</span>
              {SURVEY_QUESTIONS.mejorar} <span className="sv-muted sv-small">(opcional)</span>
            </span>
          </label>
          <textarea id="sv-mejorar" name="mejorar" maxLength={MAX_MEJORAR} placeholder="Escriba aquí su comentario" />
        </div>

        <div className="sv-card">
          <fieldset className="sv-q">
            <legend>
              <span className="sv-num">5</span>
              {SURVEY_QUESTIONS.referencia}
            </legend>
            <div className="sv-yesno">
              <label className="sv-opt">
                <input type="radio" name="referencia" value="si" required />
                <span>Sí</span>
              </label>
              <label className="sv-opt">
                <input type="radio" name="referencia" value="no" required />
                <span>No</span>
              </label>
            </div>
          </fieldset>
        </div>

        <button className="sv-submit" type="submit">
          Enviar respuesta
        </button>
      </form>
      <script dangerouslySetInnerHTML={{ __html: LIMIT_SCRIPT }} />
      <p className="sv-foot">360 by Professional Tyres</p>
    </>
  );
}
