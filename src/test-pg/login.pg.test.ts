/**
 * Hotfix login (18/11, producción con 7d6b54d) y hotfix login 2 (entrar sin fricción): recorrido completo contra Postgres
 * con la conexión de producción (pooler en modo transacción, pg-options.ts, pool de 5). El bot (una función) da el enlace;
 * la entrada la atiende otra; las pantallas, otras dos (cada una con su pool, como funciones distintas de Vercel).
 *
 *   `portal` ×3 (el mismo enlace) -> GET (no gasta) -> POST (cookie) -> /portal -> otra pantalla -> el mismo enlace otra
 *   vez (con la cookie: al portal; sin ella: entra de nuevo) -> enlace vencido con sesión (al portal) -> enlace vencido sin
 *   sesión (entrada con el botón de WhatsApp) -> `cerrar portal` (sesiones y enlace anulados). 50 veces, en paralelo.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../lib/portal/bot/commands";
import { getPortalCommand, type PortalContext } from "../lib/portal/bot/registry";
import { loginGet, loginPost } from "../lib/portal/auth/login";
import { SESSION_COOKIE } from "../lib/portal/auth/constants";
import { createLoginLink, getSessionUser } from "../lib/portal/auth/tokens";
import { PgPortalStore } from "../lib/portal/store/pg-portal-store";
import type { PortalUser } from "../lib/portal/store/types";
import { testDbUrl, truncateAll } from "./harness";

const ENV = { PORTAL_SESSION_SECRET: "test-secret-0123456789abcdef", PORTAL_BASE_URL: "https://portal.example.pe", NODE_ENV: "production", PORTAL_BOT_WHATSAPP: "51999888777" };
const PORTAL = "https://portal.example.pe/portal";
const N = 50;

/** El bot, la función que atiende /portal/login y las que atienden las pantallas: instancias distintas, cada una con su pool. */
let botFn: PgPortalStore;
let loginFn: PgPortalStore;
let pageFn: PgPortalStore;
let otherPageFn: PgPortalStore;
let users: PortalUser[];

beforeAll(async () => {
  await truncateAll(testDbUrl());
  botFn = PgPortalStore.connect(testDbUrl());
  loginFn = PgPortalStore.connect(testDbUrl());
  pageFn = PgPortalStore.connect(testDbUrl());
  otherPageFn = PgPortalStore.connect(testDbUrl());
  users = [];
  for (let i = 0; i < N; i++) users.push(await botFn.upsertUser({ nombre: `Vendedor ${i}`, whatsapp: `519000${String(i).padStart(5, "0")}`, rol: "vendedor" }));
});
afterAll(async () => {
  await Promise.all([botFn?.close(), loginFn?.close(), pageFn?.close(), otherPageFn?.close()]);
});

function cookieOf(res: Response): { value: string; header: string } {
  const header = res.headers.get("set-cookie") ?? "";
  const m = header.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return { value: m ? decodeURIComponent(m[1]) : "", header };
}

/** Un comando del bot para el usuario (el handler real, registrado por src/lib/portal/bot/commands). Las respuestas. */
async function bot(user: PortalUser, name: "portal" | "cerrar_portal"): Promise<string[]> {
  const replies: string[] = [];
  const ctx = { store: botFn, user, from: user.whatsapp, env: ENV, now: new Date(), reply: async (b: string) => void replies.push(b), log: () => undefined } as unknown as PortalContext;
  await getPortalCommand(name)!(ctx, "");
  return replies;
}

const linkIn = (reply: string) => reply.match(/https:\/\/portal\.example\.pe\/portal\/login\?t=\S+/)?.[0] ?? "";
const tokenOf = (url: string) => new URL(url).searchParams.get("t")!;

function browser(ip: string, cookie?: string) {
  const headers = { "x-forwarded-for": ip, host: "portal.example.pe", origin: "https://portal.example.pe", ...(cookie ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` } : {}) };
  const opts = (fn: PgPortalStore) => ({ env: ENV, limits: { store: async () => fn }, store: async () => fn });
  return {
    get: (url: string, fn: PgPortalStore = loginFn) => loginGet(new Request(url, { headers }), opts(fn)),
    post: (token: string, fn: PgPortalStore = loginFn) =>
      loginPost(new Request(`${PORTAL}/login`, { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t: token, via: "auto" }) }), async () => fn, opts(fn)),
  };
}

/** Pedir el enlace y entrar (GET + POST) desde un navegador sin sesión. */
async function enter(user: PortalUser, ip: string, fn: PgPortalStore = loginFn): Promise<{ status: number; location: string | null; cookie: string; header: string; page1: PortalUser | null; page2: PortalUser | null }> {
  const url = linkIn((await bot(user, "portal"))[0]);
  const b = browser(ip);
  expect((await b.get(url, fn)).status).toBe(200);
  const post = await b.post(tokenOf(url), fn);
  const c = cookieOf(post);
  // /portal (layout + página, renueva la sesión) en otra función, de inmediato; luego otra pantalla en una tercera
  const page1 = await getSessionUser(pageFn, c.value, { renew: true });
  const page2 = await getSessionUser(otherPageFn, c.value, { renew: true });
  return { status: post.status, location: post.headers.get("location"), cookie: c.value, header: c.header, page1, page2 };
}

/** El recorrido completo del hotfix login 2; devuelve lo que no salió como se espera (vacío = bien). */
async function fullJourney(user: PortalUser, ip: string): Promise<string[]> {
  const bad: string[] = [];
  const check = (ok: boolean, what: string) => void (ok || bad.push(what));
  // pedir `portal` tres veces seguidas: el mismo enlace, y los tres mensajes sirven
  const replies = [...(await bot(user, "portal")), ...(await bot(user, "portal")), ...(await bot(user, "portal"))];
  const urls = replies.map(linkIn);
  check(urls.every((u) => u && u === urls[0]), "portal ×3 no dio el mismo enlace");
  check(replies.every((r) => r.includes("Sirve por 24 horas")), "texto del mensaje");
  const url = urls[0];
  const token = tokenOf(url);
  // la vista previa de WhatsApp (GET) y entrar
  check((await browser(ip).get(url)).status === 200, "vista previa");
  check((await browser(ip).get(url)).status === 200, "GET del enlace");
  const post = await browser(ip).post(token);
  const cookie = cookieOf(post).value;
  check(post.status === 303 && post.headers.get("location") === PORTAL && !!cookie, `POST ${post.status}`);
  // /portal y otra pantalla, en otras funciones
  check((await getSessionUser(pageFn, cookie, { renew: true }))?.id === user.id, "/portal sin sesión");
  check((await getSessionUser(otherPageFn, cookie, { renew: true }))?.id === user.id, "segunda pantalla sin sesión");
  // volver a abrir el mismo enlace: con la cookie, al portal; sin ella (navegador cerrado sin guardarla), entra otra vez
  const again = await browser(ip, cookie).get(url);
  check(again.status === 303 && again.headers.get("location") === PORTAL, `mismo enlace con sesión: ${again.status}`);
  for (const r of replies) {
    const p = await browser(ip).post(tokenOf(linkIn(r)));
    check(p.status === 303 && !!cookieOf(p).value, `mismo enlace sin sesión: ${p.status}`);
  }
  // un enlace vencido con sesión: al portal; sin sesión: la entrada con el botón de WhatsApp
  const expired = await createLoginLink(botFn, user, { env: ENV, now: new Date(Date.now() - 25 * 3_600_000) });
  const exp1 = await browser(ip, cookie).get(expired.url);
  check(exp1.status === 303 && exp1.headers.get("location") === PORTAL, `vencido con sesión: ${exp1.status}`);
  const exp2 = await browser(ip).get(expired.url);
  const html = await exp2.text();
  check(exp2.status === 401 && html.includes("https://wa.me/51999888777?text=portal") && html.includes("Pedir enlace por WhatsApp"), `vencido sin sesión: ${exp2.status}`);
  // `cerrar portal`: todo queda invalidado
  const closed = await bot(user, "cerrar_portal");
  check(/cerré tu portal en todos los teléfonos \(\d+ sesiones abiertas\)/.test(closed[0] ?? ""), `cerrar portal: ${closed[0]}`);
  check((await getSessionUser(pageFn, cookie)) === null, "la sesión sigue después de cerrar portal");
  const afterGet = await browser(ip).get(url);
  check(afterGet.status === 401, `enlace después de cerrar portal (GET): ${afterGet.status}`);
  const afterPost = await browser(ip).post(token);
  check(afterPost.status === 401 && !cookieOf(afterPost).value, `enlace después de cerrar portal (POST): ${afterPost.status}`);
  const withOldCookie = await browser(ip, cookie).get(url);
  check(withOldCookie.status === 401, `cookie vieja después de cerrar portal: ${withOldCookie.status}`);
  // y `portal` da uno nuevo que entra
  const fresh = linkIn((await bot(user, "portal"))[0]);
  check(fresh !== url, "después de cerrar portal, el bot reenvió el enlace anulado");
  check((await browser(ip).post(tokenOf(fresh))).status === 303, "el enlace nuevo no entra");
  return bad;
}

describe("entrada al portal con Postgres (hotfix login 2)", () => {
  it("recorrido completo de un usuario: portal ×3, entrar, dos pantallas, mismo enlace, vencido con y sin sesión, cerrar portal", async () => {
    expect(await fullJourney(users[0], "10.0.0.1")).toEqual([]);
  });

  it(`el recorrido completo ${N} veces en paralelo (${N} usuarios, cada uno desde su IP)`, async () => {
    const runs = await Promise.all(users.map((u, i) => fullJourney(u, `10.1.${i}.1`)));
    expect(runs.map((bad, i) => ({ i, bad })).filter((r) => r.bad.length)).toEqual([]);
  }, 300_000);

  it("cookie con sus atributos de seguridad y sesión de 30 días (fechas bien escritas y leídas)", async () => {
    const r = await enter(users[1], "10.0.0.2");
    expect(r.status).toBe(303);
    expect(r.location).toBe(PORTAL);
    expect(r.header).toMatch(/HttpOnly/i);
    expect(r.header).toMatch(/Path=\//);
    expect(r.header).toMatch(/SameSite=lax/i);
    expect(r.header).toMatch(/Secure/i);
    expect(r.page1?.id).toBe(users[1].id);
    expect(r.page2?.id).toBe(users[1].id);
    const { sha256 } = await import("../lib/portal/auth/tokens");
    const s = await pageFn.getSession(sha256(r.cookie), new Date());
    const days = (s!.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("una conexión del pool con una transacción abierta (como el BEGIN fallido del 16/11) no se traga la entrada", async () => {
    const fn = PgPortalStore.connect(testDbUrl());
    try {
      // BEGIN fuera de sql.begin en el pool: la lib lo rechaza (UNSAFE_TRANSACTION) pero el servidor deja la transacción
      // abierta y la conexión vuelve al pool; todo lo que se escriba por ella queda sin confirmar
      const raw = (fn as unknown as { sql: { unsafe(q: string): Promise<unknown> } }).sql;
      await raw.unsafe("begin").catch(() => undefined);
      const runs = [];
      for (let i = 0; i < 15; i++) runs.push(await enter(users[i % 5], `10.2.${i}.1`, fn));
      expect(runs.map((r) => [r.status, !!r.page1, !!r.page2])).toEqual(runs.map(() => [303, true, true]));
    } finally {
      await fn.close();
    }
  }, 120_000);

  it("la conexión que traía una transacción abierta se sanea al reservarla: lo pendiente se deshace", async () => {
    const fn = PgPortalStore.connect(testDbUrl());
    const admin = (await import("postgres")).default(testDbUrl(), { prepare: false, max: 1, onnotice: () => undefined });
    const dbName = new URL(testDbUrl()).pathname.slice(1);
    const idleTx = async () => (await admin`select count(*)::int as n from pg_stat_activity where datname = ${dbName} and state like 'idle in transaction%'`)[0].n as number;
    try {
      const raw = (fn as unknown as { sql: { unsafe(q: string): Promise<unknown> } }).sql;
      // una transacción sin COMMIT con una escritura a medias (la conexión es la única del pool todavía: todo va por ella)
      await raw.unsafe("begin").catch(() => undefined);
      await raw.unsafe("insert into rate_limit_hits (bucket, window_start, hits) values ('a-medias', now(), 1)");
      // cada transacción reserva una conexión del pool (en turno): a lo más 5 para pasar por la colgada
      for (let i = 0; i < 6; i++) await fn.useLoginTokenIntoSession(`no-existe-${i}`, new Date(), { id: `s-${i}`, expiresAt: new Date(Date.now() + 60_000) });
      expect(await idleTx()).toBe(0);
      // lo de la transacción sin COMMIT se deshace (no se confirma a ciegas con el COMMIT de la siguiente)
      expect((await admin`select count(*)::int as n from rate_limit_hits where bucket = 'a-medias'`)[0].n).toBe(0);
    } finally {
      await fn.close();
      await admin.end();
    }
  }, 60_000);
});
