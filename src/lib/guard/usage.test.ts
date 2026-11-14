/**
 * Corrida E, punto 2: topes de gasto. Medidor único (guard/usage.ts): costo, topes por usuario y globales, registro del
 * uso real, aviso de una línea al usuario y una vez por día al administrador, recorte del texto y max_tokens por propósito,
 * QUOTE_LLM_MODE=off y la voz (VOICE_DISABLED, duración antes de Deepgram, tope de minutos).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractPricesWithLLM } from "../llm/extract-prices";
import { __setAnthropicForTests } from "../llm/client";
import { parseRequestWithLLM } from "../llm/parse-request";
import { configureReportBot } from "../portal/bot";
import { loadPortalConfig, type PortalLimitsConfig } from "../portal/config";
import { VOICE_DISABLED_REPLY } from "../portal/bot/report";
import { JsonPortalStore } from "../portal/store";
import { parseRequest } from "../quote/request";
import { extractReport, type LlmClient } from "../portal/report/extract";
import { SettingsSchema, type Settings } from "../settings";
import { JsonStore } from "../store/json-store";
import type { UsageSummaryRow } from "../store/types";
import { FakeWhatsAppClient } from "../whatsapp/client";
import { BotHandler } from "../whatsapp/handler";
import type { InboundMessage } from "../whatsapp/webhook";
import { __setLimitsForTests, CLIP_NOTICE, findCap, LLM_CAP_NOTICE, llmCost, audioCost, meteredModelCall, runWithUsage, UsageCapExceeded, VOICE_CAP_REPLY, type UsageContext } from "./usage";

const FRANK = "51900000001";
const JAIME = "51900000002";
const ADMIN = "18600000009";

const base = loadPortalConfig().limits;
const limits = (over: Partial<PortalLimitsConfig> = {}): PortalLimitsConfig => ({ ...base, ...over });
const row = (phone: string, o: Partial<UsageSummaryRow> = {}): UsageSummaryRow => ({ phone, purpose: "reporte", llmCalls: 0, inputTokens: 0, outputTokens: 0, audioCalls: 0, audioSeconds: 0, costUsd: 0, ...o });

describe("costo y topes (puro)", () => {
  it("costo estimado: Haiku 4.5 a 1/5 USD por millón; modelo no listado, el precio 'default'; Deepgram por minuto", () => {
    expect(llmCost("claude-haiku-4-5-20251001", 1_000_000, 100_000, base)).toBeCloseTo(1.5, 6);
    expect(llmCost("otro-modelo", 1_000_000, 0, base)).toBeCloseTo(3, 6);
    expect(audioCost(120, base)).toBeCloseTo(0.0086, 6);
  });

  it("valores de config/portal.json para el piloto", () => {
    expect(base.perUserDaily).toEqual({ llmCalls: 150, llmTokens: 500000, audioMinutes: 45 });
    expect(base.globalDaily).toEqual({ llmCalls: 400, llmTokens: 1500000, audioMinutes: 120 });
    expect(base.maxVoiceSeconds).toBe(180);
    expect(base.maxUserChars).toBe(2000);
    expect(base.maxTokens).toMatchObject({ reporte: 1500, cotizador_pedido: 2048, lista_precios: 8192 });
  });

  it("por usuario, global y 'sistema' (solo globales)", () => {
    const cfg = limits({ perUserDaily: { llmCalls: 2, llmTokens: 1000, audioMinutes: 1 }, globalDaily: { llmCalls: 3, llmTokens: 5000, audioMinutes: 2 } });
    expect(findCap([row(FRANK, { llmCalls: 1 })], FRANK, { llmCall: true }, cfg)).toBeNull();
    expect(findCap([row(FRANK, { llmCalls: 2 })], FRANK, { llmCall: true }, cfg)).toMatchObject({ scope: "usuario", metric: "llmCalls" });
    expect(findCap([row(FRANK, { llmCalls: 1, inputTokens: 900, outputTokens: 100 })], FRANK, { llmCall: true }, cfg)).toMatchObject({ scope: "usuario", metric: "llmTokens" });
    expect(findCap([row(FRANK, { llmCalls: 1 }), row(JAIME, { llmCalls: 2 })], FRANK, { llmCall: true }, cfg)).toMatchObject({ scope: "global", metric: "llmCalls" });
    expect(findCap([row(FRANK, { llmCalls: 2 })], "sistema", { llmCall: true }, cfg)).toBeNull();
    expect(findCap([row(FRANK, { audioSeconds: 50 })], FRANK, { audioMinutes: 0.2 }, cfg)).toMatchObject({ scope: "usuario", metric: "audioMinutes" });
    expect(findCap([row(FRANK, { audioSeconds: 30 })], FRANK, { audioMinutes: 0.2 }, cfg)).toBeNull();
  });
});

describe("medidor: una llamada pasa por el contador", () => {
  afterEach(() => __setLimitsForTests(null));

  it("registra tokens reales y costo a nombre del usuario del contexto; al tope no llama y lo dice una vez", async () => {
    __setLimitsForTests(limits({ perUserDaily: { llmCalls: 1, llmTokens: 1_000_000, audioMinutes: 10 } }));
    const store = JsonStore.memory();
    const admin: string[] = [];
    const ctx: UsageContext = { phone: FRANK, sink: store, notices: new Set(), notifyAdmin: async (t) => void admin.push(t) };
    let calls = 0;
    const call = async () => (calls++, { usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50 } });
    await runWithUsage(ctx, () => meteredModelCall("reporte", "claude-haiku-4-5-20251001", call));
    expect(await store.usageSummary(new Date(0))).toEqual([{ phone: FRANK, purpose: "reporte", llmCalls: 1, inputTokens: 1050, outputTokens: 200, audioCalls: 0, audioSeconds: 0, costUsd: expect.closeTo(0.00205, 8) }]);
    process.env.PORTAL_ADMIN_NUMBER = ADMIN;
    try {
      await expect(runWithUsage(ctx, () => meteredModelCall("reporte", "claude-haiku-4-5-20251001", call))).rejects.toBeInstanceOf(UsageCapExceeded);
      await expect(runWithUsage(ctx, () => meteredModelCall("cotizador_pedido", "claude-haiku-4-5-20251001", call))).rejects.toBeInstanceOf(UsageCapExceeded);
    } finally {
      delete process.env.PORTAL_ADMIN_NUMBER;
    }
    expect(calls).toBe(1);
    expect([...ctx.notices]).toEqual([LLM_CAP_NOTICE]);
    expect(admin).toHaveLength(1); // una vez por día y por tope
    expect(admin[0]).toContain("Tope de consumo alcanzado");
    expect(admin[0]).toContain(FRANK);
  });

  it("reporte: pasa por el medidor (propósito, max_tokens 1500, texto cortado); al tope, reglas con el motivo", async () => {
    const store = JsonStore.memory();
    const ctx: UsageContext = { phone: FRANK, sink: store, notices: new Set() };
    const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const client: LlmClient = {
      messages: {
        async create(p) {
          seen.push(p);
          const input = { empresa: null, tipo: "visita", contacto: null, interes: { medidas: [] }, proximaAccion: null, etapaSugerida: null, ocurrioEn: null, confianza: "media", faltantes: [] };
          return { content: [{ type: "tool_use", id: "t", name: "registrar_reporte", input } as Anthropic.ToolUseBlock], usage: { input_tokens: 3000, output_tokens: 380 } };
        },
      },
    };
    const ectx = { now: new Date("2026-11-13T15:00:00Z"), vendedor: { id: 1, nombre: "Frank" }, companies: [] };
    const r = await runWithUsage(ctx, () => extractReport(`Visité Zeta Bus. ${"bla ".repeat(800)}`, ectx, { client }));
    expect(r.via).toBe("llm");
    expect(seen[0].max_tokens).toBe(1500);
    // corrida E punto 3: el texto va delimitado como dato (<mensaje>…</mensaje>); dentro, los 2.000 caracteres
    expect(String(seen[0].messages[0].content).replace(/^<mensaje>\n|\n<\/mensaje>$/g, "").length).toBe(2000);
    expect([...ctx.notices]).toEqual([CLIP_NOTICE(2000)]);
    expect(await store.usageSummary(new Date(0))).toMatchObject([{ phone: FRANK, purpose: "reporte", llmCalls: 1, inputTokens: 3000, outputTokens: 380 }]);
    __setLimitsForTests(limits({ perUserDaily: { llmCalls: 1, llmTokens: 1_000_000, audioMinutes: 10 } }));
    const capped = await runWithUsage(ctx, () => extractReport("Visité Zeta Bus", ectx, { client }));
    expect(seen).toHaveLength(1);
    expect(capped.via).toBe("rules");
    expect(capped.llmError).toMatch(/^tope usuario de llamadas al modelo/);
  });

  it("fuera de un mensaje y sin store: no limita ni registra (usuario 'sistema')", async () => {
    __setLimitsForTests(limits({ globalDaily: { llmCalls: 0, llmTokens: 0, audioMinutes: 0 } }));
    let calls = 0;
    await meteredModelCall("lista_precios", "m", async () => (calls++, {}));
    expect(calls).toBe(1);
  });
});

// ── por el cotizador y el portal, con Anthropic simulado ──

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
  salespeople: { [FRANK]: { name: "Frank Rodríguez" } },
});

let id = 0;
const msg = (extra: Partial<InboundMessage> = {}): InboundMessage => ({ id: `wamid.u${++id}`, from: FRANK, timestamp: "1", type: "text", text: "hola", forwarded: false, ...extra });

describe("topes en el bot", () => {
  let client: FakeWhatsAppClient;
  let store: JsonStore;
  let portal: JsonPortalStore;
  let bot: BotHandler;
  let requests: Anthropic.MessageCreateParamsNonStreaming[];
  let downloads: number;
  let deepgramCalls: number;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "LLM_DISABLED", "DEEPGRAM_API_KEY", "VOICE_DISABLED", "QUOTE_LLM_MODE", "ADMIN_NUMBERS", "PORTAL_ADMIN_NUMBER", "PORTAL_SESSION_SECRET"]) saved[k] = process.env[k];
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.LLM_DISABLED;
    delete process.env.VOICE_DISABLED;
    // corrida E punto 4: el valor por defecto pasó a "shadow"; estas pruebas ejercitan el camino con modelo ("on")
    process.env.QUOTE_LLM_MODE = "on";
    process.env.DEEPGRAM_API_KEY = "dg-test-key";
    process.env.PORTAL_ADMIN_NUMBER = ADMIN;
    process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
    requests = [];
    downloads = 0;
    deepgramCalls = 0;
    __setAnthropicForTests({
      messages: {
        create: async (p: Anthropic.MessageCreateParamsNonStreaming) => {
          requests.push(p);
          return { content: [{ type: "tool_use", id: "t1", name: String((p.tool_choice as { name?: string })?.name ?? ""), input: { lines: [] } }], usage: { input_tokens: 100, output_tokens: 20 } };
        },
      },
    } as unknown as Anthropic);
    client = new FakeWhatsAppClient();
    const realDownload = client.downloadMedia.bind(client);
    client.downloadMedia = async (mediaId: string) => {
      downloads++;
      return realDownload(mediaId);
    };
    configureReportBot({
      llm: null,
      downloadMedia: (mid) => client.downloadMedia(mid),
      deepgramFetch: (async () => {
        deepgramCalls++;
        return new Response(JSON.stringify({ metadata: { duration: 7 }, results: { channels: [{ alternatives: [{ transcript: "visité transportes zeta bus", confidence: 0.9 }] }] } }), { status: 200 });
      }) as typeof fetch,
    });
    store = JsonStore.memory();
    portal = JsonPortalStore.memory();
    await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
    bot = new BotHandler({ client, store, settings, portalStore: portal });
  });

  afterEach(() => {
    __setAnthropicForTests(undefined);
    __setLimitsForTests(null);
    configureReportBot(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const PEDIDO = "Fenixway Valor 87 295/80R22.5 x4 para Transportes Beta";

  it("max_tokens por propósito y propósito en la tabla (pedido escrito / con foto)", async () => {
    await bot.handle(msg({ text: PEDIDO }));
    expect(requests.map((r) => r.max_tokens)).toEqual([2048]);
    await bot.handle(msg({ text: "cancelar" }));
    client.media.set("img1", { data: Buffer.from("jpeg"), mimeType: "image/jpeg" });
    await bot.handle(msg({ type: "image", text: "cotízame 4 llantas 295/80R22.5", media: { id: "img1", mimeType: "image/jpeg", caption: "cotízame 4 llantas 295/80R22.5" } }));
    const purposes = (await store.usageSummary(new Date(0))).map((r) => `${r.purpose}:${r.llmCalls}`).sort();
    // la foto: una lectura con el archivo y luego la del texto combinado (como siempre)
    expect(purposes).toEqual(["cotizador_imagen:1", "cotizador_pedido:2"]);
  });

  it("al tope: el pedido sale por reglas, una línea al usuario y un aviso al administrador una vez por día", async () => {
    __setLimitsForTests(limits({ perUserDaily: { llmCalls: 1, llmTokens: 1_000_000, audioMinutes: 10 } }));
    await bot.handle(msg({ text: PEDIDO }));
    await bot.handle(msg({ text: "cancelar" }));
    const before = client.sent.length;
    await bot.handle(msg({ text: PEDIDO }));
    expect(requests).toHaveLength(1); // la segunda no llamó
    const out = client.sent.slice(before);
    expect(out.filter((m) => m.to === FRANK).map((m) => m.body).join("\n")).toContain("295/80R22.5"); // siguió con reglas
    expect(out.filter((m) => m.to === FRANK).at(-1)?.body).toBe(LLM_CAP_NOTICE);
    expect(out.filter((m) => m.to === ADMIN)).toHaveLength(1);
    // otra vez al tope el mismo día: la línea al usuario sí, el administrador no
    await bot.handle(msg({ text: "cancelar" }));
    await bot.handle(msg({ text: PEDIDO }));
    expect(client.sent.filter((m) => m.to === ADMIN)).toHaveLength(1);
    // con foto al tope: no se descarga el archivo
    client.media.set("img2", { data: Buffer.from("jpeg"), mimeType: "image/jpeg" });
    await bot.handle(msg({ text: "cancelar" }));
    await bot.handle(msg({ type: "image", text: "cotízame 4 llantas 295/80R22.5", media: { id: "img2", mimeType: "image/jpeg", caption: "cotízame 4 llantas 295/80R22.5" } }));
    expect(downloads).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it("QUOTE_LLM_MODE=off: cero llamadas al leer pedidos (texto y foto, sin descargar)", async () => {
    process.env.QUOTE_LLM_MODE = "off";
    expect(await parseRequestWithLLM(PEDIDO)).toBeNull();
    expect((await parseRequest(PEDIDO)).lines.length).toBeGreaterThan(0);
    await bot.handle(msg({ text: PEDIDO }));
    await bot.handle(msg({ text: "cancelar" }));
    client.media.set("img3", { data: Buffer.from("jpeg"), mimeType: "image/jpeg" });
    await bot.handle(msg({ type: "image", text: "cotízame 4 llantas 295/80R22.5", media: { id: "img3", mimeType: "image/jpeg", caption: "cotízame 4 llantas 295/80R22.5" } }));
    expect(requests).toHaveLength(0);
    expect(downloads).toBe(0);
    process.env.QUOTE_LLM_MODE = "on";
    await parseRequestWithLLM(PEDIDO);
    expect(requests).toHaveLength(1);
  });

  it("texto largo al modelo: se corta en 2.000 caracteres y se avisa en una línea; las listas de precios tienen su propio tope", async () => {
    const long = `${PEDIDO}\n${"nota ".repeat(1000)}`;
    await bot.handle(msg({ text: long }));
    const sentText = (requests[0].messages[0].content as { type: string; text?: string }[]).find((b) => b.type === "text")?.text ?? "";
    expect(sentText.replace(/^<mensaje>\n|\n<\/mensaje>$/g, "").length).toBe(2000); // delimitado como dato (punto 3)
    expect(client.texts().at(-1)).toBe(CLIP_NOTICE(2000));
    // un pedido largo: si el modelo (texto cortado) lee menos ítems que las reglas (texto completo), mandan las reglas
    __setAnthropicForTests({
      messages: {
        create: async (p: Anthropic.MessageCreateParamsNonStreaming) => {
          requests.push(p);
          return { content: [{ type: "tool_use", id: "t2", name: "record_request", input: { lines: [{ size: "295/80R22.5", brand: "Fenixway", model: "Valor 87", quantity: 4 }] } }], usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    } as unknown as Anthropic);
    const longOrder = `Fenixway Valor 87 295/80R22.5 x4\n${"Atentamente, área de compras. ".repeat(80)}\nFenixway Valor 99 11R22.5 x2`;
    expect((await parseRequest(longOrder)).lines.map((l) => l.size?.display)).toEqual(["295/80R22.5", "11R22.5"]);
    expect((await parseRequest(PEDIDO)).parsedBy).toBe("llm+regex"); // corto: como siempre
    // lista de proveedor: 60.000 (limits.maxPriceListChars), sin aviso de recorte
    requests.length = 0;
    await extractPricesWithLLM({ text: "x".repeat(70_000) }, { provider: "Norte", sourceRef: "t", source: "whatsapp" });
    const listText = (requests[0].messages[0].content as { type: string; text?: string }[]).find((b) => b.type === "text")?.text ?? "";
    expect(listText.length).toBe("Provider: Norte\n\n<documento>\n".length + 60_000 + "\n</documento>".length); // delimitado (punto 3)
    expect(requests[0].max_tokens).toBe(8192);
  });

  const audio = (mediaId: string): InboundMessage => msg({ type: "audio", text: undefined, media: { id: mediaId, mimeType: "audio/ogg; codecs=opus" } });

  it("VOICE_DISABLED=1: respuesta fija, sin descarga ni Deepgram", async () => {
    process.env.VOICE_DISABLED = "1";
    client.media.set("a1", { data: Buffer.from("OggS"), mimeType: "audio/ogg" });
    await bot.handle(audio("a1"));
    expect(client.texts().at(-1)).toBe(VOICE_DISABLED_REPLY);
    expect({ downloads, deepgramCalls }).toEqual({ downloads: 0, deepgramCalls: 0 });
  });

  it("nota de voz de más de 180 s: se descarga (gratis) pero no se paga Deepgram; una corta sí y se registran sus segundos", async () => {
    client.media.set("larga", { data: opusNote(600), mimeType: "audio/ogg; codecs=opus" });
    await bot.handle(audio("larga"));
    expect(client.texts().at(-1)).toContain("más de 3 minutos");
    expect({ downloads, deepgramCalls }).toEqual({ downloads: 1, deepgramCalls: 0 });
    client.media.set("corta", { data: opusNote(8), mimeType: "audio/ogg; codecs=opus" });
    await bot.handle(audio("corta"));
    expect(deepgramCalls).toBe(1);
    expect((await store.usageSummary(new Date(0))).find((r) => r.purpose === "voz")).toMatchObject({ phone: FRANK, audioCalls: 1, audioSeconds: 7 });
  });

  it("tope de minutos de voz: no se llama a Deepgram, respuesta fija y aviso al administrador", async () => {
    __setLimitsForTests(limits({ perUserDaily: { llmCalls: 100, llmTokens: 1_000_000, audioMinutes: 0.1 } }));
    client.media.set("c1", { data: opusNote(8), mimeType: "audio/ogg; codecs=opus" });
    await bot.handle(audio("c1")); // 8 s > 6 s
    expect(deepgramCalls).toBe(0);
    expect(client.sent.filter((m) => m.to === FRANK).map((m) => m.body)).toContain(VOICE_CAP_REPLY);
    expect(client.sent.filter((m) => m.to === ADMIN).map((m) => m.body).join()).toContain("minutos de voz");
  });
});

/** Nota de voz Opus sintética de `seconds` segundos (cabecera OpusHead + páginas con granule). */
function opusNote(seconds: number): Buffer {
  const page = (granule: bigint, payload: Buffer, type = 0) => {
    const h = Buffer.alloc(27);
    h.write("OggS", 0, "latin1");
    h[5] = type;
    h.writeBigInt64LE(granule, 6);
    h[26] = 1;
    return Buffer.concat([h, Buffer.from([payload.length]), payload]);
  };
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "latin1");
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(312, 10);
  return Buffer.concat([page(BigInt(0), head, 2), page(BigInt(Math.round(seconds * 48000) + 312), Buffer.alloc(60, 1))]);
}
