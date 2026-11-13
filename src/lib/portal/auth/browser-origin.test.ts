/**
 * Regresión del 403 "Solicitud no permitida" en la primera prueba manual: la página de confirmación del enlace se servía con
 * `referrer-policy: no-referrer` y, con esa política, el navegador manda `Origin: null` en el POST del formulario (Fetch
 * standard, "serializing a request origin": para un POST que no es CORS, si la política es no-referrer el Origin es "null").
 * Aquí se arma el POST tal como lo manda un navegador según la política que la propia página declara.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { JsonPortalStore } from "../store";
import type { PortalUser } from "../store/types";
import { isSameOrigin, loginGet, loginPost } from "./login";
import { createLoginLink } from "./tokens";

const env = { PORTAL_SESSION_SECRET: "test-secret-0123456789abcdef", PORTAL_BASE_URL: "https://portal.example.pe" };

/**
 * Origin que manda un navegador en un POST de formulario al MISMO origen de la página (Fetch standard §3.1 "serializing a
 * request origin" + "append a request Origin header"): no-referrer -> "null"; el resto conserva el origen para el mismo
 * sitio (same-origin, strict-origin, origin, strict-origin-when-cross-origin, no-referrer-when-downgrade, unsafe-url...).
 */
function browserSameOriginPostOrigin(referrerPolicy: string, pageOrigin: string): string {
  const policy = referrerPolicy.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).pop() ?? "";
  return policy === "no-referrer" ? "null" : pageOrigin;
}

let store: JsonPortalStore;
let frank: PortalUser;

beforeEach(async () => {
  store = JsonPortalStore.memory();
  frank = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
});

describe("login desde un navegador real", () => {
  it("el formulario de la página de confirmación entra con la política que la página declara", async () => {
    const link = await createLoginLink(store, frank, { env });
    const page = await loginGet(new Request(link.url, { headers: { host: "portal.example.pe" } }), { env });
    expect(page.status).toBe(200);
    const policy = page.headers.get("referrer-policy") ?? "";
    expect(policy).toBe("same-origin");
    const origin = browserSameOriginPostOrigin(policy, "https://portal.example.pe");
    const body = new URLSearchParams({ t: link.token });
    const res = await loginPost(
      new Request("https://portal.example.pe/portal/login", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", origin, host: "portal.example.pe" } }),
      store,
      { env },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie") ?? "").toContain("=");
  });

  it("política a política: solo no-referrer produce Origin null, y Origin null sigue rechazado", () => {
    const req = (origin: string) => new Request("https://portal.example.pe/portal/login", { method: "POST", headers: { origin, host: "portal.example.pe" } });
    for (const p of ["same-origin", "strict-origin", "strict-origin-when-cross-origin", "origin", "no-referrer-when-downgrade"]) {
      expect(isSameOrigin(req(browserSameOriginPostOrigin(p, "https://portal.example.pe"))), p).toBe(true);
    }
    expect(isSameOrigin(req(browserSameOriginPostOrigin("no-referrer", "https://portal.example.pe")))).toBe(false);
  });

  it("todas las páginas de /portal/login usan same-origin (el token no sale a otros sitios)", async () => {
    for (const res of [await loginGet(new Request("https://portal.example.pe/portal/login"), { env }), await loginGet(new Request("https://portal.example.pe/portal/login?t=x.y"), { env })]) {
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
    }
  });
});

describe("encuesta pública (/encuesta/[token], server action)", () => {
  it("no declara no-referrer: el navegador mandaría Origin null y Next aborta la server action", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../../app/encuesta/layout.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/referrer:\s*"no-referrer"/);
    expect(src).toMatch(/referrer:\s*TOKEN_PAGE_REFERRER_POLICY/);
    const { TOKEN_PAGE_REFERRER_POLICY } = await import("./constants");
    expect(browserSameOriginPostOrigin(TOKEN_PAGE_REFERRER_POLICY, "https://portal.example.pe")).toBe("https://portal.example.pe");
  });
});
