import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ingestExcel } from "../ingest/tabular";
import { ingestPdf } from "../ingest/pdf";
import { resolveSourceOptions } from "../ingest/sources";
import type { PriceRow } from "../ingest/types";
import { formatQuoteNumber } from "../quote/build";
import type { EmailAttachment } from "../quote/email";
import { XLSX_MIME } from "../quote/files";
import type { Quote } from "../quote/types";
import { loadCustomerProfiles, SettingsSchema, type Settings } from "../settings";
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
    expect(doc?.fileName).toBe("COT-0001.pdf"); // named after the quote number
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
    await bot.handle(text("plazo de entrega: inmediata\npago: letras BCP 90 días")); // several fields at once; the last value wins
    expect(client.last()?.body).toContain("Entrega: inmediata");
    expect(client.last()?.body).toContain("Pago: letras BCP 90 días");
    await bot.handle(text("con igv"));
    expect(client.last()?.body).toContain("Total: US$ 2,265.60 (precios incluyen IGV 18%)"); // 1920 * 1.18

    await bot.handle(text("enviar"));
    expect(client.last()?.body).toContain("COT-0001");
    expect((await store.getQuote("COT-0001"))?.status).toBe("sent");
    expect(await store.getConversation(PHONE)).toBeNull();
  });

  it("photos: upload with caption, 'foto 1a' sends it, PDF gets an annex page; missing attention is flagged", async () => {
    process.env.PHOTOS_DISABLED = "1";
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    client.media.set("img1", { data: png, mimeType: "image/png" });
    await bot.handle({ id: "wamid.img1", from: PHONE, timestamp: "1", type: "image", forwarded: false, media: { id: "img1", mimeType: "image/png", caption: "foto Michelin XZE2+" } });
    expect(client.last()?.body).toContain("Guardé la foto de *Michelin XZE2+*");
    expect(await store.getPhoto("michelin", "xze2+")).not.toBeNull();

    await bot.handle(text("Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com"));
    await bot.handle(text("foto 1a"));
    const img = client.sent.filter((m) => m.kind === "image").pop();
    expect(img?.file?.equals(png)).toBe(true);
    expect(img?.caption).toContain("Michelin XZE2+");

    await bot.handle(text("ok"));
    const quote = await store.getQuote("COT-0001");
    expect(quote?.items[0].photoUrl?.startsWith("data:image/png;base64,")).toBe(true);
    expect(quote?.items[0].photoSource).toBe("WhatsApp");
    const doc = client.sent.find((m) => m.kind === "document");
    expect(doc?.caption).toContain("📷 Fotos: 1/1");
    expect(client.last()?.body).toContain("⚠️ Falta en el PDF: *atención: Sr. Pérez*");
    expect(client.last()?.body).toContain("Validez: 7 días");

    await bot.handle(text("atención: Sr. Juan Pérez"));
    expect(client.last()?.body).not.toContain("Falta en el PDF: *atención");
    await bot.handle(text("enviar"));

    // the photo is embedded under the items, on the same single page (rendered with photos enabled)
    delete process.env.PHOTOS_DISABLED;
    const { renderQuotePdf } = await import("../quote/pdf");
    const pdf = await renderQuotePdf((await store.getQuote("COT-0001"))!, settings);
    expect((pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(1); // one page: quote + photo strip
  });

  it("customer memory: contact, address and terms of the last quote are reused", async () => {
    process.env.PHOTOS_DISABLED = "1";
    await bot.handle(text("Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com\natención: Sra. Karen Ordoñez\ndirección: Av. Argentina 1500, Callao\npago: letras 60 días"));
    await bot.handle(text("ok"));
    await bot.handle(text("enviar"));

    await bot.handle(text("Michelin 11R22.5 XZE2+ x2, juan@abc.com"));
    const options = client.last()?.body ?? "";
    expect(options).toContain("📒 Datos de la última cotización a Transportes ABC");
    expect(options).toContain("atención Sra. Karen Ordoñez");
    await bot.handle(text("ok"));
    const q = await store.getQuote("COT-0002");
    expect(q?.customer.attention).toBe("Sra. Karen Ordoñez");
    expect(q?.customer.address).toBe("Av. Argentina 1500, Callao");
    expect(q?.paymentType).toBe("letras 60 días");
    expect(client.last()?.body).not.toContain("Falta en el PDF");
  });

  it("choosing option b with a bare number on a single line", async () => {
    await bot.handle(text("295/80R22.5 x2 cliente Pedro"));
    await bot.handle(text("2"));
    expect(client.last()?.body).toContain("¿A qué correo lo envío?");
    await bot.handle(text("pedro@mail.com"));
    expect(client.last()?.body).toContain("*Para:* pedro@mail.com");
  });

  it("two options of the same line with quantities, written the salesman's way", async () => {
    await bot.handle(text("295/80R22.5 x2 para Transportes ABC, juan@abc.com"));
    const options = client.last()?.body ?? "";
    expect(options).toMatch(/\*a\)\*[\s\S]*\*b\)\*/);
    await bot.handle(text("OPCION A X 2UNDS\nOPCION B X 8 UNDS"));
    expect(client.last()?.body).toContain("*Para:* juan@abc.com");
    const q = await store.getQuote("COT-0001");
    expect(q?.items.length).toBe(2);
    expect(q?.items.map((i) => i.quantity)).toEqual([2, 8]);
    expect(q?.items[0].description).not.toBe(q?.items[1].description);
  });

  it("APLICACIÓN and plate come from the salesman's words and can be changed per item", async () => {
    await bot.handle(text("295/80R22.5 18PR AHN-988 mixt del x4 para Transportes ABC, juan@abc.com"));
    expect(client.last()?.body).toContain("MIXT DEL placa AHN-988 x4");
    await bot.handle(text("aplicación 1 MIXTA"));
    expect(client.last()?.body).toContain("MIXTA placa AHN-988 x4");
    await bot.handle(text("ok"));
    let q = await store.getQuote("COT-0001");
    expect(q?.items[0].application).toBe("MIXTA");
    expect(q?.items[0].plate).toBe("AHN-988");
    await bot.handle(text("aplicación 1 POST ON/OFF"));
    q = await store.getQuote("COT-0001");
    expect(q?.items[0].application).toBe("POST ON/OFF");
    expect(client.last()?.body).toContain("*Para:* juan@abc.com");
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
    process.env.ADMIN_NUMBERS = PHONE; // a provider never loaded before: only an admin registers it
    try {
      await bot.handle(text("Hola, lista Aeolus: HN08 11R22.5 - 270 usd (stock 40), HN355 295/80R22.5 - 285 usd", true));
      expect(client.last()?.body).toContain("¿De qué proveedor es?");
      await bot.handle(text("proveedor nuevo: Importadora Norte"));
      expect(client.last()?.body).toContain("Guardé *2 precios* de *Importadora Norte*");
      await bot.handle(text("11R22.5 x1 para Z, z@z.com"));
      expect(client.last()?.body).toContain("*a)* 🚚 Importadora Norte · stock 40 · Aeolus HN08 11R22.5");
    } finally {
      delete process.env.ADMIN_NUMBERS;
    }
  });

  it("'proveedor: X' skips the question; a PDF document is ingested", async () => {
    process.env.ADMIN_NUMBERS = PHONE;
    try {
      await bot.handle(text("proveedor: Llantas del Sur\nTriangle TR668 11R22.5 a 305", true));
      expect(client.last()?.body).toContain("Guardé *1 precios* de *Llantas del Sur*");
      client.media.set("media-pdf", { data: fs.readFileSync(path.resolve(process.cwd(), "samples/proveedor-b-lista.pdf")), mimeType: "application/pdf", fileName: "lista.pdf" });
      await bot.handle({ id: "wamid.doc", from: PHONE, timestamp: "1", type: "document", forwarded: false, media: { id: "media-pdf", mimeType: "application/pdf", fileName: "lista.pdf" } });
      expect(client.last()?.body).toContain("¿De qué proveedor es?");
      await bot.handle(text("proveedor nuevo: Norte"));
      expect(client.last()?.body).toContain("Guardé *7 precios* de *Norte*");
    } finally {
      delete process.env.ADMIN_NUMBERS;
    }
  });

  it("info commands", async () => {
    await bot.handle(text("proveedores"));
    expect(client.last()?.body).toContain("Llantas del Sur (proveedor): 16 filas");
    await bot.handle(text("precios 11 r 22,5"));
    expect(client.last()?.body).toContain("*11R22.5*");
    expect(client.last()?.body).toContain("Double Coin RR680");
  });
});

describe("ingestion lock: known providers only, admins register and delete, quotes are not price lists", () => {
  const ADMIN = "18605180534";
  const priceMsg = "Hola, lista Aeolus: HN08 11R22.5 - 270 usd (stock 40), HN355 295/80R22.5 - 285 usd";
  let store: JsonStore;
  let client: FakeWhatsAppClient;
  let bot: BotHandler;
  const asAdmin = (m: InboundMessage): InboundMessage => ({ ...m, from: ADMIN });
  const providers = async () => (await store.providers()).map((p) => p.provider);

  beforeAll(() => {
    process.env.LLM_DISABLED = "1";
  });
  beforeEach(async () => {
    process.env.ADMIN_NUMBERS = ADMIN;
    store = JsonStore.memory();
    client = new FakeWhatsAppClient();
    bot = new BotHandler({ client, store, settings });
    const xls = await ingestExcel(fs.readFileSync(path.resolve(process.cwd(), "samples/proveedor-a-lista.xlsx")), { provider: "Llantas del Sur", sourceRef: "a.xlsx", priceDate: "2026-10-01" });
    await store.upsertRows(xls.rows);
  });
  afterEach(() => {
    delete process.env.ADMIN_NUMBERS;
  });

  it("an unknown name repeats the question and creates nothing; a known name or alias is accepted", async () => {
    await bot.handle(text(priceMsg, true));
    expect(client.last()?.body).toContain("¿De qué proveedor es?");
    await bot.handle(text("Importadora Norte"));
    const again = client.last()?.body ?? "";
    expect(again).toContain("No conozco ese proveedor. *¿De qué proveedor es?* Responde con uno de estos: Llantas del Sur, JCH, Steel, Protyres — o *cancelar*.");
    expect(await providers()).toEqual(["Llantas del Sur"]);
    expect((await store.getConversation(PHONE))?.step).toBe("need_provider");
    await bot.handle(text("j.ch. comercial")); // alias from config/providers.json, any case / punctuation
    expect(client.last()?.body).toContain("Guardé *2 precios* de *JCH*");
    expect(await providers()).toEqual(["Llantas del Sur", "JCH"]);
  });

  it("'proveedor nuevo: X' is refused to a non-admin and works for an admin; 'cancelar' drops the file", async () => {
    await bot.handle(text(priceMsg, true));
    await bot.handle(text("proveedor nuevo: Importadora Norte"));
    expect(client.last()?.body).toBe("Solo el administrador puede registrar proveedores nuevos. Responde con uno conocido (Llantas del Sur, JCH, Steel, Protyres) o *cancelar*.");
    expect(await providers()).toEqual(["Llantas del Sur"]);
    await bot.handle(text("cancelar"));
    expect(client.last()?.body).toContain("Cancelado");
    expect(await store.getConversation(PHONE)).toBeNull();

    await bot.handle(asAdmin(text(priceMsg, true)));
    expect(client.last()?.body).toContain("(o *proveedor nuevo: Nombre*)");
    await bot.handle(asAdmin(text("proveedor nuevo: Importadora Norte")));
    expect(client.last()?.body).toContain("Guardé *2 precios* de *Importadora Norte*");
    expect(await providers()).toEqual(["Llantas del Sur", "Importadora Norte"]);
  });

  it("'proveedor: X' with the list only works for a known X", async () => {
    await bot.handle(text(`proveedor: Importadora Norte\n${priceMsg}`, true));
    expect(client.last()?.body).toContain("No conozco el proveedor *Importadora Norte*");
    expect(await providers()).toEqual(["Llantas del Sur"]);
    await bot.handle(text(`proveedor: llantas del sur\n${priceMsg}`, true)); // a new list replaces the pending one
    expect(client.last()?.body).toContain("Guardé *2 precios* de *Llantas del Sur*");
    await bot.handle(text(`proveedor: J.CH. Precios de hoy\n${priceMsg}`, true)); // dots inside the name
    expect(client.last()?.body).toContain("Guardé *2 precios* de *JCH*");
  });

  it("a Prosegur-format Excel or one of our quotes is refused for ingestion", async () => {
    const pros = fs.readFileSync(path.resolve(process.cwd(), "samples/prosegur-451.xlsx"));
    const name = "151026-1830-AYACUCHO-PROFESSIONAL TYRES S.A.C.-451.xlsx";
    client.media.set("m-pros", { data: pros, mimeType: XLSX_MIME, fileName: name });
    await bot.handle({ id: "wamid.p1", from: PHONE, timestamp: "1", type: "document", forwarded: false, media: { id: "m-pros", mimeType: XLSX_MIME, fileName: name, caption: "proveedor: JCH" } });
    expect(client.last()?.body).toBe("Esto parece una cotización, no una lista de precios, así que no la cargo. Escríbeme el pedido como texto (llantas con cantidad, cliente, correo…)");
    expect(await store.getConversation(PHONE)).toBeNull();
    expect((await store.providers()).map((p) => [p.provider, p.rows])).toEqual([["Llantas del Sur", 16]]);

    client.media.set("m-own", { data: fs.readFileSync(path.resolve(process.cwd(), "samples/seller-451-reference.xlsx")), mimeType: XLSX_MIME, fileName: "COT 451.xlsx" });
    await bot.handle(asAdmin({ id: "wamid.p2", from: PHONE, timestamp: "1", type: "document", forwarded: false, media: { id: "m-own", mimeType: XLSX_MIME, fileName: "COT 451.xlsx", caption: "proveedor nuevo: Prosegur" } }));
    expect(client.last()?.body).toContain("Esto parece una cotización");
    expect(await providers()).toEqual(["Llantas del Sur"]);
  });

  it("'borrar proveedor' removes its rows, for admins only", async () => {
    await bot.handle(text("borrar proveedor Llantas del Sur"));
    expect(client.last()?.body).toBe("Solo el administrador puede borrar proveedores.");
    expect(await providers()).toEqual(["Llantas del Sur"]);
    await bot.handle(asAdmin(text("borrar proveedor llantas del sur")));
    expect(client.last()?.body).toBe("🗑️ Borré *16 filas* de *Llantas del Sur*.");
    expect(await providers()).toEqual([]);
    await bot.handle(asAdmin(text("borrar proveedor Nadie")));
    expect(client.last()?.body).toContain("No hay ninguna lista del proveedor *Nadie*");
  });
});

describe("Prosegur quotes: profile, numbering, Excel, stored files, history", () => {
  const FMT = "{MES} {YYYY} - {NNN}";
  const pSettings: Settings = SettingsSchema.parse({
    company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
    pricing: { currency: "USD", taxPct: 18, provider: { marginPct: 15, pricesIncludeTax: false }, stalePriceDays: 30 },
    quote: { numberFormat: FMT, counterStart: 16, validityDays: 7, paymentType: "Factura crédito", paymentTerm: "30 días", deliveryTerm: "48 hrs post OC" },
    salespeople: { default: PHONE, [PHONE]: { name: "Frank Melek Rodríguez Mirano", title: "Key Account Manager", phone: "955 344 340", email: "frank.rodriguez@360tyres.pe" } },
    customers: loadCustomerProfiles(),
  });
  let store: JsonStore;
  let client: FakeWhatsAppClient;
  let bot: BotHandler;
  const emails: { quote: Quote; attachments: EmailAttachment[] }[] = [];
  const docs = () => client.sent.filter((m) => m.kind === "document");
  const today = () => new Date().toISOString().slice(0, 10);
  const num = (n: number) => formatQuoteNumber(FMT, n, today());
  const ddmmyy = () => {
    const [y, m, d] = today().split("-");
    return `${d}${m}${y.slice(2)}`;
  };

  beforeAll(() => {
    process.env.LLM_DISABLED = "1";
    process.env.PHOTOS_DISABLED = "1";
  });

  beforeEach(async () => {
    store = JsonStore.memory();
    client = new FakeWhatsAppClient();
    emails.length = 0;
    bot = new BotHandler({ client, store, settings: pSettings, sendEmail: async (quote, attachments) => (emails.push({ quote, attachments }), { sent: true, id: "test" }) });
    const xls = await ingestExcel(fs.readFileSync(path.resolve(process.cwd(), "samples/proveedor-a-lista.xlsx")), { provider: "Llantas del Sur", sourceRef: "a.xlsx", priceDate: today() });
    await store.upsertRows(xls.rows);
  });

  it("asks for unidad/ub/solicitante, 'número 451', PDF + Excel, enviar with both files, stored, reenviar, cotizaciones; next is 452", async () => {
    await bot.handle(text("prosegur\nMichelin 295/80R22.5 X Multi Z x2\nBridgestone 11R22.5 R268 x4\ncorreo flota@prosegur.com.pe"));
    let body = client.last()?.body ?? "";
    expect(body).toContain("PROSEGUR SA · flota@prosegur.com.pe · sin IGV · pago: FACTURA · plazo: 30 días · entrega: 48 HRS POST OC · validez 7 días");
    expect(body).toContain("Para el formato de Prosegur me falta:");
    expect(body).toMatch(/\*unidad:\*[\s\S]*\*ub:\*[\s\S]*\*solicitante:\*/);
    expect((await store.getConversation(PHONE))?.step).toBe("need_fields");

    await bot.handle(text("unidad: Ayacucho\nub: 1830\nsolicitante: Johann Castañeda"));
    body = client.last()?.body ?? "";
    expect(body).toContain("unidad Ayacucho · UB 1830 · solicitante Johann Castañeda");
    expect(body).toContain("*1.* Michelin 295/80R22.5 X MULTI Z x2");
    expect(body).toContain("*a)* 🚚 Llantas del Sur");
    expect((await store.getConversation(PHONE))?.step).toBe("choose");

    await bot.handle(text("número 451"));
    expect(client.last()?.body).toContain(`Esta cotización será la *${num(451)}*`);

    await bot.handle(text("ok"));
    const [pdfDoc, xlsDoc] = docs();
    expect(pdfDoc.fileName).toBe(`${num(451)}.pdf`); // "OCTUBRE 2026 - 451.pdf"
    expect(xlsDoc.fileName).toBe(`${ddmmyy()}-1830-AYACUCHO-PROFESSIONAL TYRES S.A.C.-451.xlsx`);
    expect(xlsDoc.caption).toBe(`Formato Prosegur · ${xlsDoc.fileName}`);
    expect(xlsDoc.mimeType).toBe(XLSX_MIME);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsDoc.file as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect([ws.getCell("G5").value, ws.getCell("G6").value, ws.getCell("K5").value, ws.getCell("C19").value, ws.getCell("G20").value]).toEqual([451, "AYACUCHO", "JOHANN CASTAÑEDA", 1830, 4]);
    expect(String(ws.getCell("F19").value)).toMatch(/^295\/80R22\.5 .*MICHELIN X MULTI Z$/);
    // Prosegur's review is the short one (contract addendum §4): head, items, total + number + email, commands
    const preview = client.last()?.body ?? "";
    expect(preview.split("\n").length).toBeLessThanOrEqual(6);
    expect(preview).toContain("Prosegur · Ayacucho · UB 1830 · solicitante Johann Castañeda\n1. 295/80R22.5");
    expect(preview).toContain(`sin IGV · ${num(451)} · correo: flota@prosegur.com.pe`);
    expect(preview).toContain("Responde *enviar*, o corrige: *precio 2 130*, *cantidad 1 3*, *aplicación 2 MIXT*, *atención: …*, *número 452*, *cancelar*");
    const q = await store.getQuote(num(451));
    expect(q).toMatchObject({ customerProfile: "prosegur", unit: "Ayacucho", ub: "1830", requester: "Johann Castañeda", paymentType: "FACTURA", paymentTerm: "30 días", deliveryTerm: "48 HRS POST OC", pricesIncludeTax: false, requestedBy: PHONE });
    expect(q?.customer.company).toBe("PROSEGUR SA");

    await bot.handle(text("enviar"));
    expect(client.last()?.body).toContain(`Enviado ✔ Cotización ${num(451)} a flota@prosegur.com.pe (PDF + Excel)`);
    expect(emails.map((e) => e.attachments.map((a) => a.filename))).toEqual([[pdfDoc.fileName, xlsDoc.fileName]]);
    expect(emails[0].quote.emailDraft?.body).toContain("en PDF y en su formato Excel de cotización de proveedores");
    expect(emails[0].quote.emailDraft?.body).toMatch(/^Estimado\/a Johann Castañeda,/); // no "atención:": the requester
    const stored = await store.getQuoteFiles(num(451));
    expect(stored.map((f) => [f.kind, f.fileName])).toEqual([
      ["pdf", pdfDoc.fileName],
      ["xlsx", xlsDoc.fileName],
    ]);
    expect(Buffer.from(stored[1].data, "base64").equals(emails[0].attachments[1].content)).toBe(true); // exactly what was sent

    const before = docs().length;
    await bot.handle(text("reenviar 451"));
    const resent = docs().slice(before);
    expect(resent.map((d) => d.fileName)).toEqual([pdfDoc.fileName, xlsDoc.fileName]);
    expect(resent[0].file?.equals(Buffer.from(stored[0].data, "base64"))).toBe(true);
    await bot.handle(text(`pdf ${num(451)}`)); // the full number works too
    expect(docs().length).toBe(before + 4);

    await bot.handle(text("cotizaciones Prosegur"));
    body = client.last()?.body ?? "";
    expect(body).toContain("*Últimas cotizaciones de Prosegur:*");
    expect(body).toContain(`• *${num(451)}* · ${today().split("-").reverse().join("/")} · US$`);
    expect(body).toContain("enviada · 2 ítems");
    await bot.handle(text("cotizaciones"));
    expect(client.last()?.body).toContain(`*${num(451)}*`);
    expect(client.last()?.body).toContain("PROSEGUR SA");

    // the same salesman's next quote is 452; unidad / UB / solicitante / correo come from the last Prosegur quote
    await bot.handle(text("prosegur\nMichelin 295/80R22.5 X Multi Z x1"));
    body = client.last()?.body ?? "";
    expect(body).toContain("📒 Datos de la última cotización a PROSEGUR SA");
    expect(body).toContain("unidad Ayacucho · UB 1830 · solicitante Johann Castañeda");
    await bot.handle(text("ok"));
    expect(docs().slice(-2).map((d) => d.fileName)).toEqual([`${num(452)}.pdf`, `${ddmmyy()}-1830-AYACUCHO-PROFESSIONAL TYRES S.A.C.-452.xlsx`]);
  });

  it("a bare 'prosegur' gets a three-line guide and makes the next request Prosegur's", async () => {
    await bot.handle(text("Prosegur"));
    const guide = client.last()?.body ?? "";
    expect(guide.split("\n").length).toBe(3);
    for (const s of ["*prosegur ayacucho 1830*", "*2 v99*", "v99, v89, f77", "*enviar*"]) expect(guide).toContain(s);
    await bot.handle(text("Michelin 295/80R22.5 X Multi Z x2 UB 1830\nunidad: Cusco\nsolicitante: Ana Torres\ncorreo ana@prosegur.pe"));
    expect(client.last()?.body).toContain("PROSEGUR SA · ana@prosegur.pe");
    expect(client.last()?.body).toContain("Michelin 295/80R22.5 X MULTI Z UB 1830 x2");
    expect(await store.getConversation(PHONE)).toMatchObject({ step: "choose", profile: "prosegur" });
  });

  it("'para Prosegur' in an ordinary request; what the salesman writes wins over the profile's defaults", async () => {
    await bot.handle(text("Michelin 295/80R22.5 X Multi Z x2 UB 1830 para Prosegur, ana@prosegur.pe\nunidad: Lima\nsolicitante: Ana\npago: contado"));
    const body = client.last()?.body ?? "";
    expect(body).toContain("PROSEGUR SA · ana@prosegur.pe · sin IGV · pago: contado · plazo: 30 días");
    expect((await store.getConversation(PHONE))?.profile).toBe("prosegur");
    // an ordinary customer stays an ordinary quote (no Excel)
    await bot.handle(text("Michelin 295/80R22.5 X Multi Z x2 para Transportes ABC, juan@abc.com"));
    expect((await store.getConversation(PHONE))?.profile).toBeUndefined();
    await bot.handle(text("ok"));
    expect(docs().map((d) => d.fileName)).toEqual([`${num(16)}.pdf`]);
  });

  it("renumbering a presented draft keeps the store consistent; 'archivo:' and 'nombre:' set names", async () => {
    await bot.handle(text("prosegur\nMichelin 295/80R22.5 X Multi Z x2 UB 1830\nunidad: Ayacucho\nsolicitante: Johann\ncorreo a@prosegur.pe"));
    await bot.handle(text("ok"));
    expect((await store.listQuotes(1))[0].number).toBe(num(16)); // counterStart: no counter yet
    await bot.handle(text("número 460"));
    expect(await store.getQuote(num(16))).toBeNull(); // the old draft is gone
    expect((await store.getQuote(num(460)))?.status).toBe("draft");
    expect((await store.getConversation(PHONE))?.quoteNumber).toBe(num(460));
    expect(docs().slice(-2).map((d) => d.fileName)).toEqual([`${num(460)}.pdf`, `${ddmmyy()}-1830-AYACUCHO-PROFESSIONAL TYRES S.A.C.-460.xlsx`]);

    await bot.handle(text("archivo: Cotización Prosegur Ayacucho"));
    expect(docs().slice(-2).map((d) => d.fileName)).toEqual(["Cotización Prosegur Ayacucho.pdf", `${ddmmyy()}-1830-AYACUCHO-PROFESSIONAL TYRES S.A.C.-460.xlsx`]);
    await bot.handle(text("archivo excel: Formato Ayacucho"));
    expect(docs().slice(-1)[0].fileName).toBe("Formato Ayacucho.xlsx");
    await bot.handle(text("nombre: PROSEGUR AYACUCHO 77"));
    expect(await store.getQuote(num(460))).toBeNull();
    expect((await store.getQuote("PROSEGUR AYACUCHO 77"))?.files).toEqual({ pdfName: "Cotización Prosegur Ayacucho", xlsxName: "Formato Ayacucho" });
    await bot.handle(text("enviar"));
    expect(emails[0].attachments.map((a) => a.filename)).toEqual(["Cotización Prosegur Ayacucho.pdf", "Formato Ayacucho.xlsx"]);

    // "nombre:" did not move the counter: the next quote is 461
    await bot.handle(text("prosegur\nMichelin 295/80R22.5 X Multi Z x1 UB 1830"));
    await bot.handle(text("ok"));
    expect((await store.listQuotes(1))[0].number).toBe(num(461));
  });

  it("a number already used asks for confirmation before replacing it", async () => {
    await bot.handle(text("prosegur\nMichelin 295/80R22.5 X Multi Z x2 UB 1830\nunidad: Ayacucho\nsolicitante: Johann\ncorreo a@prosegur.pe\nnúmero 451"));
    await bot.handle(text("ok"));
    await bot.handle(text("enviar"));
    expect((await store.getQuote(num(451)))?.status).toBe("sent");
    expect((await store.getQuoteFiles(num(451))).length).toBe(2);

    await bot.handle(text("prosegur\nBridgestone 11R22.5 R268 x4 UB 1830"));
    await bot.handle(text("número 451"));
    expect(client.last()?.body).toContain(`Ya existe la cotización *${num(451)}* (enviada, PROSEGUR SA`);
    expect(client.last()?.body).toContain("*número 451 confirmar*");
    await bot.handle(text("ok"));
    expect(client.last()?.body).toContain("Ya existe la cotización");
    await bot.handle(text("número 451 confirmar")); // "ok" was already given: builds it
    const q = await store.getQuote(num(451));
    expect(q?.items[0].brand).toBe("Bridgestone");
    expect(q?.status).toBe("draft");
    expect(await store.getQuoteFiles(num(451))).toEqual([]); // the replaced quote's files are gone
  });

  it("more than 11 items cannot go in Prosegur's format", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `Michelin 295/80R22.5 X Multi Z x1 UB ${1001 + i}`).join("\n");
    await bot.handle(text(`prosegur\n${lines}\nunidad: Ayacucho\nsolicitante: Johann\ncorreo a@prosegur.pe`));
    await bot.handle(text("ok"));
    expect(client.last()?.body).toContain("El formato de Prosegur tiene 11 filas de ítems y esta cotización tiene 12");
    expect(docs()).toEqual([]);
    expect((await store.getConversation(PHONE))?.step).toBe("choose");
  });

  // ---------- contract prices + shorthand (docs/spec-prosegur-contrato.md) ----------

  const sheet = async (file: Buffer) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file as unknown as ArrayBuffer);
    return wb.worksheets[0];
  };

  it("contract: 'prosegur ayacucho 1830 / 2 v99 / 4 v89' gives PDF + Excel at once; enviar; the unit's next quote needs nothing more", async () => {
    // the unit's first quote: the solicitante is asked once (a bare name is enough), then the email
    await bot.handle(text("prosegur ayacucho 1830\n2 v99\n4 v89"));
    expect(client.last()?.body).toBe(
      [
        "Prosegur · Ayacucho · UB 1830",
        "1. 215/75R17.5 18PR Fenixway Valor 99 MIXT x2 · US$ 123.17",
        "2. 215/75R17.5 18PR Fenixway Valor 89 POST x4 · US$ 126.42",
        "Para el formato de Prosegur me falta:",
        "• *solicitante:* nombre de quien pide la cotización",
        "Envíamelos (uno por línea) o responde *ok* para seguir sin ellos.",
      ].join("\n"),
    );
    await bot.handle(text("Johann Castañeda"));
    expect(docs().length).toBe(2); // no options: straight to the documents
    expect(client.last()?.body).toContain("¿A qué correo lo envío?");
    await bot.handle(text("compras@prosegur.com"));
    await bot.handle(text("enviar"));
    expect(emails.length).toBe(1);

    // the three messages
    let before = client.sent.length;
    await bot.handle(text("prosegur ayacucho 1830\n2 v99\n4 v89"));
    const replies = client.sent.slice(before);
    expect(replies.map((m) => m.kind)).toEqual(["document", "document", "text"]);
    expect(replies.map((m) => m.fileName ?? "")).toEqual([`${num(17)}.pdf`, `${ddmmyy()}-1830-AYACUCHO-PROFESSIONAL TYRES S.A.C.-17.xlsx`, ""]);
    expect(replies[2].body).toBe(
      [
        "Prosegur · Ayacucho · UB 1830 · solicitante Johann Castañeda",
        "1. 215/75R17.5 18PR Fenixway Valor 99 MIXT x2 · US$ 123.17",
        "2. 215/75R17.5 18PR Fenixway Valor 89 POST x4 · US$ 126.42",
        `Total US$ 752.02 sin IGV · ${num(17)} · correo: compras@prosegur.com`,
        "Responde *enviar*, o corrige: *precio 2 130*, *cantidad 1 3*, *aplicación 2 MIXT*, *atención: …*, *número 18*, *cancelar*",
      ].join("\n"),
    );
    const ws = await sheet(replies[1].file!);
    expect(["C19", "F19", "G19", "K19", "F20", "G20", "K20", "G6", "K5"].map((a) => ws.getCell(a).value)).toEqual([1830, "215/75R17.5 18PR FENIXWAY VALOR 99", 2, 123.17, "215/75R17.5 18PR FENIXWAY VALOR 89", 4, 126.42, "AYACUCHO", "JOHANN CASTAÑEDA"]);
    const q = await store.getQuote(num(17));
    expect(q?.items.map((i) => [i.origin, i.provider, i.code, i.unitPrice, i.listPrice, i.discountPct, i.application, i.description])).toEqual([
      ["contract", "contrato", "v99", 123.17, 123.17, 0, "MIXT", "215/75R17.5 18PR FENIXWAY VALOR 99"],
      ["contract", "contrato", "v89", 126.42, 126.42, 0, "POST", "215/75R17.5 18PR FENIXWAY VALOR 89"],
    ]);
    expect(q).toMatchObject({ unit: "Ayacucho", ub: "1830", requester: "Johann Castañeda", customer: { company: "PROSEGUR SA", email: "compras@prosegur.com", attention: "Johann Castañeda", address: "Ayacucho" } }); // dirección = unidad when none was given
    await bot.handle(text("enviar"));
    expect(client.last()?.body).toBe(`Enviado ✔ Cotización ${num(17)} a compras@prosegur.com (PDF + Excel).`);
    expect(emails[1].attachments.map((a) => a.filename)).toEqual([`${num(17)}.pdf`, `${ddmmyy()}-1830-AYACUCHO-PROFESSIONAL TYRES S.A.C.-17.xlsx`]);
    expect((await store.getQuoteFiles(num(17))).map((f) => f.kind)).toEqual(["pdf", "xlsx"]);

    // the salesman's counter continues
    before = client.sent.length;
    await bot.handle(text("prosegur ayacucho 1830, 1 v99"));
    expect(client.sent.slice(before).map((m) => m.fileName)).toEqual([`${num(18)}.pdf`, `${ddmmyy()}-1830-AYACUCHO-PROFESSIONAL TYRES S.A.C.-18.xlsx`, undefined]);
  });

  it("contract: solicitante and atención come from the last quote of the same unit; a new unit is asked once", async () => {
    await bot.handle(text("prosegur ayacucho 1830\n2 v99\nsolicitante: Johann Castañeda\ncorreo compras@prosegur.com"));
    await bot.handle(text("enviar"));
    await bot.handle(text("prosegur cusco 1900\n2 v99\nsolicitante: Ana Torres\natención: Sra. Ana Torres")); // the email comes from the customer's last quote
    expect(client.last()?.body).toContain("Prosegur · Cusco · UB 1900 · solicitante Ana Torres\n");
    await bot.handle(text("enviar"));
    expect(emails.map((e) => [e.quote.unit, e.quote.requester, e.quote.customer.attention, e.quote.customer.email])).toEqual([
      ["Ayacucho", "Johann Castañeda", "Johann Castañeda", "compras@prosegur.com"],
      ["Cusco", "Ana Torres", "Sra. Ana Torres", "compras@prosegur.com"],
    ]);

    await bot.handle(text("prosegur ayacucho 1830\n4 v89"));
    expect(client.last()?.body).toContain("Prosegur · Ayacucho · UB 1830 · solicitante Johann Castañeda\n");
    expect((await store.listQuotes(1))[0].customer.attention).toBe("Johann Castañeda");
    await bot.handle(text("prosegur cusco 1900\n4 v89"));
    expect(client.last()?.body).toContain("Prosegur · Cusco · UB 1900 · solicitante Ana Torres\n");
    expect((await store.listQuotes(1))[0].customer.attention).toBe("Sra. Ana Torres");
    await bot.handle(text("prosegur arequipa 2100\n1 v99")); // never quoted: asked
    expect(client.last()?.body).toContain("Prosegur · Arequipa · UB 2100\n1. 215/75R17.5 18PR Fenixway Valor 99 MIXT x1 · US$ 123.17\nPara el formato de Prosegur me falta:\n• *solicitante:*");
    await bot.handle(text("solicitante: Luis Quispe"));
    expect(client.last()?.body).toContain("Prosegur · Arequipa · UB 2100 · solicitante Luis Quispe\n");
    // another requester at Cusco: the attention goes with him, not with the previous requester
    await bot.handle(text("prosegur cusco 1900\n1 v99\nsolicitante: Pedro Ruiz"));
    expect((await store.listQuotes(1))[0]).toMatchObject({ unit: "Cusco", requester: "Pedro Ruiz", customer: { attention: "Pedro Ruiz" } });
  });

  it("contract: an item without APLICACIÓN (f77) is asked once; the answer is saved and not asked again", async () => {
    await bot.handle(text("prosegur ayacucho 1830\n2 f77\nsolicitante: Johann\ncorreo compras@prosegur.com"));
    expect(client.last()?.body).toBe("¿Qué aplicación lleva la Flama 77? (MIXT, POST, DEL…)");
    expect(docs()).toEqual([]);
    expect((await store.getConversation(PHONE))?.step).toBe("need_application");
    await bot.handle(text("precio 1 130")); // not an answer: asked again
    expect(client.last()?.body).toBe("¿Qué aplicación lleva la Flama 77? (MIXT, POST, DEL…) — o *ok* para seguir sin ella.");
    await bot.handle(text("post"));
    expect(client.texts()).toContain("✅ Flama 77: aplicación *POST*, guardada para las próximas cotizaciones.");
    expect(docs().length).toBe(2);
    expect(client.last()?.body).toContain("1. 215/75R17.5 18PR Fenixway Flama 77 POST x2 · US$ 116.34");
    // only what was learnt is stored: the price, model… keep following config/customers.json
    expect((await store.getContractItems("prosegur")).find((i) => i.id === "f77")).toEqual({ id: "f77", application: "POST", updatedBy: PHONE, updatedAt: expect.any(String) });
    await bot.handle(text("aplicación 1 MIXT")); // per quote, as always (the contract keeps POST)
    expect(client.last()?.body).toContain("Flama 77 MIXT x2");
    await bot.handle(text("enviar"));

    const before = client.sent.length;
    await bot.handle(text("prosegur ayacucho 1830\n1 f77"));
    expect(client.sent.slice(before).map((m) => m.kind)).toEqual(["document", "document", "text"]); // not asked again
    expect(client.last()?.body).toContain("Flama 77 POST x1");
  });

  it("contract: 'contrato prosegur' lists the items; only an admin changes them, for the next quotes", async () => {
    const ADMIN = "18605180534";
    const admin = (body: string): InboundMessage => ({ ...text(body), from: ADMIN });
    process.env.ADMIN_NUMBERS = ADMIN;
    try {
      await bot.handle(text("contrato prosegur"));
      expect(client.last()?.body).toBe(
        [
          "*Contrato Prosegur 2 años · precios sin IGV*",
          "v99 · Fenixway Valor 99 · 215/75R17.5 18PR · MIXT · US$ 123.17",
          "v89 · Fenixway Valor 89 · 215/75R17.5 18PR · POST · US$ 126.42",
          "f77 · Fenixway Flama 77 · 215/75R17.5 18PR · sin aplicación · US$ 116.34",
          "kl71 · Marshal KL71 · 215/75R15 8PR · sin aplicación · US$ 149.81",
        ].join("\n"),
      );
      await bot.handle(text("contrato prosegur v99 125.50"));
      expect(client.last()?.body).toBe("Solo el administrador cambia los precios de contrato.");
      await bot.handle(text("contrato prosegur nuevo: f66 = Fenixway Flama 66 215/75R17.5 18PR POST 118.00"));
      expect(client.last()?.body).toBe("Solo el administrador cambia los precios de contrato.");
      expect(await store.getContractItems("prosegur")).toEqual([]);

      await bot.handle(admin("contrato prosegur"));
      expect(client.last()?.body).toContain("\nCambiar: *contrato prosegur v99 125.50* · *contrato prosegur f77 aplicación POST*");
      await bot.handle(admin("contrato prosegur v99 125,50"));
      expect(client.last()?.body).toBe("✅ v99 · Fenixway Valor 99 · 215/75R17.5 18PR · MIXT · US$ 125.50 (antes US$ 123.17). Vale para las próximas cotizaciones.");
      await bot.handle(admin("contrato prosegur f77 aplicación POST"));
      expect(client.last()?.body).toBe("✅ f77 · Fenixway Flama 77 · 215/75R17.5 18PR · POST · US$ 116.34");
      await bot.handle(admin("contrato prosegur nuevo: f66 = Fenixway Flama 66 215/75R17.5 18PR POST 118.00"));
      expect(client.last()?.body).toBe("✅ Agregué en el contrato de Prosegur: f66 · Fenixway Flama 66 · 215/75R17.5 18PR · POST · US$ 118.00");
      await bot.handle(admin("contrato prosegur v100 99"));
      expect(client.last()?.body).toBe("No hay ningún ítem *v100* en el contrato de Prosegur (ítems: v99, v89, f77, kl71, f66).");

      // the next quote uses them (the salesman is not an admin)
      await bot.handle(text("prosegur ayacucho 1830\n2 v99\n1 flama 66\n1 f77\nsolicitante: Johann\ncorreo compras@prosegur.com"));
      let body = client.last()?.body ?? "";
      expect(body).toContain("1. 215/75R17.5 18PR Fenixway Valor 99 MIXT x2 · US$ 125.50\n2. 215/75R17.5 18PR Fenixway Flama 66 POST x1 · US$ 118.00\n3. 215/75R17.5 18PR Fenixway Flama 77 POST x1 · US$ 116.34");
      // the commands do not disturb the quote in progress
      await bot.handle(text("contrato prosegur"));
      expect(client.last()?.body).toContain("v99 · Fenixway Valor 99 · 215/75R17.5 18PR · MIXT · US$ 125.50\n");
      await bot.handle(text("enviar"));
      expect(client.last()?.body).toContain("Enviado ✔");
      expect(emails[0].quote.items.map((i) => i.unitPrice)).toEqual([125.5, 118, 116.34]);

      await bot.handle(admin("contrato prosegur borrar f66"));
      expect(client.last()?.body).toBe("🗑️ Quité *f66* del contrato de Prosegur.");
      await bot.handle(admin("contrato prosegur borrar v99"));
      expect(client.last()?.body).toBe("↩️ *v99* vuelve a lo de config/customers.json: v99 · Fenixway Valor 99 · 215/75R17.5 18PR · MIXT · US$ 123.17");
      await bot.handle(text("contrato prosegur"));
      body = client.last()?.body ?? "";
      expect(body).toContain("v99 · Fenixway Valor 99 · 215/75R17.5 18PR · MIXT · US$ 123.17");
      expect(body).toContain("f77 · Fenixway Flama 77 · 215/75R17.5 18PR · POST · US$ 116.34");
      expect(body).not.toContain("f66");
    } finally {
      delete process.env.ADMIN_NUMBERS;
    }
  });

  it("contract: in a mixed request only the other lines have options; contract lines are pre-chosen (📑 contrato)", async () => {
    await bot.handle(text("prosegur ayacucho 1830\n2 v99\nMichelin 295/80R22.5 X Multi Z x2\nsolicitante: Johann\ncorreo compras@prosegur.com"));
    expect(client.last()?.body).toContain("*1.* Fenixway 215/75R17.5 Valor 99 18PR MIXT x2\n  📑 contrato · US$ 123.17\n\n*2.* Michelin 295/80R22.5 X MULTI Z x2 → elegido *a*\n  *a)* 🚚 Llantas del Sur");
    expect(client.last()?.body).not.toContain("sin precio en las listas");
    expect((await store.getConversation(PHONE))?.step).toBe("choose");
    await bot.handle(text("1b"));
    expect(client.last()?.body).toBe("El ítem 1 no tiene opción *b*.");
    await bot.handle(text("precio 1 130"));
    expect(client.last()?.body).toContain("📑 contrato · precio manual US$ 130.00");
    await bot.handle(text("ok"));
    expect((await store.getQuote(num(16)))?.items.map((i) => [i.origin, i.unitPrice, i.quantity])).toEqual([
      ["contract", 130, 2],
      ["provider", 471.5, 2],
    ]);
  });

  it("contract: 'precio 2 130', 'cantidad 1 3', 'quitar 2' on the presented quote; a UB per line", async () => {
    await bot.handle(text("prosegur ayacucho ub 1830\nv99 x2\nv89 x4 ub 1845\nsolicitante: Johann\ncorreo compras@prosegur.com"));
    expect(client.last()?.body).toContain("2. 215/75R17.5 18PR Fenixway Valor 89 POST UB 1845 x4 · US$ 126.42");
    const ws = await sheet(docs()[1].file!);
    expect([ws.getCell("C19").value, ws.getCell("C20").value]).toEqual([1830, 1845]);
    await bot.handle(text("precio 2 130"));
    expect((await store.getQuote(num(16)))?.items[1]).toMatchObject({ unitPrice: 130, listPrice: 126.42, discountPct: 0, total: 520, origin: "contract" });
    await bot.handle(text("cantidad 1 3"));
    expect((await store.getQuote(num(16)))?.items[0]).toMatchObject({ quantity: 3, total: 369.51 });
    expect(client.last()?.body).toContain(`Total US$ 889.51 sin IGV · ${num(16)}`);
    await bot.handle(text("cantidad 5 3"));
    expect(client.last()?.body).toBe("No existe el ítem 5; hay 2.");
    await bot.handle(text("quitar 2"));
    expect((await store.getQuote(num(16)))?.items.map((i) => i.code)).toEqual(["v99"]);
    expect(client.last()?.body).toContain(`Total US$ 369.51 sin IGV · ${num(16)}`);
  });

  it("contract: 'prosegur ayacucho 1830' alone keeps its unit and UB for the next message", async () => {
    await bot.handle(text("prosegur ayacucho 1830"));
    expect(client.last()?.body).toBe("Prosegur · Ayacucho · UB 1830\nAhora las llantas, una por línea: *2 v99*, *4 v89*");
    expect(await store.getConversation(PHONE)).toMatchObject({ step: "idle", profile: "prosegur", requestText: "unidad: Ayacucho\nub: 1830" });
    await bot.handle(text("2 v99\nsolicitante: Johann\ncorreo compras@prosegur.com"));
    expect(docs().length).toBe(2);
    expect(await store.getQuote(num(16))).toMatchObject({ unit: "Ayacucho", ub: "1830", customerProfile: "prosegur" });
  });

  it("contract: the items as messages of their own ('2 v99', then '4 v89') end up in the same quote", async () => {
    await bot.handle(text("prosegur ayacucho 1830\n1 v99\nsolicitante: Johann Castañeda\ncorreo compras@prosegur.com"));
    await bot.handle(text("enviar"));
    // codes alone with no customer yet: how to start (the unit is not guessed)
    await bot.handle(text("2 v99"));
    expect(client.last()?.body).toBe("¿Es para Prosegur? Escribe primero el cliente y la unidad, p.ej. *prosegur ayacucho 1830*, y debajo las llantas (*2 v99*).");
    expect(docs().length).toBe(2);
    // a unit the bot knows: the quote comes with the first item, the next ones are added to it
    await bot.handle(text("prosegur ayacucho 1830"));
    await bot.handle(text("2 v99"));
    const files17 = [`${num(17)}.pdf`, `${ddmmyy()}-1830-AYACUCHO-PROFESSIONAL TYRES S.A.C.-17.xlsx`];
    expect(docs().slice(-2).map((d) => d.fileName)).toEqual(files17);
    await bot.handle(text("4 v89"));
    expect(docs().length).toBe(6);
    expect(docs().slice(-2).map((d) => d.fileName)).toEqual(files17); // the same quote, presented again
    expect(client.last()?.body).toContain(`1. 215/75R17.5 18PR Fenixway Valor 99 MIXT x2 · US$ 123.17\n2. 215/75R17.5 18PR Fenixway Valor 89 POST x4 · US$ 126.42\nTotal US$ 752.02 sin IGV · ${num(17)} · correo: compras@prosegur.com`);
    await bot.handle(text("v99 x1")); // the same item again: one more of it
    await bot.handle(text("enviar"));
    expect(emails[1].quote.items.map((i) => [i.code, i.quantity, i.total])).toEqual([
      ["v99", 3, 369.51],
      ["v89", 4, 505.68],
    ]);
    expect(emails[1].attachments.map((a) => a.filename)).toEqual(files17);

    // a unit quoted for the first time: the items wait with the question for its solicitante
    await bot.handle(text("prosegur arequipa 2100"));
    await bot.handle(text("2 v99"));
    await bot.handle(text("4 v89"));
    expect(client.last()?.body).toBe(
      [
        "Prosegur · Arequipa · UB 2100",
        "1. 215/75R17.5 18PR Fenixway Valor 99 MIXT x2 · US$ 123.17",
        "2. 215/75R17.5 18PR Fenixway Valor 89 POST x4 · US$ 126.42",
        "Para el formato de Prosegur me falta:",
        "• *solicitante:* nombre de quien pide la cotización",
        "Envíamelos (uno por línea) o responde *ok* para seguir sin ellos.",
      ].join("\n"),
    );
    await bot.handle(text("Luis Quispe"));
    expect(client.last()?.body).toContain(`Prosegur · Arequipa · UB 2100 · solicitante Luis Quispe\n1. 215/75R17.5 18PR Fenixway Valor 99 MIXT x2 · US$ 123.17\n2. 215/75R17.5 18PR Fenixway Valor 89 POST x4 · US$ 126.42\nTotal US$ 752.02 sin IGV · ${num(18)} · correo: compras@prosegur.com`);
  });

  it("contract: items sent while the bot asks for an APLICACIÓN join the quote; the question stands", async () => {
    // while building: the request gets the new line, the question comes again; "ok" goes on without it
    await bot.handle(text("prosegur ayacucho 1830\n2 f77\nsolicitante: Johann\ncorreo compras@prosegur.com"));
    await bot.handle(text("4 v89"));
    expect(client.last()?.body).toBe("¿Qué aplicación lleva la Flama 77? (MIXT, POST, DEL…)");
    expect(docs()).toEqual([]);
    await bot.handle(text("ok"));
    expect(client.last()?.body).toContain("1. 215/75R17.5 18PR Fenixway Flama 77 x2 · US$ 116.34\n2. 215/75R17.5 18PR Fenixway Valor 89 POST x4 · US$ 126.42\n");
    expect(await store.getContractItems("prosegur")).toEqual([]); // "ok" saves nothing

    // on the quote presented: "1 f77" is asked about first, "1 v99" meanwhile waits with it; then both go in
    await bot.handle(text("1 f77"));
    expect(client.last()?.body).toBe("¿Qué aplicación lleva la Flama 77? (MIXT, POST, DEL…)");
    await bot.handle(text("1 v99"));
    expect(client.last()?.body).toBe("¿Qué aplicación lleva la Flama 77? (MIXT, POST, DEL…)");
    expect(docs().length).toBe(2);
    await bot.handle(text("mixt"));
    expect(client.texts()).toContain("✅ Flama 77: aplicación *MIXT*, guardada para las próximas cotizaciones.");
    expect(docs().length).toBe(4);
    expect(client.last()?.body).toContain(`1. 215/75R17.5 18PR Fenixway Flama 77 MIXT x3 · US$ 116.34\n2. 215/75R17.5 18PR Fenixway Valor 89 POST x4 · US$ 126.42\n3. 215/75R17.5 18PR Fenixway Valor 99 MIXT x1 · US$ 123.17\nTotal US$ 977.87 sin IGV · ${num(16)}`);
    // a bare position word is an answer or nothing, never an item: "post" on the presented quote changes nothing
    await bot.handle(text("post"));
    expect((await store.getQuote(num(16)))?.items.length).toBe(3);
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
    expect(body).toContain("*3.* 12R22.5 G377 TRACCION x19");
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
