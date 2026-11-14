/**
 * Bloque "Por qué este nivel" de la ficha (corrida G, punto 4): cada factor en palabras con su fuerza (palabra y barra,
 * sin puntos ni pesos), los frenos y la nota de que es una estimación. Sin puntaje: lo dice.
 */
import { ESTIMATE_NOTE, explainWhy, STRENGTH_LABEL } from "@/lib/portal/scoring/explain";
import type { Company } from "@/lib/portal/store/types";
import { NivelBadge } from "../../_components/bits";

export function WhyLevel({ company }: { company: Pick<Company, "nivel" | "score" | "scoreDetalle"> }) {
  const why = explainWhy(company.scoreDetalle);
  const calculated = !!company.nivel && company.score !== null && why.factores.length > 0;
  return (
    <section className="pt-card" aria-labelledby="nivel-title">
      <div className="pt-section-head">
        <h2 id="nivel-title">Por qué este nivel</h2>
        <NivelBadge nivel={calculated ? company.nivel : null} />
      </div>
      {!calculated ? (
        <p className="pt-muted">El nivel de esta empresa aún no se ha calculado. Se calcula con el padrón y las ventas cargadas; aparecerá en el próximo cálculo.</p>
      ) : (
        <>
          <p className="pt-small pt-muted">{ESTIMATE_NOTE}</p>
          {why.frenos.length > 0 && (
            <ul className="pt-why-brakes">
              {why.frenos.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          <ul className="pt-why">
            {why.factores.map((f) => (
              <li key={f.id}>
                <div className="pt-why-head">
                  <strong>{f.titulo}</strong>
                  <span className={`pt-why-strength pt-why-${f.fuerza}`}>{STRENGTH_LABEL[f.fuerza]}</span>
                </div>
                <div className="pt-why-bar" aria-hidden="true">
                  <span style={{ width: `${Math.round(Math.max(0, Math.min(1, f.valor)) * 100)}%` }} />
                </div>
                <div className="pt-small">{f.texto}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
