/**
 * Corrida E, punto 5: /encuesta/<token> — límite de vistas y envíos por IP y por token (en el proxy, con 429 de verdad),
 * token absurdo rechazado sin tocar la base, cuerpo máximo del envío y tamaño de los campos del formulario.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { loadPortalConfig } from "../config";
import { JsonPortalStore, __setPortalStoreForTests } from "../store";
import type { PortalStore } from "../store/types";
import { MAX_MEJORAR, parseSurveyForm, surveyFormTooLarge } from "./questions";
import { surveyGate } from "./gate";
import { newSurveyToken } from "./tokens";
import { proxy } from "@/proxy";

const env = { PORTAL_SESSION_SECRET: "test-secret-0123456789abcdef" };
const cfg = loadPortalConfig().publicInputs;
const BASE = "https://portal.example.pe/encuesta";

let store: JsonPortalStore;
beforeEach(() => {
  store = JsonPortalStore.memory();
});

const deps = (s: PortalStore = store) => ({ store: s, env, config: cfg, log: () => undefined });
const view = (token: string, ip = "190.1.1.1") => new Request(`${BASE}/${token}`, { headers: { "x-forwarded-for": ip } });
const submit = (token: string, ip = "190.1.1.1", body = "nps=9", extra: Record<string, string> = {}) =>
  new Request(`${BASE}/${token}`, { method: "POST", body, headers: { "x-forwarded-for": ip, "content-type": "application/x-www-form-urlencoded", ...extra } });

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

describe("surveyGate", () => {
  it("vistas: pasa hasta perToken y luego 429 con página en español; otro enlace sigue", async () => {
    const { token } = newSurveyToken();
    const max = cfg.rateLimits.surveyView.perToken!;
    for (let i = 0; i < max; i++) expect(await surveyGate(view(token, `190.0.0.${i}`), deps())).toBeNull();
    const res = await surveyGate(view(token, "190.0.1.1"), deps());
    expect(res?.status).toBe(429);
    expect(res?.headers.get("retry-after")).toBeTruthy();
    expect(await res!.text()).toContain("Demasiados intentos");
    expect(await surveyGate(view(newSurveyToken().token, "190.0.1.1"), deps())).toBeNull();
  });

  it("envíos: perToken por enlace (cuenta aparte de las vistas)", async () => {
    const { token } = newSurveyToken();
    const max = cfg.rateLimits.surveySubmit.perToken!;
    for (let i = 0; i < max; i++) expect(await surveyGate(submit(token, `191.0.0.${i}`), deps())).toBeNull();
    expect((await surveyGate(submit(token, "191.0.1.1"), deps()))?.status).toBe(429);
    expect(await surveyGate(view(token, "191.0.1.1"), deps())).toBeNull();
  });

  it("por IP: muchos enlaces distintos desde la misma IP se bloquean al pasar perIp", async () => {
    const max = cfg.rateLimits.surveyView.perIp;
    for (let i = 0; i < max; i++) expect(await surveyGate(view(newSurveyToken().token, "192.0.0.1"), deps())).toBeNull();
    expect((await surveyGate(view(newSurveyToken().token, "192.0.0.1"), deps()))?.status).toBe(429);
    expect(await surveyGate(view(newSurveyToken().token, "192.0.0.2"), deps())).toBeNull();
  });

  it("token absurdo o con otra forma: 404 sin tocar la base", async () => {
    const { store: s, calls } = countingStore(store);
    expect((await surveyGate(view("x".repeat(5000)), deps(s)))?.status).toBe(404);
    expect((await surveyGate(view("corto"), deps(s)))?.status).toBe(404);
    expect((await surveyGate(view("invalido"), deps(s)))?.status).toBe(404);
    expect((await surveyGate(view(`${"a".repeat(42)}%3C`), deps(s)))?.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("envío con cuerpo declarado mayor que maxSurveyBodyBytes: 413 sin tocar la base", async () => {
    const { store: s, calls } = countingStore(store);
    const { token } = newSurveyToken();
    const body = "mejorar=" + "a".repeat(cfg.maxSurveyBodyBytes + 1);
    // el navegador siempre manda Content-Length en un formulario; sin él (chunked) manda el tope de Next + surveyFormTooLarge
    const res = await surveyGate(submit(token, "193.0.0.1", body, { "content-length": String(body.length) }), deps(s));
    expect(res?.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("/encuesta sola u otra ruta: no la toca", async () => {
    expect(await surveyGate(new Request(`${BASE}`), deps())).toBeNull();
    expect(await surveyGate(new Request("https://portal.example.pe/portal"), deps())).toBeNull();
  });
});

describe("proxy: /encuesta pasa por la puerta", () => {
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

  it("429 al pasar el máximo de vistas del enlace; antes deja seguir", async () => {
    const { token } = newSurveyToken();
    const max = cfg.rateLimits.surveyView.perToken!;
    for (let i = 0; i < max; i++) {
      const res = await proxy(new NextRequest(`${BASE}/${token}`, { headers: { "x-forwarded-for": `194.0.0.${i}` } }));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
    expect((await proxy(new NextRequest(`${BASE}/${token}`, { headers: { "x-forwarded-for": "194.0.1.1" } }))).status).toBe(429);
  });

  it("/portal sin cookie sigue yendo al login", async () => {
    const res = await proxy(new NextRequest("https://portal.example.pe/portal/empresas"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/portal/login");
  });
});

describe("formulario de la encuesta: tamaños", () => {
  const valid = (extra: [string, string][] = []) => {
    const f = new FormData();
    f.set("token", "a".repeat(43));
    f.set("nps", "9");
    f.append("valora", "precio");
    f.set("satisfaccion", "5");
    f.set("referencia", "si");
    for (const [k, v] of extra) f.append(k, v);
    return f;
  };

  it("una respuesta normal (con 'mejorar' de 1.000) no es demasiado grande", () => {
    expect(surveyFormTooLarge(valid([["mejorar", "a".repeat(MAX_MEJORAR)]]))).toBe(false);
  });

  it("demasiados campos, un campo enorme o un archivo: demasiado grande", () => {
    expect(surveyFormTooLarge(valid([["mejorar", "a".repeat(MAX_MEJORAR * 20)]]))).toBe(true);
    expect(surveyFormTooLarge(valid(Array.from({ length: 200 }, (_, i) => ["valora", `x${i}`] as [string, string])))).toBe(true);
    const f = valid();
    f.set("adjunto", new File(["hola"], "a.txt"));
    expect(surveyFormTooLarge(f)).toBe(true);
  });

  it("parseSurveyForm: 'qué valora' con decenas de casillas es error, no se guarda", () => {
    const f = valid(Array.from({ length: 50 }, () => ["valora", "precio"] as [string, string]));
    const r = parseSurveyForm(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("valora_max");
  });
});
