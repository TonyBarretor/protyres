import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PriceRow } from "../../ingest/types";
import { buildQuote } from "../../quote/build";
import type { QuoteItem } from "../../quote/types";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient, type OutboundMessage } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import { parseWebhook, type InboundMessage } from "../../whatsapp/webhook";
import { normalizeOrderItemsText } from "../order/items";
import { parseAgencia, parseFechaEntrega, parseFlete, parsePlazo, parseProveedor } from "../order/questions";
import { JsonPortalStore } from "../store";
import type { Company, PortalUser } from "../store/types";
import { configureReportBot } from "./report";
import { configureOrderBot, OC_STEP, parseOcArgs, PATRICIA_REMINDER, type OcStep } from "./commands/oc";
import { getPendingHandler, type PortalContext } from "./registry";
import { classifyIntent } from "./router";
import { getPending, parkedOf, setPending } from "./state";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7, paymentType: "Factura crédito", paymentTerm: "30 días" },
  salespeople: { default: "51900000001", "51900000001": { name: "Frank Rodríguez", title: "Key Account Manager", phone: "900 000 001", email: "frank@example.pe" } },
});

const FRANK = "51900000001";
/** Empresas inventadas (RUC y razón social ficticios). */
const RUC_ANDES = "20999000011";
const RUC_ROCA = "20999000044";
const TODAY = "2026-11-11";

function row(p: Partial<PriceRow> & Pick<PriceRow, "id" | "provider" | "kind" | "brand" | "model" | "size" | "cost">): PriceRow {
  return {
    description: `${p.size} ${p.brand} ${p.model}`.toUpperCase(),
    sizeDisplay: p.size,
    sizeRaw: p.size,
    isTyre: true,
    ply: 18,
    priceIncludesTax: p.kind === "own",
    currency: "USD",
    stock: p.kind === "provider" ? 40 : null,
    priceDate: TODAY,
    source: "excel",
    sourceRef: "test.xlsx",
    ...p,
  };
}

const ROWS: PriceRow[] = [
  // lista propia: 472 con IGV = 400 sin IGV
  row({ id: "own-valor87", provider: "360 Tyres", kind: "own", brand: "Fenixway", model: "Valor 87", size: "295/80R22.5", cost: 472 }),
  // proveedor: costo 200 sin IGV (236 con IGV); venta = 200 × 1,15 = 230 sin IGV
  row({ id: "prov-flama77", provider: "Llantas del Sur", kind: "provider", brand: "Fenixway", model: "Flama 77", size: "315/80R22.5", cost: 200 }),
];

let seq = 0;
let client: FakeWhatsAppClient;
let portal: JsonPortalStore;
let prices: JsonStore;
let bot: BotHandler;
let frank: PortalUser;
let andes: Company;
let roca: Company;
const saved: Record<string, string | undefined> = {};

const textMsg = (body: string): InboundMessage => ({ id: `wamid.oc${++seq}`, from: FRANK, timestamp: "1", type: "text", text: body, forwarded: false });
const docMsg = (caption: string | undefined, mediaId: string, fileName = "OC-4500123.pdf"): InboundMessage => ({
  id: `wamid.oc${++seq}`,
  from: FRANK,
  timestamp: "1",
  type: "document",
  text: caption,
  forwarded: false,
  media: { id: mediaId, mimeType: "application/pdf", fileName, caption },
});

/** Mensajes nuevos del bot tras `msg`. */
async function say(msg: InboundMessage | string): Promise<OutboundMessage[]> {
  const before = client.sent.length;
  await bot.handle(typeof msg === "string" ? textMsg(msg) : msg);
  return client.sent.slice(before);
}
/** Lo último que leyó el vendedor: texto o body de un interactivo (las preguntas con botones). */
const lastText = (out: OutboundMessage[]) => [...out].reverse().find((m) => m.kind === "text" || m.kind === "interactive")?.body ?? "";

async function sheetOf(doc: OutboundMessage): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(doc.file! as unknown as ArrayBuffer);
  return wb.getWorksheet("Formato de Pedido")!;
}
const cell = (ws: ExcelJS.Worksheet, a: string) => {
  const v = ws.getCell(a).value;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v && typeof v === "object" && "result" in v) return (v as { result: unknown }).result;
  return v;
};

/** Cotización 032 para ANDES enlazada a su oportunidad: 8 llantas propias a 254 + 4 del proveedor. */
async function seedQuote(items?: QuoteItem[]) {
  const base: QuoteItem[] = items ?? [
    { description: "Llanta Fenixway Valor 87 295/80R22.5 18PR", brand: "Fenixway", model: "Valor 87", size: "295/80R22.5", sizeDisplay: "295/80R22.5", ply: 18, quantity: 8, unitPrice: 254, listPrice: 400, discountPct: 36.5, total: 2032, origin: "own", manualPrice: true, provider: "360 Tyres", priceDate: TODAY, available: null },
    { description: "Llanta Fenixway Flama 77 315/80R22.5 18PR", brand: "Fenixway", model: "Flama 77", size: "315/80R22.5", sizeDisplay: "315/80R22.5", ply: 18, quantity: 4, unitPrice: 230, discountPct: 0, total: 920, origin: "provider", provider: "Llantas del Sur", unitCost: 200, priceDate: TODAY, available: 40 },
  ];
  const quote = buildQuote({
    number: "NOVIEMBRE 2026 - 032",
    request: { raw: "pedido de prueba", lines: [], parsedBy: "regex", customerCompany: "TRANSPORTES ANDES DEL PERU S.A.C.", address: "Av. Los Andes 450, Ate", paymentTerm: "45 días" },
    items: base,
    settings,
    today: TODAY,
    requestedBy: FRANK,
  });
  await prices.saveQuote(quote);
  const opp = await portal.createOpportunity({ companyId: andes.id, ownerUserId: frank.id, etapa: "cotizacion_enviada", quoteNumber: quote.number, createdBy: frank.id });
  return { quote, opp };
}

beforeEach(async () => {
  for (const k of ["LLM_DISABLED", "PHOTOS_DISABLED", "DEEPGRAM_API_KEY", "PORTAL_SESSION_SECRET"]) saved[k] = process.env[k];
  process.env.LLM_DISABLED = "1";
  process.env.PHOTOS_DISABLED = "1";
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  delete process.env.DEEPGRAM_API_KEY;
  client = new FakeWhatsAppClient();
  portal = JsonPortalStore.memory();
  prices = JsonStore.memory();
  await prices.upsertRows(ROWS);
  frank = await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  const r = await portal.upsertCompanies([
    { ruc: RUC_ANDES, razonSocial: "TRANSPORTES ANDES DEL PERU S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 12, llantasPiso: 72 },
    { ruc: RUC_ROCA, razonSocial: "E.T. LA ROCA S.R.L.", sector: "carga", departamento: "LIMA", unidades: 15, llantasPiso: 150 },
  ]);
  // `oc` exige poder editar la empresa (como `cita`): las dos son de Frank
  andes = (await portal.updateCompany(r.ids[RUC_ANDES], { ownerUserId: frank.id }))!;
  roca = (await portal.updateCompany(r.ids[RUC_ROCA], { ownerUserId: frank.id }))!;
  await portal.addContact({ companyId: andes.id, nombre: "Rosa Díaz", cargo: "jefa de flota", telefono: "987654321" });
  configureOrderBot({ priceStore: prices, settings });
  bot = new BotHandler({ client, store: prices, settings, portalStore: portal });
});

afterEach(() => {
  configureOrderBot(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("oc: con cotización enlazada y PDF adjunto", () => {
  it("guarda la OC con el PDF, pregunta una por una, llena el Excel y cierra la oportunidad sin tocar sales", async () => {
    const { opp } = await seedQuote();
    const pdf = Buffer.from("%PDF-1.4 orden de compra de prueba");
    client.media.set("oc-pdf-1", { data: pdf, mimeType: "application/pdf", fileName: "OC-4500123.pdf" });

    let out = await say(docMsg("oc andes 4500123", "oc-pdf-1"));
    expect(lastText(out)).toContain("OC *4500123* de *TRANSPORTES ANDES DEL PERU* registrada con el adjunto (OC-4500123.pdf)");
    expect(lastText(out)).toContain("Uso la cotización *032*");
    expect(lastText(out)).toContain("responde *sí*, o *no* para escribir otros ítems");
    const [order] = await portal.listPurchaseOrders({ companyId: andes.id });
    expect(order).toMatchObject({ numero: "4500123", status: "recibida", fileName: "OC-4500123.pdf", mimeType: "application/pdf", quoteNumber: "NOVIEMBRE 2026 - 032", userId: frank.id });
    expect("data" in order).toBe(false); // el listado no trae el archivo
    expect(Buffer.from((await portal.getPurchaseOrder(order.id))!.data!, "base64").equals(pdf)).toBe(true);

    out = await say("sí");
    expect(lastText(out)).toContain("Dirección fiscal de *TRANSPORTES ANDES DEL PERU*? (de la cotización: Av. Los Andes 450, Ate — responde *igual*");
    out = await say("igual");
    expect(lastText(out)).toContain("Dirección de entrega?");
    out = await say("Jr. Las Palmeras 120, Ate");
    expect(lastText(out)).toContain("(del portal: Rosa Díaz - Cel. 987654321");
    out = await say("igual");
    expect(lastText(out)).toContain("Agencia de transporte");
    out = await say("Andeskar, Luis Pérez 987 654 321");
    expect(lastText(out)).toContain("Fecha de entrega?");
    // una respuesta con forma de pedido o un "sí" no se van al cotizador: el paso del pedido se queda con todo
    out = await say("48 h post OC");
    expect(lastText(out)).toContain("Servicio de enllante?");
    out = await say("no");
    expect(lastText(out)).toContain("Servicio de marcado?");
    out = await say("sí");
    expect(lastText(out)).toContain("Flete por cuenta de quién?");
    out = await say("360, 20 soles x llanta");
    expect(lastText(out)).toContain("*45 días* según la cotización 032");
    out = await say("60");
    expect(lastText(out)).toContain("Condiciones de pago del proveedor y dónde se recoge?");
    out = await say("letras 90, recoge en almacén Lurín");
    expect(lastText(out)).toContain("Observaciones?");
    out = await say("entregar en horario de oficina");

    // Excel sin leyenda y luego el resumen con el recordatorio
    const doc = out.find((m) => m.kind === "document")!;
    expect(doc.fileName).toMatch(/^Pedido ATC - TRANSPORTES ANDES DEL PERU - \d{2}-\d{2}-\d{4}\.xlsx$/);
    expect(doc.caption ?? "").toBe("");
    expect(out.indexOf(doc)).toBeLessThan(out.length - 1);
    const summary = lastText(out);
    expect(summary).toContain("✅ Pedido de *TRANSPORTES ANDES DEL PERU* listo (OC 4500123, cotización 032)");
    expect(summary).toContain("Cerrado ganado");
    // corrida D: el resumen termina con el recordatorio para Patricia y la línea de avance (paso 7 de 7)
    expect(summary).toContain(`${PATRICIA_REMINDER}\n✅ Paso 7 de 7 con TRANSPORTES ANDES DEL PERU: pedido a Patricia generado`);

    const ws = await sheetOf(doc);
    expect(cell(ws, "G5")).toBe("Frank Rodríguez");
    expect(cell(ws, "G6")).toBe("TRANSPORTES ANDES DEL PERU S.A.C.");
    expect(cell(ws, "G7")).toBe(Number(RUC_ANDES));
    expect(cell(ws, "G8")).toBe("Av. Los Andes 450, Ate");
    expect(cell(ws, "G9")).toBe("Jr. Las Palmeras 120, Ate");
    expect(cell(ws, "G10")).toBe("48 h post OC");
    expect(cell(ws, "G11")).toBe("CREDITO 60 DÍAS");
    expect(cell(ws, "G12")).toBe("NO");
    expect(cell(ws, "G13")).toBe("SI");
    expect(cell(ws, "G14")).toBe("Rosa Díaz - Cel. 987654321");
    expect(cell(ws, "G15")).toBe("360TYRES");
    expect(cell(ws, "J15")).toBe("VALOR FLETE: 20 SOLES X LLANTA");
    expect(cell(ws, "C18")).toBeNull(); // código de sistema vacío
    expect(cell(ws, "E18")).toBe(8);
    expect(cell(ws, "F18")).toBe("295/80R22.5 18PR FENIXWAY VALOR 87");
    expect(cell(ws, "I18")).toBe(299.72);
    expect(cell(ws, "E19")).toBe(4);
    expect(cell(ws, "I19")).toBe(271.4);
    expect(cell(ws, "J25")).toBe(3483.36);
    expect(cell(ws, "C27")).toBe("Observaciones: entregar en horario de oficina");
    expect(cell(ws, "G29")).toBe("LLANTAS DEL SUR");
    expect(cell(ws, "G33")).toBe("315/80R22.5 18PR");
    expect(cell(ws, "G36")).toBe(236);
    expect(cell(ws, "G37")).toBe("LETRAS 90");
    expect(cell(ws, "G38")).toBe("ALMACÉN LURÍN");
    expect(cell(ws, "C41")).toBe("CONTACTO DE PERSONA EN AGENCIA ANDESKAR");
    expect(cell(ws, "C42")).toBe("Luis Pérez");
    expect(cell(ws, "D43")).toBe("987 654 321");

    // oportunidad, actividad con la venta esperada, cliente, plazo, memoria y OC
    const o = (await portal.getOpportunity(opp.id))!;
    expect(o.etapa).toBe("cerrado_ganado");
    expect(o.closedAt).not.toBeNull();
    expect(o.montoEstimado).toBe(3483.36);
    const act = (await portal.listActivities({ companyId: andes.id })).find((a) => a.tipo === "oc")!;
    expect(act.opportunityId).toBe(opp.id);
    expect(act.data).toMatchObject({ numero: "4500123", quoteNumber: "NOVIEMBRE 2026 - 032", ventaEsperada: { moneda: "USD", total: 3483.36, unidades: 12 } });
    expect((act.data!.ventaEsperada as { items: unknown[] }).items).toHaveLength(2);
    expect(await portal.salesByRuc(RUC_ANDES)).toHaveLength(0); // la venta real llega con el Excel de ventas
    const c = (await portal.getCompany(andes.id))!;
    expect(c.esCliente).toBe(true);
    expect(c.creditTermsDays).toBe(60); // el vendedor dio otro plazo: queda para la empresa
    const prof = (await portal.getOrderProfile(andes.id))!.data;
    expect(prof).toMatchObject({ direccionFiscal: "Av. Los Andes 450, Ate", direccionEntrega: "Jr. Las Palmeras 120, Ate", contacto: "Rosa Díaz - Cel. 987654321", agencia: "Andeskar", last: { fechaEntrega: "48 h post OC", enllante: "NO", marcado: "SI", flete: "360TYRES", pagoProveedor: "LETRAS 90" } });
    expect((await portal.getPurchaseOrder(order.id))!.status).toBe("pedido_generado");
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
  });
});

describe("oc: sin cotización previa", () => {
  it("pide los ítems con el formato de cotización y los arma con las listas (precio escrito manda)", async () => {
    let out = await say("oc roca 7788");
    expect(lastText(out)).toContain("No encontré una cotización tuya para *E.T. LA ROCA*");
    expect(lastText(out)).toContain("Escríbeme los ítems de la OC con el formato de cotización");
    out = await say("8 x Fenixway Flama 77 315/80R22.5 a 254\n4 x Fenixway Valor 87 295/80R22.5");
    const t = lastText(out);
    expect(t).toContain("Entendí:");
    expect(t).toContain("8 × 315/80R22.5 18PR FENIXWAY FLAMA 77 — US$ 299.72 c/u _(LLANTAS DEL SUR)_"); // 254 + IGV
    expect(t).toContain("4 × 295/80R22.5 18PR FENIXWAY VALOR 87 — US$ 472.00 c/u"); // lista propia
    expect(t).toContain("Dirección fiscal de *E.T. LA ROCA*?");
    const answers = ["Av. Industrial 300, Lurín", "la misma", "Pedro Soto 999888777", "ninguna", "20/11", "sí", "no", "cliente", "contado", "contado, recoge en almacén del proveedor", "ninguna"];
    for (const a of answers) out = await say(a);
    const doc = out.find((m) => m.kind === "document")!;
    const ws = await sheetOf(doc);
    expect(cell(ws, "G6")).toBe("E.T. LA ROCA S.R.L.");
    expect(cell(ws, "F18")).toBe("315/80R22.5 18PR FENIXWAY FLAMA 77");
    expect(cell(ws, "I18")).toBe(299.72);
    expect(cell(ws, "F19")).toBe("295/80R22.5 18PR FENIXWAY VALOR 87");
    expect(cell(ws, "I19")).toBe(472);
    expect(cell(ws, "G10")).toBe("2026-11-20");
    expect(cell(ws, "G11")).toBe("CONTADO");
    expect(cell(ws, "G29")).toBe("LLANTAS DEL SUR");
    expect(cell(ws, "G36")).toBe(236);
    expect(cell(ws, "G38")).toBe("ALMACÉN DEL PROVEEDOR");
    expect(cell(ws, "C41")).toBe("CONTACTO DE PERSONA EN AGENCIA");
    expect(lastText(out)).toContain("(OC 7788)");
    // sin oportunidad previa: se crea y queda en Cerrado ganado
    const opps = await portal.listOpportunities({ companyId: roca.id });
    expect(opps).toHaveLength(1);
    expect(opps[0].etapa).toBe("cerrado_ganado");
    expect((await portal.getCompany(roca.id))!.creditTermsDays).toBe(0);
  });

  it("más de 7 ítems: lo dice y pide dividir; el paso sigue esperando los ítems", async () => {
    await say("oc roca");
    const lines = Array.from({ length: 8 }, (_, i) => `${i + 1} x Fenixway Valor 87 295/80R22.5 precio ${200 + i}`).join("\n");
    const out = await say(lines);
    expect(lastText(out)).toContain("tiene 7 filas de ítems y escribiste 8");
    expect(lastText(out)).toContain("Divide la OC en dos pedidos");
    const step = (await getPending(portal, FRANK, new Date())) as OcStep;
    expect(step.kind).toBe(OC_STEP);
    expect(step.phase).toBe("items");
    expect(out.some((m) => m.kind === "document")).toBe(false);
  });

  it("cotización enlazada de más de 7 ítems: avisa y pide los ítems", async () => {
    const item = (i: number): QuoteItem => ({ description: `Llanta ${i}`, brand: "Fenixway", model: "Valor 87", size: "295/80R22.5", sizeDisplay: "295/80R22.5", quantity: 1, unitPrice: 250 + i, discountPct: 0, total: 250 + i, origin: "manual", provider: "manual", priceDate: TODAY, available: null });
    await seedQuote(Array.from({ length: 8 }, (_, i) => item(i)));
    const out = await say("oc andes 4500999");
    expect(lastText(out)).toContain("La cotización *032* tiene 8 ítems. El formato de pedido tiene 7 filas de ítems y este pedido tiene 8. Divídelo en dos pedidos.");
    expect(lastText(out)).toContain("Escríbeme los ítems de la OC");
  });
});

describe("oc: preguntas con botones (corrida D)", () => {
  /** Pulsa `title` en el último interactivo: entra como lo manda WhatsApp (button_reply con el id `pt:…`). */
  function press(title: string): InboundMessage {
    const last = client.interactives().at(-1);
    const b = last?.type === "button" ? last.buttons.find((x) => x.title === title) : undefined;
    if (!b) throw new Error(`no hay botón «${title}» (último: ${JSON.stringify(last)})`);
    const payload = { entry: [{ changes: [{ field: "messages", value: { messages: [{ id: `wamid.oc${++seq}`, from: FRANK, timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: b.id, title } } }] } }] }] };
    return parseWebhook(payload).messages[0];
  }
  const titles = (out: OutboundMessage[]) => {
    const m = [...out].reverse().find((x) => x.kind === "interactive" || x.kind === "text");
    return m?.interactive?.type === "button" ? m.interactive.buttons.map((b) => b.title) : [];
  };

  it("cotización *Sí*/*No*, *Igual*, *La misma*, *Ninguna*, *Sí*/*No* y *Cliente*: pulsarlos completa el pedido como escribirlos", async () => {
    await seedQuote();
    let out = await say("oc andes 4500123");
    expect(titles(out)).toEqual(["Sí", "No"]);
    out = await say(press("Sí"));
    expect(lastText(out)).toContain("Dirección fiscal de *TRANSPORTES ANDES DEL PERU*?");
    expect(titles(out)).toEqual(["Igual"]);
    out = await say(press("Igual"));
    expect(titles(out)).toEqual(["La misma"]);
    out = await say(press("La misma"));
    expect(lastText(out)).toContain("Persona de contacto");
    out = await say(press("Igual"));
    expect(titles(out)).toEqual(["Ninguna"]);
    out = await say(press("Ninguna"));
    expect(lastText(out)).toContain("Fecha de entrega?");
    expect(titles(out)).toEqual([]); // sin defecto: respuesta libre
    out = await say("20/11");
    expect(titles(out)).toEqual(["Sí", "No"]);
    out = await say(press("Sí"));
    out = await say(press("No"));
    expect(titles(out)).toEqual(["Cliente", "360", "Agencia"]);
    out = await say(press("Cliente"));
    expect(titles(out)).toEqual(["Igual", "Contado"]);
    out = await say(press("Igual"));
    out = await say("letras 90, almacén Steel");
    expect(titles(out)).toEqual(["Ninguna"]);
    out = await say(press("Ninguna"));
    const ws = await sheetOf(out.find((m) => m.kind === "document")!);
    expect(cell(ws, "G8")).toBe("Av. Los Andes 450, Ate");
    expect(cell(ws, "G9")).toBe("Av. Los Andes 450, Ate");
    expect(cell(ws, "G12")).toBe("SI");
    expect(cell(ws, "G13")).toBe("NO");
    expect(cell(ws, "G15")).toBe("CLIENTE");
    expect(lastText(out)).toContain(PATRICIA_REMINDER);
  });
});

describe("oc: memoria del cliente", () => {
  it("ofrece los datos y las respuestas de la última vez; *igual* los acepta", async () => {
    await portal.setOrderProfile(roca.id, {
      direccionFiscal: "Av. Industrial 300, Lurín",
      direccionEntrega: "Almacén Chilca km 62",
      contacto: "Pedro Soto 999888777",
      agencia: "",
      last: { fechaEntrega: "48 h post OC", enllante: "SI", marcado: "NO", flete: "AGENCIA", valorFlete: "15 SOLES X LLANTA", observaciones: "llamar antes" },
    });
    await portal.updateCompany(roca.id, { creditTermsDays: 30 });
    await say("oc roca 5500");
    let out = await say("4 x Fenixway Valor 87 295/80R22.5");
    let t = lastText(out);
    expect(t).toContain("Datos de *E.T. LA ROCA* de la última vez:");
    expect(t).toContain("• Dirección de entrega: Almacén Chilca km 62");
    expect(t).toContain("• Agencia: ninguna");
    out = await say("igual");
    expect(lastText(out)).toContain("Fecha de entrega? (la última vez: 48 h post OC — responde *igual* o escribe otra)");
    out = await say("igual");
    expect(lastText(out)).toContain("la última vez: si — *igual*");
    out = await say("igual");
    expect(lastText(out)).toContain("la última vez: no — *igual*");
    out = await say("ok");
    expect(lastText(out)).toContain("La última vez: AGENCIA, 15 SOLES X LLANTA");
    out = await say("igual");
    t = lastText(out);
    expect(t).toContain("*30 días* de E.T. LA ROCA en el portal");
    out = await say("igual");
    expect(lastText(out)).toContain("(la última vez: llamar antes — responde *igual*");
    out = await say("igual"); // sin ítems de terceros no pregunta por el proveedor
    const ws = await sheetOf(out.find((m) => m.kind === "document")!);
    expect(cell(ws, "G8")).toBe("Av. Industrial 300, Lurín");
    expect(cell(ws, "G9")).toBe("Almacén Chilca km 62");
    expect(cell(ws, "G10")).toBe("48 h post OC");
    expect(cell(ws, "G11")).toBe("CREDITO 30 DÍAS");
    expect(cell(ws, "G12")).toBe("SI");
    expect(cell(ws, "G13")).toBe("NO");
    expect(cell(ws, "G14")).toBe("Pedro Soto 999888777");
    expect(cell(ws, "G15")).toBe("AGENCIA");
    expect(cell(ws, "J15")).toBe("VALOR FLETE: 15 SOLES X LLANTA");
    expect(cell(ws, "C27")).toBe("Observaciones: llamar antes");
    expect(cell(ws, "G29")).toBeNull();
    expect((await portal.getCompany(roca.id))!.creditTermsDays).toBe(30); // aceptó el plazo de la empresa: no cambia
  });

  it("corrige un dato recordado con *entrega: …* y una respuesta que no se entiende repite la pregunta", async () => {
    await portal.setOrderProfile(roca.id, { direccionFiscal: "Av. Industrial 300, Lurín", direccionEntrega: "Almacén Chilca km 62", contacto: "Pedro Soto", agencia: "" });
    await say("oc roca");
    await say("4 x Fenixway Valor 87 295/80R22.5");
    let out = await say("entrega: Av. Nueva 500, Callao");
    expect(lastText(out)).toContain("Fecha de entrega?");
    out = await say("mañana");
    expect(lastText(out)).toContain("Servicio de enllante?");
    out = await say("tal vez");
    expect(lastText(out)).toContain("Responde *sí* o *no*.");
    expect(lastText(out)).toContain("Servicio de enllante?");
    for (const a of ["no", "no", "cliente", "15", "ninguna"]) out = await say(a);
    const ws = await sheetOf(out.find((m) => m.kind === "document")!);
    expect(cell(ws, "G9")).toBe("Av. Nueva 500, Callao");
    expect(cell(ws, "G8")).toBe("Av. Industrial 300, Lurín");
    expect((await portal.getOrderProfile(roca.id))!.data.direccionEntrega).toBe("Av. Nueva 500, Callao");
  });
});

describe("oc: respuesta por voz", () => {
  it("una nota de voz en una pregunta se transcribe con el camino de los reportes y vale como respuesta", async () => {
    process.env.DEEPGRAM_API_KEY = "dg-test-key";
    const deepgramFetch = (async () =>
      new Response(JSON.stringify({ metadata: { duration: 2 }, results: { channels: [{ alternatives: [{ transcript: "48 horas después de la OC", confidence: 0.9 }] }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    configureReportBot({ llm: null, deepgramFetch, downloadMedia: async () => ({ data: Buffer.from("ogg"), mimeType: "audio/ogg" }), logMessage: async () => undefined });
    try {
      await portal.setOrderProfile(roca.id, { direccionFiscal: "Av. Industrial 300", direccionEntrega: "Av. Industrial 300", contacto: "Pedro Soto", agencia: "" });
      await say("oc roca");
      await say("4 x Fenixway Valor 87 295/80R22.5");
      await say("igual");
      const out = await say({ id: `wamid.oc${++seq}`, from: FRANK, timestamp: "1", type: "audio", forwarded: false, media: { id: "aud-oc", mimeType: "audio/ogg" } });
      const texts = out.filter((m) => m.kind === "text" || m.kind === "interactive").map((m) => m.body ?? "");
      expect(texts[0]).toContain("🎙️ Entendí: «48 horas después de la OC»");
      expect(texts[1]).toContain("Servicio de enllante?");
      const step = (await getPending(portal, FRANK, new Date())) as OcStep;
      expect(step.answers.fechaEntrega).toBe("48 horas después de la OC");
    } finally {
      configureReportBot(null);
    }
  });
});

describe("oc: adjunto después del comando", () => {
  async function ctxFor(msg: InboundMessage, out: string[]): Promise<PortalContext> {
    return {
      store: portal,
      user: frank,
      from: FRANK,
      msg,
      reply: async (b) => void out.push(b),
      sendDocument: async () => undefined,
      sendTextTo: async () => undefined,
      requote: async () => undefined,
      env: {},
      now: new Date(),
      log: () => undefined,
      downloadMedia: (id) => client.downloadMedia(id),
    };
  }

  it("el PDF que llega en los 10 min siguientes se guarda en la OC y repite la pregunta", async () => {
    await say("oc roca 4500123");
    const step = (await getPending(portal, FRANK, new Date())) as OcStep;
    expect(step).toMatchObject({ kind: OC_STEP, captureText: true, acceptsMedia: true, hasFile: false });
    // el router deja pasar el adjunto al paso pendiente
    expect(classifyIntent({ text: "", hasMedia: true, mediaType: "document", state: "idle", isPortalUser: true, pendingPortalStep: step })).toBe("portal_flow");
    client.media.set("oc-late", { data: Buffer.from("%PDF tarde"), mimeType: "application/pdf", fileName: "orden.pdf" });
    const out: string[] = [];
    const msg = docMsg(undefined, "oc-late", "orden.pdf");
    await getPendingHandler(OC_STEP)!(await ctxFor(msg, out), step, "");
    expect(out[0]).toContain("📎 Guardé la OC (orden.pdf).");
    expect(out[0]).toContain("Escríbeme los ítems");
    const order = (await portal.getPurchaseOrder(step.orderId))!;
    expect(order.fileName).toBe("orden.pdf");
    expect(Buffer.from(order.data!, "base64").toString()).toBe("%PDF tarde");
    expect(((await getPending(portal, FRANK, new Date())) as OcStep).hasFile).toBe(true);
  });

  it("por el handler: el PDF sin leyenda justo después de oc llega al paso pendiente y se guarda", async () => {
    await say("oc roca 4500123");
    const step = (await getPending(portal, FRANK, new Date())) as OcStep;
    client.media.set("oc-handler", { data: Buffer.from("%PDF por handler"), mimeType: "application/pdf", fileName: "oc.pdf" });
    const out = await say(docMsg(undefined, "oc-handler", "oc.pdf"));
    expect(out.map((m) => ("body" in m ? m.body : "")).join("\n")).toContain("📎 Guardé la OC (oc.pdf).");
    expect(Buffer.from((await portal.getPurchaseOrder(step.orderId))!.data!, "base64").toString()).toBe("%PDF por handler");
  });

  it("pasados 10 min no lo guarda", async () => {
    await say("oc roca 4500123");
    const step = (await getPending(portal, FRANK, new Date())) as OcStep;
    const old = { ...step, mediaUntil: new Date(Date.now() - 1000).toISOString() };
    await setPending(portal, FRANK, old, new Date());
    client.media.set("oc-late2", { data: Buffer.from("x"), mimeType: "application/pdf" });
    const out: string[] = [];
    await getPendingHandler(OC_STEP)!(await ctxFor(docMsg(undefined, "oc-late2"), out), old, "");
    expect(out[0]).toContain("más de 10 min");
    expect((await portal.getPurchaseOrder(step.orderId))!.data).toBeNull();
  });
});

describe("oc: piezas puras", () => {
  it("parseOcArgs", () => {
    expect(parseOcArgs("zbuss 4500123")).toEqual({ empresa: "zbuss", numero: "4500123" });
    expect(parseOcArgs("zbuss n° 45")).toEqual({ empresa: "zbuss", numero: "45" });
    expect(parseOcArgs("20602221505 4500123")).toEqual({ empresa: "20602221505", numero: "4500123" });
    expect(parseOcArgs("20602221505")).toEqual({ empresa: "20602221505", numero: null });
    expect(parseOcArgs("expreso 2000")).toEqual({ empresa: "expreso 2000", numero: null });
    expect(parseOcArgs("la roca oc OC-778")).toEqual({ empresa: "la roca", numero: "OC-778" });
  });

  it("respuestas cortas", () => {
    expect(parseFlete("cliente")).toEqual({ flete: "CLIENTE" });
    expect(parseFlete("360, 20 soles x llanta")).toEqual({ flete: "360TYRES", valorFlete: "20 SOLES X LLANTA" });
    expect(parseFlete("agencia 15 soles")).toEqual({ flete: "AGENCIA", valorFlete: "15 SOLES" });
    expect(parseProveedor("contado, recoge en Lurín")).toEqual({ pagoProveedor: "CONTADO", recojo: "LURÍN" });
    expect(parseProveedor("letras 90")).toEqual({ pagoProveedor: "LETRAS 90" });
    expect(parseAgencia("ninguna")).toEqual({ agencia: "" });
    expect(parseAgencia("Andeskar, Luis Pérez 987 654 321")).toEqual({ agencia: "Andeskar", agenciaContacto: "Luis Pérez", agenciaTelefono: "987 654 321" });
    expect(parsePlazo("45 días")).toBe(45);
    expect(parsePlazo("contado")).toBe(0);
    expect(parsePlazo("pronto")).toBeNull();
    const now = new Date("2026-11-11T15:00:00Z");
    expect(parseFechaEntrega("20/11", now)).toBe("2026-11-20");
    expect(parseFechaEntrega("48 h post OC", now)).toBe("48 h post OC");
    expect(normalizeOrderItemsText("8 x Fenixway Flama 77 315/80R22.5 a 254\n2 x 11R22.5 a US$ 300.50")).toBe("8 x Fenixway Flama 77 315/80R22.5 precio 254\n2 x 11R22.5 precio 300.50");
  });

  it("router: el paso del pedido se queda con textos con forma de pedido; otros pasos no", () => {
    const base = { hasMedia: false, state: "idle", isPortalUser: true };
    const items = "8 x Fenixway Flama 77 315/80R22.5 a 254";
    expect(classifyIntent({ ...base, text: items, pendingPortalStep: { kind: OC_STEP, captureText: true } })).toBe("portal_flow");
    expect(classifyIntent({ ...base, text: items, pendingPortalStep: { kind: "report_draft" } })).toBe("quote");
    expect(classifyIntent({ ...base, text: "", hasMedia: true, mediaType: "document", pendingPortalStep: { kind: "report_draft" } })).toBe("passthrough");
  });
});

describe("revisión B: el pedido de la OC no se queda con lo que no es suyo", () => {
  const imgMsg = (caption: string, mediaId: string): InboundMessage => ({ id: `wamid.oc${++seq}`, from: FRANK, timestamp: "1", type: "image", text: caption, forwarded: false, media: { id: mediaId, mimeType: "image/jpeg", caption } });
  const all = (out: OutboundMessage[]) => out.map((m) => ("body" in m ? (m.body ?? "") : "")).join("\n");
  const parked = async () => parkedOf(await portal.getPortalConversation(FRANK), OC_STEP, new Date()) as OcStep | null;
  // corrida D (punto 7): el pedido ya no se "aparta" con un aviso antes del cotizador; pasa a pausa y el recordatorio va
  // DESPUÉS de la respuesta del cotizador, con *Continuar* / *Descartar*. `oc <RUC>` lo sigue retomando.
  const NOTICE = "⏸ Dejaste pendiente: pedido de la OC 7788 de E.T. LA ROCA (";

  async function toQuestions() {
    await say("oc roca 7788");
    const out = await say("4 x Fenixway Valor 87 295/80R22.5");
    expect(lastText(out)).toContain("Dirección fiscal de *E.T. LA ROCA*?");
    const step = (await getPending(portal, FRANK, new Date())) as OcStep;
    expect(step).toMatchObject({ phase: "questions", captureText: false, keepText: true });
    return step;
  }

  it("fase de ítems: *ayuda* y *proveedores* van al cotizador; el pedido se aparta con aviso y *oc <RUC>* lo retoma", async () => {
    await say("oc roca 7788");
    const step = (await getPending(portal, FRANK, new Date())) as OcStep;
    expect(step).toMatchObject({ phase: "items", captureText: true, keepText: false });
    let out = await say("ayuda");
    expect(all(out)).toContain(NOTICE);
    expect(all(out)).toContain("cotiz"); // la ayuda del cotizador
    // el recordatorio es lo último (después del cotizador) y lleva los botones
    expect(lastText(out)).toBe(`${NOTICE}faltan los ítems).`);
    expect(out.at(-1)).toMatchObject({ kind: "interactive", interactive: { buttons: [{ title: "Continuar" }, { title: "Descartar" }] } });
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
    expect((await parked())?.orderId).toBe(step.orderId);
    out = await say(`oc ${RUC_ROCA}`);
    expect(lastText(out)).toContain("▶️ Retomo el pedido de la OC *7788* de *E.T. LA ROCA*.");
    expect(lastText(out)).toContain("Escríbeme los ítems de la OC");
    expect(((await getPending(portal, FRANK, new Date())) as OcStep).orderId).toBe(step.orderId);
    expect(await portal.listPurchaseOrders({ companyId: roca.id })).toHaveLength(1); // misma OC, no otra
    expect(await parked()).toBeNull();
    out = await say("proveedores");
    expect(all(out)).toContain(NOTICE);
  });

  it("preguntas: un pedido nuevo (con medida) va al cotizador; un *gracias* después no se lo queda el pedido", async () => {
    const step = await toQuestions();
    const out = await say("Fenixway Valor 87 295/80R22.5 x4 para Transportes Beta");
    expect(all(out)).toContain(NOTICE);
    expect(all(out)).toContain("Cotización nueva");
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
    // retomarlo conserva lo respondido (la pregunta en curso)
    await prices.setConversation(FRANK, null);
    const back = await say("oc roca 7788");
    expect(lastText(back)).toContain("Dirección fiscal de *E.T. LA ROCA*?");
    expect(((await getPending(portal, FRANK, new Date())) as OcStep).items).toEqual(step.items);
  });

  it("preguntas: *proveedores* y *ayuda* van al cotizador; *entrega: …* sigue siendo respuesta", async () => {
    await toQuestions();
    await say("Av. Industrial 300, Lurín");
    const out = await say("proveedores");
    expect(all(out)).toContain(NOTICE);
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
  });

  it("fase de cotización: un texto con medida de llanta es un pedido nuevo", async () => {
    await seedQuote();
    await say("oc andes 4500777");
    const out = await say("Fenixway Valor 87 295/80R22.5 x2 para Transportes Beta");
    expect(all(out)).toContain("⏸ Dejaste pendiente: pedido de la OC 4500777 de TRANSPORTES ANDES DEL PERU (falta confirmar la cotización)."); // corrida D
    expect(all(out)).toContain("Cotización nueva");
  });

  it("Observaciones: un pedido no vale como observación (va al cotizador); una observación normal sí", async () => {
    await toQuestions();
    for (const a of ["Av. Industrial 300, Lurín", "la misma", "Pedro Soto 999888777", "ninguna", "20/11", "sí", "no", "cliente", "contado"]) await say(a);
    expect(((await getPending(portal, FRANK, new Date())) as OcStep).field).toBe("observaciones");
    let out = await say("cotízame 8 llantas Fenixway para Transportes Beta");
    expect(all(out)).toContain(NOTICE);
    expect(out.some((m) => m.kind === "document" && /^Pedido ATC/.test(m.fileName ?? ""))).toBe(false);
    expect((await parked())?.answers.observaciones).toBeUndefined();
    await prices.setConversation(FRANK, null);
    out = await say("oc roca");
    expect(lastText(out)).toContain("Observaciones?");
    out = await say("295/80R22.5 x4 para Transportes Beta"); // con medida: el router ya lo manda al cotizador
    expect(all(out)).toContain(NOTICE);
    await prices.setConversation(FRANK, null);
    await say("oc roca");
    out = await say("llamar antes de llegar");
    expect(out.some((m) => m.kind === "document")).toBe(true);
    expect(lastText(out)).toContain("Obs.: llamar antes de llegar");
  });

  it("adjuntos: foto con leyenda *foto …* y lista de precios con leyenda siguen al cotizador; fuera de los 10 min también", async () => {
    await say("oc roca 7788");
    const step = (await getPending(portal, FRANK, new Date())) as OcStep;
    client.media.set("img-foto", { data: Buffer.from("jpg"), mimeType: "image/jpeg" });
    let out = await say(imgMsg("foto Fenixway Valor 87", "img-foto"));
    expect(all(out)).not.toContain("Guardé la OC");
    client.media.set("lista-1", { data: Buffer.from("medida,precio\n295/80R22.5,400\n"), mimeType: "text/csv", fileName: "lista.csv" });
    out = await say({ ...docMsg("lista de precios Llantas del Sur", "lista-1", "lista.csv"), media: { id: "lista-1", mimeType: "text/csv", fileName: "lista.csv", caption: "lista de precios Llantas del Sur" } });
    expect(all(out)).not.toContain("Guardé la OC");
    expect((await portal.getPurchaseOrder(step.orderId))!.data).toBeNull();
    // el paso no se perdió por esos adjuntos
    await prices.setConversation(FRANK, null);
    expect(((await getPending(portal, FRANK, new Date())) as OcStep | null)?.orderId ?? (await parked())?.orderId).toBe(step.orderId);
    // pasados los 10 min, un PDF sin leyenda tampoco es la OC
    await setPending(portal, FRANK, { ...step, mediaUntil: new Date(Date.now() - 1000).toISOString() }, new Date());
    client.media.set("tarde", { data: Buffer.from("%PDF"), mimeType: "application/pdf", fileName: "lista2.pdf" });
    out = await say(docMsg(undefined, "tarde", "lista2.pdf"));
    expect(all(out)).toContain("lista de precios");
    expect((await portal.getPurchaseOrder(step.orderId))!.data).toBeNull();
  });
});

describe("revisión B: oc y el cotizador, permisos, plazo y cancelar", () => {
  it("con una cotización a medio armar (choose) no toca nada y pide terminarla o cancelarla", async () => {
    await say("Fenixway Valor 87 295/80R22.5 x4 para Transportes Beta");
    const before = await prices.getConversation(FRANK);
    expect(before?.step).not.toBe("idle");
    expect(["review_quote", "need_email"]).not.toContain(before?.step);
    const out = await say("oc roca 7788");
    expect(lastText(out)).toBe("Tienes una cotización/lista a medio armar; termínala o escribe *cancelar* y vuelve a mandar *oc …*");
    expect(await prices.getConversation(FRANK)).toEqual(before);
    expect(await portal.listPurchaseOrders({ companyId: roca.id })).toHaveLength(0);
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
  });

  it("con un perfil esperando el pedido tampoco; con review_quote cierra el paso (la cotización ya está guardada)", async () => {
    await prices.setConversation(FRANK, { phone: FRANK, step: "idle", profile: "prosegur", updatedAt: new Date().toISOString() });
    expect(lastText(await say("oc roca"))).toContain("a medio armar");
    for (const step of ["choose", "need_provider", "need_fields", "need_application", "confirm_new"] as const) {
      await prices.setConversation(FRANK, { phone: FRANK, step, updatedAt: new Date().toISOString() });
      expect([step, lastText(await say("oc roca"))]).toEqual([step, "Tienes una cotización/lista a medio armar; termínala o escribe *cancelar* y vuelve a mandar *oc …*"]);
      expect((await prices.getConversation(FRANK))?.step).toBe(step);
    }
    for (const step of ["review_quote", "need_email"] as const) {
      await prices.setConversation(FRANK, { phone: FRANK, step, updatedAt: new Date().toISOString() });
      expect(lastText(await say("oc roca"))).toContain("Escríbeme los ítems de la OC");
      expect((await prices.getConversation(FRANK))?.step ?? "idle").toBe("idle");
      await say("cancelar");
    }
  });

  it("empresa de otro vendedor: Primero *asignarme RUC*", async () => {
    const juan = await portal.upsertUser({ nombre: "Juan Bustios", whatsapp: "51900000009", rol: "vendedor" });
    await portal.updateCompany(roca.id, { ownerUserId: juan.id });
    const out = await say("oc roca 7788");
    expect(lastText(out)).toBe(`*E.T. LA ROCA S.R.L.* no es tuya. Primero: *asignarme ${RUC_ROCA}* (o pide al supervisor).`);
    expect(await portal.listPurchaseOrders({ companyId: roca.id })).toHaveLength(0);
  });

  it("plazo escrito en la OC: no cambia el plazo que la empresa ya tenía y lo dice en el resumen", async () => {
    await portal.updateCompany(roca.id, { creditTermsDays: 30 });
    await say("oc roca 7788");
    await say("4 x Fenixway Valor 87 295/80R22.5");
    let out: OutboundMessage[] = [];
    for (const a of ["Av. Industrial 300, Lurín", "la misma", "Pedro Soto 999888777", "ninguna", "20/11", "sí", "no", "cliente", "60", "ninguna"]) out = await say(a);
    const ws = await sheetOf(out.find((m) => m.kind === "document")!);
    expect(cell(ws, "G11")).toBe("CREDITO 60 DÍAS"); // el pedido lleva lo que dijo el vendedor
    expect(lastText(out)).toContain("El plazo habitual sigue en 30 días; cámbialo en el portal si corresponde.");
    expect((await portal.getCompany(roca.id))!.creditTermsDays).toBe(30);
  });

  it("*cancelar* durante el pedido marca la OC como cancelada", async () => {
    await say("oc roca 7788");
    const step = (await getPending(portal, FRANK, new Date())) as OcStep;
    await say("cancelar");
    expect((await portal.getPurchaseOrder(step.orderId))!.status).toBe("cancelada");
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
    expect(lastText(await say("oc roca 7788"))).toContain("registrada"); // OC nueva, no la cancelada
    expect(await portal.listPurchaseOrders({ companyId: roca.id })).toHaveLength(2);
  });
});

describe("oc: modelo que no existe en esa medida (corrida F, punto 7)", () => {
  // caso real: "Fenixway Flama 77 295/80R22.5" quedó como FLAMA 89 (bastaba un parecido de 0,6)
  beforeEach(async () => {
    await prices.upsertRows([
      row({ id: "own-flama89-295", provider: "360 Tyres", kind: "own", brand: "Fenixway", model: "Flama 89", size: "295/80R22.5", cost: 495.6 }),
      row({ id: "prov-flama77-315b", provider: "Llantas del Sur", kind: "provider", brand: "Fenixway", model: "Flama 77", size: "315/80R22.5", cost: 210 }),
    ]);
  });
  function press(title: string): InboundMessage {
    const last = client.interactives().at(-1);
    const b = last?.type === "button" ? last.buttons.find((x) => x.title === title) : undefined;
    if (!b) throw new Error(`no hay botón «${title}» (último: ${JSON.stringify(last)})`);
    const payload = { entry: [{ changes: [{ field: "messages", value: { messages: [{ id: `wamid.oc${++seq}`, from: FRANK, timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: b.id, title } } }] } }] }] };
    return parseWebhook(payload).messages[0];
  }
  const buttonsOf = (out: OutboundMessage[]) => {
    const m = [...out].reverse().find((x) => x.kind === "interactive");
    return m?.interactive?.type === "button" ? m.interactive.buttons.map((b) => b.title) : [];
  };

  it("no sustituye en silencio: se detiene, muestra las opciones con precio y pregunta con botones; sin Excel hasta elegir", async () => {
    await say("oc roca 7788");
    let out = await say("8 x Fenixway Flama 77 295/80R22.5");
    const t = lastText(out);
    expect(t).toContain("No tengo *FLAMA 77* en esa medida (8 × Fenixway FLAMA 77 295/80R22.5)");
    expect(t).toContain("1. Fenixway Flama 89 18PR — US$ 495.60 c/u inc. IGV");
    expect(t).not.toContain("Entendí:");
    expect(buttonsOf(out)).toEqual(["Flama 89", "Valor 87"]);
    expect(buttonsOf(out).every((x) => x.length <= 20)).toBe(true);
    expect(out.some((m) => m.kind === "document")).toBe(false);
    const step = (await getPending(portal, FRANK, new Date())) as OcStep;
    expect(step.phase).toBe("model");
    expect(step.captureText).toBe(true);

    out = await say(press("Flama 89"));
    expect(lastText(out)).toContain("Entendí:");
    expect(lastText(out)).toContain("8 × 295/80R22.5 18PR FENIXWAY FLAMA 89 — US$ 495.60 c/u");
    expect(((await getPending(portal, FRANK, new Date())) as OcStep).phase).toBe("questions");
  });

  it("con precio escrito: *Dejar como escribí* lo deja como ítem manual con ese precio; elegir otro modelo mantiene el precio", async () => {
    await say("oc roca");
    let out = await say("8 x Fenixway Flama 77 295/80R22.5 a 254");
    expect(buttonsOf(out)).toEqual(["Flama 89", "Valor 87", "Dejar como escribí"]);
    expect(lastText(out)).toContain("se mantiene el precio que escribiste");
    out = await say(press("Dejar como escribí"));
    expect(lastText(out)).toContain("Entendí:");
    expect(lastText(out)).toMatch(/8 × .*FLAMA 77.* — US\$ 299\.72 c\/u/i);

    await say("cancelar");
    await say("oc roca");
    await say("8 x Fenixway Flama 77 295/80R22.5 a 254");
    out = await say("1"); // escrito: la opción 1
    expect(lastText(out)).toContain("8 × 295/80R22.5 18PR FENIXWAY FLAMA 89 — US$ 299.72 c/u");
  });

  it("modelo exacto o sin modelo pedido: sigue como hoy, sin preguntar", async () => {
    await say("oc roca");
    let out = await say("8 x Fenixway Flama 77 315/80R22.5 a 254");
    expect(lastText(out)).toContain("Entendí:");
    await say("cancelar");
    await say("oc roca");
    out = await say("4 x Fenixway 295/80R22.5");
    expect(lastText(out)).toContain("Entendí:");
    expect(buttonsOf(out)).not.toContain("Flama 89");
  });

  it("los ítems escritos de nuevo reemplazan la pregunta", async () => {
    await say("oc roca");
    await say("8 x Fenixway Flama 77 295/80R22.5");
    const out = await say("8 x Fenixway Valor 87 295/80R22.5");
    expect(lastText(out)).toContain("8 × 295/80R22.5 18PR FENIXWAY VALOR 87 — US$ 472.00 c/u");
  });
});
