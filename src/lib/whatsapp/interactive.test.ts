/**
 * Mensajes interactivos (corrida D, punto 2): límites de Meta, caída a texto, payload de la Graph API, webhook
 * (button_reply / list_reply con el id `pt:…`) y registro en `messages`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonStore } from "../store/json-store";
import { FakeWhatsAppClient, GraphWhatsAppClient } from "./client";
import {
  BUTTON_BODY_MAX,
  BUTTON_TITLE_MAX,
  deliverInteractive,
  graphInteractive,
  interactiveAsText,
  LIST_ROW_DESCRIPTION_MAX,
  LIST_ROW_TITLE_MAX,
  portalButtons,
  prepareInteractive,
  type InteractiveMessage,
} from "./interactive";
import { LoggingWhatsAppClient } from "./logging-client";
import { parseWebhook } from "./webhook";

const buttons = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `pt:op${i + 1}`, title: `Opción ${i + 1}` }));
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `pt:${i + 1}`, title: `Empresa ${i + 1}`, description: `RUC 2099900${String(i).padStart(4, "0")}` }));

describe("prepareInteractive: límites de Meta", () => {
  it("botones: hasta 3, títulos recortados a 20, ids hasta 256, body hasta 1024, títulos únicos", () => {
    expect(prepareInteractive({ type: "button", body: "¿Guardo?", buttons: buttons(3) })).not.toBeNull();
    expect(prepareInteractive({ type: "button", body: "¿Guardo?", buttons: buttons(4) })).toBeNull();
    expect(prepareInteractive({ type: "button", body: "¿Guardo?", buttons: [] })).toBeNull();
    const long = prepareInteractive({ type: "button", body: "x", buttons: [{ id: "pt:a", title: "Un título demasiado largo para WhatsApp" }] });
    expect(long?.type === "button" && long.buttons[0].title).toBe("Un título demasiado…");
    expect(long?.type === "button" && long.buttons[0].title.length).toBe(BUTTON_TITLE_MAX);
    expect(prepareInteractive({ type: "button", body: "x", buttons: [{ id: `pt:${"a".repeat(253)}`, title: "ok" }] })).not.toBeNull();
    expect(prepareInteractive({ type: "button", body: "x", buttons: [{ id: `pt:${"a".repeat(254)}`, title: "ok" }] })).toBeNull();
    expect(prepareInteractive({ type: "button", body: "y".repeat(BUTTON_BODY_MAX), buttons: buttons(1) })).not.toBeNull();
    expect(prepareInteractive({ type: "button", body: "y".repeat(BUTTON_BODY_MAX + 1), buttons: buttons(1) })).toBeNull();
    expect(prepareInteractive({ type: "button", body: "x", buttons: [{ id: "pt:a", title: "Sí" }, { id: "pt:b", title: "si" }] })).toBeNull();
    const footer = prepareInteractive({ type: "button", body: "x", footer: "f".repeat(80), buttons: buttons(1) });
    expect(footer?.footer?.length).toBeLessThanOrEqual(60);
  });

  it("listas: hasta 10 filas en total, título de fila 24, descripción 72, id 200, body 4096, botón 20", () => {
    const list = (r: { id: string; title: string; description?: string }[], body = "¿Cuál?"): InteractiveMessage => ({ type: "list", body, button: "Elegir empresa", sections: [{ rows: r }] });
    expect(prepareInteractive(list(rows(10)))).not.toBeNull();
    expect(prepareInteractive(list(rows(11)))).toBeNull();
    expect(prepareInteractive({ type: "list", body: "x", button: "b", sections: [{ title: "A", rows: rows(6) }, { title: "B", rows: rows(5).map((r) => ({ ...r, id: `${r.id}b` })) }] })).toBeNull();
    const clipped = prepareInteractive(list([{ id: "pt:1", title: "TRANSPORTES Y SERVICIOS GENERALES DEL SUR", description: "d".repeat(100) }]));
    const row = clipped?.type === "list" ? clipped.sections[0].rows[0] : null;
    expect(row?.title.length).toBeLessThanOrEqual(LIST_ROW_TITLE_MAX);
    expect(row?.description?.length).toBeLessThanOrEqual(LIST_ROW_DESCRIPTION_MAX);
    expect(prepareInteractive(list([{ id: `pt:${"9".repeat(197)}`, title: "a" }]))).not.toBeNull();
    expect(prepareInteractive(list([{ id: `pt:${"9".repeat(198)}`, title: "a" }]))).toBeNull();
    expect(prepareInteractive(list(rows(2), "z".repeat(4096)))).not.toBeNull();
    expect(prepareInteractive(list(rows(2), "z".repeat(4097)))).toBeNull();
    const btn = prepareInteractive({ type: "list", body: "x", button: "Elegir una empresa del padrón", sections: [{ rows: rows(2) }] });
    expect(btn?.type === "list" && btn.button.length).toBeLessThanOrEqual(20);
  });
});

describe("caída a texto", () => {
  it("botones -> body + 'Responde *sí* o *corregir*.' con los textos equivalentes; lista -> numerada", () => {
    expect(interactiveAsText({ type: "button", body: "¿Guardo el reporte?", buttons: portalButtons([{ id: "sí", title: "Sí, guardar" }, { id: "corregir", title: "Corregir" }]) })).toBe("¿Guardo el reporte?\n\nResponde *sí* o *corregir*.");
    expect(interactiveAsText({ type: "list", body: "¿Cuál?", button: "Elegir", sections: [{ rows: rows(2) }] })).toBe("¿Cuál?\n*1.* Empresa 1 · RUC 20999000000\n*2.* Empresa 2 · RUC 20999000001\nResponde con el número.");
  });

  it("deliverInteractive: interactivo si se puede; texto sin canal, fuera de límites o si WhatsApp lo rechaza", async () => {
    const msg: InteractiveMessage = { type: "button", body: "¿Enlazo?", buttons: portalButtons([{ id: "enlazar", title: "Enlazar" }]) };
    const sent: string[] = [];
    const texts: string[] = [];
    const logs: string[] = [];
    const ch = { send: async (m: InteractiveMessage) => void sent.push(m.body), sendText: async (b: string) => void texts.push(b), log: (l: string) => void logs.push(l) };
    expect(await deliverInteractive(msg, ch)).toBe("interactive");
    expect(await deliverInteractive(msg, { sendText: ch.sendText })).toBe("text");
    expect(await deliverInteractive({ ...msg, buttons: buttons(4) }, ch, "texto propio")).toBe("text");
    expect(await deliverInteractive(msg, { ...ch, send: async () => Promise.reject(new Error("WhatsApp API 400: (#131009) Parameter value is not valid")) })).toBe("text");
    expect(sent).toEqual(["¿Enlazo?"]);
    expect(texts).toEqual(["¿Enlazo?\n\nResponde *enlazar*.", "texto propio", "¿Enlazo?\n\nResponde *enlazar*."]);
    expect(logs.join("\n")).toContain("131009");
  });
});

describe("Graph API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sendInteractive manda el payload de botones de la documentación de Meta", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), { status: 200 });
    });
    const g = new GraphWhatsAppClient({ token: "t", phoneNumberId: "123", version: "v22.0" });
    await g.sendInteractive("51900000001", { type: "button", body: "¿Guardo?", buttons: portalButtons([{ id: "sí", title: "Sí, guardar" }, { id: "corregir", title: "Corregir" }]) });
    expect(calls[0].url).toBe("https://graph.facebook.com/v22.0/123/messages");
    expect(calls[0].body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "51900000001",
      type: "interactive",
      interactive: { type: "button", body: { text: "¿Guardo?" }, action: { buttons: [{ type: "reply", reply: { id: "pt:sí", title: "Sí, guardar" } }, { type: "reply", reply: { id: "pt:corregir", title: "Corregir" } }] } },
    });
  });

  it("payload de lista", () => {
    expect(graphInteractive({ type: "list", body: "¿Cuál?", button: "Elegir empresa", sections: [{ rows: [{ id: "pt:1", title: "ZBUSS", description: "RUC 20602221505" }] }] })).toEqual({
      type: "list",
      body: { text: "¿Cuál?" },
      action: { button: "Elegir empresa", sections: [{ rows: [{ id: "pt:1", title: "ZBUSS", description: "RUC 20602221505" }] }] },
    });
  });

  it("si WhatsApp rechaza el interactivo, sendInteractive lanza (quien llama cae a texto)", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "Invalid parameter" } }), { status: 400 }));
    const g = new GraphWhatsAppClient({ token: "t", phoneNumberId: "123" });
    await expect(g.sendInteractive("519", { type: "button", body: "x", buttons: buttons(1) })).rejects.toThrow("Invalid parameter");
  });
});

describe("webhook: respuesta a un botón o a una lista", () => {
  const payload = (interactive: unknown) => ({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [{ id: "wamid.b1", from: "51900000001", timestamp: "1", type: "interactive", interactive }] } }] }],
  });

  it("id del portal (`pt:`): el texto es el id sin prefijo (lo mismo que escribirlo); guarda id, tipo y título", () => {
    const [m] = parseWebhook(payload({ type: "button_reply", button_reply: { id: "pt:asignarme 20602221505", title: "Asignarme" } })).messages;
    expect(m).toMatchObject({ type: "interactive", text: "asignarme 20602221505", interactiveId: "pt:asignarme 20602221505", interactiveType: "button_reply", interactiveTitle: "Asignarme" });
    const [l] = parseWebhook(payload({ type: "list_reply", list_reply: { id: "pt:2", title: "ZBUSS", description: "RUC 20602221505" } })).messages;
    expect(l).toMatchObject({ text: "2", interactiveId: "pt:2", interactiveType: "list_reply" });
  });

  it("id ajeno al portal: el texto es el título (como antes)", () => {
    const [m] = parseWebhook(payload({ type: "button_reply", button_reply: { id: "otro-boton", title: "Ver precios" } })).messages;
    expect(m).toMatchObject({ text: "Ver precios", interactiveId: "otro-boton" });
  });
});

describe("registro y cliente de pruebas", () => {
  it("LoggingWhatsAppClient registra el interactivo en messages (kind interactive, body + opciones); el Fake lo guarda", async () => {
    const store = JsonStore.memory();
    const fake = new FakeWhatsAppClient();
    const logging = new LoggingWhatsAppClient(fake, store);
    await logging.sendInteractive("51900000001", { type: "button", body: "¿Guardo?", buttons: portalButtons([{ id: "sí", title: "Sí, guardar" }, { id: "corregir", title: "Corregir" }]) });
    expect(fake.sent[0]).toMatchObject({ kind: "interactive", body: "¿Guardo?" });
    expect(fake.interactives()).toHaveLength(1);
    expect(fake.texts()).toEqual(["¿Guardo?"]);
    const [logged] = await store.listMessages("51900000001");
    expect(logged).toMatchObject({ direction: "out", kind: "interactive", body: "¿Guardo?\n[Sí, guardar] [Corregir]" });
  });
});
