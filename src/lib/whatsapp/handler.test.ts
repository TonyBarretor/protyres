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
import { BotHandler, parseBareItemCommand, parsePicks } from "./handler";
import { historyLine, limaTime } from "./logging-client";
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
    expect(doc?.fileName).toBe("Cotizacion 26 - 0001.pdf"); // named after the quote number
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

  it("per-quote 'margen 10%' prices provider options; 'margen 12' while choosing re-prices; 'atención a:' is read", async () => {
    const falken: PriceRow = { id: "falken-29580r225", provider: "Llantas del Sur", kind: "provider", description: "295/80R22.5 FALKEN", brand: "Falken", model: "", size: "295/80R22.5", sizeDisplay: "295/80R22.5", sizeRaw: "295/80R22.5", isTyre: true, cost: 422.3, priceIncludesTax: false, currency: "USD", stock: 10, priceDate: "2026-10-01", source: "excel", sourceRef: "a.xlsx" };
    await store.upsertRows([falken]);
    await bot.handle(text("FALKEN 295/80R22.5 MIXTA X 6, MARGEN 10% CLIENTE MOVIL BUS S.A.C. , ATENCION A: SR. JONATAHAN MATTA, DIRECCION: LIMA"));
    const options = client.last()?.body ?? "";
    expect(options).toContain("Falken");
    expect(options).toContain("*US$ 464.53* (costo US$ 422.30"); // 422.30 × 1.10 instead of the default 15% (485.65)
    expect(options).toContain("margen 10%");
    expect(options).toContain("*margen 10*");
    expect(options).not.toMatch(/Falken 295\/80R22\.5 MARGEN/i);

    await bot.handle(text("margen 12"));
    const repriced = client.last()?.body ?? "";
    expect(repriced).toContain("*US$ 472.98*"); // 422.30 × 1.12
    expect(repriced).toContain("margen 12%");
    expect(repriced).not.toContain("margen 10%");

    await bot.handle(text("ok"));
    const quote = await store.getQuote("COT-0001");
    expect(quote?.customer.attention).toBe("SR. JONATAHAN MATTA");
    expect(quote?.customer.company).toBe("MOVIL BUS S.A.C.");
    expect(quote?.items[0].unitPrice).toBe(472.98);
    expect(quote?.items[0].quantity).toBe(6);

    // typed on the shown quote: "atención a: …" is a field line too (not "a: …" as the value)
    await bot.handle(text("compras@movilbus.pe")); // no email in the request: asked for it
    expect((await store.getConversation(PHONE))?.step).toBe("review_quote");
    await bot.handle(text("atención a: Sr. Pedro Ruiz"));
    expect((await store.getQuote("COT-0001"))?.customer.attention).toBe("Sr. Pedro Ruiz");
  });

  it("provider stock per warehouse is shown next to the stock in the options and in 'stock <medida>', not on the quote", async () => {
    const jch: PriceRow = { id: "jch-29580r225-gi388", provider: "JCH", kind: "provider", code: "TBR2250719", description: "NTCO: 295/80 R22.5 154K GI-388 SUPER-MIXTA FALKEN TL JP", brand: "Falken", model: "GI-388 SUPER MIXTA", size: "295/80R22.5", sizeDisplay: "295/80R22.5", sizeRaw: "295/80 R22.5", isTyre: true, cost: 422.3, priceIncludesTax: false, currency: "USD", stock: 78, stockByWarehouse: { Arriola: 8, Frutales: 20, "Lurín": 50 }, priceDate: "2026-10-01", source: "excel", sourceRef: "jch.xlsx" };
    const lurin: PriceRow = { ...jch, id: "jch-29580r225-other", code: "TBR2250720", model: "GI-368", description: "NTCO: 295/80 R22.5 GI-368 FALKEN", stock: 50, stockByWarehouse: { "Lurín": 50 } };
    await store.upsertRows([jch, lurin]);
    await bot.handle(text("Falken 295/80R22.5 x 4 para Transportes ABC, juan@abc.com"));
    const options = client.last()?.body ?? "";
    expect(options).toContain("🚚 JCH · stock 78 (Arriola 8 · Frutales 20 · Lurín 50) · Falken GI-388 SUPER MIXTA 295/80R22.5");
    expect(options).toContain("🚚 JCH · stock 50 (Lurín) · Falken GI-368");
    await bot.handle(text("cancelar"));

    await bot.handle(text("stock 295/80R22.5"));
    expect(client.last()?.body).toContain("stock 78 (Arriola 8 · Frutales 20 · Lurín 50)");

    await bot.handle(text("Falken 295/80R22.5 GI-388 x 4 para Transportes ABC, juan@abc.com"));
    await bot.handle(text("ok"));
    const quote = await store.getQuote("COT-0001");
    expect(JSON.stringify(quote)).not.toContain("Arriola");
  });

  it("'Entendí:' lists the segments it did not understand, with a hint; still listed after a choose command", async () => {
    const falken: PriceRow = { id: "falken-29580r225", provider: "Llantas del Sur", kind: "provider", description: "295/80R22.5 FALKEN", brand: "Falken", model: "", size: "295/80R22.5", sizeDisplay: "295/80R22.5", sizeRaw: "295/80R22.5", isTyre: true, cost: 422.3, priceIncludesTax: false, currency: "USD", stock: 10, priceDate: "2026-10-01", source: "excel", sourceRef: "a.xlsx" };
    await store.upsertRows([falken]);
    await bot.handle(text("Falken 295/80R22.5 mixta x6, para el señor Jonathan Matta, dirección: Lima\natt. compras"));
    const options = client.last()?.body ?? "";
    expect(options).toContain("Entendí:");
    expect(options).toContain("⚠️ No entendí: «para el señor Jonathan Matta» — lo dejé fuera; si hace falta, reenvíalo como *clave: valor* o como línea de llanta");
    expect(options).toContain("⚠️ No entendí: «att. compras» — si es la atención escribe *atención: Nombre*");

    await bot.handle(text("dscto 5"));
    const again = client.last()?.body ?? "";
    expect(again).toContain("⚠️ No entendí: «att. compras»");

    await bot.handle(text("ok"));
    const quote = await store.getQuote("COT-0001");
    expect(quote?.customer.attention).toBeUndefined();
    expect(JSON.stringify(quote)).not.toContain("No entendí");
  });

  it("a fully understood message has no 'No entendí' line", async () => {
    const falken: PriceRow = { id: "falken-29580r225", provider: "Llantas del Sur", kind: "provider", description: "295/80R22.5 FALKEN", brand: "Falken", model: "", size: "295/80R22.5", sizeDisplay: "295/80R22.5", sizeRaw: "295/80R22.5", isTyre: true, cost: 422.3, priceIncludesTax: false, currency: "USD", stock: 10, priceDate: "2026-10-01", source: "excel", sourceRef: "a.xlsx" };
    await store.upsertRows([falken]);
    await bot.handle(text("Hola, buenos días\nFALKEN 295/80R22.5 MIXTA X 6, MARGEN 10% CLIENTE MOVIL BUS S.A.C. , ATENCION A: SR. JONATAHAN MATTA, DIRECCION: LIMA\nGracias"));
    const options = client.last()?.body ?? "";
    expect(options).toContain("Entendí:");
    expect(options).not.toContain("No entendí");
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
    expect(doc?.caption).toBe("");
    expect(client.last()?.body).toContain("· Fotos 1/1\n\nReenvía al cliente");
    expect(client.last()?.body).not.toContain("sin foto:");
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
    expect(options).toContain("📒 atención Sra. Karen Ordoñez · dirección Av. Argentina 1500, Callao · pago letras 60 días, como en la 001 (Transportes ABC) _(se cambian con *atención: …*, *dirección: …*, *pago: …*)_");
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
    expect(body).toContain("3. PARCHE RS-35 VIPAL x25 @ US$ 3.50 (precio manual)"); // the state, not the options again
    expect(body).not.toContain("*a)*");
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

  it("'precio 259' in the request: the chosen option at that price, the quote uses it; 'precio 1 300' re-prices", async () => {
    const flama: PriceRow = { id: "fenix-31580r225-flama77", provider: "Llantas del Sur", kind: "provider", description: "315/80R22.5 FENIXWAY FLAMA 77", brand: "Fenixway", model: "FLAMA 77", size: "315/80R22.5", sizeDisplay: "315/80R22.5", sizeRaw: "315/80R22.5", isTyre: true, cost: 230, priceIncludesTax: false, currency: "USD", stock: 10, priceDate: "2026-10-01", source: "excel", sourceRef: "a.xlsx" };
    await store.upsertRows([flama]);
    await bot.handle(text("Fenixway Flama 77 315/80R22.5 x4 precio 259, cliente: Transportes Lima S.A.C., atención: Sr. Juan Pérez, dirección: Lima"));
    const options = client.last()?.body ?? "";
    expect((await store.getConversation(PHONE))?.step).toBe("choose");
    expect(options).toContain("*1.* Fenixway 315/80R22.5 FLAMA 77 x4 precio 259 → elegido *a* · precio manual US$ 259.00");
    expect(options).toContain("🚚 Llantas del Sur");
    expect(options).not.toContain("No entendí");
    expect(options).not.toContain("sin precio en las listas");

    await bot.handle(text("ok"));
    let q = await store.getQuote("COT-0001");
    expect(q?.items.map((i) => [i.brand, i.quantity, i.unitPrice, i.total])).toEqual([["Fenixway", 4, 259, 1036]]);
    expect(q?.customer.company).toBe("Transportes Lima S.A.C.");
    expect(q?.customer.attention).toBe("Sr. Juan Pérez");
    expect(q?.customer.address).toBe("Lima");
    await bot.handle(text("cancelar"));

    // typed afterwards while choosing, "precio 1 300" overrides the request's price
    await bot.handle(text("Fenixway Flama 77 315/80R22.5 x4 precio 259 para Transportes Lima S.A.C., c@lima.pe"));
    await bot.handle(text("precio 1 300"));
    expect(client.last()?.body).toContain("1. Fenixway FLAMA 77 315/80R22.5 x4 @ US$ 300.00 (precio manual)");
    await bot.handle(text("dscto 5")); // a re-show keeps the override
    expect(client.last()?.body).toContain("precio manual US$ 300.00");
    await bot.handle(text("ok"));
    q = await store.getQuote("COT-0002");
    expect(q?.items[0].unitPrice).toBe(300);
  });

  it("'precio N' on a line no list has: a manual item with the salesman's description", async () => {
    await bot.handle(text("Fenixway Flama 77 315/80R22.5 x4 precio 259; Michelin 11R22.5 XZE2+ x2 para Transportes ABC, c@abc.pe"));
    const options = client.last()?.body ?? "";
    expect(options).toContain("*1.* Fenixway 315/80R22.5 FLAMA 77 x4 precio 259\n  ✍️ precio manual US$ 259.00");
    expect(options).not.toContain("sin precio en las listas");
    await bot.handle(text("ok"));
    const q = await store.getQuote("COT-0001");
    expect(q?.items.map((i) => [i.description, i.quantity, i.unitPrice, i.origin])).toEqual([
      ["Llanta Fenixway FLAMA 77 315/80R22.5", 4, 259, "manual"],
      ["Llanta Michelin XZE2+ 11R22.5 146/143L", 2, 457.7, "provider"],
    ]);
  });

  it("a request with a quantity or a customer is a request even with 'precio N' (not a provider price)", async () => {
    await bot.handle(text("Falken 295/80R22.5 x6 precio 300 para Transportes ABC"));
    expect((await store.getConversation(PHONE))?.step).toBe("choose");
    expect(client.last()?.body).toContain("Falken 295/80R22.5 x6 precio 300");
    await bot.handle(text("cancelar"));
    await bot.handle(text("Falken 295/80R22.5 precio 300, atención: Sr. Juan Pérez"));
    expect((await store.getConversation(PHONE))?.step).toBe("choose");
    await bot.handle(text("cancelar"));
    // ambiguous (no quantity, no customer): still a provider's price, as before
    await bot.handle(text("Falken 295/80R22.5 precio 300"));
    expect((await store.getConversation(PHONE))?.step).toBe("need_provider");
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

  it("message log: every message in and out is logged (files by name); 'historial' is for admins, compact, Lima time", async () => {
    await bot.handle(text("Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com"));
    await bot.handle(text("ok"));
    const log = await store.listMessages(PHONE, 100);
    expect(log[0]).toMatchObject({ direction: "in", kind: "text", body: "Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com" });
    expect(log[1]).toMatchObject({ direction: "out", kind: "text" });
    expect(log[1].body).toContain("Entendí:");
    const doc = log.find((m) => m.kind === "document");
    expect(doc).toMatchObject({ direction: "out", fileName: "Cotizacion 26 - 0001.pdf", quoteNumber: "COT-0001" });
    expect(JSON.stringify(log)).not.toContain("JVBER"); // never the PDF bytes
    expect(log.filter((m) => m.direction === "out").length).toBe(client.sent.length);
    // an inbound document: only its name
    await bot.handle({ id: "wamid.doclog", from: PHONE, timestamp: "1", type: "audio", forwarded: false, media: { id: "aud1", mimeType: "audio/ogg" } });
    expect((await store.listMessages(PHONE, 2))[0]).toMatchObject({ direction: "in", kind: "audio", body: "(audio)" });

    await bot.handle(text("historial"));
    expect(client.last()?.body).toBe("Solo el administrador puede ver el historial.");
    process.env.ADMIN_NUMBERS = "18605180534";
    try {
      const admin = (body: string): InboundMessage => ({ ...text(body), from: "18605180534" });
      await bot.handle(admin(`historial ${PHONE}`));
      const lines = (client.last()?.body ?? "").split("\n");
      expect(lines[0]).toMatch(new RegExp(`^\\*Historial ${PHONE}\\* \\(\\d+\\)$`));
      expect(lines[1]).toMatch(/^\d\d\/\d\d \d\d:\d\d ← Michelin 11R22\.5 XZE2\+ x4 para Transportes ABC, juan@abc\.com$/);
      expect(lines.some((l) => /^\d\d\/\d\d \d\d:\d\d → \(PDF: Cotizacion 26 - 0001\.pdf\)$/.test(l))).toBe(true);
      expect(lines.slice(1).every((l) => l.length <= 12 + 80 + 45)).toBe(true); // bodies truncated to 80 chars
      expect(lines.slice(-2)).toEqual([expect.stringMatching(/← historial$/), expect.stringMatching(/→ Solo el administrador puede ver el historial\.$/)]); // the non-admin's attempt, newest last
      await bot.handle(admin(`historial ${PHONE} 2`));
      expect((client.last()?.body ?? "").split("\n").length).toBe(3);
      await bot.handle(admin("historial 955344340 2")); // without the country code
      expect(client.last()?.body).toContain(`*Historial ${PHONE}*`);
      await bot.handle(admin("historial"));
      expect(client.last()?.body).toMatch(/^\*Historial 18605180534\* \(\d+\)\n.*← historial 51955344340\n/);
    } finally {
      delete process.env.ADMIN_NUMBERS;
    }
  });

  it("history lines: Lima time, arrows, truncated body, file label; a failing log never breaks the bot", async () => {
    expect(limaTime("2026-10-30T22:16:00Z")).toBe("30/10 17:16");
    expect(historyLine({ direction: "out", kind: "document", body: "*1.* Fenixway Flama 77", fileName: "Cotizacion 26 - 0031.pdf", createdAt: "2026-10-30T22:16:00Z" })).toBe("30/10 17:16 → *1.* Fenixway Flama 77 (PDF: Cotizacion 26 - 0031.pdf)");
    const long = historyLine({ direction: "in", kind: "text", body: "a\nb ".repeat(60), createdAt: "2026-10-30T05:01:00Z" });
    expect(long).toMatch(/^30\/10 00:01 ← a b a b .*…$/);
    expect(long.length).toBe("30/10 00:01 ← ".length + 80);

    const broken = Object.assign(JsonStore.memory(), { logMessage: async () => Promise.reject(new Error("db down")) });
    const c2 = new FakeWhatsAppClient();
    const logs: string[] = [];
    const b2 = new BotHandler({ client: c2, store: broken, settings, log: (m) => logs.push(m) });
    await b2.handle(text("hola"));
    expect(c2.last()?.body).toContain("Cotizador Protyres");
    expect(logs.some((l) => l.includes("db down"))).toBe(true);
  });

  it("'agregar …' adds tyres to the quote in progress: while choosing (options again) and on the presented quote (PDF again)", async () => {
    await bot.handle(text("Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com"));
    await bot.handle(text("agregar Bridgestone 11R22.5 R268 x2"));
    let body = client.last()?.body ?? "";
    expect(body).toMatch(/^Transportes ABC\n1\. Michelin XZE2\+ 11R22\.5 x4 @ US\$ 457\.70\n2\. Bridgestone R268 11R22\.5 x2 @ US\$ 442\.75\n/); // the state…
    expect(body).toContain("*2.* Bridgestone 11R22.5 R268 x2"); // …and the options of the new line only
    expect(body).not.toContain("*1.* Michelin");
    expect((await store.getConversation(PHONE))?.pending?.length).toBe(2);
    await bot.handle(text("+ Michelin 11R22.5 XZE2+ x2")); // the same tyre: its quantity grows
    expect((await store.getConversation(PHONE))?.pending?.map((p) => p.quantity)).toEqual([6, 2]);
    await bot.handle(text("agregar algo"));
    expect(client.last()?.body).toContain("No encontré ninguna llanta en «algo»");
    await bot.handle(text("ok"));
    let q = await store.getQuote("COT-0001");
    expect(q?.items.map((i) => [i.brand, i.quantity])).toEqual([
      ["Michelin", 6],
      ["Bridgestone", 2],
    ]);

    // on the presented quote: several lines at once; the quote is rebuilt and its PDF sent again
    const docsBefore = client.sent.filter((m) => m.kind === "document").length;
    await bot.handle(text("añadir 295/80R22.5 x2\nFenixway Flama 77 315/80R22.5 x4 precio 259"));
    expect(client.sent.filter((m) => m.kind === "document").length).toBe(docsBefore + 1);
    q = await store.getQuote("COT-0001");
    expect(q?.items.length).toBe(4);
    expect(q?.items[2].size).toBe("295/80R22.5");
    expect(q?.items[3]).toMatchObject({ brand: "Fenixway", quantity: 4, unitPrice: 259, origin: "manual" });
    expect((await store.getConversation(PHONE))?.step).toBe("review_quote");
    await bot.handle(text("agregar Michelin 13R22.5 x2"));
    expect(client.last()?.body).toContain("No hay precio en las listas para «Michelin 13R22.5 x2»");
    expect((await store.getQuote("COT-0001"))?.items.length).toBe(4);
  });

  describe("quote boundaries: a new request while a quote is open", () => {
    const flama: PriceRow = { id: "fenix-31580r225-flama77", provider: "Llantas del Sur", kind: "provider", description: "315/80R22.5 FENIXWAY FLAMA 77", brand: "Fenixway", model: "FLAMA 77", size: "315/80R22.5", sizeDisplay: "315/80R22.5", sizeRaw: "315/80R22.5", isTyre: true, cost: 230, priceIncludesTax: false, currency: "USD", stock: 10, priceDate: "2026-10-01", source: "excel", sourceRef: "a.xlsx" };
    const state = async () => (await store.getConversation(PHONE))?.step;
    const QUESTION = "Tienes la cotización 001 (MOVIL BUS S.A.C.) abierta. ¿Es un *cambio* en esa, una llanta para *agregar*, o una cotización *nueva*?";
    beforeEach(async () => {
      await store.upsertRows([flama]);
      // quote 001: Flama 77 x4 at a typed price, as in the incident
      await bot.handle(text("Fenixway Flama 77 315/80R22.5 x4 para MOVIL BUS S.A.C., atención: Sr. Jonathan Matta, compras@movilbus.pe"));
      await bot.handle(text("precio 1 254"));
      await bot.handle(text("ok"));
    });

    it("the first options message of a new quote has the header; later ones do not", async () => {
      const first = client.texts().find((t) => t.includes("Entendí:")) ?? "";
      expect(first).toMatch(/^🆕 Cotización nueva · MOVIL BUS S\.A\.C\.\nEntendí:/);
      expect(client.texts().filter((t) => t.includes("🆕")).length).toBe(1); // not on "precio 1 254"
    });

    it("after a change the reply shows the quote's state: customer, items with prices, terms, total", async () => {
      const STATE = "MOVIL BUS S.A.C. · Sr. Jonathan Matta\n1. Fenixway FLAMA 77 315/80R22.5 x8 @ US$ 254.00 (precio manual)\nPago: — · Plazo: 45 días · Entrega: —\nTotal US$ 2,032.00 sin IGV";
      await bot.handle(text("plazo: 45 días"));
      await bot.handle(text("x8"));
      expect(client.last()?.body).toContain(`*cancelar*.\n\n${STATE}\n\n📧 *Para:* compras@movilbus.pe`);
      await bot.handle(text("con igv"));
      expect(client.last()?.body).toContain("1. Fenixway FLAMA 77 315/80R22.5 x8 @ US$ 299.72 (precio manual)\nPago: — · Plazo: 45 días · Entrega: —\nTotal US$ 2,397.76 con IGV");

      // while choosing: the state replaces the options (nothing to choose again)
      await bot.handle(text("cancelar"));
      await bot.handle(text("Fenixway Flama 77 315/80R22.5 x4 para MOVIL BUS S.A.C., atención: Sr. Jonathan Matta"));
      await bot.handle(text("cantidad 1 8"));
      await bot.handle(text("precio 254"));
      await bot.handle(text("plazo: 45 días"));
      expect(client.last()?.body).toBe(`${STATE}\n\nResponde *ok* para armar el PDF, o *opciones* para ver las opciones.`);
      await bot.handle(text("opciones"));
      expect(client.last()?.body).toContain("*a)* 🚚 Llantas del Sur");
      expect(client.last()?.body).not.toContain("Total US$");
    });

    it("same customer → asks; 'cambiar' updates quantity / price / terms of the open quote", async () => {
      await bot.handle(text("Fenixway Flama 77 315/80R22.5 x8 para Movil Bus"));
      expect(client.last()?.body).toBe(QUESTION);
      expect(await state()).toBe("confirm_new");
      await bot.handle(text("cambiar"));
      let q = await store.getQuote("COT-0001");
      expect(q?.items.map((i) => [i.quantity, i.unitPrice])).toEqual([[8, 254]]);
      expect(client.last()?.body).toContain("*cancelar*.\n\n✏️ Cambié en la 001: cantidad 8.\n");
      expect(await store.getQuote("COT-0002")).toBeNull();
      expect(await state()).toBe("review_quote");

      await bot.handle(text("Fenixway Flama 77 315/80R22.5 x8 precio 260 para MOVIL BUS S.A.C.\nplazo: 45 días"));
      await bot.handle(text("es un cambio"));
      q = await store.getQuote("COT-0001");
      expect(q?.items.map((i) => [i.quantity, i.unitPrice, i.manualPrice])).toEqual([[8, 260, true]]);
      expect(q?.paymentTerm).toBe("45 días");
      expect(client.last()?.body).toContain("✏️ Cambié en la 001: precio 260, plazo 45 días.");

      await bot.handle(text("Fenixway Flama 77 315/80R22.5 x8 MOVIL BUS S.A.C."));
      await bot.handle(text("cambio"));
      expect(client.last()?.body).toBe("Es igual a la 001: no cambié nada.");
      expect(await state()).toBe("review_quote");
    });

    it("'cambiar' with a tyre the quote does not have says so; 'agregar' then adds it", async () => {
      await bot.handle(text("Michelin 11R22.5 XZE2+ x2 para Movil Bus"));
      expect(client.last()?.body).toBe(QUESTION);
      await bot.handle(text("cambiar"));
      expect(client.last()?.body).toBe("No puedo aplicarlo como cambio: «Michelin 11R22.5 XZE2+ x2» no está en la 001. Responde *agregar* (otra llanta en la 001) o *nueva* (otra cotización).");
      expect(await state()).toBe("confirm_new");
      await bot.handle(text("agregar"));
      expect((await store.getQuote("COT-0001"))?.items.map((i) => [i.brand, i.quantity])).toEqual([
        ["Fenixway", 4],
        ["Michelin", 2],
      ]);
      expect(await state()).toBe("review_quote");
    });

    it("'nueva' starts a new quote: header, the typed price and the plazo of the last quote to that customer carried over (overridable)", async () => {
      await bot.handle(text("plazo: 45 días"));
      await bot.handle(text("Fenixway Flama 77 315/80R22.5 x8 para Movil Bus"));
      await bot.handle(text("nueva"));
      const body = client.last()?.body ?? "";
      const list = body.match(/\*US\$ ([\d.,]+)\*/)?.[1];
      expect(body).toMatch(/^🆕 Cotización nueva · Movil Bus\n📒 /);
      expect(body).toContain("plazo 45 días");
      expect(body).toContain(", como en la 001 (MOVIL BUS S.A.C.)");
      expect(body).toContain(`💲 precio 254 como en la 001 a este cliente (escribe *precio 1 ${list}* para volver a lista)`);
      expect(body).toContain("→ elegido *a* · precio manual US$ 254.00");
      await bot.handle(text("ok"));
      const q = await store.getQuote("COT-0002");
      expect(q?.items.map((i) => [i.quantity, i.unitPrice])).toEqual([[8, 254]]);
      expect(q?.paymentTerm).toBe("45 días");
      expect(q?.customer.attention).toBe("Sr. Jonathan Matta");

      // typed values win over the remembered ones
      await bot.handle(text("Fenixway Flama 77 315/80R22.5 x2 precio 250 para Movil Bus\nplazo: 60 días"));
      await bot.handle(text("nueva"));
      expect(client.last()?.body).not.toContain("💲");
      await bot.handle(text("ok"));
      expect((await store.getQuote("COT-0003"))?.items[0].unitPrice).toBe(250);
      expect((await store.getQuote("COT-0003"))?.paymentTerm).toBe("60 días");
    });

    it("a manual price older than 30 days is not carried over", async () => {
      const q = (await store.getQuote("COT-0001"))!;
      await store.saveQuote({ ...q, createdAt: new Date(Date.now() - 31 * 86400_000).toISOString() });
      await bot.handle(text("cancelar"));
      await bot.handle(text("Fenixway Flama 77 315/80R22.5 x8 para Movil Bus"));
      expect(client.last()?.body).not.toContain("💲");
    });

    it("another customer → the new quote starts at once with the 'Cerré' line; while choosing, the same customer is asked about", async () => {
      await bot.handle(text("Michelin 11R22.5 XZE2+ x2 para Transportes ABC, juan@abc.com"));
      expect(client.last()?.body).toMatch(/^🆕 Cotización nueva · Transportes ABC\nCerré la 001 \(MOVIL BUS\) y empiezo una nueva\.\nEntendí:/);
      expect(await state()).toBe("choose");
      await bot.handle(text("Michelin 11R22.5 XZE2+ x4 para Transportes ABC"));
      expect(client.last()?.body).toBe("Tienes una cotización en curso (Transportes ABC). ¿Es un *cambio* en esa, una llanta para *agregar*, o una cotización *nueva*?");
      await bot.handle(text("qué?"));
      expect(client.last()?.body).toContain("Responde *cambiar*");
      await bot.handle(text("cambiar"));
      expect(client.last()?.body).toMatch(/^✏️ Cambié en la cotización en curso: cantidad 4\.\n/);
      expect((await store.getConversation(PHONE))?.pending?.[0].quantity).toBe(4);
      await bot.handle(text("Michelin 11R22.5 XZE2+ x4 para Transportes ABC"));
      await bot.handle(text("cancelar"));
      expect(await store.getConversation(PHONE)).toBeNull();
    });
  });

  it("a single item takes 'cantidad 8' / 'x8' / '8 unidades' / 'precio 254' / 'a 254' / 'aplicación …' / 'quitar' / 'foto' without its number", async () => {
    const pend = async () => (await store.getConversation(PHONE))?.pending?.[0];
    await bot.handle(text("Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com"));
    await bot.handle(text("cantidad 8"));
    expect((await pend())?.quantity).toBe(8);
    await bot.handle(text("x6"));
    expect((await pend())?.quantity).toBe(6);
    await bot.handle(text("10 unidades"));
    expect((await pend())?.quantity).toBe(10);
    await bot.handle(text("precio 254"));
    expect((await pend())?.unitPriceOverride).toBe(254);
    await bot.handle(text("a 250.50"));
    expect((await pend())?.unitPriceOverride).toBe(250.5);
    await bot.handle(text("aplicación MIXT DEL"));
    expect((await pend())?.application).toBe("MIXT DEL");
    await bot.handle(text("foto"));
    expect(client.last()?.body).toContain("No tengo foto de *Michelin XZE2+*"); // the only item's photo
    expect((await store.getConversation(PHONE))?.step).toBe("choose");
    await bot.handle(text("ok"));
    let q = await store.getQuote("COT-0001");
    expect(q?.items.map((i) => [i.quantity, i.unitPrice, i.application])).toEqual([[10, 250.5, "MIXT DEL"]]);

    // on the presented quote
    await bot.handle(text("x8"));
    q = await store.getQuote("COT-0001");
    expect(q?.items.map((i) => [i.quantity, i.total])).toEqual([[8, 2004]]);
    await bot.handle(text("a 254"));
    expect((await store.getQuote("COT-0001"))?.items[0].unitPrice).toBe(254);
    await bot.handle(text("cantidad 4"));
    await bot.handle(text("precio 260"));
    q = await store.getQuote("COT-0001");
    expect(q?.items.map((i) => [i.quantity, i.unitPrice, i.manualPrice])).toEqual([[4, 260, true]]);
    await bot.handle(text("aplicación POST"));
    expect((await store.getQuote("COT-0001"))?.items[0].application).toBe("POST");
    await bot.handle(text("quitar"));
    expect(client.last()?.body).toBe("No quedó ningún ítem para cotizar. Escribe el pedido de nuevo.");
  });

  it("bare item commands are not option picks, and picks are not bare commands", () => {
    expect(parseBareItemCommand("x8")).toEqual({ kind: "quantity", value: 8 });
    expect(parseBareItemCommand("8 unidades")).toEqual({ kind: "quantity", value: 8 });
    expect(parseBareItemCommand("precio 1,254.50")).toEqual({ kind: "price", value: 1254.5 });
    expect(parseBareItemCommand("precio 4,50")).toEqual({ kind: "price", value: 4.5 });
    for (const t of ["a x2, b x8", "b x4", "precio 1 254", "cantidad 1 8", "quitar 2", "aplicación 2 MIXT", "a 2", "2"]) expect(parseBareItemCommand(t)).toBeNull();
    expect(parsePicks("a x2, b x8", 1)).toEqual([
      { line: 0, option: 0, quantity: 2 },
      { line: 0, option: 1, quantity: 8 },
    ]);
    expect(parsePicks("x8", 1)).toBeNull();
  });

  it("with two or more items the number is required: '¿De qué ítem?'", async () => {
    await bot.handle(text("Michelin 11R22.5 XZE2+ x4; Bridgestone 11R22.5 R268 x2 para Transportes ABC, juan@abc.com"));
    for (const [cmd, ask] of [
      ["cantidad 8", "cantidad 2 8"],
      ["x8", "cantidad 2 8"],
      ["8 unidades", "cantidad 2 8"],
      ["precio 254", "precio 2 254"],
      ["a 254", "precio 2 254"],
      ["quitar", "quitar 2"],
      ["aplicación MIXT", "aplicación 2 MIXT"],
    ]) {
      await bot.handle(text(cmd));
      expect(client.last()?.body).toBe(`¿De qué ítem? (ej. ${ask})`);
    }
    await bot.handle(text("foto"));
    expect(client.last()?.body).toBe("¿De qué ítem? (ej. foto 2)");
    expect((await store.getConversation(PHONE))?.pending?.map((p) => p.quantity)).toEqual([4, 2]);
    // 'a x2, b x8' still picks options; 'quitar 2' leaves one item, so a bare command applies to it
    await bot.handle(text("quitar 2"));
    await bot.handle(text("x3"));
    expect((await store.getConversation(PHONE))?.pending?.map((p) => p.quantity)).toEqual([3, 2]);
    await bot.handle(text("ok"));
    await bot.handle(text("agregar Bridgestone 11R22.5 R268 x2"));
    await bot.handle(text("precio 254"));
    expect(client.last()?.body).toBe("¿De qué ítem? (ej. precio 2 254)");
    expect((await store.getQuote("COT-0001"))?.items.map((i) => i.unitPrice)).not.toContain(254);
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
    const name = "Cotizacion 451 Ayacucho - UB 1830.xlsx";
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
  /** The PDF's name ("Cotizacion 26 - 0451.pdf") and the Prosegur Excel's ("Cotizacion 451 Ayacucho - UB 1830.xlsx"). */
  const pdfName = (n: number) => `Cotizacion ${today().slice(2, 4)} - ${String(n).padStart(4, "0")}.pdf`;
  const xlsName = (n: number, unit = "Ayacucho", ub = "1830") => `Cotizacion ${n} ${unit} - UB ${ub}.xlsx`;

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
    expect(pdfDoc.fileName).toBe(pdfName(451)); // "Cotizacion 26 - 0451.pdf"
    expect(xlsDoc.fileName).toBe(xlsName(451));
    expect(pdfDoc.caption).toBe("");
    expect(xlsDoc.caption).toBe("");
    expect(xlsDoc.mimeType).toBe(XLSX_MIME);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsDoc.file as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect([ws.getCell("G5").value, ws.getCell("G6").value, ws.getCell("K5").value, ws.getCell("C19").value, ws.getCell("G20").value]).toEqual([451, "AYACUCHO", "JOHANN CASTAÑEDA", 1830, 4]);
    expect(String(ws.getCell("F19").value)).toMatch(/^295\/80R22\.5 .*MICHELIN X MULTI Z$/);
    // Prosegur's review is the short one (contract addendum §4): head, items, total + number + email, commands
    const [recap, preview, ...more] = (client.last()?.body ?? "").split("\n\n");
    expect(more).toEqual([]);
    expect(recap).toMatch(new RegExp(`^\\*${num(451)}\\* · PROSEGUR SA\n.*\nPago factura 30 días · Total US\\$ [\\d,.]+ \\(sin IGV\\)$`)); // no photo notes
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
    expect(resent.map((d) => d.caption)).toEqual(["", ""]);
    expect(client.last()).toMatchObject({ kind: "text", body: recap }); // the summary comes after, in its own message
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
    expect(body).toContain(`, como en la 451 (PROSEGUR SA)`);
    expect(body).toMatch(/^🆕 Cotización nueva · PROSEGUR SA\n📒 /);
    expect(body).toContain("unidad Ayacucho · UB 1830 · solicitante Johann Castañeda");
    await bot.handle(text("ok"));
    expect(docs().slice(-2).map((d) => d.fileName)).toEqual([pdfName(452), xlsName(452)]);
  });

  it("the quote comes as three messages: a text for the customer, the PDF without a caption, then the summary and the review", async () => {
    const flama: PriceRow = { id: "fenix-31580r225-flama77", provider: "Llantas del Sur", kind: "provider", description: "315/80R22.5 FENIXWAY FLAMA 77", brand: "Fenixway", model: "FLAMA 77", size: "315/80R22.5", sizeDisplay: "315/80R22.5", sizeRaw: "315/80R22.5", isTyre: true, cost: 230, priceIncludesTax: false, currency: "USD", stock: 10, priceDate: today(), source: "excel", sourceRef: "a.xlsx" };
    await store.upsertRows([flama]);
    await bot.handle(text("Fenixway Flama 77 315/80R22.5 x8 precio 254 para MOVIL BUS S.A.C., atención: Sr. Jonathan Matta, compras@movilbus.pe"));
    const before = client.sent.length;
    await bot.handle(text("ok"));
    const out = client.sent.slice(before);
    expect(out.map((m) => m.kind)).toEqual(["text", "document", "text"]);
    const forCustomer = [
      "Estimados señores MOVIL BUS S.A.C.",
      "Atención: Sr. Jonathan Matta",
      `Adjunto la cotización ${num(16)}:`,
      "• 8 × Fenixway FLAMA 77 315/80R22.5 – US$ 254.00 c/u",
      "Total: US$ 2,032.00 + IGV",
      "Forma de pago: Factura crédito, 30 días · Entrega: 48 hrs post OC · Validez: 7 días",
      "Quedo atento a cualquier consulta.",
      "Frank Melek Rodríguez Mirano · 360 by Professional Tyres · 955 344 340",
    ];
    expect(out[0].body).toBe(forCustomer.join("\n"));
    expect(out[0].body).not.toMatch(/[*_]|\p{Extended_Pictographic}/u); // forwardable as is: no bot formatting, no emojis
    expect(out[1].caption).toBe("");
    expect(
      out[2].body?.startsWith(
        [
          `*${num(16)}* · MOVIL BUS S.A.C.`,
          "8 × FLAMA 77 @ US$ 254.00 (precio manual)",
          "Pago factura crédito 30 días · Total US$ 2,032.00 (sin IGV) · Fotos 0/1",
          "sin foto: Fenixway FLAMA 77 → mándame la imagen con el texto *foto Fenixway FLAMA 77*",
          "",
          "Reenvía al cliente el texto y el PDF. O responde *enviar* (correo), *agregar …*, *precio 2 250*, *cancelar*.",
          "",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(out[2].body).toContain("📧 *Para:* compras@movilbus.pe");

    await bot.handle(text("con igv")); // a rebuild sends both again
    const again = client.sent.slice(-3);
    expect(again.map((m) => m.kind)).toEqual(["text", "document", "text"]);
    expect(again[0].body).toContain("• 8 × Fenixway FLAMA 77 315/80R22.5 – US$ 299.72 c/u\nTotal: US$ 2,397.76 inc. IGV");
    expect(again[1].caption).toBe("");
    expect(again[2].body).toContain("Total US$ 2,397.76 (inc. IGV)");

    // "reenviar": the documents without a caption, then the summary (a draft has no stored files: regenerated, and it says so)
    const mark = client.sent.length;
    await bot.handle(text("reenviar 16"));
    const resent = client.sent.slice(mark);
    expect(resent.map((m) => m.kind)).toEqual(["document", "text", "text"]);
    expect(resent[0].caption).toBe("");
    expect(resent[1].body).toBe(`*${num(16)}* · MOVIL BUS S.A.C.\n8 × FLAMA 77 @ US$ 299.72 (precio manual)\nPago factura crédito 30 días · Total US$ 2,397.76 (inc. IGV) · Fotos 0/1`);
    expect(resent[2].body).toContain("los generé de nuevo");
  });

  it("a request without plazo / pago ends its first options message with the default plazo, once", async () => {
    const HINT = "Plazo 30 días por defecto (escribe plazo: 45 días para cambiarlo).";
    await bot.handle(text("Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com"));
    expect(client.last()?.body?.endsWith(`*cancelar*.\n${HINT}`)).toBe(true);
    await bot.handle(text("dscto 5"));
    expect(client.last()?.body).not.toContain(HINT); // only once per quote
    await bot.handle(text("cancelar"));
    for (const t of ["Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com\nplazo: 60 días", "Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com\npago: contado"]) {
      await bot.handle(text(t));
      expect(client.last()?.body).not.toContain("por defecto");
      await bot.handle(text("cancelar"));
    }
    // a customer whose last quote had another plazo: remembered, so no hint
    await bot.handle(text("Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com\nplazo: 45 días"));
    await bot.handle(text("ok"));
    await bot.handle(text("enviar"));
    await bot.handle(text("Michelin 11R22.5 XZE2+ x2 para Transportes ABC"));
    expect(client.last()?.body).toContain("📒 plazo 45 días");
    expect(client.last()?.body).not.toContain("por defecto");
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
    expect(docs().map((d) => d.fileName)).toEqual([pdfName(16)]);
  });

  it("renumbering a presented draft keeps the store consistent; 'archivo:' and 'nombre:' set names", async () => {
    await bot.handle(text("prosegur\nMichelin 295/80R22.5 X Multi Z x2 UB 1830\nunidad: Ayacucho\nsolicitante: Johann\ncorreo a@prosegur.pe"));
    await bot.handle(text("ok"));
    expect((await store.listQuotes(1))[0].number).toBe(num(16)); // counterStart: no counter yet
    await bot.handle(text("número 460"));
    expect(await store.getQuote(num(16))).toBeNull(); // the old draft is gone
    expect((await store.getQuote(num(460)))?.status).toBe("draft");
    expect((await store.getConversation(PHONE))?.quoteNumber).toBe(num(460));
    expect(docs().slice(-2).map((d) => d.fileName)).toEqual([pdfName(460), xlsName(460)]);

    await bot.handle(text("archivo: Cotización Prosegur Ayacucho"));
    expect(docs().slice(-2).map((d) => d.fileName)).toEqual(["Cotización Prosegur Ayacucho.pdf", xlsName(460)]);
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
    expect(replies.map((m) => m.kind)).toEqual(["text", "document", "document", "text"]);
    expect(replies.map((m) => m.fileName ?? "")).toEqual(["", pdfName(17), xlsName(17), ""]);
    // first the text for the customer, with the unit and UB
    expect(replies[0].body).toBe(
      [
        "Estimados señores PROSEGUR SA",
        "Atención: Johann Castañeda",
        "Unidad: Ayacucho · UB 1830",
        `Adjunto la cotización ${num(17)}:`,
        "• 2 × Fenixway Valor 99 215/75R17.5 18PR MIXT – US$ 123.17 c/u",
        "• 4 × Fenixway Valor 89 215/75R17.5 18PR POST – US$ 126.42 c/u",
        "Total: US$ 752.02 + IGV",
        "Forma de pago: FACTURA, 30 días · Entrega: 48 HRS POST OC · Validez: 7 días",
        "Quedo atento a cualquier consulta.",
        "Frank Melek Rodríguez Mirano · 360 by Professional Tyres · 955 344 340",
      ].join("\n"),
    );
    expect(replies.slice(1, 3).map((m) => m.caption)).toEqual(["", ""]);
    expect(replies[3].body).toBe(
      [
        `*${num(17)}* · PROSEGUR SA`,
        "2 × Valor 99 @ US$ 123.17 (contrato) · 4 × Valor 89 @ US$ 126.42 (contrato)",
        "Pago factura 30 días · Total US$ 752.02 (sin IGV)",
        "",
        "Prosegur · Ayacucho · UB 1830 · solicitante Johann Castañeda",
        "1. 215/75R17.5 18PR Fenixway Valor 99 MIXT x2 · US$ 123.17",
        "2. 215/75R17.5 18PR Fenixway Valor 89 POST x4 · US$ 126.42",
        `Total US$ 752.02 sin IGV · ${num(17)} · correo: compras@prosegur.com`,
        "Responde *enviar*, o corrige: *precio 2 130*, *cantidad 1 3*, *aplicación 2 MIXT*, *atención: …*, *número 18*, *cancelar*",
      ].join("\n"),
    );
    const ws = await sheet(replies[2].file!);
    expect(["C19", "F19", "G19", "K19", "F20", "G20", "K20", "G6", "K5"].map((a) => ws.getCell(a).value)).toEqual([1830, "215/75R17.5 18PR FENIXWAY VALOR 99", 2, 123.17, "215/75R17.5 18PR FENIXWAY VALOR 89", 4, 126.42, "AYACUCHO", "JOHANN CASTAÑEDA"]);
    const q = await store.getQuote(num(17));
    expect(q?.items.map((i) => [i.origin, i.provider, i.code, i.unitPrice, i.listPrice, i.discountPct, i.application, i.description])).toEqual([
      ["contract", "contrato", "v99", 123.17, 123.17, 0, "MIXT", "215/75R17.5 18PR FENIXWAY VALOR 99"],
      ["contract", "contrato", "v89", 126.42, 126.42, 0, "POST", "215/75R17.5 18PR FENIXWAY VALOR 89"],
    ]);
    expect(q).toMatchObject({ unit: "Ayacucho", ub: "1830", requester: "Johann Castañeda", customer: { company: "PROSEGUR SA", email: "compras@prosegur.com", attention: "Johann Castañeda", address: "Ayacucho" } }); // dirección = unidad when none was given
    await bot.handle(text("enviar"));
    expect(client.last()?.body).toBe(`Enviado ✔ Cotización ${num(17)} a compras@prosegur.com (PDF + Excel).`);
    expect(emails[1].attachments.map((a) => a.filename)).toEqual([pdfName(17), xlsName(17)]);
    expect((await store.getQuoteFiles(num(17))).map((f) => f.kind)).toEqual(["pdf", "xlsx"]);

    // the salesman's counter continues
    before = client.sent.length;
    await bot.handle(text("prosegur ayacucho 1830, 1 v99"));
    expect(client.sent.slice(before).map((m) => m.fileName)).toEqual([undefined, pdfName(18), xlsName(18), undefined]);
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
    expect(client.sent.slice(before).map((m) => m.kind)).toEqual(["text", "document", "document", "text"]); // not asked again
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
    expect(client.last()?.body).toContain("1. Fenixway Valor 99 215/75R17.5 18PR MIXT x2 @ US$ 130.00 (precio manual)");
    await bot.handle(text("opciones"));
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
    const files17 = [pdfName(17), xlsName(17)];
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

  it("contract: 'agregar 4 v89' on the presented quote goes through the contract (keeps the Excel)", async () => {
    await bot.handle(text("prosegur ayacucho 1830\n2 v99\nsolicitante: Johann Castañeda\ncorreo compras@prosegur.com"));
    await bot.handle(text("agregar 4 v89"));
    expect(docs().slice(-2).map((d) => d.fileName)).toEqual([pdfName(16), xlsName(16)]);
    expect((await store.getQuote(num(16)))?.items.map((i) => [i.code, i.quantity])).toEqual([
      ["v99", 2],
      ["v89", 4],
    ]);
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
    expect(body).toContain("*US$ 315.25* (lista US$ 350.28 −10%)"); // own list carries IGV: 413.33 / 1.18 = 350.28
    await bot.handle(text("con igv"));
    expect(client.last()?.body).toContain("con IGV");
    await bot.handle(text("ok"));
    const preview = client.last()?.body ?? "";
    expect(preview).toContain("(precios incluyen IGV 18%)");
    expect(preview).toContain("4 x US$ 372.00"); // 315.25 * 1.18 = 371.995
    expect(preview).toContain("Total: US$ 1,488.00"); // printed total = sum of displayed line totals
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
