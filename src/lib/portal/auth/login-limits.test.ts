/**
 * Corrida E, punto 5: /portal/login con límite de intentos (por IP y por token), cuerpo máximo y token absurdo rechazado
 * antes de tocar la base. Se prueba la lógica (login.ts) y el route handler (src/app/portal/login/route.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPortalConfig } from "../config";
import { JsonPortalStore, __setPortalStoreForTests } from "../store";
import type { PortalStore, PortalUser } from "../store/types";
import { loginGet, loginPost } from "./login";
import { createLoginLink, revokeAccess } from "./tokens";
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

  // hotfix login 2 (cambio pedido): un enlace vigente sirve las veces que haga falta y no cuenta; el límite por token es
  // para los enlaces que no sirven (vencidos o anulados), enviados desde muchas IPs
  it("por token: un enlace anulado, enviado desde muchas IPs, se bloquea al pasar perToken", async () => {
    const link = await createLoginLink(store, frank, { env });
    for (let i = 0; i < 3; i++) expect((await loginPost(post(link.token, "201.0.0.250"), store, opts())).status).toBe(303);
    await revokeAccess(store, frank.id);
    for (let i = 0; i < rule.perToken!; i++) expect((await loginPost(post(link.token, `201.0.0.${i}`), store, opts())).status).toBe(401);
    expect((await loginPost(post(link.token, "201.0.1.1"), store, opts())).status).toBe(429);
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

describe("hotfix login: un usuario legítimo no queda bloqueado", () => {
  it("pide 4 enlaces seguidos, abre cada uno dos veces (vista previa + él) y entra con cada uno: nunca 429", async () => {
    for (let round = 0; round < 3; round++)
      for (let i = 0; i < 4; i++) {
        const link = await createLoginLink(store, frank, { env });
        for (let k = 0; k < 2; k++) expect((await loginGet(new Request(link.url, { headers: ipHeaders("190.5.5.5") }), { ...opts(), store })).status).toBe(200);
        expect((await loginPost(post(link.token, "190.5.5.5"), store, opts())).status).toBe(303);
      }
  });

  it("una entrada que salió bien no cuenta como intento fallido", async () => {
    // perIp - 1 intentos fallidos desde la IP de la oficina
    for (let i = 0; i < rule.perIp - 1; i++) expect((await loginPost(post(`basura${i}.firma`, "190.6.6.6"), store, opts())).status).toBe(401);
    // varias entradas buenas: no suman
    for (let i = 0; i < 5; i++) expect((await loginPost(post((await createLoginLink(store, frank, { env })).token, "190.6.6.6"), store, opts())).status).toBe(303);
    // el siguiente fallido es el número perIp: todavía pasa (401), el de después ya no
    expect((await loginPost(post("basura.otra", "190.6.6.6"), store, opts())).status).toBe(401);
    expect((await loginPost(post("basura.mas", "190.6.6.6"), store, opts())).status).toBe(429);
  });

  it("el mismo enlace tocado 10 veces (GET + POST, sin cookie: navegador cerrado) entra las 10; nada cuenta", async () => {
    const link = await createLoginLink(store, frank, { env });
    for (let i = 0; i < 10; i++) {
      expect((await loginGet(new Request(link.url, { headers: ipHeaders("190.7.7.7") }), { ...opts(), store })).status).toBe(200);
      expect((await loginPost(post(link.token, "190.7.7.7"), store, opts())).status).toBe(303);
    }
  });

  it("un enlace vencido tocado 6 veces sin sesión: la entrada con el botón cada vez, nunca «Demasiados intentos»", async () => {
    const link = await createLoginLink(store, frank, { env, now: new Date(Date.now() - 25 * 3_600_000) });
    expect(rule.perToken!).toBeGreaterThanOrEqual(12);
    for (let i = 0; i < 6; i++) {
      const get = await loginGet(new Request(link.url, { headers: ipHeaders("190.8.8.8") }), { ...opts(), store });
      expect(get.status).toBe(401);
      expect(await get.text()).toContain("Este enlace ya venció");
      expect((await loginPost(post(link.token, "190.8.8.8"), store, opts())).status).toBe(401);
    }
  });
});

describe("hotfix login 2: con sesión vigente, cualquier enlace entra", () => {
  const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").match(/portal_session=([^;]+)/)?.[1] ?? "";
  const withCookie = (c: string) => ({ cookie: `portal_session=${c}` });

  it("GET y POST del enlace ya usado con la cookie: al portal sin crear otra sesión; sin cookie, el enlace vuelve a entrar", async () => {
    const link = await createLoginLink(store, frank, { env });
    const first = await loginPost(post(link.token), store, opts());
    expect(first.status).toBe(303);
    const c = cookieOf(first);
    const get = await loginGet(new Request(link.url, { headers: { ...ipHeaders("200.1.1.1"), ...withCookie(c) } }), { ...opts(), store });
    expect(get.status).toBe(303);
    expect(get.headers.get("location")).toBe("https://portal.example.pe/portal");
    const again = await loginPost(post(link.token, "200.1.1.1", withCookie(c)), store, opts());
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe("https://portal.example.pe/portal");
    expect(again.headers.get("set-cookie")).toBeNull();
    // sin la cookie (otro navegador, o el mismo después de cerrarlo): el enlace sigue sirviendo
    const other = await loginPost(post(link.token, "200.1.1.1"), store, opts());
    expect(other.status).toBe(303);
    expect(cookieOf(other)).not.toBe("");
    // una cookie que no es de una sesión vigente no cuenta como sesión: el enlace decide
    expect((await loginPost(post(link.token, "200.1.1.1", withCookie("cookie-falsa")), store, opts())).status).toBe(303);
  });

  it("vencido, anulado, inexistente, con firma mala o sin token: al portal, sin gastar nada ni contar (más veces que el límite)", async () => {
    const c = cookieOf(await loginPost(post((await createLoginLink(store, frank, { env })).token), store, opts()));
    const expired = await createLoginLink(store, frank, { env, now: new Date(Date.now() - 25 * 3_600_000) });
    const tokens = [`?t=${encodeURIComponent(expired.token)}`, "?t=basura.firma", `?t=${"a".repeat(200)}`, "", `?t=${encodeURIComponent(expired.token)}&next=%2Fportal%2Fvalidar-ranking`];
    for (let i = 0; i <= rule.perIp; i++)
      for (const q of tokens) {
        const res = await loginGet(new Request(`${BASE}${q}`, { headers: { ...ipHeaders("200.3.3.3"), ...withCookie(c) } }), { ...opts(), store });
        expect(res.status, q).toBe(303);
        expect(res.headers.get("location"), q).toBe(q.includes("next=") ? "https://portal.example.pe/portal/validar-ranking" : "https://portal.example.pe/portal");
      }
    const post303 = await loginPost(post(expired.token, "200.3.3.3", withCookie(c)), store, opts());
    expect(post303.status).toBe(303);
    // y nada de eso contó: desde esa IP, sin cookie, el primer intento fallido no es 429
    expect((await loginPost(post("basura.firma", "200.3.3.3"), store, opts())).status).toBe(401);
  });

  it("la vista previa de WhatsApp (GET sin cookie, muchas veces) no gasta, no invalida ni cuenta", async () => {
    const link = await createLoginLink(store, frank, { env });
    const { store: s, calls } = countingStore(store);
    for (let i = 0; i <= rule.perIp; i++) expect((await loginGet(new Request(link.url, { headers: { ...ipHeaders("200.4.4.4"), "user-agent": "WhatsApp/2.24" } }), { ...opts(s), store: s })).status).toBe(200);
    expect(calls.filter((c) => c !== "peekLoginToken")).toEqual([]);
    expect((await loginPost(post(link.token, "200.4.4.4"), store, opts())).status).toBe(303);
  });
});

describe("hotfix login 2: sin sesión, la entrada con el botón para pedir el enlace", () => {
  const envBot = { ...env, PORTAL_BOT_WHATSAPP: "51 999 888 777" };

  it("sin token y con un enlace vencido: botón «Pedir enlace por WhatsApp» al chat del bot con portal escrito", async () => {
    const expired = await createLoginLink(store, frank, { env, now: new Date(Date.now() - 25 * 3_600_000) });
    for (const url of [BASE, expired.url]) {
      const html = await (await loginGet(new Request(url), { env: envBot, store })).text();
      expect(html).toContain('<a class="btn" href="https://wa.me/51999888777?text=portal"');
      expect(html).toContain("Pedir enlace por WhatsApp");
      expect(html).toContain("Se abre el chat del bot con la palabra <b>portal</b> ya escrita");
      expect(html).toContain("El enlace sirve por 24 horas. Después de entrar, tu teléfono queda con la sesión abierta por 30 días.");
    }
    // también la de «Demasiados intentos»
    let last: Response | null = null;
    for (let i = 0; i <= rule.perIp; i++) last = await loginPost(post(`basura${i}.firma`, "200.5.5.5"), store, { ...opts(), env: envBot });
    expect(last!.status).toBe(429);
    expect(await last!.text()).toContain("https://wa.me/51999888777?text=portal");
  });

  it("sin número del bot configurado: la instrucción escrita (sin botón roto)", async () => {
    const html = await (await loginGet(new Request(BASE), { env, store })).text();
    expect(html).not.toContain("wa.me");
    expect(html).toContain("Escribe <b>portal</b> al bot de WhatsApp");
  });
});
