import { beforeEach, describe, expect, it } from "vitest";
import { JsonPortalStore } from "../store";
import type { PortalUser } from "../store/types";
import { LOGIN_PATH, LOGIN_TOKEN_TTL_MS, SESSION_COOKIE, SESSION_TTL_MS } from "./constants";
import { PortalAuthConfigError, SESSION_RENEW_STEP_MS, createLoginLink, createSession, destroySession, fixedPortalAddress, getSessionUser, loginLinkFor, loginWithToken, peekLoginLink, portalBaseUrl, revokeAccess, sessionCookie, sha256 } from "./tokens";

/** userId si el enlace entra (y crea una sesión), null si no. */
const enter = async (s: JsonPortalStore, token: string, opts: { env?: Record<string, string>; now?: Date } = {}) => (await loginWithToken(s, token, opts))?.userId ?? null;

const env = { PORTAL_SESSION_SECRET: "test-secret-0123456789abcdef", PORTAL_BASE_URL: "https://portal.example.pe/" };
const T0 = new Date("2026-11-11T15:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let store: JsonPortalStore;
let frank: PortalUser;

beforeEach(async () => {
  store = JsonPortalStore.memory();
  frank = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
});

// hotfix login 2 (cambio pedido): el enlace deja de ser de un solo uso; sirve todas las veces que haga falta durante 24 h
describe("login link", () => {
  it("builds a signed link valid for 24 hours and stores only the hash", async () => {
    const link = await createLoginLink(store, frank, { env, now: T0 });
    expect(link.url.startsWith(`https://portal.example.pe${LOGIN_PATH}?t=`)).toBe(true);
    const [raw, sig] = link.token.split(".");
    expect(Buffer.from(raw, "base64url").length).toBe(32);
    expect(sig.length).toBeGreaterThan(20);
    expect(link.expiresAt.getTime() - T0.getTime()).toBe(LOGIN_TOKEN_TTL_MS);
    expect(LOGIN_TOKEN_TTL_MS).toBe(24 * 3_600_000);
    expect(decodeURIComponent(new URL(link.url).searchParams.get("t")!)).toBe(link.token);
    // the raw token is not a key of the store: only its sha256
    expect(await store.peekLoginToken(raw, T0)).toBeNull();
    expect(await store.peekLoginToken(sha256(raw), T0)).toBe(frank.id);
  });

  it("valid signature -> userId, as many times as needed while it lasts", async () => {
    const link = await createLoginLink(store, frank, { env, now: T0 });
    for (const m of [1, 2, 60, 23 * 60]) expect(await enter(store, link.token, { env, now: at(m * 60_000) })).toBe(frank.id);
  });

  it("peek (WhatsApp preview / GET) neither spends nor marks the link", async () => {
    const link = await createLoginLink(store, frank, { env, now: T0 });
    for (let i = 0; i < 5; i++) expect(await peekLoginLink(store, link.token, { env, now: T0 })).toBe(frank.id);
    expect(await enter(store, link.token, { env, now: T0 })).toBe(frank.id);
  });

  it("rejects a tampered signature or token, and a different secret", async () => {
    const link = await createLoginLink(store, frank, { env, now: T0 });
    const [raw, sig] = link.token.split(".");
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    expect(await enter(store, `${raw}.${flip(sig)}`, { env, now: T0 })).toBeNull();
    expect(await enter(store, `${flip(raw)}.${sig}`, { env, now: T0 })).toBeNull();
    expect(await enter(store, raw, { env, now: T0 })).toBeNull();
    expect(await enter(store, "", { env, now: T0 })).toBeNull();
    expect(await enter(store, link.token, { env: { PORTAL_SESSION_SECRET: "another-secret-0123456789" }, now: T0 })).toBeNull();
    expect(await peekLoginLink(store, `${raw}.${flip(sig)}`, { env, now: T0 })).toBeNull();
    expect(await enter(store, link.token, { env, now: T0 })).toBe(frank.id);
  });

  it("expires after 24 hours", async () => {
    const link = await createLoginLink(store, frank, { env, now: T0 });
    expect(await enter(store, link.token, { env, now: at(LOGIN_TOKEN_TTL_MS - 1000) })).toBe(frank.id);
    expect(await enter(store, link.token, { env, now: at(LOGIN_TOKEN_TTL_MS) })).toBeNull();
    expect(await peekLoginLink(store, link.token, { env, now: at(LOGIN_TOKEN_TTL_MS) })).toBeNull();
  });

  it("loginLinkFor: the current link again, renewed to 24 h from now; a new one only when there is none", async () => {
    const a = await loginLinkFor(store, frank, { env, now: T0 });
    expect(a.reused).toBe(false);
    const b = await loginLinkFor(store, frank, { env, now: at(20 * 3_600_000) });
    expect(b.reused).toBe(true);
    expect(b.token).toBe(a.token);
    expect(b.expiresAt.getTime()).toBe(at(44 * 3_600_000).getTime());
    // the renewed link still works after its first 24 hours
    expect(await enter(store, a.token, { env, now: at(30 * 3_600_000) })).toBe(frank.id);
    // with the next destination (ranking notice) it is the same token
    const c = await loginLinkFor(store, frank, { env, now: at(21 * 3_600_000), next: "/portal/validar-ranking" });
    expect(c.token).toBe(a.token);
    expect(c.url).toContain("next=%2Fportal%2Fvalidar-ranking");
    // once it expired: a new one; an older still-valid link of the same user also works
    const d = await loginLinkFor(store, frank, { env, now: at(45 * 3_600_000) });
    expect(d.reused).toBe(false);
    expect(d.token).not.toBe(a.token);
    const other = await createLoginLink(store, frank, { env, now: at(45 * 3_600_000) });
    expect(await enter(store, d.token, { env, now: at(46 * 3_600_000) })).toBe(frank.id);
    expect(await enter(store, other.token, { env, now: at(46 * 3_600_000) })).toBe(frank.id);
  });

  it("loginLinkFor with a rotated secret: a new link (the old one cannot be rebuilt)", async () => {
    const a = await loginLinkFor(store, frank, { env, now: T0 });
    const env2 = { ...env, PORTAL_SESSION_SECRET: "rotated-secret-0123456789abc" };
    const b = await loginLinkFor(store, frank, { env: env2, now: at(60_000) });
    expect(b.reused).toBe(false);
    expect(b.token).not.toBe(a.token);
    expect(await enter(store, b.token, { env: env2, now: at(120_000) })).toBe(frank.id);
  });

  it("revokeAccess: all sessions out and links void", async () => {
    const link = await loginLinkFor(store, frank, { env, now: T0 });
    const s1 = await loginWithToken(store, link.token, { env, now: T0 });
    const s2 = await createSession(store, frank.id, { now: T0 });
    expect(await revokeAccess(store, frank.id, { now: at(1000) })).toEqual({ sessions: 2, links: 1 });
    expect(await getSessionUser(store, s1!.session.cookieValue, { now: at(2000) })).toBeNull();
    expect(await getSessionUser(store, s2.cookieValue, { now: at(2000) })).toBeNull();
    expect(await enter(store, link.token, { env, now: at(2000) })).toBeNull();
    expect((await loginLinkFor(store, frank, { env, now: at(3000) })).reused).toBe(false);
  });

  it("refuses to work without a secret (or with a too short one)", async () => {
    await expect(createLoginLink(store, frank, { env: {}, now: T0 })).rejects.toBeInstanceOf(PortalAuthConfigError);
    await expect(createLoginLink(store, frank, { env: { PORTAL_SESSION_SECRET: "   " }, now: T0 })).rejects.toThrow(/PORTAL_SESSION_SECRET/);
    await expect(createLoginLink(store, frank, { env: { PORTAL_SESSION_SECRET: "short" }, now: T0 })).rejects.toThrow(/corto/);
    await expect(loginLinkFor(store, frank, { env: {}, now: T0 })).rejects.toBeInstanceOf(PortalAuthConfigError);
    const link = await createLoginLink(store, frank, { env, now: T0 });
    await expect(loginWithToken(store, link.token, { env: {}, now: T0 })).rejects.toBeInstanceOf(PortalAuthConfigError);
  });

  it("base URL: PORTAL_BASE_URL, then Vercel production URL, then localhost", () => {
    expect(portalBaseUrl({ PORTAL_BASE_URL: "https://a.pe/" })).toBe("https://a.pe");
    expect(portalBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: "protyres.vercel.app" })).toBe("https://protyres.vercel.app");
    expect(portalBaseUrl({})).toBe("http://localhost:3000");
    expect(fixedPortalAddress({ VERCEL_PROJECT_PRODUCTION_URL: "protyres.vercel.app" })).toBe("protyres.vercel.app/portal");
  });
});

describe("session", () => {
  it("valid session returns the user; the store keeps only the hash", async () => {
    const s = await createSession(store, frank.id, { now: T0 });
    expect(s.expiresAt.getTime() - T0.getTime()).toBe(SESSION_TTL_MS);
    expect(await store.getSession(s.cookieValue, T0)).toBeNull();
    expect((await getSessionUser(store, s.cookieValue, { now: at(29 * 86_400_000) }))?.id).toBe(frank.id);
    expect(await getSessionUser(store, "nope", { now: T0 })).toBeNull();
    expect(await getSessionUser(store, undefined, { now: T0 })).toBeNull();
  });

  it("expired session, inactive user and logout -> no user", async () => {
    const s = await createSession(store, frank.id, { now: T0 });
    expect(await getSessionUser(store, s.cookieValue, { now: at(SESSION_TTL_MS) })).toBeNull();
    await store.upsertUser({ nombre: frank.nombre, whatsapp: "51900000001", rol: "vendedor", activo: false });
    expect(await getSessionUser(store, s.cookieValue, { now: T0 })).toBeNull();
    await store.upsertUser({ nombre: frank.nombre, whatsapp: "51900000001", rol: "vendedor", activo: true });
    expect((await getSessionUser(store, s.cookieValue, { now: T0 }))?.id).toBe(frank.id);
    await destroySession(store, s.cookieValue);
    expect(await getSessionUser(store, s.cookieValue, { now: T0 })).toBeNull();
  });

  it("renews with use: each visit gives 30 days from now again (written at most once an hour)", async () => {
    const s = await createSession(store, frank.id, { now: T0 });
    // a visit on day 20 with renew: the session lasts until day 50
    expect((await getSessionUser(store, s.cookieValue, { now: at(20 * 86_400_000), renew: true }))?.id).toBe(frank.id);
    expect((await getSessionUser(store, s.cookieValue, { now: at(45 * 86_400_000) }))?.id).toBe(frank.id);
    expect((await store.getSession(sha256(s.cookieValue), at(45 * 86_400_000)))?.expiresAt.getTime()).toBe(at(50 * 86_400_000).getTime());
    // a visit a few minutes later does not write again
    await getSessionUser(store, s.cookieValue, { now: at(20 * 86_400_000 + SESSION_RENEW_STEP_MS / 2), renew: true });
    expect((await store.getSession(sha256(s.cookieValue), at(45 * 86_400_000)))?.expiresAt.getTime()).toBe(at(50 * 86_400_000).getTime());
    // without visits it still expires
    expect(await getSessionUser(store, s.cookieValue, { now: at(50 * 86_400_000), renew: true })).toBeNull();
  });

  it("cookie: httpOnly, lax, 30 days, secure only in production", async () => {
    const s = await createSession(store, frank.id, { now: T0 });
    const dev = sessionCookie(s, { env: { NODE_ENV: "development" }, now: T0 });
    expect(dev.name).toBe(SESSION_COOKIE);
    expect(dev.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: SESSION_TTL_MS / 1000 });
    expect(sessionCookie(s, { env: { NODE_ENV: "production" }, now: T0 }).options.secure).toBe(true);
  });
});
