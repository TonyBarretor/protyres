/**
 * Corrida J, punto 1.10: el pedido para Patricia con placas. Las líneas se siguen agrupando por producto; las placas van
 * en las observaciones (y en la venta esperada de la actividad, para saber qué se vendió a cada vehículo). Datos inventados.
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
import { groupPedidoItems, pedidoFromQuote, pedidoPlatesNote } from "../order/pedido-xlsx";
import { JsonPortalStore } from "../store";
import type { Company, PortalUser } from "../store/types";
import { configureOrderBot } from "./commands/oc";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7, paymentType: "Factura crédito", paymentTerm: "30 días" },
  salespeople: { default: "51900000001", "51900000001": { name: "Frank Rodríguez", title: "Key Account Manager", phone: "900 000 001", email: "frank@example.pe" } },
});

const FRANK = "51900000001";
const RUC_ANDES = "20999000011";
const TODAY = "2026-11-11";

const valor87 = (quantity: number, plate?: string): QuoteItem => ({
  description: "Llanta Fenixway Valor 87 295/80R22.5 18PR",
  brand: "Fenixway",
  model: "Valor 87",
  size: "295/80R22.5",
  sizeDisplay: "295/80R22.5",
  ply: 18,
  quantity,
  unitPrice: 254,
  listPrice: 400,
  discountPct: 36.5,
  total: 254 * quantity,
  origin: "own",
  manualPrice: true,
  provider: "360 Tyres",
  priceDate: TODAY,
  available: null,
  ...(plate ? { plate } : {}),
});
const flama77 = (quantity: number, plate?: string): QuoteItem => ({
  description: "Llanta Fenixway Flama 77 315/80R22.5 18PR",
  brand: "Fenixway",
  model: "Flama 77",
  size: "315/80R22.5",
  sizeDisplay: "315/80R22.5",
  ply: 18,
  quantity,
  unitPrice: 230,
  discountPct: 0,
  total: 230 * quantity,
  origin: "provider",
  provider: "Llantas del Sur",
  unitCost: 200,
  priceDate: TODAY,
  available: 40,
  ...(plate ? { plate } : {}),
});

function quoteOf(items: QuoteItem[]) {
  return buildQuote({
    number: "NOVIEMBRE 2026 - 032",
    request: { raw: "pedido de prueba", lines: [], parsedBy: "regex", customerCompany: "TRANSPORTES ANDES DEL PERU S.A.C.", address: "Av. Los Andes 450, Ate", paymentTerm: "45 días" },
    items,
    settings,
    today: TODAY,
    requestedBy: FRANK,
  });
}

describe("pedido con placas (puro)", () => {
  it("el mismo producto con placas distintas y la misma placa repetida: una línea por producto, las placas con sus llantas", () => {
    const q = quoteOf([valor87(8, "ABC-123"), valor87(2, "ABC-123"), valor87(4, "DEF-456"), flama77(4)]);
    const lines = groupPedidoItems(pedidoFromQuote(q).items);
    expect(lines.map((l) => [l.modelo, l.cantidad, l.placas])).toEqual([
      ["Valor 87", 14, [{ placa: "ABC-123", cantidad: 10 }, { placa: "DEF-456", cantidad: 4 }]],
      ["Flama 77", 4, undefined],
    ]);
    expect(pedidoPlatesNote(lines)).toBe("Placas: 295/80R22.5 18PR FENIXWAY VALOR 87: ABC-123 (10), DEF-456 (4)");
  });

  it("líneas del mismo producto con y sin placa: las sin placa se cuentan aparte; sin placas, la nota queda vacía", () => {
    const lines = groupPedidoItems(pedidoFromQuote(quoteOf([valor87(2), valor87(4, "ABC-123"), valor87(2)])).items);
    expect(lines).toHaveLength(1);
    expect(pedidoPlatesNote(lines)).toBe("Placas: 295/80R22.5 18PR FENIXWAY VALOR 87: ABC-123 (4), sin placa (4)");
    expect(pedidoPlatesNote(groupPedidoItems(pedidoFromQuote(quoteOf([valor87(8), flama77(4)])).items))).toBe("");
  });
});

describe("oc: pedido para Patricia con placas", () => {
  let client: FakeWhatsAppClient;
  let portal: JsonPortalStore;
  let prices: JsonStore;
  let bot: BotHandler;
  let frank: PortalUser;
  let andes: Company;
  let seq = 0;
  const saved: Record<string, string | undefined> = {};
  const say = async (body: string): Promise<OutboundMessage[]> => {
    const before = client.sent.length;
    await bot.handle({ id: `wamid.ocp${++seq}`, from: FRANK, timestamp: "1", type: "text", text: body, forwarded: false } as InboundMessage);
    return client.sent.slice(before);
  };
  const lastText = (out: OutboundMessage[]) => [...out].reverse().find((m) => m.kind === "text" || m.kind === "interactive")?.body ?? "";

  beforeEach(async () => {
    for (const k of ["LLM_DISABLED", "PHOTOS_DISABLED", "DEEPGRAM_API_KEY"]) saved[k] = process.env[k];
    process.env.LLM_DISABLED = "1";
    process.env.PHOTOS_DISABLED = "1";
    delete process.env.DEEPGRAM_API_KEY;
    client = new FakeWhatsAppClient();
    portal = JsonPortalStore.memory();
    prices = JsonStore.memory();
    const row = (p: Partial<PriceRow> & Pick<PriceRow, "id" | "provider" | "kind" | "brand" | "model" | "size" | "cost">): PriceRow => ({ description: `${p.size} ${p.brand} ${p.model}`.toUpperCase(), sizeDisplay: p.size, sizeRaw: p.size, isTyre: true, ply: 18, priceIncludesTax: p.kind === "own", currency: "USD", stock: p.kind === "provider" ? 40 : null, priceDate: TODAY, source: "excel", sourceRef: "test.xlsx", ...p });
    await prices.upsertRows([row({ id: "own-valor87", provider: "360 Tyres", kind: "own", brand: "Fenixway", model: "Valor 87", size: "295/80R22.5", cost: 472 }), row({ id: "prov-flama77", provider: "Llantas del Sur", kind: "provider", brand: "Fenixway", model: "Flama 77", size: "315/80R22.5", cost: 200 })]);
    frank = await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
    const r = await portal.upsertCompanies([{ ruc: RUC_ANDES, razonSocial: "TRANSPORTES ANDES DEL PERU S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 12, llantasPiso: 72 }]);
    andes = (await portal.updateCompany(r.ids[RUC_ANDES], { ownerUserId: frank.id }))!;
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

  it("agrupa por producto, las placas van a las observaciones del Excel, al resumen y a la venta esperada", async () => {
    const quote = quoteOf([valor87(8, "ABC-123"), valor87(2, "ABC-123"), valor87(4, "DEF-456"), flama77(4)]);
    await prices.saveQuote(quote);
    await portal.createOpportunity({ companyId: andes.id, ownerUserId: frank.id, etapa: "cotizacion_enviada", quoteNumber: quote.number, createdBy: frank.id });
    let out = await say("oc andes 4500123");
    expect(lastText(out)).toContain("Uso la cotización *032*");
    for (const answer of ["sí", "igual", "Jr. Las Palmeras 120, Ate", "Rosa Díaz 987654321", "Andeskar, Luis Pérez 987 654 321", "48 h post OC", "no", "sí", "360, 20 soles x llanta", "60", "letras 90, recoge en almacén Lurín", "entregar en horario de oficina"]) {
      out = await say(answer);
      if (out.some((m) => m.kind === "document")) break;
      if (/Observaciones del despacho/.test(lastText(out))) {
        out = await say("ninguna");
        break;
      }
    }
    const doc = out.find((m) => m.kind === "document");
    expect(doc, lastText(out)).toBeDefined();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(doc!.file! as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Formato de Pedido")!;
    expect(ws.getCell("E18").value).toBe(14);
    expect(ws.getCell("F18").value).toBe("295/80R22.5 18PR FENIXWAY VALOR 87");
    expect(ws.getCell("E19").value).toBe(4);
    expect(ws.getCell("C27").value).toBe("Observaciones: entregar en horario de oficina — Placas: 295/80R22.5 18PR FENIXWAY VALOR 87: ABC-123 (10), DEF-456 (4)");
    const summary = lastText(out);
    expect(summary).toContain("• 14 × 295/80R22.5 18PR FENIXWAY VALOR 87 — US$ 299.72 c/u");
    expect(summary).toContain(" · placa ABC-123 (10), DEF-456 (4)");
    const act = (await portal.listActivities({ companyId: andes.id })).find((a) => a.tipo === "oc")!;
    const items = (act.data!.ventaEsperada as { items: { placas?: unknown }[] }).items;
    expect(items.map((i) => i.placas)).toEqual([[{ placa: "ABC-123", cantidad: 8 }], [{ placa: "ABC-123", cantidad: 2 }], [{ placa: "DEF-456", cantidad: 4 }], undefined]);
  });
});
