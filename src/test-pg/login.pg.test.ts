/**
 * Hotfix login (18/11, producción con 7d6b54d): el POST de /portal/login validaba el enlace y creaba la sesión, pero la
 * petición siguiente a /portal no la reconocía y volvía a la entrada; al reabrir el enlace, "Enlace vencido o ya usado" y
 * luego "Demasiados intentos".
 *
 * Recorrido completo contra Postgres con la conexión de producción (pooler en modo transacción, pg-options.ts, pool de 5):
 * enlace -> GET (no se gasta) -> POST (cookie) -> /portal con la cookie desde OTRA instancia del store (otra función de
 * Vercel, otras conexiones) -> una segunda página. 50 veces, en paralelo.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loginGet, loginPost } from "../lib/portal/auth/login";
import { SESSION_COOKIE } from "../lib/portal/auth/constants";
import { createLoginLink, getSessionUser } from "../lib/portal/auth/tokens";
import { PgPortalStore } from "../lib/portal/store/pg-portal-store";
import type { PortalUser } from "../lib/portal/store/types";
import { testDbUrl, truncateAll } from "./harness";

const ENV = { PORTAL_SESSION_SECRET: "test-secret-0123456789abcdef", PORTAL_BASE_URL: "https://portal.example.pe", NODE_ENV: "production" };

/** La función que atiende /portal/login y las que atienden las páginas: instancias distintas, cada una con su pool. */
let loginFn: PgPortalStore;
let pageFn: PgPortalStore;
let otherPageFn: PgPortalStore;
let users: PortalUser[];

beforeAll(async () => {
  await truncateAll(testDbUrl());
  loginFn = PgPortalStore.connect(testDbUrl());
  pageFn = PgPortalStore.connect(testDbUrl());
  otherPageFn = PgPortalStore.connect(testDbUrl());
  users = [];
  for (let i = 0; i < 5; i++) users.push(await loginFn.upsertUser({ nombre: `Vendedor ${i}`, whatsapp: `5190000010${i}`, rol: "vendedor" }));
});
afterAll(async () => {
  await Promise.all([loginFn?.close(), pageFn?.close(), otherPageFn?.close()]);
});

function cookieOf(res: Response): { value: string; header: string } {
  const header = res.headers.get("set-cookie") ?? "";
  const m = header.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return { value: m ? decodeURIComponent(m[1]) : "", header };
}

/** Un ingreso completo de un usuario desde su IP: el bot crea el enlace, el navegador lo abre y lo envía. */
async function journey(user: PortalUser, ip: string, fn: PgPortalStore = loginFn): Promise<{ status: number; location: string | null; cookie: string; header: string; page1: PortalUser | null; page2: PortalUser | null }> {
  // el enlace lo crea el bot (otra función); la entrada la atiende `fn`
  const link = await createLoginLink(loginFn, user, { env: ENV });
  const headers = { "x-forwarded-for": ip, host: "portal.example.pe", origin: "https://portal.example.pe" };
  const limits = { store: async () => fn };
  const get = await loginGet(new Request(link.url, { headers }), { env: ENV, limits });
  expect(get.status).toBe(200);
  const body = new URLSearchParams({ t: link.token, via: "auto" });
  const post = await loginPost(new Request("https://portal.example.pe/portal/login", { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body }), async () => fn, { env: ENV, limits });
  const c = cookieOf(post);
  // /portal (layout + página) en otra función, de inmediato; luego otra pantalla en una tercera
  const page1 = await getSessionUser(pageFn, c.value);
  const page2 = await getSessionUser(otherPageFn, c.value);
  return { status: post.status, location: post.headers.get("location"), cookie: c.value, header: c.header, page1, page2 };
}

describe("entrada al portal con Postgres (hotfix login)", () => {
  it("enlace -> POST -> /portal con la cookie desde otra instancia -> segunda página", async () => {
    const r = await journey(users[0], "10.0.0.1");
    expect(r.status).toBe(303);
    expect(r.location).toBe("https://portal.example.pe/portal");
    expect(r.cookie).not.toBe("");
    expect(r.header).toMatch(/HttpOnly/i);
    expect(r.header).toMatch(/Path=\//);
    expect(r.header).toMatch(/SameSite=lax/i);
    expect(r.header).toMatch(/Secure/i);
    expect(r.page1?.id).toBe(users[0].id);
    expect(r.page2?.id).toBe(users[0].id);
  });

  it("la sesión queda guardada con 30 días de vigencia (fechas bien escritas y leídas)", async () => {
    const r = await journey(users[1], "10.0.0.2");
    const { sha256 } = await import("../lib/portal/auth/tokens");
    const s = await pageFn.getSession(sha256(r.cookie), new Date());
    expect(s).not.toBeNull();
    const days = (s!.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("50 ingresos en paralelo (5 usuarios, cada uno desde su IP): todos reconocidos en las dos páginas", async () => {
    const runs = await Promise.all(Array.from({ length: 50 }, (_, i) => journey(users[i % 5], `10.1.${i % 5}.1`)));
    const bad = runs.map((r, i) => ({ i, ...r })).filter((r) => r.status !== 303 || !r.page1 || !r.page2);
    expect(bad.map((b) => ({ i: b.i, status: b.status, page1: !!b.page1, page2: !!b.page2 }))).toEqual([]);
    runs.forEach((r, i) => expect(r.page1?.id).toBe(users[i % 5].id));
  }, 120_000);

  it("una conexión del pool con una transacción abierta (como el BEGIN fallido del 16/11) no se traga la entrada", async () => {
    const fn = PgPortalStore.connect(testDbUrl());
    try {
      // BEGIN fuera de sql.begin en el pool: la lib lo rechaza (UNSAFE_TRANSACTION) pero el servidor deja la transacción
      // abierta y la conexión vuelve al pool; todo lo que se escriba por ella queda sin confirmar
      const raw = (fn as unknown as { sql: { unsafe(q: string): Promise<unknown> } }).sql;
      await raw.unsafe("begin").catch(() => undefined);
      const runs = [];
      for (let i = 0; i < 15; i++) runs.push(await journey(users[i % 5], `10.2.${i}.1`, fn));
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
      for (let i = 0; i < 6; i++) await fn.consumeLoginTokenIntoSession(`no-existe-${i}`, new Date(), { id: `s-${i}`, expiresAt: new Date(Date.now() + 60_000) });
      expect(await idleTx()).toBe(0);
      // lo de la transacción sin COMMIT se deshace (no se confirma a ciegas con el COMMIT de la siguiente)
      expect((await admin`select count(*)::int as n from rate_limit_hits where bucket = 'a-medias'`)[0].n).toBe(0);
    } finally {
      await fn.close();
      await admin.end();
    }
  }, 60_000);
});
