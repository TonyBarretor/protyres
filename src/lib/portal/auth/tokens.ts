/**
 * Acceso al portal sin contraseñas.
 *
 *   bot "portal"  ->  loginLinkFor(): reenvía el enlace vigente del usuario (renovado a access.linkHours, 24 h) o crea uno.
 *                     token = HMAC(PORTAL_SESSION_SECRET, nonce) (32 bytes base64url) + "." + HMAC del token; en el store
 *                     va sha256(token) y el nonce (sin el secreto, la base sola no da el enlace)
 *   /portal/login ->  firma (tiempo constante) + enlace vigente (hotfix login 2: sirve las veces que haga falta hasta
 *                     vencer, salvo que se anule con `cerrar portal`) -> sesión nueva: id aleatorio en la cookie
 *                     `portal_session`; en el store, sha256(id), access.sessionDays (30 días), renovada con cada visita
 *
 * Sin PORTAL_SESSION_SECRET no se generan ni aceptan enlaces (PortalAuthConfigError).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PortalStore, PortalUser } from "../store/types";
import { linkTtlMs, sessionTtlMs } from "./access";
import { HOME_PATH, LOGIN_PATH, SESSION_COOKIE, safeNextPath } from "./constants";

type Env = Record<string, string | undefined>;

/** Falta configuración (el secreto): el bot y la ruta de login lo muestran tal cual. */
export class PortalAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalAuthConfigError";
  }
}

export const MISSING_SECRET_MESSAGE = "Falta PORTAL_SESSION_SECRET: el portal no puede generar ni aceptar enlaces de acceso.";

/** Mínimo razonable para un secreto HMAC. */
const MIN_SECRET_LENGTH = 16;

export function sessionSecret(env: Env = process.env): string {
  const s = (env.PORTAL_SESSION_SECRET ?? "").trim();
  if (!s) throw new PortalAuthConfigError(MISSING_SECRET_MESSAGE);
  if (s.length < MIN_SECRET_LENGTH) throw new PortalAuthConfigError(`PORTAL_SESSION_SECRET es demasiado corto (mínimo ${MIN_SECRET_LENGTH} caracteres).`);
  return s;
}

/** PORTAL_BASE_URL, o https://VERCEL_PROJECT_PRODUCTION_URL, o http://localhost:3000 (sin "/" final). */
export function portalBaseUrl(env: Env = process.env): string {
  const explicit = (env.PORTAL_BASE_URL ?? "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = (env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return "http://localhost:3000";
}

/** Dirección fija del portal para guardarla: "protyres.vercel.app/portal" (sin https://). */
export function fixedPortalAddress(env: Env = process.env): string {
  return `${portalBaseUrl(env).replace(/^https?:\/\//, "")}${HOME_PATH}`;
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const randomId = (): string => randomBytes(32).toString("base64url");

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function sameString(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface AuthOptions {
  env?: Env;
  now?: Date;
}

export interface LoginLinkOptions extends AuthOptions {
  ttlMs?: number;
  /** Pantalla a la que entra tras el login (solo las de LOGIN_NEXT_PATHS; otra se ignora). */
  next?: string;
}

export interface LoginLink {
  url: string;
  token: string;
  expiresAt: Date;
  /** true si es el enlace vigente que ya tenía el usuario (renovado), false si es nuevo. */
  reused: boolean;
}

/** Firma el token sin guardarlo (tests y verificación de forma). */
export function signLoginToken(raw: string, env: Env = process.env): string {
  return `${raw}.${sign(raw, sessionSecret(env))}`;
}

/** Parte aleatoria del token a partir del nonce guardado: sin el secreto no se puede armar. */
function rawFromNonce(nonce: string, secret: string): string {
  return createHmac("sha256", secret).update(`portal-login:${nonce}`).digest("base64url");
}

function linkUrl(token: string, env: Env, next: string | undefined): string {
  const safe = safeNextPath(next);
  return `${portalBaseUrl(env)}${LOGIN_PATH}?t=${encodeURIComponent(token)}${safe ? `&next=${encodeURIComponent(safe)}` : ""}`;
}

/**
 * Enlace NUEVO para el usuario (vigencia access.linkHours, reutilizable en ese plazo). Lanza PortalAuthConfigError sin
 * secreto (antes de tocar el store). El bot usa loginLinkFor(), que antes reenvía el vigente.
 */
export async function createLoginLink(store: PortalStore, user: Pick<PortalUser, "id">, opts: LoginLinkOptions = {}): Promise<LoginLink> {
  const env = opts.env ?? process.env;
  const secret = sessionSecret(env);
  const now = opts.now ?? new Date();
  const nonce = randomId();
  const raw = rawFromNonce(nonce, secret);
  const token = `${raw}.${sign(raw, secret)}`;
  const expiresAt = new Date(now.getTime() + (opts.ttlMs ?? linkTtlMs()));
  await store.saveLoginToken({ tokenHash: sha256(raw), userId: user.id, expiresAt, nonce });
  return { url: linkUrl(token, env, opts.next), token, expiresAt, reused: false };
}

/**
 * Hotfix login 2: el enlace que manda el bot. Si el usuario ya tiene uno vigente, es ESE mismo, con el vencimiento
 * renovado a access.linkHours desde ahora (así el último enlace del chat siempre sirve y no se acumulan enlaces); si no,
 * uno nuevo. Pedir `portal` tres veces seguidas da tres veces el mismo enlace.
 */
export async function loginLinkFor(store: PortalStore, user: Pick<PortalUser, "id">, opts: LoginLinkOptions = {}): Promise<LoginLink> {
  const env = opts.env ?? process.env;
  const secret = sessionSecret(env);
  const now = opts.now ?? new Date();
  const current = await store.currentLoginToken(user.id, now);
  if (current) {
    const raw = rawFromNonce(current.nonce, secret);
    // otro secreto (rotado) o una fila que no corresponde: no se reenvía, se crea uno nuevo
    if (sha256(raw) === current.tokenHash) {
      const expiresAt = new Date(Math.max(current.expiresAt.getTime(), now.getTime() + (opts.ttlMs ?? linkTtlMs())));
      await store.extendLoginToken(current.tokenHash, expiresAt);
      return { url: linkUrl(`${raw}.${sign(raw, secret)}`, env, opts.next), token: `${raw}.${sign(raw, secret)}`, expiresAt, reused: true };
    }
  }
  return createLoginLink(store, user, opts);
}

/** Solo la firma (no toca el store ni consume): la ruta GET la usa para no mostrar el botón con enlaces falsos. */
export function hasValidSignature(token: string | null | undefined, env: Env = process.env): boolean {
  const secret = sessionSecret(env);
  const parts = (token ?? "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  return sameString(parts[1], sign(parts[0], secret));
}

/** Parte del token que identifica el enlace en el store (sha256 de la parte antes del punto). */
function tokenHashOf(token: string | null | undefined): string {
  return sha256((token ?? "").split(".")[0]);
}

/**
 * Hotfix login 2: firma + enlace vigente, sin gastarlo ni marcarlo (la vista previa de WhatsApp y el GET de la entrada).
 * userId o null. Lanza PortalAuthConfigError sin secreto.
 */
export async function peekLoginLink(store: PortalStore, token: string | null | undefined, opts: AuthOptions = {}): Promise<number | null> {
  if (!hasValidSignature(token, opts.env ?? process.env)) return null;
  return store.peekLoginToken(tokenHashOf(token), opts.now ?? new Date());
}

// ── sesión ──

export interface NewSession {
  /** Valor de la cookie (no se guarda en el store). */
  cookieValue: string;
  expiresAt: Date;
}

/**
 * Entrada con el enlace: firma + enlace vigente + sesión nueva, en UNA operación confirmada antes de responder (Postgres:
 * una transacción en una conexión reservada, que antes descarta una transacción abierta de antes: pg-options.ts). El
 * enlace sigue sirviendo hasta que vence (hotfix login 2). null si la firma no vale o el enlace no existe, venció o se anuló.
 */
export async function loginWithToken(store: PortalStore, token: string | null | undefined, opts: AuthOptions & { ttlMs?: number } = {}): Promise<{ userId: number; session: NewSession } | null> {
  if (!hasValidSignature(token, opts.env ?? process.env)) return null;
  const now = opts.now ?? new Date();
  const cookieValue = randomId();
  const expiresAt = new Date(now.getTime() + (opts.ttlMs ?? sessionTtlMs()));
  const userId = await store.useLoginTokenIntoSession(tokenHashOf(token), now, { id: sha256(cookieValue), expiresAt });
  return userId === null ? null : { userId, session: { cookieValue, expiresAt } };
}

export async function createSession(store: PortalStore, userId: number, opts: AuthOptions & { ttlMs?: number } = {}): Promise<NewSession> {
  const now = opts.now ?? new Date();
  const cookieValue = randomId();
  const expiresAt = new Date(now.getTime() + (opts.ttlMs ?? sessionTtlMs()));
  await store.createSession({ id: sha256(cookieValue), userId, expiresAt });
  return { cookieValue, expiresAt };
}

/** La sesión se renueva con el uso, pero se escribe a lo más una vez por este intervalo (no en cada petición). */
export const SESSION_RENEW_STEP_MS = 60 * 60 * 1000;

/**
 * Usuario activo de la sesión, o null (cookie vacía, sesión inexistente o vencida, usuario borrado o inactivo). Con
 * `renew` (las pantallas del portal), la sesión vuelve a durar access.sessionDays desde ahora (hotfix login 2); se
 * escribe solo si ganó más de SESSION_RENEW_STEP_MS, y si la escritura falla la pantalla sigue.
 */
export async function getSessionUser(store: PortalStore, cookieValue: string | null | undefined, opts: AuthOptions & { renew?: boolean; ttlMs?: number } = {}): Promise<PortalUser | null> {
  if (!cookieValue) return null;
  const now = opts.now ?? new Date();
  const session = await store.getSession(sha256(cookieValue), now);
  if (!session) return null;
  const user = await store.getUser(session.userId);
  if (!user || !user.activo) return null;
  if (opts.renew) {
    const expiresAt = new Date(now.getTime() + (opts.ttlMs ?? sessionTtlMs()));
    if (expiresAt.getTime() - session.expiresAt.getTime() >= SESSION_RENEW_STEP_MS) {
      await store.renewSession(session.id, expiresAt).catch((err: unknown) => console.warn(`[portal] no se pudo renovar la sesión: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  return user;
}

/** Hotfix login 2 (`cerrar portal` y la terminal del administrador): cierra todas las sesiones y anula los enlaces. */
export async function revokeAccess(store: PortalStore, userId: number, opts: AuthOptions = {}): Promise<{ sessions: number; links: number }> {
  const r = await store.revokeUserAccess(userId, opts.now ?? new Date());
  await store.flush();
  return r;
}

export async function destroySession(store: PortalStore, cookieValue: string | null | undefined): Promise<void> {
  if (cookieValue) await store.deleteSession(sha256(cookieValue));
}

export interface SessionCookie {
  name: string;
  value: string;
  options: { httpOnly: true; secure: boolean; sameSite: "lax"; path: string; expires: Date; maxAge: number };
}

/** Cookie `portal_session`: httpOnly, secure en producción, sameSite lax, hasta que vence la sesión (30 días). */
export function sessionCookie(session: NewSession, opts: AuthOptions = {}): SessionCookie {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  return {
    name: SESSION_COOKIE,
    value: session.cookieValue,
    options: {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: session.expiresAt,
      maxAge: Math.max(0, Math.floor((session.expiresAt.getTime() - now.getTime()) / 1000)),
    },
  };
}
