/**
 * Botones y listas en el bot del portal (corrida D, punto 2), por el BotHandler con el WhatsApp de pruebas:
 *  - `empresa` con un resultado -> botón *Asignarme*; con varios -> lista (≤ 10) y con más, texto como antes.
 *  - confirmación del reporte -> *Sí, guardar* / *Corregir*.
 *  - preguntas del pedido (`oc`) con defecto o sí/no -> botones (en oc.test.ts y aquí la de la cotización).
 *  - pulsar un botón (webhook real con id `pt:…`) da lo mismo que escribir su equivalente; si el envío interactivo
 *    falla, el mismo texto va como mensaje normal; un botón viejo nunca llega al cotizador.
 *  - `asignarme` por nombre y por voz ("asígname ZBUSS").
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import { parseWebhook, type InboundMessage } from "../../whatsapp/webhook";
import { JsonPortalStore } from "../store";
import type { PortalUser } from "../store/types";
import { questionButtons, type QuestionContext } from "../order/questions";
import { nextOrderQuestion } from "../order/questions";
import { STALE_BUTTON } from ".";
import { configureReportBot, REPORT_CORRECT_PROMPT } from "./report";
import { getPending } from "./state";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
});

const FRANK = "51900000001";
const OTRO = "51900000003";
/** Empresas inventadas. */
const RUC_ZB = "20999000077";
const RUC_ANDES = "20999000011";
const RUC_ANDES_SUR = "20999000022";

let seq = 0;
let client: FakeWhatsAppClient;
let portal: JsonPortalStore;
let prices: JsonStore;
let bot: BotHandler;
let frank: PortalUser;
let ids: Record<string, number>;
const saved: Record<string, string | undefined> = {};

const textMsg = (body: string, from = FRANK): InboundMessage => ({ id: `wamid.i${++seq}`, from, timestamp: "1", type: "text", text: body, forwarded: false });

/** Pulsa el botón / fila `title` del último interactivo: el mensaje entra como lo manda WhatsApp (webhook real). */
function press(title: string): InboundMessage {
  const last = client.interactives().at(-1);
  if (!last) throw new Error("no hubo interactivo");
  const hit = last.type === "button" ? last.buttons.find((b) => b.title === title) : last.sections.flatMap((s) => s.rows).find((r) => r.title === title || r.id === `pt:${title}`);
  if (!hit) throw new Error(`no hay botón ${title}`);
  const interactive = last.type === "button" ? { type: "button_reply", button_reply: { id: hit.id, title: hit.title } } : { type: "list_reply", list_reply: { id: hit.id, title: hit.title } };
  const payload = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { messages: [{ id: `wamid.i${++seq}`, from: FRANK, timestamp: "1", type: "interactive", interactive }] } }] }] };
  return parseWebhook(payload).messages[0];
}

const say = async (m: InboundMessage | string) => {
  const before = client.sent.length;
  await bot.handle(typeof m === "string" ? textMsg(m) : m);
  return client.sent.slice(before);
};
const bodyOf = (out: Awaited<ReturnType<typeof say>>) =>
  out
    .filter((m) => m.kind === "text" || m.kind === "interactive")
    .map((m) => m.body ?? "")
    .join("\n---\n");

beforeEach(async () => {
  for (const k of ["LLM_DISABLED", "PHOTOS_DISABLED", "PORTAL_SESSION_SECRET", "PORTAL_BASE_URL", "DEEPGRAM_API_KEY"]) saved[k] = process.env[k];
  process.env.LLM_DISABLED = "1";
  process.env.PHOTOS_DISABLED = "1";
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  process.env.PORTAL_BASE_URL = "https://portal.example.pe";
  delete process.env.DEEPGRAM_API_KEY;
  client = new FakeWhatsAppClient();
  portal = JsonPortalStore.memory();
  prices = JsonStore.memory();
  frank = await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  await portal.upsertUser({ nombre: "Otro Vendedor", whatsapp: OTRO, rol: "vendedor" });
  const r = await portal.upsertCompanies([
    { ruc: RUC_ZB, razonSocial: "ZETABUS S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 85, llantasPiso: 510 },
    { ruc: RUC_ANDES, razonSocial: "TRANSPORTES ANDES DEL PERU S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 12, llantasPiso: 72 },
    { ruc: RUC_ANDES_SUR, razonSocial: "EMPRESA ANDES SUR E.I.R.L.", sector: "carga", departamento: "AREQUIPA", unidades: 30, llantasPiso: 300 },
    // 11 empresas "ROCA ..." para pasar el límite de 10 filas de una lista
    ...Array.from({ length: 11 }, (_, i) => ({ ruc: `2099910${String(i).padStart(4, "0")}`, razonSocial: `ROCA ${String.fromCharCode(65 + i)} S.A.C.`, sector: "carga" as const, departamento: "LIMA", unidades: 5 + i, llantasPiso: 50 })),
  ]);
  ids = r.ids;
  configureReportBot({ llm: null, logMessage: (e) => prices.logMessage(e) });
  bot = new BotHandler({ client, store: prices, settings, portalStore: portal });
});

afterEach(() => {
  configureReportBot(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("empresa: botón Asignarme y lista para elegir", () => {
  it("un resultado sin dueño -> ficha con botón *Asignarme* (id `pt:asignarme <RUC>`); pulsarlo = escribir el comando", async () => {
    const out = await say("empresa zetabus");
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("interactive");
    expect(out[0].body).toContain("🏢 *ZETABUS S.A.C.*");
    expect(out[0].body).toContain(`Para tomarla: *asignarme ${RUC_ZB}*`);
    expect(out[0].interactive).toMatchObject({ type: "button", buttons: [{ id: `pt:asignarme ${RUC_ZB}`, title: "Asignarme" }] });

    const pressed = press("Asignarme");
    expect(pressed.text).toBe(`asignarme ${RUC_ZB}`);
    const after = bodyOf(await say(pressed));
    expect(after).toContain("✔ Empresa asignada a ti.");
    expect((await portal.getCompany(ids[RUC_ZB]))?.ownerUserId).toBe(frank.id);
    // ya es suya: sin botón
    const mine = await say("empresa zetabus");
    expect(mine[0].kind).toBe("text");
  });

  it("de otro vendedor: sin botón (un vendedor no puede tomarla)", async () => {
    const otro = await portal.getUserByWhatsapp(OTRO);
    await portal.setOwner(ids[RUC_ZB], otro!.id);
    const out = await say("empresa zetabus");
    expect(out[0].kind).toBe("text");
    expect(out[0].body).toContain("Dueño: Otro Vendedor");
  });

  it("varias (≤ 10) -> lista con el número de cada opción como id; elegir una fila = escribir el número", async () => {
    const out = await say("empresa andes");
    expect(out[0].kind).toBe("interactive");
    expect(out[0].body).toContain("Encontré 2 empresas con «andes». ¿Cuál? Responde con el número:");
    expect(out[0].interactive).toMatchObject({ type: "list", button: "Elegir empresa" });
    const rowsShown = out[0].interactive!.type === "list" ? out[0].interactive!.sections[0].rows : [];
    expect(rowsShown.map((r) => r.id)).toEqual(["pt:1", "pt:2"]);
    expect(rowsShown.map((r) => r.title)).toEqual(["EMPRESA ANDES SUR", "TRANSPORTES ANDES DEL P…"]); // recortado a 24
    expect(rowsShown[0].description).toBe(`RUC ${RUC_ANDES_SUR} · 30 unid.`);
    const after = bodyOf(await say(press("2")));
    expect(after).toContain("🏢 *TRANSPORTES ANDES DEL PERU S.A.C.*");
  });

  it("asignarme por nombre con varias coincidencias -> lista; la fila elegida se asigna", async () => {
    await say("asignarme andes");
    const after = bodyOf(await say(press("EMPRESA ANDES SUR")));
    expect(after).toContain("✔ Empresa asignada a ti.");
    expect((await portal.getCompany(ids[RUC_ANDES_SUR]))?.ownerUserId).toBe(frank.id);
  });

  it("más de 10 -> texto como antes (5 opciones y cuántas más)", async () => {
    const out = await say("empresa roca");
    expect(out[0].kind).toBe("text");
    expect(out[0].body).toContain("Encontré 11 empresas con «roca»");
    expect(out[0].body).toContain("_…y 6 más: escribe más del nombre o el RUC._");
  });

  it("si WhatsApp rechaza el interactivo, el mismo texto va como mensaje normal (no se pierde)", async () => {
    client.failInteractive = new Error("WhatsApp API 400: interactive not allowed");
    const out = await say("empresa zetabus");
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("text");
    expect(out[0].body).toContain(`Para tomarla: *asignarme ${RUC_ZB}*`);
  });
});

describe("confirmación del reporte: Sí, guardar / Corregir", () => {
  it("el resumen trae los dos botones; *Corregir* pide el cambio y el borrador sigue; *Sí, guardar* guarda", async () => {
    await portal.setOwner(ids[RUC_ZB], frank.id);
    const out = await say("Visité Zetabus, hablé con Carlos Quispe, jefe de flota. Quieren probar Fenixway.");
    const summary = out.at(-1)!;
    expect(summary.kind).toBe("interactive");
    expect(summary.body).toMatch(/¿Está bien\? Responde \*sí\* o corrige$/);
    expect(summary.interactive).toMatchObject({ type: "button", buttons: [{ id: "pt:sí", title: "Sí, guardar" }, { id: "pt:corregir", title: "Corregir" }] });

    expect(bodyOf(await say(press("Corregir")))).toBe(REPORT_CORRECT_PROMPT);
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("report_draft");

    const fixed = await say("fue con el gerente general");
    expect(fixed.at(-1)?.interactive?.type).toBe("button");
    const saved = bodyOf(await say(press("Sí, guardar")));
    expect(saved).toContain("✔ Guardado: visita — *ZETABUS*");
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
  });

  it("escribir el título del botón (`sí, guardar`) también confirma", async () => {
    await portal.setOwner(ids[RUC_ZB], frank.id);
    await say("Visité Zetabus, hablé con Carlos Quispe, jefe de flota.");
    expect(bodyOf(await say("Sí, guardar"))).toContain("✔ Guardado: visita");
  });
});

describe("botones viejos", () => {
  it("un *Sí, guardar* sin nada pendiente no llega al cotizador (aunque esté revisando una cotización): avisa que venció", async () => {
    await portal.setOwner(ids[RUC_ZB], frank.id);
    await say("Visité Zetabus, hablé con Carlos Quispe, jefe de flota.");
    const old = press("Sí, guardar");
    await say("no"); // descarta el reporte
    await prices.setConversation(FRANK, { phone: FRANK, step: "review_quote", quoteNumber: "COT-0001", updatedAt: new Date().toISOString() });
    const out = await say(old);
    expect(bodyOf(out)).toBe(STALE_BUTTON);
    expect((await prices.getConversation(FRANK))?.step).toBe("review_quote");
  });
});

describe("preguntas del pedido: botones", () => {
  const qctx = (over: Partial<QuestionContext> = {}): QuestionContext => ({ profile: {}, terceros: false, plazo: null, sugerencias: {}, cliente: "ZETABUS", ...over });
  it("igual / sí-no / la misma / ninguna según la pregunta; cada id es una respuesta escrita válida", () => {
    const base = { cliente: {}, clienteListo: [] };
    expect(questionButtons(nextOrderQuestion(base, qctx({ sugerencias: { direccionFiscal: "Av. 1" } }))!)).toEqual([{ id: "igual", title: "Igual" }]);
    expect(questionButtons(nextOrderQuestion(base, qctx())!)).toEqual([]);
    const listo = { cliente: { direccionFiscal: "Av. 1" }, clienteListo: ["direccionFiscal" as const] };
    expect(questionButtons(nextOrderQuestion(listo, qctx())!)).toEqual([{ id: "la misma", title: "La misma" }]);
    const datos = { cliente: {}, clienteListo: ["direccionFiscal", "direccionEntrega", "contacto"] as ("direccionFiscal" | "direccionEntrega" | "contacto")[] };
    expect(questionButtons(nextOrderQuestion(datos, qctx())!)).toEqual([{ id: "ninguna", title: "Ninguna" }]);
    const enllante = { ...datos, clienteListo: [...datos.clienteListo, "agencia" as const], fechaEntrega: "2026-11-20" };
    expect(questionButtons(nextOrderQuestion(enllante, qctx())!).map((b) => b.title)).toEqual(["Sí", "No"]);
    expect(questionButtons(nextOrderQuestion(enllante, qctx({ profile: { last: { enllante: "SI" } } }))!).map((b) => b.title)).toEqual(["Sí", "No", "Igual"]);
    const plazo = { ...enllante, enllante: "SI" as const, marcado: "NO" as const, flete: "CLIENTE" };
    expect(questionButtons(nextOrderQuestion(plazo, qctx({ plazo: { dias: 30, fuente: "x" } }))!).map((b) => b.id)).toEqual(["igual", "contado"]);
  });
});

describe("asignarme por voz", () => {
  it("una nota de voz que dice «Asígname Zetabus.» corre el comando (no se toma como reporte)", async () => {
    process.env.DEEPGRAM_API_KEY = "dg-test-key";
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ metadata: { duration: 2 }, results: { channels: [{ alternatives: [{ transcript: "Asígname Zetabus.", confidence: 0.95 }] }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    configureReportBot({ llm: null, deepgramFetch: fetchImpl, downloadMedia: async () => ({ data: Buffer.from("OggS"), mimeType: "audio/ogg" }), logMessage: (e) => prices.logMessage(e) });
    const audio: InboundMessage = { id: `wamid.i${++seq}`, from: FRANK, timestamp: "1", type: "audio", forwarded: false, media: { id: "aud-1", mimeType: "audio/ogg" } };
    const out = bodyOf(await say(audio));
    expect(out).toContain("🎙️ Entendí: «Asígname Zetabus.»");
    expect(out).toContain("✔ Empresa asignada a ti.");
    expect(out).not.toContain("Reporte de");
    expect((await portal.getCompany(ids[RUC_ZB]))?.ownerUserId).toBe(frank.id);
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
  });
});
