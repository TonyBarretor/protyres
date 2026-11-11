/**
 * "Resumen de encuestas" del tablero (bloque C3): recomendación promedio, NPS (promotores − detractores), lo más valorado
 * y los últimos comentarios. page.tsx lo carga con loadSurveySummary respetando el alcance (vendedor: sus empresas;
 * supervisor: todas o las del vendedor elegido). Sin respuestas no renderiza nada.
 */
import Link from "next/link";
import type { DashboardSurveySummary } from "@/lib/portal/survey/summary";
import { formatLimaShort } from "@/lib/portal/ui/time";

export type SurveySummaryData = DashboardSurveySummary;

export function SurveySummary({ data }: { data?: SurveySummaryData | null }) {
  if (!data || data.respuestas === 0) return null;
  return (
    <section className="pt-card" aria-labelledby="encuestas-title">
      <h2 id="encuestas-title">Resumen de encuestas</h2>
      <p className="pt-small pt-muted">Últimos {data.months} meses</p>
      <p>
        {data.respuestas} respuesta{data.respuestas === 1 ? "" : "s"}
        {data.promedio !== null && (
          <>
            {" "}
            · recomendación promedio <strong>{data.promedio.toFixed(1)}</strong> / 10
          </>
        )}
        {data.nps !== null && (
          <>
            {" "}
            · NPS <strong>{data.nps}</strong>
          </>
        )}
      </p>
      <p className="pt-small pt-muted">
        {data.promotores} promotor{data.promotores === 1 ? "" : "es"} (9–10) · {data.pasivos} pasivo{data.pasivos === 1 ? "" : "s"} (7–8) · {data.detractores} detractor
        {data.detractores === 1 ? "" : "es"} (0–6)
        {data.satisfaccion !== null && <> · última entrega {data.satisfaccion.toFixed(1)} / 5</>}
        {data.referencias > 0 && <> · {data.referencias} autoriza{data.referencias === 1 ? "" : "n"} citarlos como referencia</>}
      </p>
      {data.valorado.length > 0 && <p className="pt-small">Lo más valorado: {data.valorado.map((v) => `${v.opcion} (${v.veces})`).join(", ")}</p>}
      {data.comentariosEmpresa.length > 0 && (
        <ul className="pt-list pt-small">
          {data.comentariosEmpresa.map((c, i) => (
            <li key={i}>
              «{c.texto}»{" "}
              <span className="pt-muted">
                — <Link href={`/portal/empresas/${c.companyId}#encuestas`}>{c.empresa}</Link>, {formatLimaShort(c.fecha)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
