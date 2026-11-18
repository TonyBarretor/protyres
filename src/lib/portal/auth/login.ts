/**
 * Lógica de /portal/login y /api/portal/logout (los route handlers solo la llaman; aquí se prueba con un store en memoria).
 *
 *   GET  /portal/login            -> pantalla "Sin sesión" (cómo pedir el enlace)
 *   GET  /portal/login?t=...      -> firma inválida: "Enlace vencido o ya usado"; firma válida: formulario que se envía solo
 *   POST /portal/login (t=...)    -> consume el token (un solo uso), crea la sesión, pone la cookie y redirige (303) a /portal,
 *                                    o al destino `next` si está en la lista cerrada LOGIN_NEXT_PATHS (corrida G).
 *                                    Si trae cabecera Origin y no es el mismo host de la petición: 403 sin tocar el token.
 *   Corrida E, punto 5: token de más de publicInputs.maxTokenChars o con caracteres raros -> "Enlace vencido" sin tocar la
 *                                    base; cuerpo del POST > maxLoginBodyBytes -> 413; más intentos que rateLimits.login
 *                                    (por IP y por token) -> 429 (src/lib/portal/auth/rate-limit.ts).
 *   POST /api/portal/logout       -> borra la sesión y la cookie, redirige a /portal/login
 *   GET  /api/portal/logout       -> 405 (cerrar sesión cambia estado: un enlace o una precarga no deben poder hacerlo)
 */
import { NextResponse } from "next/server";
import type { PortalStore } from "../store/types";
import { HOME_PATH, LOGIN_PATH, SESSION_COOKIE, safeNextPath } from "./constants";
import { configErrorPage, confirmLoginPage, expiredLinkPage, forbiddenOriginPage, noSessionPage, payloadTooLargePage, tooManyAttemptsPage } from "./pages";
import { checkRateLimit, clientIp, publicInputsConfig, refundRateLimit, retryText, type RateLimitDeps } from "./rate-limit";
import { PortalAuthConfigError, destroySession, getSessionUser, hasValidSignature, loginWithToken, sessionCookie, type AuthOptions } from "./tokens";

/**
 * Corrida E, punto 5. `limits`: límite de intentos por IP y por token (el route handler lo pasa siempre; sin él, p. ej. en
 * pruebas viejas, no se cuenta). El tamaño del cuerpo y la forma del token se comprueban siempre, antes de tocar la base.
 */
export interface LoginOptions extends AuthOptions {
  limits?: RateLimitDeps;
  /**
   * Hotfix login: el store para mirar si el navegador ya tiene una sesión vigente (GET: un enlace ya usado lleva al portal
   * en vez de "Enlace vencido"). Sin él, el GET no la mira.
   */
  store?: PortalStore | (() => Promise<PortalStore>);
}

/** El usuario de la cookie de sesión de la petición, si la sesión sigue vigente (null si no, o si el store falla). */
async function sessionUserOf(req: Request, store: PortalStore | (() => Promise<PortalStore>) | undefined, opts: AuthOptions): Promise<{ nombre: string } | null> {
  const value = readCookie(req, SESSION_COOKIE);
  if (!value || !store) return null;
  try {
    return await getSessionUser(typeof store === "function" ? await store() : store, value, opts);
  } catch {
    return null;
  }
}

/** Ya hay sesión: al portal (o al destino `next` de la lista cerrada), sin gastar el enlace. */
function toPortal(req: Request, next: string | null): Response {
  const res = NextResponse.redirect(new URL(safeNextPath(next) ?? HOME_PATH, req.url), 303);
  res.headers.set("cache-control", "no-store");
  return res;
}

/** Forma de un token de enlace (base64url + "." + firma) y largo razonable: lo demás ni se cuenta ni se busca. */
const TOKEN_CHARS = /^[A-Za-z0-9_.-]+$/;
function plausibleToken(token: string): boolean {
  return token.length <= publicInputsConfig().maxTokenChars && TOKEN_CHARS.test(token);
}

async function limited(req: Request, token: string, opts: LoginOptions): Promise<Response | null> {
  if (!opts.limits) return null;
  const r = await checkRateLimit({ ...opts.limits, now: opts.limits.now ?? opts.now }, "login", { ip: clientIp(req.headers), token });
  return r.ok ? null : tooManyAttemptsPage(r.retryAfterSec, retryText(r.retryAfterSec));
}

function guard(fn: () => Promise<Response>): Promise<Response> {
  return fn().catch((err: unknown) => {
    if (err instanceof PortalAuthConfigError) return configErrorPage(err.message);
    throw err;
  });
}

export function loginGet(req: Request, opts: LoginOptions = {}): Promise<Response> {
  return guard(async () => {
    const params = new URL(req.url).searchParams;
    const token = params.get("t");
    if (!token) return noSessionPage();
    if (!plausibleToken(token)) return expiredLinkPage();
    // hotfix login: abrir un enlace bien firmado no gasta nada ni cuenta como intento (la vista previa de WhatsApp y volver
    // a abrirlo no deben bloquear a nadie); uno con la firma mala sí cuenta
    if (!hasValidSignature(token, opts.env ?? process.env)) {
      const blocked = await limited(req, token, opts);
      return blocked ?? expiredLinkPage();
    }
    // ya hay sesión vigente en este navegador (p. ej. el enlace se abrió otra vez): directo al portal
    const current = await sessionUserOf(req, opts.store, opts);
    if (current) {
      console.log(`[portal] enlace abierto con sesión vigente de ${current.nombre}: al portal`);
      return toPortal(req, params.get("next"));
    }
    if (opts.limits) console.log(`[portal] enlace de entrada abierto (GET, no se gasta): ${browserHint(req)}`);
    return confirmLoginPage(token, safeNextPath(params.get("next")));
  });
}

/** Lee el cuerpo sin pasar de `max` bytes (aunque no traiga Content-Length o mienta). null = demasiado grande. */
export async function readBodyLimited(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Token del formulario (o de ?t=), cómo se envió (`via`: auto = el JS de la página, boton = el usuario) y el destino
 * `next` (formulario o ?next=, sin validar); "too_large" si el cuerpo pasa del máximo.
 */
async function tokenFromBody(req: Request): Promise<{ token: string | null; via: string; next: string | null } | "too_large"> {
  const query = new URL(req.url).searchParams;
  const fromQuery = query.get("t");
  const nextQuery = query.get("next");
  const body = await readBodyLimited(req, publicInputsConfig().maxLoginBodyBytes);
  if (body === null) return "too_large";
  try {
    const form = await new Response(body as BodyInit, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
    const t = form.get("t");
    const via = String(form.get("via") ?? "").slice(0, 10) || "?";
    const n = form.get("next");
    if (typeof t === "string" && t) return { token: t, via, next: typeof n === "string" ? n : nextQuery };
  } catch {
    // sin cuerpo de formulario: se usa ?t=
  }
  return { token: fromQuery, via: "?", next: nextQuery };
}

/**
 * Diagnóstico de la entrada (corrida F, punto 6): navegador (user-agent recortado) y cabeceras Fetch Metadata, sin el
 * token. Sirve para ver en los registros si la vista previa de WhatsApp abrió el enlace y si el envío fue automático.
 */
export function browserHint(req: Request): string {
  const h = req.headers;
  const ua = (h.get("user-agent") ?? "sin user-agent").replace(/[\r\n]+/g, " ").slice(0, 160);
  const meta = ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"].map((k) => h.get(k)).filter(Boolean).join("/");
  return meta ? `${ua} [${meta}]` : ua;
}

/** Host de la petición: el que vio el proxy (Vercel pone x-forwarded-host), si no Host, si no el de la URL. */
function requestHost(req: Request): string {
  const fwd = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  return (fwd || req.headers.get("host") || new URL(req.url).host).toLowerCase();
}

/** true si no hay cabecera Origin (clientes viejos) o si su host coincide con el de la petición. "null" no coincide. */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host.toLowerCase() === requestHost(req);
  } catch {
    return false;
  }
}

export function loginPost(req: Request, store: PortalStore | (() => Promise<PortalStore>), opts: LoginOptions = {}): Promise<Response> {
  return guard(async () => {
    if (!isSameOrigin(req)) return forbiddenOriginPage();
    const sent = await tokenFromBody(req);
    if (sent === "too_large") return payloadTooLargePage();
    const token = sent.token;
    if (!token || !plausibleToken(token)) return expiredLinkPage();
    const blocked = await limited(req, token, opts);
    if (blocked) return blocked;
    if (!hasValidSignature(token, opts.env ?? process.env)) return expiredLinkPage();
    const s = typeof store === "function" ? await store() : store;
    // hotfix login: consumo del enlace y sesión en una sola operación, confirmada antes de responder
    const login = await loginWithToken(s, token, opts);
    const user = login === null ? null : await s.getUser(login.userId);
    if (!login || !user || !user.activo) {
      if (login) await destroySession(s, login.session.cookieValue);
      await s.flush();
      // el enlace ya se usó pero este navegador tiene una sesión vigente: al portal, no "Enlace vencido"
      const current = await sessionUserOf(req, s, opts);
      if (current) {
        console.log(`[portal] enlace ya usado con sesión vigente de ${current.nombre}: al portal`);
        return toPortal(req, sent.next);
      }
      return expiredLinkPage();
    }
    if (opts.limits) {
      console.log(`[portal] entrada de ${user.nombre} (envío ${sent.via === "auto" ? "automático" : sent.via === "boton" ? "con el botón" : sent.via}): ${browserHint(req)}`);
      // una entrada que salió bien no cuenta como intento
      await refundRateLimit({ ...opts.limits, now: opts.limits.now ?? opts.now }, "login", { ip: clientIp(req.headers), token });
    }
    const session = login.session;
    await s.flush(); // store JSON: que el consumo y la sesión queden escritos antes de responder
    // destino solo de la lista cerrada (rutas exactas del mismo sitio); otro valor entra al inicio
    const res = NextResponse.redirect(new URL(safeNextPath(sent.next) ?? HOME_PATH, req.url), 303);
    const c = sessionCookie(session, opts);
    res.cookies.set(c.name, c.value, c.options);
    res.headers.set("cache-control", "no-store");
    return res;
  });
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export async function logout(req: Request, store: PortalStore | (() => Promise<PortalStore>)): Promise<Response> {
  const value = readCookie(req, SESSION_COOKIE);
  if (value) {
    const s = typeof store === "function" ? await store() : store;
    await destroySession(s, value);
    await s.flush();
  }
  const res = NextResponse.redirect(new URL(LOGIN_PATH, req.url), 303);
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}

/** GET /api/portal/logout: no cierra sesión. */
export function logoutMethodNotAllowed(): Response {
  return new Response("Usa el botón «Salir» del portal (POST).", { status: 405, headers: { allow: "POST", "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
