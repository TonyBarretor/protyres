import { beforeEach, describe, expect, it } from "vitest";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import type { InboundMessage } from "../../whatsapp/webhook";
import { createSession, getSessionUser, loginWithToken, peekLoginLink } from "../auth/tokens";
import { JsonPortalStore } from "../store";
import { handlePortalCommand, NOT_REGISTERED, PORTAL_ROUTE_TIMEOUT_MS, routePortal } from ".";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
  // vendedores del cotizador (config/pilot.json): FRANK también es usuario del portal; STRANGER solo del cotizador. Corrida E:
  // un número que no está aquí ni en el portal no pasa la puerta del bot.
  salespeople: { "51900000001": { name: "Frank Rodríguez" }, "51900000099": { name: "Vendedor solo del cotizador" } },
});

const FRANK = "51900000001";
const STRANGER = "51900000099";
const SECRET = "test-secret-0123456789abcdef";
let id = 0;
const text = (from: string, body: string): InboundMessage => ({ id: `wamid.p${++id}`, from, timestamp: "1", type: "text", text: body, forwarded: false });

let client: FakeWhatsAppClient;
let portal: JsonPortalStore;
let bot: BotHandler;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["PORTAL_SESSION_SECRET", "PORTAL_BASE_URL"]) saved[k] = process.env[k];
  process.env.PORTAL_SESSION_SECRET = SECRET;
  process.env.PORTAL_BASE_URL = "https://portal.example.pe";
  client = new FakeWhatsAppClient();
  portal = JsonPortalStore.memory();
  await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  bot = new BotHandler({ client, store: JsonStore.memory(), settings, portalStore: portal });
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
});

describe("bot command 'portal'", () => {
  // hotfix login 2 (cambio pedido): el enlace ya no es de un solo uso; sirve 24 h y `portal` reenvía el vigente
  const linkOf = (reply: string) => reply.match(/https:\/\/portal\.example\.pe\/portal\/login\?t=\S+/)?.[0] ?? "";
  const tokenOf = (reply: string) => new URL(linkOf(reply)).searchParams.get("t")!;

  it("replies with a reusable link to a registered user (any case / accents)", async () => {
    await bot.handle(text(FRANK, "Pórtal"));
    const reply = client.texts().at(-1) ?? "";
    expect(reply).toContain("Hola Frank");
    expect(reply).toContain("Sirve por 24 horas. Después de entrar, tu teléfono queda con la sesión abierta por 30 días.");
    expect(linkOf(reply)).toBeTruthy();
    const token = tokenOf(reply);
    // entra, y vuelve a entrar con el mismo enlace (otro navegador, el teléfono después de cerrar el navegador)
    expect((await loginWithToken(portal, token))?.userId).toBeGreaterThan(0);
    expect((await loginWithToken(portal, token))?.userId).toBeGreaterThan(0);
  });

  it("'portal' three times in a row: the same link each time, and the three messages work", async () => {
    for (let i = 0; i < 3; i++) await bot.handle(text(FRANK, "portal"));
    const replies = client.texts().slice(-3);
    const links = replies.map(linkOf);
    expect(links[0]).toBeTruthy();
    expect(new Set(links).size).toBe(1);
    for (const r of replies) expect((await loginWithToken(portal, tokenOf(r)))?.userId).toBeGreaterThan(0);
  });

  it("'cerrar portal' closes every session and voids the links; 'portal' then gives a new link", async () => {
    await bot.handle(text(FRANK, "portal"));
    const token = tokenOf(client.texts().at(-1) ?? "");
    const frank = (await portal.getUserByWhatsapp(FRANK))!;
    const a = await loginWithToken(portal, token);
    const b = await createSession(portal, frank.id);
    await bot.handle(text(FRANK, "Cerrar portal"));
    expect(client.texts().at(-1)).toContain("cerré tu portal en todos los teléfonos (2 sesiones abiertas)");
    expect(await getSessionUser(portal, a!.session.cookieValue)).toBeNull();
    expect(await getSessionUser(portal, b.cookieValue)).toBeNull();
    expect(await peekLoginLink(portal, token)).toBeNull();
    expect(await loginWithToken(portal, token)).toBeNull();
    await bot.handle(text(FRANK, "portal"));
    const fresh = tokenOf(client.texts().at(-1) ?? "");
    expect(fresh).not.toBe(token);
    expect((await loginWithToken(portal, fresh))?.userId).toBe(frank.id);
  });

  it("'cerrar portal' from a number that is not in the portal goes to the quoter (not handled)", async () => {
    const replies: string[] = [];
    expect(await handlePortalCommand({ from: STRANGER, text: "cerrar portal", reply: async (b) => void replies.push(b), store: portal })).toBe(false);
    expect(replies).toEqual([]);
  });

  it("rejects a number that is not registered", async () => {
    await bot.handle(text(STRANGER, "portal"));
    expect(client.texts().at(-1)).toBe(NOT_REGISTERED);
  });

  it("without secret: clear message, no link", async () => {
    delete process.env.PORTAL_SESSION_SECRET;
    await bot.handle(text(FRANK, "PORTAL"));
    const reply = client.texts().at(-1) ?? "";
    // corrida F, punto 3: el nombre de la variable va al log del bot, no al chat
    expect(reply).toBe("El portal aún no está configurado: contacta al administrador.");
    expect(reply).not.toContain("PORTAL_SESSION_SECRET");
    expect(reply).not.toContain("http");
  });

  it("other text is not handled (the quoting flow keeps it)", async () => {
    const replies: string[] = [];
    const reply = async (b: string) => void replies.push(b);
    expect(await handlePortalCommand({ from: FRANK, text: "portal de clientes", reply, store: portal })).toBe(false);
    expect(await handlePortalCommand({ from: FRANK, text: "ayuda", reply, store: portal })).toBe(false);
    expect(replies).toEqual([]);
  });
});

describe("store lento: el cotizador no espera al portal", () => {
  /** El mismo store, con cada lectura retrasada `ms`. */
  function slow(store: JsonPortalStore, ms: number): JsonPortalStore {
    return new Proxy(store, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return async (...args: unknown[]) => {
          await new Promise((r) => setTimeout(r, ms));
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }

  it("el tiempo límite por defecto es 4 s", () => {
    expect(PORTAL_ROUTE_TIMEOUT_MS).toBe(4000);
  });

  it("texto que no es comando: si el store tarda más que el límite, se registra y sigue el cotizador", async () => {
    const logs: string[] = [];
    const replies: string[] = [];
    const t0 = Date.now();
    const handled = await routePortal({ from: FRANK, text: "Visité ZBUSS, me atendió el jefe de flota", reply: async (b) => void replies.push(b), store: slow(portal, 300), timeoutMs: 40, log: (m) => logs.push(m) });
    expect(handled).toBe(false);
    expect(Date.now() - t0).toBeLessThan(250);
    expect(replies).toEqual([]);
    expect(logs.join("\n")).toMatch(/sigue el cotizador: el portal no respondió en 40 ms/);
  });

  it("mensaje que va directo al cotizador (adjunto, flujo a medias): los avisos pendientes también tienen límite", async () => {
    await portal.setPortalConversation(FRANK, { notices: [{ text: "Resumen del día", createdAt: new Date().toISOString() }] });
    const logs: string[] = [];
    const t0 = Date.now();
    const handled = await routePortal({ from: FRANK, text: "ok", quoteStep: "review_quote", reply: async () => undefined, store: slow(portal, 300), timeoutMs: 40, log: (m) => logs.push(m) });
    expect(handled).toBe(false);
    expect(Date.now() - t0).toBeLessThan(250);
    expect(logs.join("\n")).toContain("no pude revisar los avisos pendientes");
  });

  it("un comando explícito espera al store (no hay a quién más pasárselo)", async () => {
    const replies: string[] = [];
    const handled = await routePortal({ from: FRANK, text: "hoy", reply: async (b) => void replies.push(b), store: slow(portal, 60), timeoutMs: 20 });
    expect(handled).toBe(true);
    expect(replies.length).toBeGreaterThan(0);
  });

  it("por el handler: con el store del portal lento, un pedido se cotiza igual", async () => {
    const quick = new BotHandler({ client, store: JsonStore.memory(), settings, portalStore: slow(portal, 5000) });
    const t0 = Date.now();
    await quick.handle(text(FRANK, "hola"));
    expect(Date.now() - t0).toBeLessThan(4800); // el límite por defecto (4 s), no los 5 s del store
    expect(client.texts().at(-1)).toContain("cotiz");
  }, 10_000);
});
