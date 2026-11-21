/**
 * Corrida J, punto 1: placa por línea en las cotizaciones (cualquier cliente), "pedir placa" (ANCRO), comandos por
 * ítem, PDF con la etiqueta PLACA, contraste con la flota del padrón y Prosegur sin cambios. Datos inventados.
 */
import fs from "node:fs";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ingestExcel } from "../ingest/tabular";
import { JsonPortalStore } from "../portal/store";
import type { FleetVehicleInput } from "../portal/store/types";
import { loadCustomerProfiles, SettingsSchema, type Settings } from "../settings";
import { JsonStore } from "../store/json-store";
import { FakeWhatsAppClient } from "./client";
import { BotHandler } from "./handler";
import type { InboundMessage } from "./webhook";

const PHONE = "51955344340";
const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
  salespeople: { default: PHONE, [PHONE]: { name: "Vendedor de Prueba", title: "Key Account Manager", phone: "955 000 000", email: "vendedor@example.pe" } },
  customers: loadCustomerProfiles(),
});

const RUC = "20999000022";
const RAZON = "TRANSPORTES PRUEBA DEL SUR S.A.C.";
const OTRA_RUC = "20999000033";
const OTRA = "CARGA INVENTADA S.A.C.";

let n = 0;
const text = (body: string): InboundMessage => ({ id: `wamid.pl.${++n}`, from: PHONE, timestamp: "1", type: "text", text: body, forwarded: false });

async function pdfText(pdf: Buffer): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const { text: t } = await extractText(doc, { mergePages: true });
  return String(t).replace(/\s+/g, " ");
}

function vehicle(companyId: number, placa: string, marca: string, anio: number, llantas: number): FleetVehicleInput {
  return { companyId, placa, marca, clase: "REMOLCADOR", anio, ejes: 3, llantas, llantasFuente: "20241231", pesoBruto: 30000, chasis: null, departamento: "LIMA", origen: "carga", medidaProbable: "295/80R22.5", confianza: "media" };
}

describe("placa por línea (corrida J)", () => {
  let store: JsonStore;
  let client: FakeWhatsAppClient;
  let bot: BotHandler;
  let pdfs: Buffer[];
  const last = () => client.last()?.body ?? "";

  beforeAll(() => {
    process.env.LLM_DISABLED = "1";
    process.env.PHOTOS_DISABLED = "1";
  });

  async function setup(opts: { portal?: boolean } = {}) {
    store = JsonStore.memory();
    client = new FakeWhatsAppClient();
    pdfs = [];
    const portal = JsonPortalStore.memory();
    if (opts.portal) {
      await portal.upsertUser({ nombre: "Vendedor de Prueba", whatsapp: PHONE, rol: "vendedor" });
      const { ids } = await portal.upsertCompanies([
        { ruc: RUC, razonSocial: RAZON, sector: "carga", departamento: "LIMA", unidades: 12, llantasPiso: 120 },
        { ruc: OTRA_RUC, razonSocial: OTRA, sector: "carga", departamento: "LIMA", unidades: 15, llantasPiso: 150 },
      ]);
      // en el padrón sin guion, como lo carga el MTC
      await portal.upsertFleet([vehicle(ids[RUC], "ABC123", "VOLVO", 2019, 10), vehicle(ids[OTRA_RUC], "XYZ789", "SCANIA", 2015, 6)]);
    }
    bot = new BotHandler({ client, store, settings, portalStore: portal, onPdf: (_q, pdf) => void pdfs.push(pdf) });
    const xls = await ingestExcel(fs.readFileSync(path.resolve(process.cwd(), "samples/proveedor-a-lista.xlsx")), { provider: "Llantas del Sur", sourceRef: "a.xlsx", priceDate: new Date().toISOString().slice(0, 10) });
    await store.upsertRows(xls.rows);
  }

  describe("cualquier cliente, sin configuración", () => {
    beforeEach(() => setup());

    it("placa en todas las líneas: el Entendí la lista, cada ítem la guarda y el PDF la imprime con la etiqueta PLACA", async () => {
      await bot.handle(text("Michelin 11R22.5 XZE2+ x4 placa abc123\nMichelin 295/80R22.5 X Multi Z x2 plc D4E-567\npara Transportes ABC, juan@abc.com"));
      expect(last()).toContain("Entendí:\n1. Michelin 11R22.5 XZE2+ placa ABC-123 x4\n2. Michelin 295/80R22.5 X MULTI Z placa D4E-567 x2");
      await bot.handle(text("ok"));
      const q = await store.getQuote("COT-0001");
      expect(q?.items.map((i) => i.plate)).toEqual(["ABC-123", "D4E-567"]);
      // el correo al cliente también la lleva (dos líneas del mismo producto se distinguen)
      expect(q?.emailDraft?.body).toContain("• Michelin XZE2+ 11R22.5 placa ABC-123 — 4 x US$");
      const t = await pdfText(pdfs[0]);
      expect(t).toMatch(/11R22\.5 146\/143L PLACA ABC-123 MICHELIN/);
      expect(t).toMatch(/295\/80R22\.5 152\/148M PLACA D4E-567 MICHELIN/);
      // y quedan para consultar qué se le cotizó a ese vehículo
      expect((await store.listQuotes({ plate: "abc 123" })).map((x) => x.number)).toEqual(["COT-0001"]);
      expect(await store.listQuotes({ plate: "ZZZ-999" })).toEqual([]);
    });

    it("placa solo en algunas líneas: las demás salen como hoy (sin PLACA)", async () => {
      await bot.handle(text("Michelin 11R22.5 XZE2+ x4 placa ABC-123\nMichelin 295/80R22.5 X Multi Z x2\npara Transportes ABC, juan@abc.com"));
      await bot.handle(text("ok"));
      const q = await store.getQuote("COT-0001");
      expect(q?.items.map((i) => i.plate)).toEqual(["ABC-123", undefined]);
      const t = await pdfText(pdfs[0]);
      expect(t).toMatch(/11R22\.5 146\/143L PLACA ABC-123 MICHELIN/);
      expect(t.match(/PLACA/g)?.length).toBe(1);
    });

    it("sin placa: ni la pregunta ni avisos; el PDF no lleva PLACA", async () => {
      await bot.handle(text("Michelin 11R22.5 XZE2+ x4\npara Transportes ABC, juan@abc.com"));
      expect(last()).not.toMatch(/placa/i);
      await bot.handle(text("ok"));
      expect((await store.getQuote("COT-0001"))?.items[0].plate).toBeUndefined();
      expect(await pdfText(pdfs[0])).not.toContain("PLACA");
    });

    it("la misma placa en dos líneas y el mismo producto con placas distintas: líneas aparte, nada se fusiona ni se rechaza", async () => {
      await bot.handle(text("Michelin 295/80R22.5 X Multi Z x8 traccion placa ABC-123\nMichelin 295/80R22.5 X Multi Z x2 direccional placa ABC-123\nMichelin 11R22.5 XZE2+ x4 placa ABC-123\nMichelin 11R22.5 XZE2+ x4 placa XYZ-789\npara Transportes ABC, juan@abc.com"));
      await bot.handle(text("ok"));
      const q = await store.getQuote("COT-0001");
      expect(q?.items.map((i) => [i.size, i.quantity, i.plate])).toEqual([
        ["295/80R22.5", 8, "ABC-123"],
        ["295/80R22.5", 2, "ABC-123"],
        ["11R22.5", 4, "ABC-123"],
        ["11R22.5", 4, "XYZ-789"],
      ]);
      const t = await pdfText(pdfs[0]);
      expect(t.match(/PLACA ABC-123/g)?.length).toBe(3);
      expect(t).toContain("PLACA XYZ-789");
    });

    it("placa mal escrita: se muestra lo entendido y se pide escribirla; *placa 1 ABC-123* la corrige", async () => {
      await bot.handle(text("Michelin 11R22.5 XZE2+ x4 placa AB12\npara Transportes ABC, juan@abc.com"));
      expect(last()).toContain("Michelin 11R22.5 XZE2+ placa ¿AB12? x4");
      expect(last()).toContain("⚠️ Ítem 1: «AB12» no parece una placa");
      await bot.handle(text("placa 1 abc 123"));
      expect(last()).toContain("✏️ Ítem 1: placa *ABC-123*.");
      expect(last()).toContain("1. Michelin XZE2+ 11R22.5 placa ABC-123 x4 @");
      await bot.handle(text("placa 1 AB12"));
      expect(last()).toBe("«AB12» no parece una placa (6 caracteres, como *ABC-123*). Escríbela así: *placa 1 ABC-123* (o *sin placa 1*).");
      await bot.handle(text("ok"));
      expect((await store.getQuote("COT-0001"))?.items[0].plate).toBe("ABC-123");
    });

    it("comandos: *placa 2 …* pone o cambia, *sin placa 2* quita, *placa …* a secas solo con un ítem; también con el PDF ya armado", async () => {
      await bot.handle(text("Michelin 11R22.5 XZE2+ x4 placa ABC-123\nMichelin 295/80R22.5 X Multi Z x2\npara Transportes ABC, juan@abc.com"));
      await bot.handle(text("placa DEF-456"));
      expect(last()).toBe("¿De qué ítem? (ej. *placa 2 DEF-456*)");
      await bot.handle(text("placa 2 DEF-456"));
      expect(last()).toContain("2. Michelin X MULTI Z 295/80R22.5 placa DEF-456 x2 @ US$ 471.50");
      await bot.handle(text("sin placa 1"));
      expect(last()).toContain("✏️ Ítem 1: sin placa.");
      expect(last()).toContain("1. Michelin XZE2+ 11R22.5 x4 @");
      await bot.handle(text("placa 3 DEF-456"));
      expect(last()).toBe("No existe el ítem 3; hay 2.");
      await bot.handle(text("ok"));
      let q = await store.getQuote("COT-0001");
      expect(q?.items.map((i) => i.plate)).toEqual([undefined, "DEF-456"]);
      // con la cotización ya presentada: se rehace con la placa nueva, mismo precio y mismo orden
      await bot.handle(text("placa 1 GHI-789"));
      q = await store.getQuote("COT-0001");
      expect(q?.items.map((i) => [i.plate, i.unitPrice])).toEqual([
        ["GHI-789", q?.items[0].unitPrice],
        ["DEF-456", q?.items[1].unitPrice],
      ]);
      expect(await pdfText(pdfs[pdfs.length - 1])).toContain("PLACA GHI-789");
      await bot.handle(text("sin placa 2"));
      q = await store.getQuote("COT-0001");
      expect(q?.items.map((i) => i.plate)).toEqual(["GHI-789", undefined]);
    });

    it("con el PDF armado y sin correo del cliente, el cambio de placa también se dice (simulador, guion de Frank)", async () => {
      await bot.handle(text("Michelin 11R22.5 XZE2+ x4 para Transportes ABC"));
      await bot.handle(text("ok"));
      expect((await store.getConversation(PHONE))?.step).toBe("need_email");
      await bot.handle(text("placa 1 XYZ-789"));
      expect(last()).toMatch(/^✏️ Ítem 1: placa \*XYZ-789\*\.\n\n/);
      expect(last()).toContain("¿A qué correo lo envío?");
      expect((await store.getQuote("COT-0001"))?.items[0].plate).toBe("XYZ-789");
    });

    it("*placa ABC-123* a secas con un solo ítem", async () => {
      await bot.handle(text("Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com"));
      await bot.handle(text("placa ABC-123"));
      expect(last()).toContain("✏️ Ítem 1: placa *ABC-123*.");
      await bot.handle(text("ok"));
      await bot.handle(text("plc XYZ789"));
      expect((await store.getQuote("COT-0001"))?.items[0].plate).toBe("XYZ-789");
    });
  });

  describe("contraste con la flota del padrón (vendedor del portal)", () => {
    beforeEach(() => setup({ portal: true }));

    it("la placa en la flota del cliente se muestra con el vehículo; de otra empresa o fuera del padrón, aviso sin bloquear", async () => {
      await bot.handle(text(`Michelin 11R22.5 XZE2+ x4 placa ABC-123\nMichelin 11R22.5 XZE2+ x4 placa XYZ-789\nMichelin 295/80R22.5 X Multi Z x2 placa QQQ-111\npara ${RAZON} RUC ${RUC}`));
      const body = last();
      expect(body).toContain("🚗 *ABC-123*: VOLVO · 2019 · 10 llantas (flota de TRANSPORTES PRUEBA DEL SUR)");
      expect(body).toContain("⚠️ *XYZ-789* figura en la flota de *CARGA INVENTADA*, no de TRANSPORTES PRUEBA DEL SUR: la dejo igual, revísala.");
      expect(body).toContain("⚠️ *QQQ-111* no está en la flota de TRANSPORTES PRUEBA DEL SUR en el padrón: la dejo igual, revísala.");
      await bot.handle(text("ok"));
      expect((await store.getQuote("COT-0001"))?.items.map((i) => i.plate)).toEqual(["ABC-123", "XYZ-789", "QQQ-111"]);
    });

    it("una placa puesta con el comando también se contrasta", async () => {
      await bot.handle(text(`Michelin 11R22.5 XZE2+ x4 para ${RAZON} RUC ${RUC}`));
      await bot.handle(text("placa 1 abc123"));
      expect(last()).toContain("✏️ Ítem 1: placa *ABC-123*.\n🚗 *ABC-123*: VOLVO · 2019 · 10 llantas (flota de TRANSPORTES PRUEBA DEL SUR)");
    });

    it("sin placas, el portal no agrega nada", async () => {
      await bot.handle(text(`Michelin 11R22.5 XZE2+ x4 para ${RAZON} RUC ${RUC}`));
      expect(last()).not.toMatch(/🚗|flota/);
    });
  });

  describe("cliente marcado para pedir placa (ANCRO S.R.L.)", () => {
    beforeEach(() => setup());

    it("si una línea llega sin placa, pregunta UNA vez antes del resumen; *placa 1 …* la pone y sigue", async () => {
      await bot.handle(text("ancro\nMichelin 11R22.5 XZE2+ x4\nMichelin 295/80R22.5 X Multi Z x2 placa ABC-123"));
      let body = last();
      expect(body).toContain("ANCRO S.R.L.");
      expect(body).toContain("🚗 ANCRO S.R.L. pide la placa de cada llanta. Sin placa:\n1. Michelin 11R22.5 XZE2+ x4\nEscríbela con el número del ítem");
      expect((await store.getConversation(PHONE))?.step).toBe("need_fields");
      await bot.handle(text("placa 1 DEF-456"));
      body = last();
      expect(body).toContain("1. Michelin 11R22.5 XZE2+ placa DEF-456 x4");
      expect(body).toContain("*a)*");
      expect((await store.getConversation(PHONE))?.step).toBe("choose");
      await bot.handle(text("ok"));
      expect((await store.getQuote("COT-0001"))?.items.map((i) => i.plate)).toEqual(["DEF-456", "ABC-123"]);
    });

    it("*sin placa* sigue sin ella y no vuelve a preguntar", async () => {
      await bot.handle(text("Michelin 11R22.5 XZE2+ x4 para ancro"));
      expect(last()).toContain("pide la placa de cada llanta");
      await bot.handle(text("sin placa"));
      expect(last()).toContain("*a)*");
      expect(last()).not.toContain("pide la placa");
      await bot.handle(text("ok"));
      expect((await store.getQuote("COT-0001"))?.items[0].plate).toBeUndefined();
    });

    it("con la placa en todas las líneas no pregunta; a una placa mal escrita le pide escribirla", async () => {
      await bot.handle(text("ancro\nMichelin 11R22.5 XZE2+ x4 placa ABC-123"));
      expect(last()).not.toContain("pide la placa");
      expect(last()).toContain("*a)*");
      await setup();
      await bot.handle(text("ancro\nMichelin 11R22.5 XZE2+ x4"));
      await bot.handle(text("placa 1 AB12"));
      expect(last()).toContain("«AB12» no parece una placa");
      expect((await store.getConversation(PHONE))?.step).toBe("need_fields");
      await bot.handle(text("ABC-123"));
      expect(last()).toContain("placa ABC-123 x4");
    });

    it("los demás clientes nunca preguntan", async () => {
      await bot.handle(text("Michelin 11R22.5 XZE2+ x4 para Transportes ABC"));
      expect(last()).not.toContain("pide la placa");
    });
  });

  describe("Prosegur sin cambios: UB, no placa", () => {
    beforeEach(() => setup());

    it("*placa …* en una cotización de Prosegur no se entiende y se pregunta; la UB sigue igual", async () => {
      await bot.handle(text("prosegur ayacucho 1830\n2 v99\nsolicitante: Johann Castañeda"));
      const q = await store.getQuote((await store.getConversation(PHONE))?.quoteNumber ?? "");
      expect(q?.items[0].ub ?? q?.ub).toBe("1830");
      await bot.handle(text("placa 1 ABC-123"));
      expect(last()).toBe("No entendí «placa 1 ABC-123»: en Prosegur cada llanta lleva su *UB* (4 cifras), no placa. ¿Qué querías cambiar? (p. ej. *UB 1830* junto a la llanta)");
      expect((await store.getQuote(q!.number))?.items[0].plate).toBeUndefined();
    });

    it("al pedir sus campos, *placa …* tampoco es una respuesta", async () => {
      await bot.handle(text("prosegur\nMichelin 295/80R22.5 X Multi Z x2"));
      expect((await store.getConversation(PHONE))?.step).toBe("need_fields");
      await bot.handle(text("placa 1 ABC-123"));
      expect(last()).toContain("en Prosegur cada llanta lleva su *UB*");
      expect((await store.getConversation(PHONE))?.step).toBe("need_fields");
    });
  });
});
