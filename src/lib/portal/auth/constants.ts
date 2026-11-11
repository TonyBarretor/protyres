/**
 * Constantes del acceso al portal. Sin dependencias de Node: las usa también src/proxy.ts.
 */

/** Cookie de sesión (httpOnly). Su valor es el id de sesión; en el store se guarda solo su sha256. */
export const SESSION_COOKIE = "portal_session";

/** Vigencia del enlace que manda el bot (un solo uso). */
export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Vigencia de la sesión (cookie y fila en el store). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Ruta pública del portal: con ?t=... entra; sin token muestra cómo pedir el enlace. */
export const LOGIN_PATH = "/portal/login";

/** Pantalla de inicio tras entrar. */
export const HOME_PATH = "/portal";
