/**
 * Corrida H, punto 5: los ítems de una OC dictados por voz. Varias llantas en una nota se separan igual que en la
 * cotización por voz; si no se puede con seguridad, se muestra lo entendido y se pide repetir; con los ítems armados, "el
 * segundo eran seis", "quita el primero" o "agrega …" por voz cambian el pedido. Empresas inventadas.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PriceRow } from "../../ingest/types";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient, type OutboundMessage } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import type { InboundMessage } from "../../whatsapp/webhook";
import { JsonPortalStore } from "../store";
import { configureOrderBot, OC_STEP, type OcStep } from "./commands/oc";
import { configureReportBot } from "./report";
import { getPending } from "./state";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7, paymentType: "Factura crédito", paymentTerm: "30 días" },
  salespeople: { default: "51900000001", "51900000001": { name: "Frank Rodríguez", title: "Key Account Manager", phone: "900 000 001", email: "frank@example.pe" } },
});
const FRANK = "51900000001";
const RUC_ROCA = "20999000044";
const TODAY = "2026-11-11";

const row = (id: string, kind: "own" | "provider", model: string, size: string, cost: number): PriceRow => ({
  id,
  provider: kind === "own" ? "360 Tyres" : "Llantas del Sur",
  kind,
  description: `${size} FENIXWAY ${model}`.toUpperCase(),
  brand: "Fenixway",
  model,
  size,
  sizeDisplay: size,
  sizeRaw: size,
  isTyre: true,
  ply: 18,
  cost,
  priceIncludesTax: kind === "own",
  currency: "USD",
  stock: kind === "provider" ? 40 : null,
  priceDate: TODAY,
  source: "excel",
  sourceRef: "test.xlsx",
});

let seq = 0;
let client: FakeWhatsAppClient;
let prices: JsonStore;
let portal: JsonPortalStore;
let bot: BotHandler;
let queue: string[];
const saved: Record<string, string | undefined> = {};

const text = (body: string): InboundMessage => ({ id: `wamid.ocv${++seq}`, from: FRANK, timestamp: "1", type: "text", text: body, forwarded: false });
function voice(transcript: string): InboundMessage {
  queue.push(transcript);
  const id = `aud-ocv-${++seq}`;
  client.media.set(id, { data: Buffer.from("OggS-fake"), mimeType: "audio/ogg; codecs=opus" });
  return { id: `wamid.ocv${seq}`, from: FRANK, timestamp: "1", type: "audio", forwarded: false, media: { id, mimeType: "audio/ogg; codecs=opus" } };
}
async function say(m: InboundMessage | string): Promise<string> {
  const before = client.sent.length;
  await bot.handle(typeof m === "string" ? text(m) : m);
  return client.sent
    .slice(before)
    .filter((x: OutboundMessage) => x.kind === "text" || x.kind === "interactive")
    .map((x) => x.body ?? "")
    .join("\n");
}
const phase = async () => ((await getPending(portal, FRANK, new Date())) as OcStep | null)?.phase;

beforeEach(async () => {
  for (const k of ["LLM_DISABLED", "PHOTOS_DISABLED", "DEEPGRAM_API_KEY", "PORTAL_SESSION_SECRET"]) saved[k] = process.env[k];
  process.env.LLM_DISABLED = "1";
  process.env.PHOTOS_DISABLED = "1";
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  process.env.DEEPGRAM_API_KEY = "dg-test-key";
  client = new FakeWhatsAppClient();
  prices = JsonStore.memory();
  portal = JsonPortalStore.memory();
  queue = [];
  await prices.upsertRows([row("own-valor87", "own", "Valor 87", "295/80R22.5", 472), row("prov-flama77", "provider", "Flama 77", "315/80R22.5", 200)]);
  const frank = await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  const r = await portal.upsertCompanies([{ ruc: RUC_ROCA, razonSocial: "E.T. LA ROCA S.R.L.", sector: "carga", departamento: "LIMA", unidades: 15, llantasPiso: 150 }]);
  await portal.updateCompany(r.ids[RUC_ROCA], { ownerUserId: frank.id });
  const deepgramFetch = (async () => {
    const transcript = queue.shift();
    if (transcript === undefined) throw new Error("cola de transcripciones vacía");
    return new Response(JSON.stringify({ metadata: { duration: 6 }, results: { channels: [{ alternatives: [{ transcript, confidence: 0.9 }] }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  configureReportBot({ llm: null, deepgramFetch, downloadMedia: (id) => client.downloadMedia(id), logMessage: (e) => prices.logMessage(e) });
  configureOrderBot({ priceStore: prices, settings });
  bot = new BotHandler({ client, store: prices, settings, portalStore: portal });
});

afterEach(() => {
  configureReportBot(null);
  configureOrderBot(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("ítems de la OC por voz (corrida H, punto 5)", () => {
  it("varias llantas en una nota (números pegados por Deepgram) -> los ítems del pedido, con el precio dicho", async () => {
    await say("oc roca 4500999");
    expect(await phase()).toBe("items");
    const out = await say(voice("8 valor 87 en 295 80 r 22.54 Flama 77 en 315, 80 r 22.5 a 230."));
    expect(out).toContain("Entendí:");
    expect(out).toMatch(/8 × 295\/80R22\.5 18PR FENIXWAY VALOR 87/);
    expect(out).toMatch(/4 × 315\/80R22\.5 18PR FENIXWAY FLAMA 77 — US\$ 271\.40 c\/u/);
    expect(await phase()).not.toBe("items");
  });

  it("si no se puede separar con seguridad, muestra lo entendido y pide repetir (no arma nada)", async () => {
    await say("oc roca 4500999");
    const out = await say(voice("8 valor 87 en 295 80 r 22.5 y 315 80 r 22.5 a 230."));
    expect(out).toContain("Entendí estas llantas:");
    expect(out).toContain("no sé si es otra llanta");
    expect(await phase()).toBe("items");
  });

  it("con los ítems armados, «el segundo eran seis» y «quita el primero» por voz cambian el pedido", async () => {
    await say("oc roca 4500999");
    await say(text("8 x Fenixway Valor 87 295/80R22.5 a 254\n4 x Fenixway Flama 77 315/80R22.5 a 230"));
    expect(await phase()).toBe("questions");
    const changed = await say(voice("El 2º eran 6."));
    expect(changed).toContain("✏️ Línea 2: 6 × 315/80R22.5 18PR FENIXWAY FLAMA 77.");
    const removed = await say(voice("Quita el 1º."));
    expect(removed).toContain("✏️ Quité la línea 1");
    expect(((await getPending(portal, FRANK, new Date())) as OcStep | null)?.items?.map((it) => it.cantidad)).toEqual([6]);
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe(OC_STEP);
  });
});
