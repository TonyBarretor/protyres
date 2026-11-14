/**
 * Corrida E, punto 5: /portal/login con límite de intentos (por IP y por token), cuerpo máximo y token absurdo rechazado
 * antes de tocar la base. Se prueba la lógica (login.ts) y el route handler (src/app/portal/login/route.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPortalConfig } from "../config";
import { JsonPortalStore, __setPortalStoreForTests } from "../store";
import type { PortalStore, PortalUser } from "../store/types";
import { loginGet, loginPost } from "./login";
import { createLoginLink } from "./tokens";
import { GET as routeGet, POST as routePost } from "@/app/portal/login/route";

const env = { PORTAL_SESSION_SECRET: "test-secret-0123456789abcdef", PORTAL_BASE_URL: "https://portal.example.pe" };
const BASE = "https://portal.example.pe/portal/login";
const cfg = loadPortalConfig().publicInputs;
const rule = cfg.rateLimits.login;

let store: JsonPortalStore;
let frank: PortalUser;

beforeEach(async () => {
  store = JsonPortalStore.memory();
  frank = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
});

const ipHeaders = (ip: string) => ({ "x-forwarded-for": `${ip}, 10.0.0.1` });
const post = (token: string, ip = "200.1.1.1", extra: Record<string, string> = {}) =>
  new Request(BASE, { method: "POST", body: new URLSearchParams({ t: token }), headers: { "content-type": "application/x-www-form-urlencoded", ...ipHeaders(ip), ...extra } });
const opts = (s: PortalStore = store) => ({ env, limits: { store: s, env, config: cfg, log: () => undefined } });

/** Store que cuenta cada acceso (para comprobar "sin tocar la base"). */
function countingStore(inner: PortalStore): { store: PortalStore; calls: string[] } {
  const calls: string[] = [];
  const store = new Proxy(inner, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        calls.push(String(p));
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { store, calls };
}

describe("/portal/login: límite de intentos", () => {
  it("POST: pasado perIp desde la misma IP -> 429 con texto en español y Retry-After; otra IP sigue", async () => {
    for (let i = 0; i < rule.perIp; i++) {
      const res = await loginPost(post(`basura${i}.firma`), store, opts());
      expect(res.status).toBe(401);
    }
    const blocked = await loginPost(post("basura.firma"), store, opts());
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await blocked.text()).toContain("Demasiados intentos");
    expect((await loginPost(post("basura.firma", "200.9.9.9"), store, opts())).status).toBe(401);
  });

  it("por token: el mismo enlace desde muchas IPs se bloquea al pasar perToken (GET y POST cuentan)", async () => {
    const link = await createLoginLink(store, frank, { env });
    for (let i = 0; i < rule.perToken!; i++) {
      const res = await loginGet(new Request(link.url, { headers: ipHeaders(`201.0.0.${i}`) }), opts());
      expect(res.status).toBe(200);
    }
    const res = await loginPost(post(link.token, "201.0.1.1"), store, opts());
    expect(res.status).toBe(429);
  });

  it("un login normal (GET + POST) pasa y el GET sin token no cuenta", async () => {
    for (let i = 0; i < rule.perIp * 2; i++) expect((await loginGet(new Request(BASE, { headers: ipHeaders("200.1.1.1") }), opts())).status).toBe(200);
    const link = await createLoginLink(store, frank, { env });
    expect((await loginGet(new Request(link.url, { headers: ipHeaders("200.1.1.1") }), opts())).status).toBe(200);
    expect((await loginPost(post(link.token), store, opts())).status).toBe(303);
  });
});

describe("/portal/login: tamaños", () => {
  it("token absurdo (más largo que maxTokenChars o con caracteres raros): rechazo sin tocar la base", async () => {
    const { store: s, calls } = countingStore(store);
    const long = "a".repeat(cfg.maxTokenChars + 1);
    expect((await loginGet(new Request(`${BASE}?t=${long}`), opts(s))).status).toBe(401);
    expect((await loginPost(post(long), s, opts(s))).status).toBe(401);
    expect((await loginGet(new Request(`${BASE}?t=${encodeURIComponent("<script>.x")}`), opts(s))).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("cuerpo del POST mayor que maxLoginBodyBytes -> 413 sin tocar la base (con y sin Content-Length)", async () => {
    const { store: s, calls } = countingStore(store);
    const big = "t=" + "a".repeat(cfg.maxLoginBodyBytes + 10);
    const withLen = new Request(BASE, { method: "POST", body: big, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect((await loginPost(withLen, s, opts(s))).status).toBe(413);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const chunked = new Request(BASE, { method: "POST", body: stream, headers: { "content-type": "application/x-www-form-urlencoded" }, duplex: "half" } as RequestInit);
    expect((await loginPost(chunked, s, opts(s))).status).toBe(413);
    const lying = new Request(BASE, { method: "POST", body: "t=x.y", headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(10_000_000) } });
    expect((await loginPost(lying, s, opts(s))).status).toBe(413);
    expect(calls).toEqual([]);
  });
});

describe("route handler /portal/login usa el límite", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.PORTAL_SESSION_SECRET;
    process.env.PORTAL_SESSION_SECRET = env.PORTAL_SESSION_SECRET;
    __setPortalStoreForTests(store);
  });
  afterEach(() => {
    __setPortalStoreForTests(null);
    if (saved === undefined) delete process.env.PORTAL_SESSION_SECRET;
    else process.env.PORTAL_SESSION_SECRET = saved;
  });

  it("POST y GET con token: 429 al pasar perIp", async () => {
    let last = 0;
    for (let i = 0; i <= rule.perIp; i++) last = (await routePost(post(`x${i}.y`, "202.2.2.2"))).status;
    expect(last).toBe(429);
    expect((await routeGet(new Request(`${BASE}?t=x.y`, { headers: ipHeaders("202.2.2.2") }))).status).toBe(429);
  });
});
