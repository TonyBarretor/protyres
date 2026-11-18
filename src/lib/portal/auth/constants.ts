/**
 * Constantes del acceso al portal. Sin dependencias de Node: las usa también src/proxy.ts.
 */

/** Cookie de sesión (httpOnly). Su valor es el id de sesión; en el store se guarda solo su sha256. */
export const SESSION_COOKIE = "portal_session";

/**
 * Vigencia del enlace que manda el bot, por defecto (hotfix login 2: sirve todas las veces que haga falta en ese plazo).
 * El valor en uso es config/portal.json → access.linkHours (auth/access.ts).
 */
export const LOGIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Vigencia de la sesión por defecto (se renueva con cada visita); la en uso es access.sessionDays (auth/access.ts). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Ruta pública del portal: con ?t=... entra; sin token muestra cómo pedir el enlace. */
export const LOGIN_PATH = "/portal/login";

/** Pantalla de inicio tras entrar. */
export const HOME_PATH = "/portal";

/**
 * Pantallas a las que el enlace del bot puede llevar tras entrar (`?next=`, corrida G: el aviso de validar el ranking).
 * Lista cerrada de rutas exactas: cualquier otro valor se ignora y se entra a HOME_PATH (sin redirecciones abiertas).
 */
export const LOGIN_NEXT_PATHS: readonly string[] = ["/portal/validar-ranking"];

/** El destino si está en la lista cerrada; si no, null. */
export function safeNextPath(next: string | null | undefined): string | null {
  return typeof next === "string" && LOGIN_NEXT_PATHS.includes(next) ? next : null;
}

/**
 * Política de Referer de las páginas que llevan un token en la URL y envían un formulario (login, encuesta pública).
 * same-origin: el token no viaja a otros sitios y el POST al mismo origen conserva la cabecera Origin. NUNCA no-referrer:
 * con ella el navegador manda `Origin: null` en el POST, el login lo rechaza (403) y Next aborta las server actions.
 */
export const TOKEN_PAGE_REFERRER_POLICY = "same-origin";
