/**
 * Corrida E, punto 5: límite de intentos de las entradas públicas (lógica pura + store en memoria).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPortalConfig } from "../config";
import { expectedSchema } from "../store/migrate-guard";
import { JsonPortalStore } from "../store";
import { checkRateLimit, clientIp, hashBucketPart, windowStartOf } from "./rate-limit";

const env = { PORTAL_SESSION_SECRET: "test-secret-0123456789abcdef" };
const cfg = loadPortalConfig().publicInputs;

describe("clientIp", () => {
  it("primer valor de x-forwarded-for; si no, x-real-ip; si no, 'desconocida'", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": " 200.1.2.3 , 10.0.0.1", "x-real-ip": "9.9.9.9" }))).toBe("200.1.2.3");
    expect(clientIp(new Headers({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(new Headers())).toBe("desconocida");
    expect(clientIp(new Headers({ "x-forwarded-for": "x".repeat(500) })).length).toBeLessThanOrEqual(64);
  });
});

describe("hashBucketPart", () => {
  it("no deja la IP en claro y depende del secreto", () => {
    const a = hashBucketPart("ip", "200.1.2.3", env);
    expect(a).not.toContain("200.1.2.3");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(hashBucketPart("ip", "200.1.2.3", env)).toBe(a);
    expect(hashBucketPart("ip", "200.1.2.3", { PORTAL_SESSION_SECRET: "otro-secreto-0123456789" })).not.toBe(a);
    expect(hashBucketPart("ip", "200.1.2.3", {})).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("windowStartOf", () => {
  it("ventana fija alineada", () => {
    const now = new Date("2026-11-13T15:37:12Z");
    expect(windowStartOf(now, 15 * 60_000).toISOString()).toBe("2026-11-13T15:30:00.000Z");
    expect(windowStartOf(now, 60 * 60_000).toISOString()).toBe("2026-11-13T15:00:00.000Z");
  });
});

describe("checkRateLimit", () => {
  const now = new Date("2026-11-13T15:37:12Z");

  it("por IP: deja pasar hasta el máximo y luego bloquea con Retry-After; otra IP sigue", async () => {
    const store = JsonPortalStore.memory();
    const deps = { store, env, now, config: cfg };
    const max = cfg.rateLimits.cron.perIp;
    for (let i = 0; i < max; i++) expect((await checkRateLimit(deps, "cron", { ip: "1.1.1.1" })).ok).toBe(true);
    const r = await checkRateLimit(deps, "cron", { ip: "1.1.1.1" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.by).toBe("ip");
      expect(r.retryAfterSec).toBeGreaterThan(0);
      expect(r.retryAfterSec).toBeLessThanOrEqual(3600);
    }
    expect((await checkRateLimit(deps, "cron", { ip: "2.2.2.2" })).ok).toBe(true);
  });

  it("la ventana siguiente vuelve a contar desde cero", async () => {
    const store = JsonPortalStore.memory();
    const max = cfg.rateLimits.cron.perIp;
    for (let i = 0; i <= max; i++) await checkRateLimit({ store, env, now, config: cfg }, "cron", { ip: "1.1.1.1" });
    const later = new Date(now.getTime() + 60 * 60_000);
    expect((await checkRateLimit({ store, env, now: later, config: cfg }, "cron", { ip: "1.1.1.1" })).ok).toBe(true);
  });

  it("por token: el mismo enlace desde IPs distintas se bloquea al pasar perToken", async () => {
    const store = JsonPortalStore.memory();
    const deps = { store, env, now, config: cfg };
    const max = cfg.rateLimits.surveySubmit.perToken!;
    for (let i = 0; i < max; i++) expect((await checkRateLimit(deps, "surveySubmit", { ip: `10.0.0.${i}`, token: "tok" })).ok).toBe(true);
    const r = await checkRateLimit(deps, "surveySubmit", { ip: "10.0.1.1", token: "tok" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.by).toBe("token");
    // otro token, otra cuenta
    expect((await checkRateLimit(deps, "surveySubmit", { ip: "10.0.1.1", token: "otro" })).ok).toBe(true);
  });

  it("los ámbitos no comparten contador", async () => {
    const store = JsonPortalStore.memory();
    const deps = { store, env, now, config: cfg };
    for (let i = 0; i <= cfg.rateLimits.cron.perIp; i++) await checkRateLimit(deps, "cron", { ip: "1.1.1.1" });
    expect((await checkRateLimit(deps, "login", { ip: "1.1.1.1", token: "t" })).ok).toBe(true);
  });

  it("si el store falla, deja pasar (no tumba el login) y lo registra", async () => {
    const broken = { hitRateLimit: async () => Promise.reject(new Error("relation rate_limit_hits does not exist")) } as unknown as JsonPortalStore;
    const logs: string[] = [];
    const r = await checkRateLimit({ store: broken, env, now, config: cfg, log: (m) => logs.push(m) }, "login", { ip: "1.1.1.1", token: "t" });
    expect(r.ok).toBe(true);
    expect(logs.join("\n")).toContain("rate_limit_hits");
  });

  it("en el store no queda la IP ni el token en claro", async () => {
    const store = JsonPortalStore.memory();
    const seen: string[] = [];
    const spy = new Proxy(store, {
      get(t, p, r) {
        if (p === "hitRateLimit") return (bucket: string, ws: Date) => (seen.push(bucket), t.hitRateLimit(bucket, ws));
        return Reflect.get(t, p, r);
      },
    });
    await checkRateLimit({ store: spy, env, now, config: cfg }, "login", { ip: "200.1.2.3", token: "secreto-del-enlace" });
    expect(seen).toHaveLength(2);
    for (const b of seen) {
      expect(b).not.toContain("200.1.2.3");
      expect(b).not.toContain("secreto-del-enlace");
    }
  });
});

describe("JsonPortalStore: rate_limit_hits", () => {
  it("cuenta por (bucket, ventana) y poda las viejas", async () => {
    const store = JsonPortalStore.memory();
    const w1 = new Date("2026-11-13T15:00:00Z");
    const w2 = new Date("2026-11-13T16:00:00Z");
    expect(await store.hitRateLimit("a", w1)).toBe(1);
    expect(await store.hitRateLimit("a", w1)).toBe(2);
    expect(await store.hitRateLimit("b", w1)).toBe(1);
    expect(await store.hitRateLimit("a", w2)).toBe(1);
    expect(await store.pruneRateLimitHits(w2)).toBe(2);
    expect(await store.hitRateLimit("a", w1)).toBe(1);
  });
});

describe("migración rate_limit_hits", () => {
  it("está en migrate.ts, es aditiva e idempotente y va al final de las tablas del portal", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "..", "cli", "migrate.ts"), "utf8");
    const stmts = [...src.matchAll(/`((?:create|alter)[\s\S]*?)`/g)].map((m) => m[1]);
    const mine = stmts.filter((s) => s.includes("rate_limit_hits"));
    expect(mine.length).toBeGreaterThanOrEqual(2);
    for (const s of mine) expect(s).toMatch(/^(create table if not exists|create index if not exists)/);
    expect(expectedSchema(mine).get("rate_limit_hits")).toEqual(["bucket", "window_start", "hits", "updated_at"]);
    expect(src.indexOf("create table if not exists rate_limit_hits")).toBeGreaterThan(src.indexOf("create table if not exists companies"));
  });
});
