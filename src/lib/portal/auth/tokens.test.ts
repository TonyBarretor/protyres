import { beforeEach, describe, expect, it } from "vitest";
import { JsonPortalStore } from "../store";
import type { PortalUser } from "../store/types";
import { LOGIN_PATH, LOGIN_TOKEN_TTL_MS, SESSION_COOKIE, SESSION_TTL_MS } from "./constants";
import { PortalAuthConfigError, createLoginLink, createSession, destroySession, getSessionUser, portalBaseUrl, sessionCookie, sha256, verifyLoginToken } from "./tokens";

const env = { PORTAL_SESSION_SECRET: "test-secret-0123456789abcdef", PORTAL_BASE_URL: "https://portal.example.pe/" };
const T0 = new Date("2026-11-11T15:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let store: JsonPortalStore;
let frank: PortalUser;

beforeEach(async () => {
  store = JsonPortalStore.memory();
  frank = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
});

describe("login link", () => {
  it("builds a signed one-time link and stores only the hash", async () => {
    const link = await createLoginLink(store, frank, { env, now: T0 });
    expect(link.url.startsWith(`https://portal.example.pe${LOGIN_PATH}?t=`)).toBe(true);
    const [raw, sig] = link.token.split(".");
    expect(Buffer.from(raw, "base64url").length).toBe(32);
    expect(sig.length).toBeGreaterThan(20);
    expect(link.expiresAt.getTime() - T0.getTime()).toBe(LOGIN_TOKEN_TTL_MS);
    expect(decodeURIComponent(new URL(link.url).searchParams.get("t")!)).toBe(link.token);
    // the raw token is not a key of the store: only its sha256
    expect(await store.consumeLoginToken(raw, T0)).toBeNull();
    expect(await store.consumeLoginToken(sha256(raw), T0)).toBe(frank.id);
  });

  it("valid signature -> userId, then single use", async () => {
    const link = await createLoginLink(store, frank, { env, now: T0 });
    expect(await verifyLoginToken(store, link.token, { env, now: at(60_000) })).toBe(frank.id);
    expect(await verifyLoginToken(store, link.token, { env, now: at(61_000) })).toBeNull();
  });

  it("rejects a tampered signature or token, and a different secret", async () => {
    const link = await createLoginLink(store, frank, { env, now: T0 });
    const [raw, sig] = link.token.split(".");
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    expect(await verifyLoginToken(store, `${raw}.${flip(sig)}`, { env, now: T0 })).toBeNull();
    expect(await verifyLoginToken(store, `${flip(raw)}.${sig}`, { env, now: T0 })).toBeNull();
    expect(await verifyLoginToken(store, raw, { env, now: T0 })).toBeNull();
    expect(await verifyLoginToken(store, "", { env, now: T0 })).toBeNull();
    expect(await verifyLoginToken(store, link.token, { env: { PORTAL_SESSION_SECRET: "another-secret-0123456789" }, now: T0 })).toBeNull();
    // the tampered attempts did not burn the real token
    expect(await verifyLoginToken(store, link.token, { env, now: T0 })).toBe(frank.id);
  });

  it("expires after 15 minutes", async () => {
    const link = await createLoginLink(store, frank, { env, now: T0 });
    expect(await verifyLoginToken(store, link.token, { env, now: at(LOGIN_TOKEN_TTL_MS) })).toBeNull();
  });

  it("refuses to work without a secret (or with a too short one)", async () => {
    await expect(createLoginLink(store, frank, { env: {}, now: T0 })).rejects.toBeInstanceOf(PortalAuthConfigError);
    await expect(createLoginLink(store, frank, { env: { PORTAL_SESSION_SECRET: "   " }, now: T0 })).rejects.toThrow(/PORTAL_SESSION_SECRET/);
    await expect(createLoginLink(store, frank, { env: { PORTAL_SESSION_SECRET: "short" }, now: T0 })).rejects.toThrow(/corto/);
    const link = await createLoginLink(store, frank, { env, now: T0 });
    await expect(verifyLoginToken(store, link.token, { env: {}, now: T0 })).rejects.toBeInstanceOf(PortalAuthConfigError);
  });

  it("base URL: PORTAL_BASE_URL, then Vercel production URL, then localhost", () => {
    expect(portalBaseUrl({ PORTAL_BASE_URL: "https://a.pe/" })).toBe("https://a.pe");
    expect(portalBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: "protyres.vercel.app" })).toBe("https://protyres.vercel.app");
    expect(portalBaseUrl({})).toBe("http://localhost:3000");
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

  it("cookie: httpOnly, lax, 30 days, secure only in production", async () => {
    const s = await createSession(store, frank.id, { now: T0 });
    const dev = sessionCookie(s, { env: { NODE_ENV: "development" }, now: T0 });
    expect(dev.name).toBe(SESSION_COOKIE);
    expect(dev.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: SESSION_TTL_MS / 1000 });
    expect(sessionCookie(s, { env: { NODE_ENV: "production" }, now: T0 }).options.secure).toBe(true);
  });
});
