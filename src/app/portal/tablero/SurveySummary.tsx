/**
 * Hueco para el "Resumen de encuestas" del tablero (lo completa el bloque C3: promedio de recomendación, lo más valorado y
 * comentarios). Mientras no haya datos no renderiza nada, así que el tablero no muestra una sección vacía.
 *
 * C3: cargar el resumen en page.tsx (respetando el alcance: el vendedor ve sus empresas, el supervisor todas) y pasarlo
 * en `data`; ampliar `SurveySummaryData` y el marcado de abajo según lo que guarde `survey_answers`.
 */
export interface SurveySummaryData {
  respuestas: number;
  /** Promedio de recomendación 0–10. */
  promedio: number | null;
  /** Lo más valorado, de más a menos elegido. */
  valorado: { opcion: string; veces: number }[];
  comentarios: string[];
}

export function SurveySummary({ data }: { data?: SurveySummaryData | null }) {
  if (!data || data.respuestas === 0) return null;
  return (
    <section className="pt-card" aria-labelledby="encuestas-title">
      <h2 id="encuestas-title">Resumen de encuestas</h2>
      <p>
        {data.respuestas} respuesta{data.respuestas === 1 ? "" : "s"}
        {data.promedio !== null && <> · recomendación promedio {data.promedio.toFixed(1)} / 10</>}
      </p>
      {data.valorado.length > 0 && <p className="pt-small">Lo más valorado: {data.valorado.map((v) => `${v.opcion} (${v.veces})`).join(", ")}</p>}
      {data.comentarios.length > 0 && (
        <ul className="pt-list pt-small">
          {data.comentarios.map((c, i) => (
            <li key={i}>«{c}»</li>
          ))}
        </ul>
      )}
    </section>
  );
}
