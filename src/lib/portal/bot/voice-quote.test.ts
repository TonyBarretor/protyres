/**
 * Cotización por voz (corrida D, punto 8), por el BotHandler con WhatsApp y Deepgram simulados:
 *  - la nota de voz "cotízame …" pasa por el MISMO flujo del cotizador: mismo "Entendí:" y mismas opciones que el texto
 *    normalizado escrito por cualquier número; antes, una línea `🎙 Escuché: …` con la transcripción literal;
 *  - nunca hay PDF sin `ok` escrito: ni con un atajo del texto (elegir *1b* arma el PDF en texto) ni con un "ok" dictado;
 *  - correcciones por voz con la cotización a la vista ("no, eran doce", "cámbialo a Valor 99", "precio 259");
 *  - medida que no está en el catálogo (o falta): se pregunta (con botones si hay candidatas), no se elige;
 *  - precedencia del punto 7 sobre la transcripción: con un reporte en confirmación, la cotización por voz lo pasa a pausa;
 *  - keyterms de Deepgram con diseños y medidas del catálogo.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PriceRow } from "../../ingest/types";
import { loadCustomerProfiles, SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient, type OutboundMessage } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import { parseWebhook, type InboundMessage } from "../../whatsapp/webhook";
import { JsonPortalStore } from "../store";
import { configureReportBot } from "./report";
import { getPending } from "./state";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
  // vendedores del cotizador (config/pilot.json): FRANK también es usuario del portal; STRANGER solo del cotizador. Corrida E:
  // un número que no está aquí ni en el portal no pasa la puerta del bot.
  salespeople: { "51900000001": { name: "Frank Rodríguez" }, "51911111111": { name: "Vendedor solo del cotizador" } },
});

const FRANK = "51900000001";
const STRANGER = "51911111111";

const row = (id: string, model: string, size: string, cost: number): PriceRow => ({
  id,
  provider: "360 Tyres",
  kind: "own",
  description: `${size} FENIXWAY ${model.toUpperCase()}`,
  brand: "Fenixway",
  model,
  size,
  sizeDisplay: size,
  sizeRaw: size,
  isTyre: true,
  ply: 18,
  cost,
  priceIncludesTax: true,
  currency: "USD",
  stock: null,
  priceDate: "2026-11-10",
  source: "excel",
  sourceRef: "t.xlsx",
});
const ROWS: PriceRow[] = [
  row("own-flama77-295", "Flama 77", "295/80R22.5", 450),
  row("own-valor99-295", "Valor 99", "295/80R22.5", 480),
  row("own-valor87-295", "Valor 87", "295/80R22.5", 472),
  row("own-flama77-275", "Flama 77", "275/80R22.5", 430),
  row("own-valor99-11", "Valor 99", "11R22.5", 400),
];

let seq = 0;
let client: FakeWhatsAppClient;
let prices: JsonStore;
let portal: JsonPortalStore;
let bot: BotHandler;
const saved: Record<string, string | undefined> = {};
/** Transcripciones que devolverá Deepgram, en orden, y las URLs pedidas (keyterms). */
let queue: string[];
let urls: string[];

const text = (body: string, from = FRANK): InboundMessage => ({ id: `wamid.v${++seq}`, from, timestamp: "1", type: "text", text: body, forwarded: false });
/** Nota de voz cuya transcripción será `transcript`. */
function voice(transcript: string, from = FRANK): InboundMessage {
  queue.push(transcript);
  const id = `aud-${++seq}`;
  client.media.set(id, { data: Buffer.from("OggS-fake"), mimeType: "audio/ogg; codecs=opus" });
  return { id: `wamid.v${seq}`, from, timestamp: "1", type: "audio", forwarded: false, media: { id, mimeType: "audio/ogg; codecs=opus" } };
}
function press(title: string): InboundMessage {
  const last = client.interactives().at(-1);
  if (!last || last.type !== "button") throw new Error("no hubo botones");
  const hit = last.buttons.find((b) => b.title === title);
  if (!hit) throw new Error(`no hay botón ${title}: ${last.buttons.map((b) => b.title).join(", ")}`);
  const payload = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { messages: [{ id: `wamid.v${++seq}`, from: FRANK, timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: hit.id, title: hit.title } } }] } }] }] };
  return parseWebhook(payload).messages[0];
}
const say = async (m: InboundMessage | string): Promise<OutboundMessage[]> => {
  const before = client.sent.length;
  await bot.handle(typeof m === "string" ? text(m) : m);
  return client.sent.slice(before);
};
const bodies = (out: OutboundMessage[]) => out.filter((m) => m.kind === "text" || m.kind === "interactive").map((m) => m.body ?? "");
const titlesOf = (m: { type: string } & Partial<{ buttons: { title: string }[] }>) => (m.type === "button" ? (m.buttons ?? []).map((b) => b.title) : []);
const docs = (out: OutboundMessage[]) => out.filter((m) => m.kind === "document");
const step = async (phone = FRANK) => (await prices.getConversation(phone))?.step ?? "idle";

beforeEach(async () => {
  for (const k of ["LLM_DISABLED", "PHOTOS_DISABLED", "PORTAL_SESSION_SECRET", "PORTAL_BASE_URL", "DEEPGRAM_API_KEY"]) saved[k] = process.env[k];
  process.env.LLM_DISABLED = "1";
  process.env.PHOTOS_DISABLED = "1";
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  process.env.PORTAL_BASE_URL = "https://portal.example.pe";
  process.env.DEEPGRAM_API_KEY = "dg-test-key";
  client = new FakeWhatsAppClient();
  prices = JsonStore.memory();
  portal = JsonPortalStore.memory();
  await prices.upsertRows(ROWS);
  await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  queue = [];
  urls = [];
  const deepgramFetch = (async (url: string | URL | Request) => {
    urls.push(decodeURIComponent(String(url)).replace(/\+/g, " "));
    const transcript = queue.shift();
    if (transcript === undefined) throw new Error("cola de transcripciones vacía");
    return new Response(JSON.stringify({ metadata: { duration: 6 }, results: { channels: [{ alternatives: [{ transcript, confidence: 0.9 }] }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
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

const DICTADO = "Cotízame ocho Flama 77 en 295 80 22.5 a 254 para Transportes Beta, a 45 días.";
const ESCRITO = "Fenixway Flama 77 295/80R22.5 x8 precio 254\npara Transportes Beta\nplazo: 45 días";

describe("cotización por voz: mismo flujo que el texto", () => {
  // "Transportes Beta" es un cliente conocido (cotización anterior, sin ítems): el cliente dictado coincide tal cual y no
  // hay aviso de cliente desconocido (ese caso: "ninguna parecida: sigue con lo dicho, pero avisa")
  beforeEach(async () => {
    await prices.saveQuote({ number: "COT-0900", date: "2026-10-01", validUntil: "2026-10-08", validityDays: 7, currency: "USD", customer: { company: "Transportes Beta" }, items: [], subtotal: 0, taxPct: 18, taxLabel: "IGV", tax: 0, total: 0 } as never);
  });

  it("🎙 Escuché (literal, una línea) y luego el mismo Entendí y las mismas opciones que el texto escrito; sin PDF hasta el ok", async () => {
    const typed = await say(text(ESCRITO, STRANGER));
    const out = await say(voice(DICTADO));
    const b = bodies(out);
    expect(b[0]).toBe(`🎙 Escuché: ${DICTADO}`);
    expect(b[0]).not.toContain("\n");
    expect(b.slice(1)).toEqual(bodies(typed));
    expect(b[1]).toContain("Entendí:");
    expect(b[1]).toContain("295/80R22.5");
    expect(docs(out)).toHaveLength(0);
    expect(await step()).toBe("choose");
    expect(urls).toHaveLength(1);
    // la transcripción queda en messages
    expect((await prices.listMessages(FRANK, 20)).some((m) => m.kind === "transcript" && m.body === DICTADO)).toBe(true);

    const ok = await say("ok");
    expect(docs(ok)).toHaveLength(1);
    expect(await step()).not.toBe("choose");
  });

  it("nunca PDF sin ok: elegir *1b* arma el PDF en texto, pero en una cotización por voz solo cambia la opción", async () => {
    await say(text(ESCRITO, STRANGER));
    const textPick = await say(text("1b", STRANGER));
    expect(docs(textPick)).toHaveLength(1); // el atajo del texto, sin cambios

    await say(voice(DICTADO));
    const pick = await say("1b");
    expect(docs(pick)).toHaveLength(0);
    expect(await step()).toBe("choose");
    expect(bodies(pick).join("\n")).toContain("Responde *ok* para armar el PDF");
    const ok = await say("ok");
    expect(docs(ok)).toHaveLength(1);
  });

  it("un 'ok' dictado no arma el PDF: pide escribirlo", async () => {
    await say(voice(DICTADO));
    const out = await say(voice("Ok, dale."));
    expect(docs(out)).toHaveLength(0);
    expect(bodies(out).join("\n")).toMatch(/escribe \*ok\*/i);
    expect(await step()).toBe("choose");
  });

  it("transcripción con ruido -> mismo pedido", async () => {
    const out = await say(voice("Eh, cotízame este... ocho llantas eh Flama setenta y siete en doscientos noventa y cinco, ochenta erre veintidós punto cinco, a doscientos cincuenta y cuatro dólares para transportes beta. Mmm, a cuarenta y cinco días, gracias."));
    const b = bodies(out);
    expect(b[0]).toMatch(/^🎙 Escuché: Eh, cotízame/);
    expect(b[1]).toContain("Entendí:");
    expect(b[1]).toContain("295/80R22.5");
    expect(b[1]).toContain("x8");
    expect(b[1]).toContain("254");
    expect(b[1]).toContain("45 días");
    expect(docs(out)).toHaveLength(0);
  });

  it("keyterms de Deepgram: diseños y medidas del catálogo además del vocabulario", async () => {
    await say(voice(DICTADO));
    expect(urls[0]).toContain("keyterm=Valor 99");
    expect(urls[0]).toContain("keyterm=295/80R22.5");
    expect(urls[0]).toContain("keyterm=Fenixway");
  });
});

describe("correcciones por voz", () => {
  it("'no, eran doce', 'cámbialo a Valor 99', 'precio 259' -> el resumen cambia, sin PDF; el ok escrito arma lo corregido", async () => {
    await say(voice(DICTADO));
    const qty = await say(voice("No, eran doce."));
    expect(bodies(qty)[0]).toBe("🎙 Escuché: No, eran doce.");
    expect(bodies(qty).join("\n")).toMatch(/x12/);
    const model = await say(voice("Cámbialo a Valor 99."));
    expect(bodies(model).join("\n")).toMatch(/Valor 99[^\n]*x12/i);
    const price = await say(voice("Precio doscientos cincuenta y nueve."));
    expect(bodies(price).join("\n")).toMatch(/259/);
    for (const out of [qty, model, price]) expect(docs(out)).toHaveLength(0);
    expect(await step()).toBe("choose");

    const ok = await say("ok");
    expect(docs(ok)).toHaveLength(1);
    const quote = (await prices.listQuotes(1))[0];
    expect(quote.items.map((it) => [it.model, it.quantity, it.unitPrice])).toEqual([["Valor 99", 12, 259]]);
  });

  it("un modelo que no está entre las opciones se dice, sin cambiar nada", async () => {
    await say(voice(DICTADO));
    const out = await say(voice("cámbialo a Flama 89"));
    expect(bodies(out).join("\n")).toMatch(/Flama 89/);
    expect(bodies(out).join("\n")).toMatch(/no (?:está|tengo)/i);
    expect(await step()).toBe("choose");
  });
});

describe("medida dictada que no está en el catálogo", () => {
  it("medida inexistente con dos candidatas: pregunta con botones, no elige; el botón sigue con la elegida", async () => {
    const out = await say(voice("cotízame cuatro Flama 77 en doscientos ochenta y cinco ochenta erre veintidós y medio para Transportes Beta"));
    const b = bodies(out);
    expect(b[0]).toMatch(/^🎙 Escuché: cotízame cuatro Flama 77/);
    expect(b.join("\n")).toContain("285/80R22.5");
    expect(b.join("\n")).not.toContain("Entendí:");
    const asked = client.interactives().at(-1);
    expect(asked?.type === "button" ? asked.buttons.map((x) => x.title) : null).toEqual(["275/80R22.5", "295/80R22.5"]);
    expect(await step()).toBe("idle");
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("voice_size");

    const picked = await say(press("295/80R22.5"));
    const pb = bodies(picked);
    expect(pb.join("\n")).toContain("Entendí:");
    expect(pb.join("\n")).toContain("295/80R22.5");
    expect(pb.join("\n")).toContain("x4");
    expect(docs(picked)).toHaveLength(0);
    expect(await step()).toBe("choose");
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
  });

  it("sin medida: la pregunta y la respuesta escrita (o dictada) completa el pedido", async () => {
    const out = await say(voice("cotízame cuatro Flama 77 para Transportes Beta"));
    expect(bodies(out).join("\n")).toMatch(/medida/i);
    expect(bodies(out).join("\n")).not.toContain("Entendí:");
    const ans = await say(voice("doscientos noventa y cinco ochenta veintidós y medio"));
    expect(bodies(ans).join("\n")).toContain("Entendí:");
    expect(bodies(ans).join("\n")).toContain("295/80R22.5");
    expect(await step()).toBe("choose");
  });

  it("medida que no existe ni se parece: lo dice y pide la medida", async () => {
    const out = await say(voice("cotízame cuatro Flama 77 en 445 65 22.5"));
    expect(bodies(out).join("\n")).toContain("445/65R22.5");
    expect(bodies(out).join("\n")).toMatch(/no está en el catálogo/i);
    expect(await step()).toBe("idle");
  });
});

describe("precedencia del punto 7 sobre la transcripción", () => {
  it("con un reporte esperando confirmación, 'cotízame …' por voz lo pasa a pausa y cotiza", async () => {
    await say("Visité Transportes Gamma, me atendió el jefe de flota, quedamos en llamar el lunes");
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("report_draft");
    const out = await say(voice(DICTADO));
    const b = bodies(out).join("\n");
    expect(b).toContain("🎙 Escuché:");
    expect(b).toContain("Entendí:");
    expect(b).toContain("⏸ Dejaste pendiente");
    expect(await step()).toBe("choose");
  });

  it("P4 por voz: con un reporte en confirmación, una medida sola dictada pregunta con los dos botones; *Cotización nueva* la cotiza por voz", async () => {
    await say("Visité Transportes Gamma, me atendió el jefe de flota, quedamos en llamar el lunes");
    const out = await say(voice("doscientos noventa y cinco ochenta veintidós y medio"));
    expect(bodies(out)[0]).toBe("🎙 Escuché: doscientos noventa y cinco ochenta veintidós y medio");
    const asked = client.interactives().at(-1);
    expect(asked?.type === "button" ? asked.buttons.map((x) => x.title) : null).toEqual(["Cotización nueva", "Es mi respuesta"]);
    expect(await step()).toBe("idle");
    const quoted = await say(press("Cotización nueva"));
    const b = bodies(quoted).join("\n");
    expect(b).toContain("🎙 Escuché:");
    expect(b).toContain("Entendí:");
    expect(b).toContain("⏸ Dejaste pendiente");
    expect(docs(quoted)).toHaveLength(0);
    expect(await step()).toBe("choose");
  });

    it("ambigua sin nada pendiente: pregunta ¿cotización o reporte? con botones, igual que escrita", async () => {
    const said = "visité Transportes Gamma, necesitan ocho 295/80R22.5";
    const typed = await say(said);
    expect(bodies(typed).at(-1)).toContain("¿Es una *cotización* o un *reporte*");
    expect(titlesOf(client.interactives().at(-1)!)).toEqual(["Cotización", "Reporte"]);
    await say("cancelar");

    const out = await say(voice(said));
    expect(bodies(out)[0]).toBe(`🎙 Escuché: ${said}`);
    expect(bodies(out).at(-1)).toContain("¿Es una *cotización* o un *reporte*");
    expect(titlesOf(client.interactives().at(-1)!)).toEqual(["Cotización", "Reporte"]);
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("intent_choice");

    // *Cotización*: cotización por voz (mismo flujo; sin PDF hasta el ok escrito)
    const quoted = await say(press("Cotización"));
    expect(bodies(quoted).join("\n")).toContain("Entendí:");
    expect(docs(quoted)).toHaveLength(0);
    expect(await step()).toBe("choose");
    const picked = await say("1b");
    expect(docs(picked)).toHaveLength(0);
  });

    it("una nota de voz de reporte sigue siendo reporte", async () => {
    const out = await say(voice("Visité Transportes Gamma, me atendió el jefe de flota, quedamos en llamar el lunes"));
    expect(bodies(out).join("\n")).toContain("🎙️ Entendí:");
    expect(bodies(out).join("\n")).not.toContain("🎙 Escuché:");
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("report_draft");
    expect(await step()).toBe("idle");
  });
});

describe("cotizador: un pedido de contrato por voz tampoco arma el PDF sin ok", () => {
  const pSettings: Settings = SettingsSchema.parse({
    company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
    pricing: { currency: "USD", taxPct: 18, provider: { marginPct: 15, pricesIncludeTax: false }, stalePriceDays: 30 },
    quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7, paymentType: "Factura crédito", paymentTerm: "30 días", deliveryTerm: "48 hrs post OC" },
    customers: loadCustomerProfiles(),
    salespeople: { [FRANK]: { name: "Frank Rodríguez" }, [STRANGER]: { name: "Vendedor solo del cotizador" } }, // corrida E: los números del pedido son del equipo
  });
  const PEDIDO = "prosegur ayacucho 1830\n2 v99\n4 v89\nsolicitante: Johann Castañeda";

  it("en texto el contrato va directo al PDF (atajo); con voiceTranscript muestra el resumen y espera el ok", async () => {
    const c = new FakeWhatsAppClient();
    const store = JsonStore.memory();
    const handler = new BotHandler({ client: c, store, settings: pSettings });
    const run = async (m: InboundMessage) => {
      const before = c.sent.length;
      await handler.handle(m);
      return c.sent.slice(before);
    };
    const typed = await run(text(PEDIDO, STRANGER));
    expect(docs(typed).length).toBeGreaterThan(0);

    const spoken = await run({ ...text(PEDIDO), voiceTranscript: "prosegur ayacucho 1830, dos v99 y cuatro v89, solicitante Johann Castañeda" });
    expect(docs(spoken)).toHaveLength(0);
    expect((await store.getConversation(FRANK))?.step).toBe("choose");
    expect(bodies(spoken).join("\n")).toContain("Responde *ok* para armar el PDF");
    const ok = await run(text("ok"));
    expect(docs(ok).length).toBe(docs(typed).length);
  });
});

// ── prueba con Deepgram real (2026-11-13): cliente y marca mal oídos ──
describe("cotización por voz: el cliente dictado contra empresas y clientes conocidos", () => {
  const own = async (razonSocial: string, ruc: string) => {
    const frank = (await portal.getUserByWhatsapp(FRANK))!;
    const r = await portal.upsertCompanies([{ ruc, razonSocial, sector: "pasajeros", departamento: "LIMA", unidades: 20, llantasPiso: 120 }]);
    await portal.setOwner(r.ids[ruc], frank.id);
  };
  const said = (cliente: string) => `Cotízame ocho Flama 77 en 295 80 22.5 a 254 para ${cliente}, a 45 días.`;

  it("«Septa BUSS» -> ZBUSS S.A.C. (claro): lo usa y lo dice", async () => {
    await own("ZBUSS S.A.C.", "20602221505");
    await own("TRANSPORTES ANDES DEL PERU S.A.C.", "20999000011");
    const out = bodies(await say(voice(said("Septa BUSS")))).join("\n");
    expect(out).toContain("👤 Cliente: entendí «Septa BUSS» → *ZBUSS S.A.C.*");
    expect(out).toContain("Entendí:");
    expect(out).toContain("ZBUSS S.A.C.");
    expect(out).not.toMatch(/Septa BUSS\s*·|· Septa BUSS/);
    expect(await step()).toBe("choose");
  });

  it("dos parecidas: pregunta con botones y sigue con la elegida", async () => {
    await own("ZBUSS S.A.C.", "20602221505");
    await own("TRANSPORTES ZETA BUS EXPRESS S.A.C.", "20999000099");
    const out = bodies(await say(voice(said("Zeta Bus")))).join("\n");
    expect(out).toContain("¿Para qué cliente es?");
    expect(await step()).toBe("idle"); // aún no cotiza
    const titles = titlesOf(client.interactives().at(-1)!);
    expect(titles).toHaveLength(3);
    expect(titles.at(-1)).toMatch(/^Dejar «/);
    const picked = bodies(await say(press(titles.find((t) => /ZBUSS/.test(t))!))).join("\n");
    expect(picked).toContain("Entendí:");
    expect(picked).toContain("ZBUSS S.A.C.");
    expect(await step()).toBe("choose");
  });

  it("ninguna parecida: sigue con lo dicho, pero avisa", async () => {
    await own("ZBUSS S.A.C.", "20602221505");
    const out = bodies(await say(voice(said("Transportes Gamma")))).join("\n");
    expect(out).toContain("⚠️ «Transportes Gamma» no está entre tus empresas ni los clientes conocidos");
    expect(out).toContain("Entendí:");
  });

  it("cliente conocido de cotizaciones anteriores («Mobil Bus» -> MOVIL BUS S.A.C.)", async () => {
    await prices.saveQuote({ number: "COT-0001", date: "2026-11-01", validUntil: "2026-11-08", validityDays: 7, currency: "USD", customer: { company: "MOVIL BUS S.A.C." }, items: [], subtotal: 0, taxPct: 18, taxLabel: "IGV", tax: 0, total: 0 } as never);
    const out = bodies(await say(voice(said("Mobil Bus")))).join("\n");
    expect(out).toContain("👤 Cliente: entendí «Mobil Bus» → *MOVIL BUS S.A.C.*");
  });
});

describe("cotización por voz: marca mal oída contra el catálogo", () => {
  it("«Fénix Uey Flama 77» -> Fenixway Flama 77 (y lo dice)", async () => {
    const out = bodies(await say(voice("Cotízame ocho Fénix Uey Flama 77 en 295 80 22.5 a 254"))).join("\n");
    expect(out).toContain("Entendí:\nFenixway 295/80R22.5 FLAMA 77 x8 precio 254");
    expect(out).toContain("«Fénix Uey» → Fenixway");
  });
});

describe("reporte por voz: marca mal oída contra el catálogo", () => {
  it("«Fénix Uey» en un reporte dictado queda como Fenixway en lo que se guarda", async () => {
    const frank = (await portal.getUserByWhatsapp(FRANK))!;
    const r = await portal.upsertCompanies([{ ruc: "20602221505", razonSocial: "ZBUSS S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 85, llantasPiso: 500 }]);
    await portal.setOwner(r.ids["20602221505"], frank.id);
    await say(voice("Visité ZBUSS, me atendió Carlos Quispe, el jefe de flota. Quieren probar Fénix Uey en direccional."));
    await say("sí");
    const [act] = await portal.listActivities({ companyId: r.ids["20602221505"] });
    const original = String((act?.data as { textoOriginal?: string } | null)?.textoOriginal ?? "");
    expect(original).toContain("quieren probar Fenixway en direccional".replace(/^q/, "Q"));
    expect(original).not.toContain("Fénix Uey");
  });
});

describe("medidas dictadas con voz real (corrida F, punto 9)", () => {
  it("«Cotízame 8 Fenix Way valor 99 en 295 80, ER 22.5 para ZBUSS.» -> 8 Fenixway Valor 99 295/80R22.5 (no «22.5-8»), y queda registrado", async () => {
    const out = bodies(await say(voice("Cotízame 8 Fenix Way valor 99 en 295 80, ER 22.5 para ZBUSS."))).join("\n");
    expect(out).not.toContain("22.5-8");
    expect(out).not.toMatch(/no está en el catálogo/);
    expect(out).toContain("🔤 Corregí lo que oí:");
    expect(out).toContain("«295 80, ER 22.5» → 295/80R22.5");
    expect(out).toMatch(/Entendí:\nFenixway 295\/80R22\.5 VALOR 99 x8/);
    expect(await step()).toBe("choose");
    const [log] = await portal.listVoiceTranscripts({ limit: 5 });
    expect(log).toMatchObject({ phone: FRANK, context: "cotizacion", outcome: "ok", transcript: "Cotízame 8 Fenix Way valor 99 en 295 80, ER 22.5 para ZBUSS." });
    expect(log.understood).toMatchObject({ sizes: ["295/80R22.5"], quantities: [8], brand: "Fenixway", customer: "ZBUSS" });
    expect(log.understood.design?.toLowerCase()).toBe("valor 99");
  });

  it("el bot pide solo la medida y la respuesta dictada «2 9 5 80 R 22.5.» se lee entera como medida", async () => {
    const asked = bodies(await say(voice("Cotízame cuatro Valor 87 para Transportes Beta.")));
    expect(asked.join("\n")).toMatch(/No entendí la medida/);
    const out = bodies(await say(voice("2 9 5 80 R 22.5."))).join("\n");
    expect(out).not.toMatch(/No entendí la medida/);
    expect(out).toContain("«2 9 5 80 R 22.5» → 295/80R22.5");
    expect(out).toMatch(/Entendí:\nFenixway 295\/80R22\.5 VALOR 87 x4/);
    expect(await step()).toBe("choose");
    const logs = await portal.listVoiceTranscripts({ limit: 10 });
    expect(logs.map((l) => [l.context, l.outcome])).toEqual([
      ["seguimiento", "ok"],
      ["medida", "ok"],
      ["cotizacion", "fallo"],
    ]);
    expect(logs[1].understood.sizes).toEqual(["295/80R22.5"]);
    expect(logs[2].understood.questions).toEqual(["sin medida"]);
    // solo fallos y preguntas
    expect((await portal.listVoiceTranscripts({ outcomes: ["fallo", "pregunta"] })).map((l) => l.context)).toEqual(["cotizacion"]);
  });

  it("varias medidas del catálogo posibles («7 50 16»): pregunta con botones y sigue con la elegida", async () => {
    await prices.upsertRows([row("own-valor99-750r16", "Valor 99", "7.5R16", 120), row("own-valor99-750-16", "Valor 99", "7.5-16", 110)]);
    const out = await say(voice("Cotízame cuatro Valor 99 en siete cincuenta dieciséis."));
    expect(bodies(out).join("\n")).toContain("Entendí la medida «7 50 16», que puede ser *7.50R16* o *7.50-16*");
    const asked = client.interactives().at(-1);
    expect(asked?.type === "button" ? asked.buttons.map((x) => [x.id, x.title]) : null).toEqual([
      ["pt:7.5R16", "7.50R16"],
      ["pt:7.5-16", "7.50-16"],
    ]);
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("voice_size");
    const picked = bodies(await say(press("7.50-16"))).join("\n");
    expect(picked).toContain("Entendí:");
    expect(picked).toMatch(/7\.50?-16/);
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
    const [, first] = await portal.listVoiceTranscripts({ limit: 5 });
    expect(first).toMatchObject({ context: "cotizacion", outcome: "pregunta" });
    expect(first.understood.questions).toEqual(["medida «7 50 16»: 7.5R16 / 7.5-16"]);
  });

  it("la misma pregunta cuando la respuesta a «¿qué medida es?» puede ser varias", async () => {
    await prices.upsertRows([row("own-valor99-750r16", "Valor 99", "7.5R16", 120), row("own-valor99-750-16", "Valor 99", "7.5-16", 110)]);
    await say(voice("Cotízame cuatro Valor 99 para Transportes Beta."));
    const out = bodies(await say(voice("siete cincuenta dieciséis"))).join("\n");
    expect(out).toContain("que puede ser *7.50R16* o *7.50-16*");
    const picked = bodies(await say(press("7.50R16"))).join("\n");
    expect(picked).toContain("Entendí:");
  });
});

// ── corrida H, puntos 5 y 6: varias llantas por voz, correcciones dirigidas y Prosegur con UB (transcripciones reales) ──
describe("varias llantas en una nota de voz (corrida H, punto 5)", () => {
  beforeEach(async () => {
    await prices.upsertRows([row("own-valor99-11", "Valor 99", "11R22.5", 400), row("own-flama77-315", "Flama 77", "315/80R22.5", 455), row("own-valor89-235", "Valor 89", "235/75R17.5", 200), row("own-valor99-12", "Valor 99", "12R22.5", 410)]);
    await prices.saveQuote({ number: "COT-0900", date: "2026-10-01", validUntil: "2026-10-08", validityDays: 7, currency: "USD", customer: { company: "Transportes Beta" }, items: [], subtotal: 0, taxPct: 18, taxLabel: "IGV", tax: 0, total: 0 } as never);
  });

  it("una nota con dos llantas (números pegados por Deepgram) -> dos ítems; cliente y plazo para toda la cotización; sin PDF", async () => {
    const out = bodies(await say(voice("Cotízame 8 valor 99 en 295 80 r 22.5 y 4 Flama 77 en 315, 80 r 22.5 a 255 para transportes beta a 30 días."))).join("\n");
    expect(out).toContain("Entendí:");
    expect(out).toMatch(/1\. Fenixway 295\/80R22\.5 VALOR 99 x8/i);
    expect(out).toMatch(/2\. Fenixway 315\/80R22\.5 FLAMA 77 x4/i);
    expect(out).toContain("plazo: 30 días");
    expect(await step()).toBe("choose");
  });

  it("correcciones dirigidas por voz: «El 2º eran 10.», «Al 1º ponle precio 259.», «Elemena el 2º.»; «Súmale …» agrega", async () => {
    await say(voice("Cotízame 8 valor 99 en 295 80 r 22.5 y 4 Flama 77 en 315 80 r 22.5 para transportes beta."));
    expect(bodies(await say(voice("El 2º eran 10."))).join("\n")).toMatch(/Flama 77 315\/80R22\.5 18PR x10/);
    expect(bodies(await say(voice("Al 1º ponle precio 259."))).join("\n")).toMatch(/Valor 99 295\/80R22\.5 18PR x8 @ US\$ 259\.00 \(precio manual\)/);
    const added = bodies(await say(voice("Súmale 6 valor 89 en 235 75 r 17.5."))).join("\n");
    expect(added).toMatch(/3\. Fenixway Valor 89 235\/75R17\.5 18PR x6/);
    const removedOut = await say(voice("Elemena el 2º."));
    expect(bodies(removedOut).join("\n")).toMatch(/2\. .*Flama 77.*_\(quitado\)_/);
    expect(docs(removedOut)).toHaveLength(0);
    const [last] = await portal.listVoiceTranscripts({ limit: 1 });
    expect(last).toMatchObject({ context: "correccion", outcome: "ok" });
  });

  it("pasada real: «Cotita 8, valor 99, …» (cotiza mal oído) es una cotización, no un reporte", async () => {
    const out = bodies(await say(voice("Cotita 8, valor 99, 295, 80 r 22.5. Otra, 4 Flama 77, 315, 80 r 22.5. Para transportes beta."))).join("\n");
    expect(out).not.toContain("🎙️ Entendí: «");
    expect(out).toMatch(/1\. Fenixway 295\/80R22\.5 VALOR 99 x8/i);
    expect(out).toMatch(/2\. Fenixway 315\/80R22\.5 FLAMA 77 x4/i);
  });

  it("pasada real: con «¿cambio, agregar o nueva?» abierto, «Súmale …» por voz agrega y una corrección dirigida espera la respuesta", async () => {
    await say(voice("Cotízame 8 valor 99 en 295 80 r 22.5 y 4 Flama 77 en 315 80 r 22.5 para transportes beta."));
    // Deepgram oyó «Padre A 4 …» por «Agrega cuatro …»: es un pedido con medida y el cotizador pregunta
    expect(bodies(await say(voice("Padre A 4 Flama 77 en 275 80 r 22.5"))).join("\n")).toContain("¿Es un *cambio* en esa, una llanta para *agregar*, o una cotización *nueva*?");
    expect(await step()).toBe("confirm_new");
    expect(bodies(await say(voice("El 3º que sea 12."))).join("\n")).toContain("Antes dime qué hago con el pedido anterior");
    // otro pedido dictado sin verbo («Valor 99 en 12 r 22.5 a 280»): el precio es precio, no 280 llantas
    const again = bodies(await say(voice("Valor 99 en 12 r 22.5 a 280"))).join("\n");
    expect(again).not.toMatch(/x280/);
    expect(await step()).toBe("confirm_new");
    const added = bodies(await say(voice("Súmale 6 valor 89 en 235 75 r 17.5."))).join("\n");
    expect(added).toMatch(/Valor 89 235\/75R17\.5 18PR x6/);
    expect(added).not.toContain("Responde *cambiar*");
  });

  it("no se pudo separar con seguridad: muestra lo entendido y pregunta; *Sí* sigue al cotizador", async () => {
    const out = bodies(await say(voice("Cotiza 8, Westlake CM 958, en 11 r 22.5 a 198, Valor 99 en 11 r 22.5 a 185 para transportes beta.")));
    const asked = out.join("\n");
    expect(asked).toContain("Entendí estas llantas:");
    expect(asked).toContain("no dice cantidad");
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("voice_split");
    expect(await step()).toBe("idle");
    const go = bodies(await say(press("Sí, así está bien"))).join("\n");
    expect(go).toContain("Entendí:");
    expect(await step()).toBe("choose");
  });
});

describe("cotización de Prosegur por voz (corrida H, punto 6)", () => {
  const pSettings: Settings = SettingsSchema.parse({
    company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
    pricing: { currency: "USD", taxPct: 18, provider: { marginPct: 15, pricesIncludeTax: false }, stalePriceDays: 30 },
    quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7, paymentType: "Factura crédito", paymentTerm: "30 días", deliveryTerm: "48 hrs post OC" },
    customers: loadCustomerProfiles(),
    salespeople: { [FRANK]: { name: "Frank Rodríguez" } },
  });
  // la cotización 471 (Juliaca), dictada y transcrita por Deepgram (fixtures/deepgram-varios-items.json, p02)
  const P471 = "Cotízame para Prosegur Julíaca 4 valor 99 en 215 75 R 17.5 para la V 1231. 4 valor 89 para la v 1812, 2 valor 99 para la v 1911, 4 valor 89 para la v 2005 y 4 valor 89 para la v 2201.";
  beforeEach(async () => {
    await prices.upsertRows([row("own-valor99-215", "Valor 99", "215/75R17.5", 150), row("own-valor89-215", "Valor 89", "215/75R17.5", 155)]);
    // una cotización anterior de Prosegur en Juliaca: la sucursal dictada se compara con las conocidas
    await prices.saveQuote({ number: "COT-0471", date: "2026-11-13", validUntil: "2026-11-20", validityDays: 7, currency: "USD", customer: { company: "PROSEGUR SA" }, customerProfile: "prosegur", unit: "Juliaca", items: [], subtotal: 0, taxPct: 18, taxLabel: "IGV", tax: 0, total: 0 } as never);
    bot = new BotHandler({ client, store: prices, settings: pSettings, portalStore: portal });
  });

  it("cliente y sucursal (como dirección), precios de contrato sin dictarlos, cada línea con su UB y la medida heredada; sin PDF hasta el ok escrito", async () => {
    const out = bodies(await say(voice(P471)));
    const all = out.join("\n");
    expect(all).toContain("👤 Entendí: cliente *Prosegur* · sucursal *Juliaca* (va como dirección) · precios de contrato; abajo cada línea con su UB.");
    expect(all).toContain("📏 Las líneas 2, 3, 4 y 5 no dicen medida: uso 215/75R17.5, la de la línea anterior.");
    for (const l of [
      "1. 215/75R17.5 18PR Fenixway Valor 99 MIXT UB 1231 x4 · US$ 123.17",
      "2. 215/75R17.5 18PR Fenixway Valor 89 POST UB 1812 x4 · US$ 126.42",
      "3. 215/75R17.5 18PR Fenixway Valor 99 MIXT UB 1911 x2 · US$ 123.17",
      "4. 215/75R17.5 18PR Fenixway Valor 89 POST UB 2005 x4 · US$ 126.42",
      "5. 215/75R17.5 18PR Fenixway Valor 89 POST UB 2201 x4 · US$ 126.42",
    ])
      expect(all).toContain(l);
    expect(docs(await say(text("solicitante: Cesar Hilario")))).toHaveLength(0);
    // una corrección dirigida antes del ok: cambia la línea, sigue sin PDF
    expect(bodies(await say(voice("El 2º eran 10."))).join("\n")).toMatch(/Valor 89 .*UB 1812.* x10|10 × Valor 89/);
    const ok = await say(text("ok"));
    expect(docs(ok).length).toBeGreaterThan(0);
    const q = (await prices.listQuotes(1))[0];
    expect(q.customer.address).toBe("Juliaca");
    expect(q.items.map((it) => [it.ub, it.quantity, it.unitPrice])).toEqual([
      ["1231", 4, 123.17],
      ["1812", 10, 126.42],
      ["1911", 2, 123.17],
      ["2005", 4, 126.42],
      ["2201", 4, 126.42],
    ]);
  });

  it("UB mal oída o que falta (siempre 4 cifras): pregunta por línea, escrita o dictada, o *sin ub*", async () => {
    const out = bodies(await say(voice("Cotízame para proseguir jubiaca. 4 valor 99 para la UVNI 231. 4 valor 89 para la UVNI 812, 2 valor 99 para la UVNI 911."))).join("\n");
    expect(out).toContain("Entendí la UB «231» en la línea 1 (Fenixway valor 99 x4), pero una UB tiene 4 cifras.");
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("voice_ub");
    expect(bodies(await say(text("123"))).join("\n")).toContain("«123» no tiene 4 cifras");
    expect(bodies(await say(text("1231"))).join("\n")).toContain("«812» en la línea 2");
    expect(bodies(await say(voice("mil ochocientos doce"))).join("\n")).toContain("«911» en la línea 3");
    const done = bodies(await say(text("sin ub"))).join("\n");
    expect(done).toContain("UB 1231 x4");
    expect(done).toContain("UB 1812 x4");
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
  });

  it("sin «cotízame»: «Prosegur, Juliaca. 4, valor 99, …, unidad 1812 …» también es una cotización (no un reporte)", async () => {
    const out = bodies(await say(voice("Prosegur, Juliaca. 4, valor 99, un llegado 1231. 4 valor 89, unidad 1812. 2 valor 99, unidad 1911."))).join("\n");
    expect(out).toContain("sucursal *Juliaca*");
    expect(out).toContain("UB 1812 x4");
    expect(out).not.toContain("🎙️ Entendí:");
  });
});
