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

/** Lo que se dice al usuario en lugar de un error técnico (falta de configuración, tabla sin migrar…). */
export const CONFIG_ERROR_TEXT = "falta configurar algo en el servidor (contacta al administrador)";

/** El mensaje de un error para el chat o una pantalla: tal cual, salvo que nombre comandos o variables. */
export function userErrorText(message: string): string {
  return hasTechText(message) ? CONFIG_ERROR_TEXT : message;
}
