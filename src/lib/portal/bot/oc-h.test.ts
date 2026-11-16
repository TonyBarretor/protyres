/**
 * Corrida H (puntos 3, 3b, 4 y 6) en el bot: pedido con stock propio y proveedor de la lista, contador de stock en las
 * opciones del cotizador y en el pedido, aviso de stock insuficiente, rehacer y anular, carga nueva, origen que se
 * pregunta, y pedidos de Prosegur por sucursal (un Excel por sucursal, memoria por sucursal, número de venta, contraste
 * con la OC en Excel). Datos inventados (empresas, RUC, UB, proveedores y teléfonos).
 */
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PriceRow } from "../../ingest/types";
import { buildQuote } from "../../quote/build";
import type { QuoteItem } from "../../quote/types";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient, type OutboundMessage } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import type { InboundMessage } from "../../whatsapp/webhook";
import { JsonPortalStore } from "../store";
import type { Company, PortalUser } from "../store/types";
import { branchFileName, configureOrderBot, parseAnular, parseOriginAnswer, PATRICIA_REMINDER_BRANCHES, quoteNumbersIn, type OcStep } from "./commands/oc";
import { getPending } from "./state";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7, paymentType: "Factura crédito", paymentTerm: "30 días" },
  salespeople: { default: "51900000001", "51900000001": { name: "Frank Rodríguez", title: "Key Account Manager", phone: "900 000 001", email: "frank@example.pe" } },
  customers: [{ name: "Prosegur", aliases: ["prosegur demo"], company: "PROSEGUR DEMO S.A.", format: "prosegur", required: [] }],
});

const FRANK = "51900000001";
const ADMIN = "51900000002";
const RUC_ANDES = "20999000011";
const RUC_ROCA = "20999000044";
const RUC_PSG = "20999000077";
const TODAY = "2026-11-16";

function row(p: Partial<PriceRow> & Pick<PriceRow, "id" | "provider" | "kind" | "brand" | "model" | "size" | "cost">): PriceRow {
  return {
    description: `${p.size} 18PR ${p.brand} ${p.model}`.toUpperCase(),
    sizeDisplay: p.size,
    sizeRaw: p.size,
    isTyre: true,
    ply: 18,
    priceIncludesTax: p.kind !== "provider",
    currency: "USD",
    stock: null,
    priceDate: TODAY,
    source: "excel",
    sourceRef: "test.xlsx",
    ...p,
  };
}

const OWN: PriceRow[] = [
  row({ id: "own-v99", provider: "Protyres", kind: "own", code: "P0336", brand: "Fenixway", model: "Valor 99", size: "215/75R17.5", cost: 185.56 }),
  row({ id: "own-v89", provider: "Protyres", kind: "own", code: "P0779", brand: "Fenixway", model: "Valor 89", size: "215/75R17.5", cost: 190 }),
];
const STOCK = (v99: number, v89: number): PriceRow[] => [
  row({ id: "stk-v99", provider: "Protyres", kind: "stock", code: "P0336", brand: "Fenixway", model: "VALOR 99", size: "215/75R17.5", cost: null, stock: v99, source: "pdf", sourceRef: "STOCK PROTYRES.pdf" }),
  row({ id: "stk-v89", provider: "Protyres", kind: "stock", code: "P0779", brand: "Fenixway", model: "VALOR 89", size: "215/75R17.5", cost: null, stock: v89, source: "pdf", sourceRef: "STOCK PROTYRES.pdf" }),
];
const JCH: PriceRow[] = [row({ id: "jch-wl", provider: "JCH", kind: "provider", brand: "Westlake", model: "CR960", size: "11R22.5", cost: 200, stock: 30 })];

let seq = 0;
let client: FakeWhatsAppClient;
let portal: JsonPortalStore;
let prices: JsonStore;
let bot: BotHandler;
let frank: PortalUser;
let andes: Company;
let psg: Company;

const textMsg = (body: string, from = FRANK): InboundMessage => ({ id: `wamid.h${++seq}`, from, timestamp: "1", type: "text", text: body, forwarded: false });
async function say(msg: InboundMessage | string): Promise<OutboundMessage[]> {
  const before = client.sent.length;
  await bot.handle(typeof msg === "string" ? textMsg(msg) : msg);
  return client.sent.slice(before);
}
const lastText = (out: OutboundMessage[]) => [...out].reverse().find((m) => m.kind === "text" || m.kind === "interactive")?.body ?? "";
const all = (out: OutboundMessage[]) => out.map((m) => m.body ?? "").join("\n");
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

const qi = (p: Partial<QuoteItem> & Pick<QuoteItem, "model" | "quantity" | "unitPrice" | "origin">): QuoteItem => ({
  description: `Llanta Fenixway ${p.model} 215/75R17.5 18PR`,
  brand: "Fenixway",
  size: "215/75R17.5",
  sizeDisplay: "215/75R17.5",
  ply: 18,
  discountPct: 0,
  total: p.unitPrice * p.quantity,
  provider: "Protyres",
  priceDate: TODAY,
  available: null,
  ...p,
});

async function saveQuote(number: string, company: string, items: QuoteItem[], extra: { unit?: string; customerProfile?: string } = {}) {
  const quote = buildQuote({
    number,
    request: { raw: "prueba", lines: [], parsedBy: "regex", customerCompany: company, paymentTerm: "30 días", ...(extra.unit ? { unit: extra.unit } : {}) },
    items,
    settings,
    today: TODAY,
    requestedBy: FRANK,
    customerProfile: extra.customerProfile,
  });
  await prices.saveQuote(quote);
  return quote;
}

beforeEach(async () => {
  process.env.LLM_DISABLED = "1";
  process.env.PHOTOS_DISABLED = "1";
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  client = new FakeWhatsAppClient();
  portal = JsonPortalStore.memory();
  prices = JsonStore.memory();
  await prices.upsertRows([...OWN, ...JCH]);
  await prices.upsertRows(STOCK(12, 20), { replace: { provider: "Protyres", kind: "stock" } });
  await prices.upsertSuppliers([
    { key: "jchllantas", name: "JCH LLANTAS", contact: "ANA PRUEBA", phone: "900 000 010", brands: ["WEST LAKE", "CHINAS"], provider: "JCH" },
    { key: "vanllantas", name: "VAN LLANTAS", contact: "LUIS PRUEBA", phone: "900 000 011", brands: ["MICHELLIN", "BFGOODRICH"] },
  ]);
  frank = await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  await portal.upsertUser({ nombre: "Admin Prueba", whatsapp: ADMIN, rol: "admin" });
  const r = await portal.upsertCompanies([
    { ruc: RUC_ANDES, razonSocial: "TRANSPORTES ANDES DEL PERU S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 12, llantasPiso: 72 },
    { ruc: RUC_ROCA, razonSocial: "E.T. LA ROCA S.R.L.", sector: "carga", departamento: "LIMA", unidades: 15, llantasPiso: 150 },
    { ruc: RUC_PSG, razonSocial: "PROSEGUR DEMO S.A.", sector: "carga", departamento: "LIMA", unidades: 50, llantasPiso: 300 },
  ]);
  andes = (await portal.updateCompany(r.ids[RUC_ANDES], { ownerUserId: frank.id }))!;
  await portal.updateCompany(r.ids[RUC_ROCA], { ownerUserId: frank.id });
  psg = (await portal.updateCompany(r.ids[RUC_PSG], { ownerUserId: frank.id }))!;
  configureOrderBot({ priceStore: prices, settings });
  bot = new BotHandler({ client, store: prices, settings, portalStore: portal });
});

afterEach(() => {
  configureOrderBot(null);
});

/** Opción de Valor 99 en las opciones del cotizador (la línea del stock propio). */
async function v99Option(): Promise<string> {
  const out = await say("215/75R17.5 Fenixway Valor 99 x4 para Transportes Beta");
  await say("cancelar");
  return all(out).split("\n").find((l) => /STOCK/.test(l) && /VALOR 99|Valor 99/i.test(l)) ?? all(out);
}

describe("contador de stock en las opciones del cotizador", () => {
  it("sin pedidos el texto es el de siempre; con un pedido muestra de dónde sale el disponible; una carga nueva lo pone en cero", async () => {
    const before = await v99Option();
    expect(before).toContain("· stock 12 ·");
    await prices.setStockDeductions("oc:1:X1", "OC X1 · PRUEBA", [{ rowId: "stk-v99", origin: "protyres|stock", warehouse: "SAN LUIS", quantity: 8, description: "215/75R17.5 18PR FENIXWAY VALOR 99" }]);
    const after = await v99Option();
    expect(after).toContain("· stock 4 (12 cargadas − 8 en pedidos) ·");
    // misma opción, mismo lugar (el orden y la opción por defecto no cambian)
    expect(after.replace(/stock .*?pedidos\)/, "stock 12")).toBe(before);
    // stock 215/75R17.5 también lo muestra
    expect(all(await say("stock 215/75R17.5"))).toContain("stock 4 (12 cargadas − 8 en pedidos)");
    // carga nueva del mismo origen: los descuentos anteriores dejan de contar
    await prices.upsertRows(STOCK(12, 20), { replace: { provider: "Protyres", kind: "stock" } });
    expect(await prices.listStockDeductions()).toEqual([]);
    expect(await v99Option()).toContain("· stock 12 ·");
  });
});

describe("pedido con stock propio y proveedor de la lista", () => {
  /** Cotización 501 de ANDES: Valor 99 en dos líneas (4 + 2) de la lista propia + 4 Westlake de JCH. */
  async function seed() {
    const q = await saveQuote("NOVIEMBRE 2026 - 501", "TRANSPORTES ANDES DEL PERU S.A.C.", [
      qi({ model: "Valor 99", quantity: 4, unitPrice: 150, origin: "own", rowId: "own-v99" }),
      qi({ model: "Valor 99", quantity: 2, unitPrice: 150, origin: "own", rowId: "own-v99" }),
      { ...qi({ model: "CR960", quantity: 4, unitPrice: 230, origin: "provider", rowId: "jch-wl", unitCost: 200 }), brand: "Westlake", size: "11R22.5", sizeDisplay: "11R22.5", description: "Llanta Westlake CR960 11R22.5 18PR", provider: "JCH" },
    ]);
    await portal.createOpportunity({ companyId: andes.id, ownerUserId: frank.id, etapa: "cotizacion_enviada", quoteNumber: q.number, createdBy: frank.id });
  }
  const ANSWERS = ["Av. Los Andes 450, Ate", "la misma", "Rosa Díaz 987654321", "ninguna", "20/11", "no", "no", "cliente", "igual"];

  it("agrupa, llena un bloque por producto con la lista de proveedores, descuenta el stock y recuerda las condiciones del proveedor", async () => {
    await seed();
    let out = await say("oc andes 4500123");
    expect(lastText(out)).toContain("Uso la cotización *501*");
    out = await say("sí");
    for (const a of ANSWERS) out = await say(a);
    expect(lastText(out)).toContain("🏭 *JCH LLANTAS* — Condiciones de pago del proveedor y dónde se recoge?");
    out = await say("letras 60, almacén Lurín");
    out = await say("facturar");
    expect(lastText(out)).toContain("Observaciones del despacho");
    out = await say("despachar por la mañana");
    const doc = out.find((m) => m.kind === "document")!;
    const ws = await sheetOf(doc);
    // detalle agrupado: 6 Valor 99 en una línea, con la fórmula del vendedor
    expect([cell(ws, "E18"), cell(ws, "F18"), cell(ws, "K18")]).toEqual([6, "215/75R17.5 18PR FENIXWAY VALOR 99", 150]);
    expect(ws.getCell("I18").formula).toBe("+K18*1.18");
    expect([cell(ws, "E19"), cell(ws, "F19")]).toEqual([4, "11R22.5 18PR WESTLAKE CR960"]);
    expect(cell(ws, "E20")).toBeNull();
    // bloque 1: stock propio; bloque 2: JCH LLANTAS con contacto y teléfono de la lista y el costo con IGV
    expect([cell(ws, "G29"), cell(ws, "G30"), cell(ws, "G32"), cell(ws, "G36"), cell(ws, "G37"), cell(ws, "G38")]).toEqual(["STOCK 360PT", "PATRICIA", "-", 0, "contado", "SAN LUIS STOCK"]);
    expect([cell(ws, "G42"), cell(ws, "G43"), cell(ws, "G44"), cell(ws, "G46"), cell(ws, "G47"), cell(ws, "G48"), cell(ws, "G49"), cell(ws, "G50"), cell(ws, "G51")]).toEqual([
      "JCH LLANTAS",
      "ANA PRUEBA",
      "900 000 010",
      "11R22.5 18PR",
      "WESTLAKE",
      "CR960",
      236,
      "LETRAS 60",
      "ALMACÉN LURÍN",
    ]);
    expect(cell(ws, "C39")).toBe("Observaciones: despachar por la mañana");
    expect(cell(ws, "C52")).toBe("Observaciones: despachar por la mañana");
    // contador: 6 Valor 99 descontados de San Luis; el resumen lo dice
    const ds = await prices.listStockDeductions();
    expect(ds.map((d) => [d.rowId, d.quantity, d.warehouse, d.orderKey])).toEqual([["stk-v99", 6, "SAN LUIS", `oc:${andes.id}:4500123`]]);
    expect(lastText(out)).toContain("📦 Descontado del stock: 215/75R17.5 18PR FENIXWAY VALOR 99: stock 6 (12 cargadas − 6 en pedidos)");
    // condiciones del proveedor recordadas en la lista
    expect((await prices.listSuppliers()).find((x) => x.name === "JCH LLANTAS")).toMatchObject({ lastPayment: "LETRAS 60", lastDelivery: "ALMACÉN LURÍN" });
    // observaciones del despacho recordadas para el cliente
    expect((await portal.getOrderProfile(andes.id))!.data).toMatchObject({ last: { observacionesTerceros: "despachar por la mañana" } });
  });

  // (otra prueba: el tope de 30 mensajes por minuto del bot corta un guion tan largo)
  it("rehacer la OC reemplaza su descuento; más de lo disponible pide confirmación; el admin ve los descuentos; anular los devuelve", async () => {
    let out: OutboundMessage[];
    // como si la OC 4500123 ya hubiera descontado 6 Valor 99 y dejado la memoria del cliente
    await prices.setStockDeductions(`oc:${andes.id}:4500123`, "OC 4500123 · TRANSPORTES ANDES DEL PERU", [{ rowId: "stk-v99", origin: "protyres|stock", warehouse: "SAN LUIS", quantity: 6, description: "215/75R17.5 18PR FENIXWAY VALOR 99" }]);
    await portal.setOrderProfile(andes.id, { direccionFiscal: "Av. Los Andes 450, Ate", direccionEntrega: "Av. Los Andes 450, Ate", contacto: "Rosa Díaz 987654321", agencia: "", last: { enllante: "NO", marcado: "NO", flete: "CLIENTE", observaciones: "facturar", observacionesTerceros: "despachar por la mañana" } });

    // rehacer la misma OC (otros ítems): no descuenta dos veces, reemplaza
    await say("oc andes 4500123");
    out = await say("4 x Fenixway Valor 99 215/75R17.5 a 150");
    expect(lastText(out)).toContain("4 × 215/75R17.5 18PR FENIXWAY VALOR 99 — US$ 177.00 c/u _(stock 12)_"); // lo de esta OC no se cuenta a sí mismo
    expect(lastText(out)).toContain("Datos de *TRANSPORTES ANDES DEL PERU* de la última vez");
    for (const a of ["igual", "20/11", "igual", "igual", "igual", "30", "igual", "igual"]) out = await say(a);
    expect(out.some((m) => m.kind === "document")).toBe(true);
    expect((await prices.listStockDeductions()).map((d) => d.quantity)).toEqual([4]);

    // pedir más de lo disponible: avisa y sigue solo con *sí*
    await say("oc roca 777");
    out = await say("10 x Fenixway Valor 99 215/75R17.5 a 150");
    expect(lastText(out)).toContain("⚠️ Stock propio insuficiente");
    expect(lastText(out)).toContain("*215/75R17.5 18PR FENIXWAY VALOR 99*: pides 10 y hay stock 8 (12 cargadas − 4 en pedidos).");
    out = await say("sí");
    expect(lastText(out)).toContain("Dirección fiscal de *E.T. LA ROCA*?");
    for (const a of ["Av. Industrial 300", "la misma", "Pedro Soto 999888777", "ninguna", "20/11", "no", "no", "cliente", "contado", "ninguna", "ninguna"]) out = await say(a);
    expect(out.some((m) => m.kind === "document")).toBe(true);
    expect((await prices.listStockDeductions()).reduce((n, d) => n + d.quantity, 0)).toBe(14);

    // el administrador ve los descuentos activos
    const adm = all(await say(textMsg("descuentos", ADMIN)));
    expect(adm).toContain("*215/75R17.5 18PR FENIXWAY VALOR 99* (SAN LUIS): stock 0 (12 cargadas − 14 en pedidos)");
    expect(adm).toContain("− 4 · OC 4500123 · TRANSPORTES ANDES DEL PERU");
    expect(adm).toContain("− 10 · OC 777 · E.T. LA ROCA");
    expect(all(await say("descuentos"))).toContain("los ve el supervisor o el administrador");

    // anular devuelve lo descontado
    out = await say("anular oc 4500123");
    expect(lastText(out)).toContain("Anulé el pedido de la OC *4500123* de *TRANSPORTES ANDES DEL PERU*");
    expect(lastText(out)).toContain("Devolví al stock: 4 × 215/75R17.5 18PR FENIXWAY VALOR 99");
    expect((await prices.listStockDeductions()).map((d) => d.quantity)).toEqual([10]);
  });

  it("producto sin origen identificable: pregunta (sugiere proveedores por marca) y usa la respuesta en el bloque", async () => {
    await saveQuote("NOVIEMBRE 2026 - 502", "TRANSPORTES ANDES DEL PERU S.A.C.", [
      { ...qi({ model: "X Multi D", quantity: 2, unitPrice: 400, origin: "manual", provider: "manual" }), brand: "Michelin", size: "295/80R22.5", sizeDisplay: "295/80R22.5", description: "Llanta Michelin X Multi D 295/80R22.5" },
    ]);
    await say("oc andes 4500200");
    let out = await say("sí");
    expect(lastText(out)).toContain("¿De dónde sale *295/80R22.5 18PR MICHELIN X MULTI D* (2 und.)?");
    expect(lastText(out)).toContain("Para *MICHELIN* puedes pedir a: *VAN LLANTAS* (Luis Prueba, 900 000 011)");
    out = await say("van 410");
    expect(lastText(out)).toContain("Dirección fiscal");
    for (const a of ["Av. Los Andes 450", "la misma", "Rosa Díaz 987654321", "ninguna", "20/11", "no", "no", "cliente", "igual"]) out = await say(a);
    expect(lastText(out)).toContain("🏭 *VAN LLANTAS*");
    for (const a of ["contado, recoge en su almacén", "ninguna", "ninguna"]) out = await say(a);
    const ws = await sheetOf(out.find((m) => m.kind === "document")!);
    expect([cell(ws, "G29"), cell(ws, "G30"), cell(ws, "G31"), cell(ws, "G36"), cell(ws, "G37")]).toEqual(["VAN LLANTAS", "LUIS PRUEBA", "900 000 011", 410, "CONTADO"]);
  });
});

describe("memoria del cliente con dos pedidos a la vez", () => {
  it("lo que otro pedido guardó mientras tanto no se pierde (se relee al guardar)", async () => {
    await say("oc andes 4500300");
    await say("4 x Fenixway Valor 99 215/75R17.5 a 150");
    // otro pedido de la misma empresa (otro vendedor / sucursal) guarda su memoria a mitad de este
    await portal.setOrderProfile(andes.id, { sucursales: { juliaca: { direccionEntrega: "Jr. Falso 447, Juliaca" } }, last: { venta: "005" } });
    let out: OutboundMessage[] = [];
    for (const a of ["Av. Los Andes 450", "la misma", "Rosa Díaz 987654321", "ninguna", "20/11", "no", "no", "cliente", "30", "ninguna", "ninguna"]) out = await say(a);
    expect(out.some((m) => m.kind === "document")).toBe(true);
    expect((await portal.getOrderProfile(andes.id))!.data).toMatchObject({
      direccionFiscal: "Av. Los Andes 450",
      sucursales: { juliaca: { direccionEntrega: "Jr. Falso 447, Juliaca" } },
      last: { venta: "005", flete: "CLIENTE" },
    });
  });
});

describe("Prosegur: un pedido por sucursal", () => {
  const ub = (model: string, quantity: number, u: string) => qi({ model, quantity, unitPrice: model === "Valor 99" ? 123.17 : 126.42, origin: "contract", provider: "contrato", ub: u });

  async function seedProsegur() {
    await saveQuote("NOVIEMBRE 2026 - 471", "PROSEGUR DEMO S.A.", [ub("Valor 99", 4, "0101"), ub("Valor 89", 4, "0202"), ub("Valor 99", 2, "0303"), ub("Valor 89", 4, "0404"), ub("Valor 89", 4, "0505")], { unit: "JULIACA", customerProfile: "prosegur" });
    await saveQuote("NOVIEMBRE 2026 - 475", "PROSEGUR DEMO S.A.", [ub("Valor 89", 2, "0606")], { unit: "AREQUIPA", customerProfile: "prosegur" });
  }

  it("dos cotizaciones (dos sucursales) -> dos Excel con su nombre, memoria por sucursal y número de venta", async () => {
    await seedProsegur();
    let out = await say("oc prosegur 4500555");
    expect(lastText(out)).toContain("Si la OC cubre varias sucursales, escribe los números de sus cotizaciones");
    out = await say("471 475");
    expect(all(out)).toContain("Uso las cotizaciones *471* (Juliaca), *475* (Arequipa).");
    // Juliaca
    expect(lastText(out)).toContain("Dirección fiscal de *PROSEGUR DEMO*?");
    out = await say("Av. Inventada 1086, Surco");
    out = await say("Jr. Falso 447, Juliaca");
    expect(lastText(out)).toContain("Persona de contacto en *Juliaca* (nombre, DNI y celular)?");
    for (const a of ["Ana Demo/DNI:00000001/900000021", "Grael, Luis Demo 900 000 020", "17/11", "no", "sí", "360, 20 soles aprox", "igual", "facturar", "despachar en Grael, pedir guía sellada"]) out = await say(a);
    expect(lastText(out)).toContain("🔢 Número de venta de *Juliaca*");
    out = await say("9");
    // Arequipa: fiscal y plazo ya están; lo de la sucursal se pregunta
    expect(lastText(out)).toContain("✅ Listo *Juliaca*. Ahora el pedido de *Arequipa*.");
    expect(lastText(out)).toContain("Dirección de entrega?");
    for (const a of ["Calle Demo 12, Arequipa", "Rosa Demo/DNI:00000002/900000022", "ninguna", "18/11", "no", "sí", "cliente", "ninguna", "ninguna"]) out = await say(a);
    expect(lastText(out)).toContain("(sugerido: 010");
    out = await say("igual");
    const docs = out.filter((m) => m.kind === "document");
    expect(docs.map((d) => d.fileName)).toEqual(["Nov26- Prosegur - Venta 009 Juliaca UBs 0101-0202-0303-0404-0505.xlsx", "Nov26- Prosegur - Venta 010 Arequipa UBs 0606.xlsx"]);
    expect(lastText(out)).toContain(PATRICIA_REMINDER_BRANCHES);
    const jul = await sheetOf(docs[0]);
    // 5 líneas -> 2 (6 y 12); stock propio (contrato que está en el stock de Odoo)
    expect([cell(jul, "E18"), cell(jul, "E19"), cell(jul, "K18"), cell(jul, "K19")]).toEqual([6, 12, 123.17, 126.42]);
    expect([cell(jul, "G9"), cell(jul, "G14"), cell(jul, "G15"), cell(jul, "J15")]).toEqual(["Jr. Falso 447, Juliaca", "Ana Demo/DNI:00000001/900000021", "360TYRES", "VALOR FLETE: 20 SOLES APROX"]);
    expect(cell(jul, "C27")).toBe("Observaciones: facturar — UBs 0101-0202-0303-0404-0505");
    expect([cell(jul, "G29"), cell(jul, "G35"), cell(jul, "G42"), cell(jul, "G48")]).toEqual(["STOCK 360PT", "VALOR 99", "STOCK 360PT", "VALOR 89"]);
    const are = await sheetOf(docs[1]);
    expect([cell(are, "E18"), cell(are, "G8"), cell(are, "G9"), cell(are, "G15")]).toEqual([2, "Av. Inventada 1086, Surco", "Calle Demo 12, Arequipa", "CLIENTE"]);
    // stock: 6 V99 y 14 V89 en una sola clave de la OC
    expect((await prices.listStockDeductions()).map((d) => [d.rowId, d.quantity])).toEqual([
      ["stk-v99", 6],
      ["stk-v89", 14],
    ]);
    // memoria por sucursal: la próxima OC de Juliaca ofrece lo de Juliaca, no lo de Arequipa
    const prof = (await portal.getOrderProfile(psg.id))!.data as { direccionFiscal: string; sucursales: Record<string, { direccionEntrega: string; last: { venta: string; observacionesTerceros: string } }> };
    expect(prof.direccionFiscal).toBe("Av. Inventada 1086, Surco");
    expect(prof.sucursales.juliaca).toMatchObject({ direccionEntrega: "Jr. Falso 447, Juliaca", agencia: "Grael", last: { venta: "009", observacionesTerceros: "despachar en Grael, pedir guía sellada", enllante: "NO", marcado: "SI" } });
    expect(prof.sucursales.arequipa).toMatchObject({ direccionEntrega: "Calle Demo 12, Arequipa", last: { venta: "010" } });
  });

  it("contraste: la OC en Excel con otra UB que la cotización se muestra y se pregunta", async () => {
    await seedProsegur();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Formato Proveedores");
    ws.addRow(["Item", "Ubicación", "UB", "Código Producto", "Sistema", "Descripción del producto o servicio", "Cantidad", "UM", "Tipo Artículo", "Moneda", "P. Unitario"]);
    const lines: [string, string, number, number][] = [["0101", "VALOR 99", 4, 123.17], ["0202", "VALOR 89", 4, 126.42], ["0313", "VALOR 99", 2, 123.17], ["0404", "VALOR 89", 4, 126.42], ["0505", "VALOR 89", 4, 126.42]];
    lines.forEach(([u, m, q, p], i) => ws.addRow([i + 1, "JULIACA", u, null, "LLANTAS", `215/75R17.5 18PR FENIXWAY ${m}`, q, "UNI", "REPUESTO", "USD", p]));
    client.media.set("oc-xlsx", { data: Buffer.from(await wb.xlsx.writeBuffer()), mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileName: "OC Prosegur.xlsx" });
    await say({ id: `wamid.h${++seq}`, from: FRANK, timestamp: "1", type: "document", text: "oc prosegur 4500556", forwarded: false, media: { id: "oc-xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileName: "OC Prosegur.xlsx", caption: "oc prosegur 4500556" } });
    let out = await say("471");
    const t = lastText(out);
    expect(t).toContain("⚠️ Antes de armar el pedido, esto no coincide:");
    expect(t).toContain("UB 0313 está en la OC pero no en la cotización 471.");
    expect(t).toContain("UB 0303 está en la cotización 471 pero no en la OC.");
    expect(t).not.toContain("VALOR 99*:"); // cantidades y precios por producto sí coinciden
    out = await say("sí");
    expect(lastText(out)).toContain("Dirección fiscal");
    expect(((await getPending(portal, FRANK, new Date())) as OcStep).phase).toBe("questions");
  });
});

describe("piezas puras (corrida H)", () => {
  it("números de cotización, origen, anular y nombre del archivo por sucursal", () => {
    expect(quoteNumbersIn("471 475")).toEqual(["471", "475"]);
    expect(quoteNumbersIn("cotizaciones 471 y 475")).toEqual(["471", "475"]);
    expect(quoteNumbersIn("sí")).toBeNull();
    const sup = [{ key: "jchllantas", name: "JCH LLANTAS", brands: [], provider: "JCH" }];
    expect(parseOriginAnswer("propio", sup)).toEqual({ stock: true });
    expect(parseOriginAnswer("jch 180", sup)).toMatchObject({ proveedor: "JCH LLANTAS", precio: 180 });
    expect(parseOriginAnswer("Llantas Norte", sup)).toEqual({ proveedor: "LLANTAS NORTE" });
    expect(parseAnular("oc 4500123")).toEqual({ numero: "4500123", empresa: "" });
    expect(parseAnular("pedido 4500123 de zbuss")).toEqual({ numero: "4500123", empresa: "zbuss" });
    expect(branchFileName("{Mes}{aa}- {Cliente} - Venta {Venta} {Sucursal} UBs {UBs}", { fecha: "2026-11-16", cliente: "PROSEGUR", venta: "009", sucursal: "JULIACA", ubs: ["1231", "1812"] })).toBe("Nov26- Prosegur - Venta 009 Juliaca UBs 1231-1812.xlsx");
  });
});
