import { beforeEach, describe, expect, it } from "vitest";
import { JsonPortalStore } from "../store";
import type { PortalUser } from "../store/types";
import { SESSION_COOKIE } from "./constants";
import { isSameOrigin, loginGet, loginPost, logout, logoutMethodNotAllowed } from "./login";
import { createLoginLink, getSessionUser } from "./tokens";

const env = { PORTAL_SESSION_SECRET: "test-secret-0123456789abcdef", PORTAL_BASE_URL: "https://portal.example.pe" };
const BASE = "https://portal.example.pe/portal/login";

let store: JsonPortalStore;
let frank: PortalUser;

beforeEach(async () => {
  store = JsonPortalStore.memory();
  frank = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
});

const post = (token: string, cookie?: string, extra: Record<string, string> = {}) => {
  const body = new URLSearchParams({ t: token });
  return new Request(BASE, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}), ...extra } });
};

describe("/portal/login", () => {
  it("GET without token: public 'no session' page", async () => {
    const res = await loginGet(new Request(BASE), { env });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("portal");
  });

  it("GET with a valid link does not consume it; POST logs in, sets the cookie and redirects to /portal", async () => {
    const link = await createLoginLink(store, frank, { env });
    const page = await loginGet(new Request(link.url), { env });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('method="post"');

    const res = await loginPost(post(link.token), store, { env });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://portal.example.pe/portal");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    const value = decodeURIComponent(setCookie.split(";")[0].split("=")[1]);
    expect((await getSessionUser(store, value))?.id).toBe(frank.id);

    // second use: expired page
    const again = await loginPost(post(link.token), store, { env });
    expect(again.status).toBe(401);
    expect(await again.text()).toContain("Enlace vencido o ya usado");

    // logout removes the session and clears the cookie
    const out = await logout(new Request("https://portal.example.pe/api/portal/logout", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(value)}` } }), store);
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe(BASE);
    expect(await getSessionUser(store, value)).toBeNull();
  });

  it("tampered token: expired page on GET and POST", async () => {
    const link = await createLoginLink(store, frank, { env });
    const bad = `${link.token}x`;
    expect((await loginGet(new Request(`${BASE}?t=${bad}`), { env })).status).toBe(401);
    expect((await loginPost(post(bad), store, { env })).status).toBe(401);
  });

  it("POST with a foreign Origin is rejected without consuming the token; same origin works", async () => {
    const link = await createLoginLink(store, frank, { env });
    const evil = await loginPost(post(link.token, undefined, { origin: "https://evil.example.com" }), store, { env });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("set-cookie")).toBeNull();
    expect((await loginPost(post(link.token, undefined, { origin: "null" }), store, { env })).status).toBe(403);
    const ok = await loginPost(post(link.token, undefined, { origin: "https://portal.example.pe" }), store, { env });
    expect(ok.status).toBe(303);
  });

  it("isSameOrigin uses x-forwarded-host / host when present", () => {
    const req = (h: Record<string, string>) => new Request("http://localhost:3000/portal/login", { method: "POST", headers: h });
    expect(isSameOrigin(req({}))).toBe(true);
    expect(isSameOrigin(req({ origin: "http://localhost:3000" }))).toBe(true);
    expect(isSameOrigin(req({ origin: "https://portal.example.pe", "x-forwarded-host": "portal.example.pe" }))).toBe(true);
    expect(isSameOrigin(req({ origin: "https://portal.example.pe", host: "portal.example.pe" }))).toBe(true);
    expect(isSameOrigin(req({ origin: "https://otro.pe", host: "portal.example.pe" }))).toBe(false);
  });

  it("GET logout is 405 and does not touch the session", async () => {
    const res = logoutMethodNotAllowed();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("without secret: clear configuration page", async () => {
    const res = await loginGet(new Request(`${BASE}?t=a.b`), { env: {} });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("PORTAL_SESSION_SECRET");
  });
});
