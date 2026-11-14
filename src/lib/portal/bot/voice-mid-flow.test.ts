/**
 * Corrida F, punto 4: una nota de voz de un usuario registrado SIEMPRE recibe una respuesta coherente, nunca "no leo
 * audios". Causa en producción: con una cotización a medio revisar (review_quote, que dura hasta *ok* o *cancelar*) la
 * nota de voz iba al cotizador. Por el BotHandler con WhatsApp y Deepgram simulados (store JSON en memoria).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PriceRow } from "../../ingest/types";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { VOICE_CAP_REPLY } from "../../guard/usage";
import { FakeWhatsAppClient, type OutboundMessage } from "../../whatsapp/client";
import { AUDIO_REPLY, BotHandler, VIDEO_REPLY } from "../../whatsapp/handler";
import type { InboundMessage } from "../../whatsapp/webhook";
import { JsonPortalStore } from "../store";
import { VOICE_STORE_BUSY } from ".";
import { configureReportBot, VOICE_DISABLED_REPLY, VOICE_EMPTY, VOICE_TOO_SHORT } from "./report";
import { getPending, pausedOf } from "./state";
import { VOICE_CONFIRM_TYPED, VOICE_PAUSED_IN_QUOTE } from "./voice-quote";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
  salespeople: { "51900000001": { name: "Frank Rodríguez" }, "51911111111": { name: "Vendedor solo del cotizador" } },
});

const FRANK = "51900000001";
const STRANGER = "51911111111";
const ROWS: PriceRow[] = [
  { id: "own-valor87", provider: "360 Tyres", kind: "own", description: "295/80R22.5 FENIXWAY VALOR 87", brand: "Fenixway", model: "Valor 87", size: "295/80R22.5", sizeDisplay: "295/80R22.5", sizeRaw: "295/80R22.5", isTyre: true, ply: 18, cost: 472, priceIncludesTax: true, currency: "USD", stock: null, priceDate: "2026-11-10", source: "excel", sourceRef: "t.xlsx" },
];
const PEDIDO = "Fenixway Valor 87 295/80R22.5 x4 para Transportes Beta, compras@beta.pe";

let seq = 0;
let client: FakeWhatsAppClient;
let prices: JsonStore;
let portal: JsonPortalStore;
let bot: BotHandler;
let queue: string[];
let dgCalls: number;
const saved: Record<string, string | undefined> = {};

const text = (body: string, from = FRANK): InboundMessage => ({ id: `wamid.f${++seq}`, from, timestamp: "1", type: "text", text: body, forwarded: false });
function voice(transcript: string, from = FRANK): InboundMessage {
  queue.push(transcript);
  const id = `aud-f${++seq}`;
  client.media.set(id, { data: Buffer.from("OggS-fake"), mimeType: "audio/ogg; codecs=opus" });
  return { id: `wamid.f${seq}`, from, timestamp: "1", type: "audio", forwarded: false, media: { id, mimeType: "audio/ogg; codecs=opus" } };
}
const say = async (m: InboundMessage | string): Promise<OutboundMessage[]> => {
  const before = client.sent.length;
  await bot.handle(typeof m === "string" ? text(m) : m);
  return client.sent.slice(before);
};
const bodies = (out: OutboundMessage[]) => out.filter((m) => m.kind === "text" || m.kind === "interactive").map((m) => m.body ?? "");
const all = (out: OutboundMessage[]) => bodies(out).join("\n");
const step = async (phone = FRANK) => (await prices.getConversation(phone))?.step ?? "idle";

beforeEach(async () => {
  for (const k of ["LLM_DISABLED", "PHOTOS_DISABLED", "PORTAL_SESSION_SECRET", "PORTAL_BASE_URL", "DEEPGRAM_API_KEY", "VOICE_DISABLED"]) saved[k] = process.env[k];
  process.env.LLM_DISABLED = "1";
  process.env.PHOTOS_DISABLED = "1";
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  process.env.PORTAL_BASE_URL = "https://portal.example.pe";
  process.env.DEEPGRAM_API_KEY = "dg-test-key";
  delete process.env.VOICE_DISABLED;
  client = new FakeWhatsAppClient();
  prices = JsonStore.memory();
  portal = JsonPortalStore.memory();
  await prices.upsertRows(ROWS);
  await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  queue = [];
  dgCalls = 0;
  const deepgramFetch = (async () => {
    dgCalls++;
    const transcript = queue.shift();
    if (transcript === undefined) throw new Error("cola de transcripciones vacía");
    return new Response(JSON.stringify({ metadata: { duration: 1 }, results: { channels: [{ alternatives: [{ transcript, confidence: 0.9 }] }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  configureReportBot({ llm: null, deepgramFetch, downloadMedia: (id) => client.downloadMedia(id), logMessage: (e) => prices.logMessage(e) });
  bot = new BotHandler({ client, store: prices, settings, portalStore: portal });
});

afterEach(() => {
  configureReportBot(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Deja una cotización en revisión (review_quote): el caso de producción. */
async function quoteInReview(): Promise<void> {
  await say(PEDIDO);
  await say("ok");
  expect(await step()).toBe("review_quote");
}

describe("nota de voz con una cotización abierta (causa del 'no leo audios' en producción)", () => {
  it("una nota de 1 s que no dice nada -> 'No te escuché bien', no 'no leo audios'; la cotización sigue igual", async () => {
    await quoteInReview();
    const out = await say(voice(""));
    expect(all(out)).not.toMatch(/no leo audios/i);
    expect(all(out)).toBe(VOICE_EMPTY);
    expect(VOICE_EMPTY).toMatch(/^No te escuché bien/);
    expect(await step()).toBe("review_quote");
  });

  it("una corrección dictada se aplica a la cotización en revisión ('eran ocho' -> cantidad 8)", async () => {
    await quoteInReview();
    const out = await say(voice("No, eran ocho."));
    const b = bodies(out);
    expect(b[0]).toBe("🎙 Escuché: No, eran ocho.");
    expect(all(out)).toMatch(/x8|8 ×|8 x|\b8\b/);
    expect(all(out)).not.toMatch(/no leo audios/i);
  });

  it("un 'ok' dictado no envía la cotización: pide escribirlo", async () => {
    await quoteInReview();
    const out = await say(voice("Ok, envíala."));
    expect(bodies(out)).toEqual(["🎙 Escuché: Ok, envíala.", VOICE_CONFIRM_TYPED]);
    expect(await step()).toBe("review_quote");
  });

  it("un reporte dictado queda en pausa (no borrador, no mezcla con la cotización); el 'sí' siguiente sigue al cotizador", async () => {
    await quoteInReview();
    const out = await say(voice("Visité Transportes Beta, me atendió el jefe de flota, quedamos en llamar el lunes"));
    const b = bodies(out);
    expect(b[0]).toMatch(/^🎙 Escuché: Visité/);
    expect(b[1]).toBe(VOICE_PAUSED_IN_QUOTE);
    expect(b[2]).toMatch(/^⏸ Dejaste pendiente: tu mensaje «Visité/);
    const buttons = client.interactives().at(-1);
    expect(buttons?.type === "button" ? buttons.buttons.map((x) => x.title) : []).toEqual(["Continuar", "Descartar"]);
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
    const paused = pausedOf(await portal.getPortalConversation(FRANK));
    expect(paused).toHaveLength(1);
    expect(paused[0].step).toMatchObject({ kind: "intent_choice", voice: true });
    expect(await step()).toBe("review_quote");
  });

  it("en una pregunta del cotizador (aplicación, perfil…) la respuesta dictada entra como si se escribiera", async () => {
    await prices.setConversation(FRANK, { phone: FRANK, step: "need_provider", updatedAt: new Date().toISOString() } as never);
    const viaVoice = await say(voice("Fenixway"));
    await prices.setConversation(STRANGER, { phone: STRANGER, step: "need_provider", updatedAt: new Date().toISOString() } as never);
    const typed = await say(text("Fenixway", STRANGER));
    expect(bodies(viaVoice)[0]).toBe("🎙 Escuché: Fenixway");
    expect(bodies(viaVoice).slice(1)).toEqual(bodies(typed));
  });

  it("voz apagada (VOICE_DISABLED) -> lo dice, sin Deepgram", async () => {
    await quoteInReview();
    process.env.VOICE_DISABLED = "1";
    const out = await say(voice("eran ocho"));
    expect(all(out)).toBe(VOICE_DISABLED_REPLY);
    expect(dgCalls).toBe(0);
  });

  it("sin clave de Deepgram -> 'la voz aún no está activa' (hablando del cambio, no del reporte)", async () => {
    await quoteInReview();
    delete process.env.DEEPGRAM_API_KEY;
    const out = await say(voice("eran ocho"));
    expect(all(out)).toBe("La voz aún no está activa. Escríbeme el cambio en texto, por favor.");
  });

  it("tope de minutos de voz alcanzado -> lo dice, sin Deepgram", async () => {
    await quoteInReview();
    await prices.recordUsage({ phone: FRANK, purpose: "voz", model: "nova-3", audioSeconds: 3 * 3600, costUsd: 0, at: new Date() });
    const out = await say(voice("eran ocho"));
    expect(all(out)).toContain(VOICE_CAP_REPLY);
    expect(dgCalls).toBe(0);
  });
});

describe("nota de voz sin cotización abierta y fuera del portal", () => {
  it("una nota de una palabra sin nada que hacer -> 'No te escuché bien: repítelo'", async () => {
    const out = await say(voice("Eh."));
    expect(bodies(out)).toEqual([`🎙 Escuché: Eh.\n${VOICE_TOO_SHORT}`]);
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
  });

  it("base lenta o caída con una nota de voz -> lo dice (antes: el cotizador y 'no leo audios')", async () => {
    const broken = new Proxy(portal, {
      get(target, prop) {
        if (prop === "getUserByWhatsapp") return async () => Promise.reject(new Error("base caída"));
        return Reflect.get(target, prop);
      },
    });
    // la puerta (corrida E) deja pasar a FRANK por pilot.json aunque el portal no responda
    bot = new BotHandler({ client, store: prices, settings, portalStore: broken });
    const out = await say(voice("eran ocho"));
    expect(all(out)).toBe(VOICE_STORE_BUSY);
  });

  it("vendedor solo del cotizador: mensaje propio para audio; el video tiene el suyo (ya no 'Por ahora no leo audios ni videos')", async () => {
    const out = await say(voice("hola", STRANGER));
    expect(all(out)).toBe(AUDIO_REPLY);
    expect(dgCalls).toBe(0);
    const vid = await say({ id: `wamid.f${++seq}`, from: STRANGER, timestamp: "1", type: "video", forwarded: false, media: { id: "vid1", mimeType: "video/mp4" } });
    expect(all(vid)).toBe(VIDEO_REPLY);
  });
});
