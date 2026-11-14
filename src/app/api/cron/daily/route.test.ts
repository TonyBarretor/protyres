/**
 * Corrida E, punto 5: la ruta del cron (protegida con CRON_SECRET) tiene límite de intentos por IP, antes de mirar el
 * secreto (frena a quien intente adivinarlo); al pasarse: 429 en JSON con Retry-After. Una corrida en seco no llama al
 * modelo ni a Deepgram ni hace peticiones de red, y limpia las ventanas viejas del límite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onUsageEvent } from "@/lib/guard/usage";
import { loadPortalConfig } from "@/lib/portal/config";
import { JsonPortalStore, __setPortalStoreForTests } from "@/lib/portal/store";
import { GET } from "./route";

const SECRET = "cron-secret-de-prueba";
const URL_ = "https://x.example/api/cron/daily";
const max = loadPortalConfig().publicInputs.rateLimits.cron.perIp;
const call = (ip: string, auth?: string, q = "") => GET(new Request(`${URL_}${q}`, { headers: { "x-forwarded-for": ip, ...(auth ? { authorization: auth } : {}) } }));

let store: JsonPortalStore;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  store = JsonPortalStore.memory();
  __setPortalStoreForTests(store);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  __setPortalStoreForTests(null);
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = saved;
});

describe("/api/cron/daily: límite de intentos", () => {
  it("con secreto equivocado: 401 hasta perIp, luego 429 (también con el secreto bueno) en esa IP; otra IP sigue", async () => {
    for (let i = 0; i < max; i++) expect((await call("203.0.0.1", "Bearer malo")).status).toBe(401);
    const res = await call("203.0.0.1", "Bearer malo");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await res.json()).error).toContain("Demasiados intentos");
    expect((await call("203.0.0.1", `Bearer ${SECRET}`, "?dry=1")).status).toBe(429);
    expect((await call("203.0.0.2", "Bearer malo")).status).toBe(401);
  });

  it("corrida en seco: 200, sin modelo, sin Deepgram, sin red; poda ventanas de hace más de 2 días", async () => {
    const old = new Date(Date.now() - 3 * 24 * 3600_000);
    await store.hitRateLimit("cron:ip:viejo", old);
    const events: unknown[] = [];
    const off = onUsageEvent((e) => events.push(e));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const res = await call("203.0.1.1", `Bearer ${SECRET}`, "?dry=1");
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    } finally {
      off();
    }
    expect(events).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await store.hitRateLimit("cron:ip:viejo", old)).toBe(1); // se había borrado
  });
});
