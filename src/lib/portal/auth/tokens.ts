/**
 * Acceso al portal sin contraseñas.
 *
 *   bot "portal"  ->  createLoginLink(): token aleatorio (32 bytes base64url) + "." + HMAC-SHA256(PORTAL_SESSION_SECRET)
 *                     en el store solo va sha256(token) con vencimiento corto (LOGIN_TOKEN_TTL_MS, 15 min)
 *   /portal/login ->  verifyLoginToken(): firma (tiempo constante) + consumo de un solo uso -> userId
 *                 ->  createSession(): id aleatorio en la cookie `portal_session`; en el store, sha256(id), 30 días
 *
 * Sin PORTAL_SESSION_SECRET no se generan ni aceptan enlaces (PortalAuthConfigError).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PortalStore, PortalUser } from "../store/types";
import { LOGIN_PATH, LOGIN_TOKEN_TTL_MS, SESSION_COOKIE, SESSION_TTL_MS, safeNextPath } from "./constants";

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
}

/** Firma el token sin guardarlo (tests y verificación de forma). */
export function signLoginToken(raw: string, env: Env = process.env): string {
  return `${raw}.${sign(raw, sessionSecret(env))}`;
}

/**
 * Nuevo enlace de un solo uso para el usuario. Lanza PortalAuthConfigError sin secreto (antes de tocar el store).
 */
export async function createLoginLink(store: PortalStore, user: Pick<PortalUser, "id">, opts: LoginLinkOptions = {}): Promise<LoginLink> {
  const env = opts.env ?? process.env;
  const secret = sessionSecret(env);
  const now = opts.now ?? new Date();
  const raw = randomId();
  const token = `${raw}.${sign(raw, secret)}`;
  const expiresAt = new Date(now.getTime() + (opts.ttlMs ?? LOGIN_TOKEN_TTL_MS));
  await store.saveLoginToken({ tokenHash: sha256(raw), userId: user.id, expiresAt });
  const next = safeNextPath(opts.next);
  return { url: `${portalBaseUrl(env)}${LOGIN_PATH}?t=${encodeURIComponent(token)}${next ? `&next=${encodeURIComponent(next)}` : ""}`, token, expiresAt };
}

/** Solo la firma (no toca el store ni consume): la ruta GET la usa para no mostrar el botón con enlaces falsos. */
export function hasValidSignature(token: string | null | undefined, env: Env = process.env): boolean {
  const secret = sessionSecret(env);
  const parts = (token ?? "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  return sameString(parts[1], sign(parts[0], secret));
}

/**
 * Comprueba la firma (tiempo constante) y consume el token (un solo uso, no vencido). userId o null.
 * Lanza PortalAuthConfigError sin secreto.
 */
export async function verifyLoginToken(store: PortalStore, token: string | null | undefined, opts: AuthOptions = {}): Promise<number | null> {
  if (!hasValidSignature(token, opts.env ?? process.env)) return null;
  const raw = (token ?? "").split(".")[0];
  return store.consumeLoginToken(sha256(raw), opts.now ?? new Date());
}

// ── sesión ──

export interface NewSession {
  /** Valor de la cookie (no se guarda en el store). */
  cookieValue: string;
  expiresAt: Date;
}

export async function createSession(store: PortalStore, userId: number, opts: AuthOptions & { ttlMs?: number } = {}): Promise<NewSession> {
  const now = opts.now ?? new Date();
  const cookieValue = randomId();
  const expiresAt = new Date(now.getTime() + (opts.ttlMs ?? SESSION_TTL_MS));
  await store.createSession({ id: sha256(cookieValue), userId, expiresAt });
  return { cookieValue, expiresAt };
}

/** Usuario activo de la sesión, o null (cookie vacía, sesión inexistente o vencida, usuario borrado o inactivo). */
export async function getSessionUser(store: PortalStore, cookieValue: string | null | undefined, opts: AuthOptions = {}): Promise<PortalUser | null> {
  if (!cookieValue) return null;
  const session = await store.getSession(sha256(cookieValue), opts.now ?? new Date());
  if (!session) return null;
  const user = await store.getUser(session.userId);
  return user && user.activo ? user : null;
}

export async function destroySession(store: PortalStore, cookieValue: string | null | undefined): Promise<void> {
  if (cookieValue) await store.deleteSession(sha256(cookieValue));
}

export interface SessionCookie {
  name: string;
  value: string;
  options: { httpOnly: true; secure: boolean; sameSite: "lax"; path: string; expires: Date; maxAge: number };
}

/** Cookie `portal_session`: httpOnly, secure en producción, sameSite lax, 30 días. */
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
