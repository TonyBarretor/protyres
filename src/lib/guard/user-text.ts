/**
 * Textos que ve el usuario (respuestas del bot, pantallas del portal): nunca comandos de terminal (`npm run …`) ni nombres
 * de variables de entorno (`DEEPGRAM_API_KEY`, `PORTAL_ADMIN_NUMBER`…). Esos van solo al log del bot, a la consola del
 * servidor y al README (corrida F, punto 3). La prueba src/lib/guard/user-text.test.ts recorre las pantallas y los avisos
 * conocidos con este mismo patrón.
 */

/** `npm run …`, `npx …` o un nombre en MAYÚSCULAS_CON_GUION_BAJO (forma de variable de entorno). */
export const TECH_TEXT_RE = /\bnpm\s+run\b|\bnpx\s+\S|\b[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]\b/;

export function hasTechText(text: string): boolean {
  return TECH_TEXT_RE.test(text ?? "");
}

/** Lo que se dice al usuario cuando de verdad falta configuración: una variable de entorno o una migración. */
export const CONFIG_ERROR_TEXT = "falta configurar algo en el servidor (contacta al administrador)";

/** Cualquier otro error técnico (base, red, librería): temporal; el detalle va al registro. */
export const TEMP_ERROR_TEXT = "tuve un problema temporal en el servidor (ya quedó registrado)";

/** Falta una variable ("X not set", "Falta X", "X no está definida") o una tabla/columna sin migrar. */
const MISSING_CONFIG_RE = /\b(?:not set|is not set|no est[aá] (?:definid|configurad)|sin configurar|not configured)|\bfalta(?:n)? (?:la tabla|la columna|configurar|[A-Z][A-Z0-9]*_)|\bdb:migrate\b|\brelation "[^"]+" does not exist|\bcolumn "[^"]+" (?:of relation "[^"]+" )?does not exist/i;

/** Postgres: tabla o columna que no existe (migración pendiente). */
const MISSING_SCHEMA_CODES = new Set(["42P01", "42703"]);

/** Errores de la base, de la red o de la lib postgres, aunque no tengan forma de variable. */
const INFRA_RE = /\b(?:ECONN\w*|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|CONNECTION_\w+|UNSAFE_TRANSACTION|socket hang up|timeout|timed out|terminat\w*|violates|constraint|syntax error|deadlock|could not serialize|duplicate key|invalid input syntax|fetch failed)\b/i;

function errorParts(err: unknown): { message: string; name: string; code: string } {
  if (typeof err === "string") return { message: err, name: "", code: "" };
  const e = err as { message?: unknown; name?: unknown; code?: unknown } | null | undefined;
  return { message: String(e?.message ?? err ?? ""), name: String(e?.name ?? ""), code: String(e?.code ?? "") };
}

/**
 * El mensaje de un error para el chat o una pantalla (corrida H, punto 1):
 *  - falta configuración de verdad (variable, migración) -> CONFIG_ERROR_TEXT;
 *  - error técnico de la base, la red o una librería (o con forma de comando/variable) -> TEMP_ERROR_TEXT;
 *  - lo demás (mensajes pensados para el usuario) -> tal cual.
 * Quien lo llama registra el detalle.
 */
export function userErrorText(err: unknown): string {
  const { message, name, code } = errorParts(err);
  if (MISSING_SCHEMA_CODES.has(code) || MISSING_CONFIG_RE.test(message)) return CONFIG_ERROR_TEXT;
  if (name === "PostgresError" || /^[0-9A-Z]{5}$/.test(code) || /^E[A-Z]+$/.test(code) || /^[A-Z][A-Z_]+$/.test(code) || INFRA_RE.test(message) || hasTechText(message)) return TEMP_ERROR_TEXT;
  return message;
}
