/**
 * Corrida H, punto 2 — comparar el store JSON con el de Postgres: mismas entradas, mismas salidas observables.
 *
 * `normalize` deja los resultados comparables: fechas como texto ISO; las que pone el reloj del servidor o de la
 * máquina en el momento (created_at = now(), updatedAt = new Date()) como "<ahora>", porque cada store usa su reloj;
 * números como número (numeric de Postgres llega como texto en algunas columnas).
 */

/** Fechas a menos de 10 min del reloj real: las puso el store "ahora" (las del escenario son fijas, de otros días). */
const NOW_WINDOW_MS = 10 * 60_000;

export function normalize(v: unknown, key = ""): unknown {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "<fecha inválida>";
    return Math.abs(v.getTime() - Date.now()) < NOW_WINDOW_MS ? "<ahora>" : v.toISOString();
  }
  // fechas guardadas como texto ISO (cotizaciones, fotos, contratos): la misma regla
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && Math.abs(Date.parse(v) - Date.now()) < NOW_WINDOW_MS) return "<ahora>";
  if (Array.isArray(v)) return v.map((x) => normalize(x, key));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined) continue;
      out[k] = normalize(x, k);
    }
    return out;
  }
  return v;
}

/** Etiquetas cuyo valor difiere (todas, no solo la primera), con los dos valores. */
export function diffTraces(json: Record<string, unknown>, pg: Record<string, unknown>): { label: string; json: unknown; pg: unknown }[] {
  const labels = [...new Set([...Object.keys(json), ...Object.keys(pg)])];
  return labels.filter((k) => JSON.stringify(json[k]) !== JSON.stringify(pg[k])).map((label) => ({ label, json: json[label], pg: pg[label] }));
}

/** Corre lo mismo en los dos stores y devuelve las dos trazas normalizadas (primero JSON, después Postgres). */
export async function bothTraces<S>(json: S, pg: S, scenario: (store: S, trace: (label: string, value: unknown) => void) => Promise<void>): Promise<{ json: Record<string, unknown>; pg: Record<string, unknown> }> {
  const run = async (s: S) => {
    const t: Record<string, unknown> = {};
    let last = Date.now();
    await scenario(s, (label, value) => {
      // un paso lento (el pooler que no devuelve una consulta) queda en la salida con su etiqueta
      const ms = Date.now() - last;
      last = Date.now();
      if (ms > 3000) console.warn(`[test:pg] paso lento: ${label} ${ms} ms`);
      if (label in t) throw new Error(`etiqueta repetida en la traza: ${label}`);
      t[label] = normalize(value);
    });
    return t;
  };
  return { json: await run(json), pg: await run(pg) };
}
