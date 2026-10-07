import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ingestExcel } from "../ingest/tabular";
import { ingestPdf } from "../ingest/pdf";
import { resolveSourceOptions } from "../ingest/sources";
import type { PriceRow } from "../ingest/types";
import { SettingsSchema, type Settings } from "../settings";
import { JsonStore } from "../store/json-store";
import { FakeWhatsAppClient } from "./client";
import { BotHandler } from "./handler";
import { parseWebhook, verifyChallenge, verifySignature, type InboundMessage } from "./webhook";
import { createHmac } from "node:crypto";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
  salespeople: { default: "51955344340", "51955344340": { name: "Frank Melek Rodríguez Mirano", title: "Key Account Manager", phone: "955 344 340", email: "frank.rodriguez@360tyres.pe" } },
});

const clientdata = path.resolve(process.cwd(), "clientdata");
const hasClientData = fs.existsSync(clientdata) && fs.readdirSync(clientdata).length >= 4;
const PHONE = "51955344340";
let id = 0;
const text = (body: string, forwarded = false): InboundMessage => ({ id: `wamid.${++id}`, from: PHONE, timestamp: "1", type: "text", text: body, forwarded });

async function loadClientData(): Promise<PriceRow[]> {
  const rows: PriceRow[] = [];
  for (const f of fs.readdirSync(clientdata)) {
    const buf = fs.readFileSync(path.join(clientdata, f));
    const o = resolveSourceOptions(f);
    const opts = { ...o, provider: o.provider ?? f, sourceRef: f };
    const res = /\.pdf$/i.test(f) ? await ingestPdf(buf, opts) : await ingestExcel(buf, opts);
    rows.push(...res.rows);
  }
  return rows;
}

describe("webhook parsing", () => {
  it("extracts text, forwarded flag and documents", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "123" },
                contacts: [{ wa_id: PHONE, profile: { name: "Frank" } }],
                messages: [
                  { id: "m1", from: PHONE, timestamp: "1", type: "text", text: { body: "hola" } },
                  { id: "m2", from: PHONE, timestamp: "2", type: "text", text: { body: "precios" }, context: { forwarded: true } },
                  { id: "m3", from: PHONE, timestamp: "3", type: "document", document: { id: "media1", mime_type: "application/pdf", filename: "lista.pdf", caption: "proveedor: Norte" } },
                ],
              },
            },
            { field: "messages", value: { statuses: [{ id: "x", status: "delivered" }] } },
          ],
        },
      ],
    };
    const { messages, phoneNumberId } = parseWebhook(payload);
    expect(phoneNumberId).toBe("123");
    expect(messages.length).toBe(3);
    expect(messages[0].profileName).toBe("Frank");
    expect(messages[1].forwarded).toBe(true);
    expect(messages[2].media?.fileName).toBe("lista.pdf");
  });

  it("verifies signature and challenge", () => {
    const body = '{"a":1}';
    const sig = "sha256=" + createHmac("sha256", "secret").update(body).digest("hex");
    expect(verifySignature(body, sig, "secret")).toBe(true);
    expect(verifySignature(body, "sha256=00", "secret")).toBe(false);
    expect(verifyChallenge(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "t", "hub.challenge": "123" }), "t")).toBe("123");
  });
});

describe("bot conversation (synthetic lists)", () => {
  let store: JsonStore;
  let client: FakeWhatsAppClient;
  let bot: BotHandler;
  const pdfs: Buffer[] = [];

  beforeAll(() => {
    process.env.LLM_DISABLED = "1";
    delete process.env.RESEND_API_KEY;
  });

  beforeEach(async () => {
    store = JsonStore.memory();
    client = new FakeWhatsAppClient();
    pdfs.length = 0;
    bot = new BotHandler({ client, store, settings, onPdf: (_q, pdf) => void pdfs.push(pdf) });
    const xls = await ingestExcel(fs.readFileSync(path.resolve(process.cwd(), "samples/proveedor-a-lista.xlsx")), { provider: "Llantas del Sur", sourceRef: "a.xlsx", priceDate: "2026-10-01" });
    await store.upsertRows(xls.rows);
  });

  it("help", async () => {
    await bot.handle(text("hola"));
    expect(client.last()?.body).toContain("Cotizador Protyres");
  });

  it("single-line flow: request -> ok -> PDF + email preview -> enviar", async () => {
    await bot.handle(text("Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com"));
    const options = client.last()?.body ?? "";
    expect(options).toContain("*1.* Michelin 11R22.5 XZE2+ x4");
    expect(options).toContain("*a)* 🚚 Llantas del Sur · sin stock · Michelin XZE2+ 11R22.5");
    expect(options).toContain("*US$ 457.70*");
    expect((await store.getConversation(PHONE))?.step).toBe("choose");

    await bot.handle(text("ok"));
    const doc = client.sent.find((m) => m.kind === "document");
    expect(doc?.fileName).toBe("Cotizacion COT-0001.pdf");
    expect(pdfs.length).toBe(1);
    const preview = client.last()?.body ?? "";
    expect(preview).toContain("*Para:* juan@abc.com");
    expect(preview).toContain("Total: US$ 1,830.80 (precios no incluyen IGV 18%)"); // 457.70*4
    expect(preview).toContain("Frank Melek Rodríguez Mirano");
    expect((await store.getConversation(PHONE))?.step).toBe("review_quote");

    await bot.handle(text("precio 480"));
    expect(client.last()?.body).toContain("Total: US$ 1,920.00"); // 480*4
    await bot.handle(text("pago: letras BCP 60 días"));
    expect(client.last()?.body).toContain("Pago: letras BCP 60 días");
    await bot.handle(text("con igv"));
    expect(client.last()?.body).toContain("Total: US$ 2,265.60 (precios incluyen IGV 18%)"); // 1920 * 1.18

    await bot.handle(text("enviar"));
    expect(client.last()?.body).toContain("COT-0001");
    expect((await store.getQuote("COT-0001"))?.status).toBe("sent");
    expect(await store.getConversation(PHONE)).toBeNull();
  });

  it("choosing option b with a bare number on a single line", async () => {
    await bot.handle(text("295/80R22.5 x2 cliente Pedro"));
    await bot.handle(text("2"));
    expect(client.last()?.body).toContain("¿A qué correo lo envío?");
    await bot.handle(text("pedro@mail.com"));
    expect(client.last()?.body).toContain("*Para:* pedro@mail.com");
  });

  it("multi-line flow: pick per line, remove a line, manual price", async () => {
    await bot.handle(text("Michelin 295/80R22.5 X Multi Z x4; Bridgestone 11R22.5 R268 x2; PARCHE RS-35 VIPAL x25 para Minera Andes S.A.C., c@andes.pe"));
    let body = client.last()?.body ?? "";
    expect(body).toContain("*1.* Michelin 295/80R22.5 X MULTI Z x4");
    expect(body).toContain("*2.* Bridgestone 11R22.5 R268 x2");
    expect(body).toContain("*3.* PARCHE RS-35 VIPAL x25");
    expect(body).toContain("sin precio en las listas");

    await bot.handle(text("ok"));
    expect(client.last()?.body).toContain("Falta precio en el ítem 3");
    await bot.handle(text("precio 3 3.5"));
    body = client.last()?.body ?? "";
    expect(body).toContain("precio manual US$ 3.50");
    await bot.handle(text("quitar 2"));
    expect(client.last()?.body).toContain("_(quitado)_");
    await bot.handle(text("ok"));
    const q = await store.getQuote("COT-0001");
    expect(q?.items.map((i) => [i.description.split(" ").slice(0, 2).join(" "), i.quantity, i.unitPrice, i.origin])).toEqual([
      ["Llanta Michelin", 4, 471.5, "provider"],
      ["PARCHE RS-35", 25, 3.5, "manual"],
    ]);
    expect(client.last()?.body).toContain("*Para:* c@andes.pe");
  });

  it("no size / no prices", async () => {
    await bot.handle(text("quiero llantas michelin"));
    expect(client.last()?.body).toContain("No encontré ninguna medida");
    await bot.handle(text("Michelin 13R22.5 x2 para X, a@b.com"));
    expect(client.last()?.body).toContain("sin precio en las listas");
  });

  it("forwarded provider message -> asks provider -> stores prices", async () => {
    await bot.handle(text("Hola, lista Aeolus: HN08 11R22.5 - 270 usd (stock 40), HN355 295/80R22.5 - 285 usd", true));
    expect(client.last()?.body).toContain("¿De qué proveedor es?");
    await bot.handle(text("Importadora Norte"));
    expect(client.last()?.body).toContain("Guardé *2 precios* de *Importadora Norte*");
    await bot.handle(text("11R22.5 x1 para Z, z@z.com"));
    expect(client.last()?.body).toContain("*a)* 🚚 Importadora Norte · stock 40 · Aeolus HN08 11R22.5");
  });

  it("'proveedor: X' skips the question; a PDF document is ingested", async () => {
    await bot.handle(text("proveedor: Llantas del Sur\nTriangle TR668 11R22.5 a 305", true));
    expect(client.last()?.body).toContain("Guardé *1 precios* de *Llantas del Sur*");
    client.media.set("media-pdf", { data: fs.readFileSync(path.resolve(process.cwd(), "samples/proveedor-b-lista.pdf")), mimeType: "application/pdf", fileName: "lista.pdf" });
    await bot.handle({ id: "wamid.doc", from: PHONE, timestamp: "1", type: "document", forwarded: false, media: { id: "media-pdf", mimeType: "application/pdf", fileName: "lista.pdf" } });
    expect(client.last()?.body).toContain("¿De qué proveedor es?");
    await bot.handle(text("Norte"));
    expect(client.last()?.body).toContain("Guardé *7 precios* de *Norte*");
  });

  it("info commands", async () => {
    await bot.handle(text("proveedores"));
    expect(client.last()?.body).toContain("Llantas del Sur (proveedor): 16 filas");
    await bot.handle(text("precios 11 r 22,5"));
    expect(client.last()?.body).toContain("*11R22.5*");
    expect(client.last()?.body).toContain("Double Coin RR680");
  });
});

describe.runIf(hasClientData)("bot conversation (client's real lists)", () => {
  let store: JsonStore;
  let client: FakeWhatsAppClient;
  let bot: BotHandler;

  beforeAll(async () => {
    process.env.LLM_DISABLED = "1";
    store = JsonStore.memory();
    await store.upsertRows(await loadClientData());
  });
  beforeEach(() => {
    client = new FakeWhatsAppClient();
    bot = new BotHandler({ client, store, settings });
  });

  it("own stock item with discount, provider alternatives, tax presentation", async () => {
    await bot.handle(text("Fenixway 295/80R22.5 Valor 87 x4 para Transportes ABC, juan@abc.com dscto 10%"));
    const body = client.last()?.body ?? "";
    expect(body).toContain("*a)* 🏭 STOCK · stock 34 · Fenixway Valor 87 295/80R22.5 18PR");
    expect(body).toContain("*US$ 372.00* (lista US$ 413.33 −10%)");
    await bot.handle(text("con igv"));
    expect(client.last()?.body).toContain("con IGV");
    await bot.handle(text("ok"));
    const preview = client.last()?.body ?? "";
    expect(preview).toContain("(precios incluyen IGV 18%)");
    expect(preview).toContain("4 x US$ 438.96"); // 372.00 * 1.18
    expect(preview).toContain("Total: US$ 1,755.84"); // printed total = sum of displayed line totals
    await bot.handle(text("cancelar"));
  });

  it("RFQ email with several lines, including items nobody lists", async () => {
    const rfq = `Material Descripción UM Cantidad
5657944 LLANTA 12.5/80 X 18 - 12 PLY R4 UND 2
5583916 PARCHE PARA LLANTA RS-35 VIPAL UND 25
5554521 LLANTA TRACCION 12R22.5 MOD G377 UND 19
5600686 LLANTA 16.9R30 GOOD YEAR SUPER TRACTION UND 2
para Cartavio S.A.A., jose.rodriguezp@azucarperu.com`;
    await bot.handle(text(rfq));
    const body = client.last()?.body ?? "";
    expect(body).toContain("*1.* 12.5/80-18 R4 12PR x2");
    expect(body).toContain("*2.* PARCHE PARA LLANTA RS-35 VIPAL x25");
    expect(body).toContain("*3.* 12R22.5 G377 tracción/posterior x19");
    expect(body).toMatch(/\*1\.\*[\s\S]*🚚 (JCH|Steel)/);
    expect(body).toContain("*2.* PARCHE PARA LLANTA RS-35 VIPAL x25\n  ❌ sin precio");
    await bot.handle(text("quitar 2"));
    await bot.handle(text("quitar 4"));
    await bot.handle(text("ok"));
    const q = await store.getQuote((await store.listQuotes(1))[0].number);
    expect(q?.items.length).toBe(2);
    expect(q?.customer.company).toBe("Cartavio S.A.A.");
    await bot.handle(text("cancelar"));
  });
});
