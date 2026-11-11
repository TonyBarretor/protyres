/**
 * Lógica de /portal/login y /api/portal/logout (los route handlers solo la llaman; aquí se prueba con un store en memoria).
 *
 *   GET  /portal/login            -> pantalla "Sin sesión" (cómo pedir el enlace)
 *   GET  /portal/login?t=...      -> firma inválida: "Enlace vencido o ya usado"; firma válida: formulario que se envía solo
 *   POST /portal/login (t=...)    -> consume el token (un solo uso), crea la sesión, pone la cookie y redirige (303) a /portal.
 *                                    Si trae cabecera Origin y no es el mismo host de la petición: 403 sin tocar el token.
 *   POST /api/portal/logout       -> borra la sesión y la cookie, redirige a /portal/login
 *   GET  /api/portal/logout       -> 405 (cerrar sesión cambia estado: un enlace o una precarga no deben poder hacerlo)
 */
import { NextResponse } from "next/server";
import type { PortalStore } from "../store/types";
import { HOME_PATH, LOGIN_PATH, SESSION_COOKIE } from "./constants";
import { configErrorPage, confirmLoginPage, expiredLinkPage, forbiddenOriginPage, noSessionPage } from "./pages";
import { PortalAuthConfigError, createSession, destroySession, hasValidSignature, sessionCookie, verifyLoginToken, type AuthOptions } from "./tokens";

function guard(fn: () => Promise<Response>): Promise<Response> {
  return fn().catch((err: unknown) => {
    if (err instanceof PortalAuthConfigError) return configErrorPage(err.message);
    throw err;
  });
}

export function loginGet(req: Request, opts: AuthOptions = {}): Promise<Response> {
  return guard(async () => {
    const token = new URL(req.url).searchParams.get("t");
    if (!token) return noSessionPage();
    if (!hasValidSignature(token, opts.env ?? process.env)) return expiredLinkPage();
    return confirmLoginPage(token);
  });
}

async function tokenFromBody(req: Request): Promise<string | null> {
  const fromQuery = new URL(req.url).searchParams.get("t");
  try {
    const form = await req.formData();
    const t = form.get("t");
    if (typeof t === "string" && t) return t;
  } catch {
    // sin cuerpo de formulario: se usa ?t=
  }
  return fromQuery;
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

export function loginPost(req: Request, store: PortalStore | (() => Promise<PortalStore>), opts: AuthOptions = {}): Promise<Response> {
  return guard(async () => {
    if (!isSameOrigin(req)) return forbiddenOriginPage();
    const token = await tokenFromBody(req);
    if (!token || !hasValidSignature(token, opts.env ?? process.env)) return expiredLinkPage();
    const s = typeof store === "function" ? await store() : store;
    const userId = await verifyLoginToken(s, token, opts);
    const user = userId === null ? null : await s.getUser(userId);
    if (!user || !user.activo) {
      await s.flush();
      return expiredLinkPage();
    }
    const session = await createSession(s, user.id, opts);
    await s.flush(); // store JSON: que el consumo y la sesión queden escritos antes de responder
    const res = NextResponse.redirect(new URL(HOME_PATH, req.url), 303);
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
