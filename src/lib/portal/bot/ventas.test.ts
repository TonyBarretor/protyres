/**
 * ventas-odoo, punto 9: `ultima venta <empresa> [medida]` (escrito y por voz) y `cliente final <factura> <empresa>` en el
 * bot. Ventas cargadas con el mismo camino que "Subir ventas" (reporte de Odoo armado con odoo-fixture). Datos inventados.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient, type OutboundMessage } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import type { InboundMessage } from "../../whatsapp/webhook";
import { lastTyreSales } from "../sales/history";
import type { OdooFixtureLine } from "../sales/odoo-fixture";
import { seedOdoo } from "../sales/odoo-seed";
import { JsonPortalStore } from "../store";
import { PORTAL_HELP } from "./commands/ayuda";
import { configureSalesBot, parseClienteFinal, parseUltimaVenta } from "./commands/ventas";
import { configureReportBot } from "./report";
import { parsePortalCommand } from "./router";
import { getPending } from "./state";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
  salespeople: { "51900000001": { name: "Frank Rodríguez" } },
});

const FRANK = "51900000001";
const TECNICO = "51900000007";
/** RUC y razones sociales inventados (el del banco es el RUC público del BCP, que está en sales.leasingRucs por defecto). */
const RUC_ANCRO = "20999000077";
const RUC_ANDINO = "20999000078";
const RUC_ANDINO_SUR = "20999000079";
const RUC_FUERA = "20999000099";
const RUC_BANCO = "20100047218";

const VENTAS: OdooFixtureLine[] = [
  { fecha: "2026-06-01", documento: "F003-4001", ruc: RUC_ANCRO, razon: "TRANSPORTES ANCRO PRUEBA S.A.C.", descripcion: "[P0759] 295/80R22.5 18PR FENIXWAY VALOR 89", cantidad: 4, precio: 240, costo: 190, margen: "20.83%" },
  { fecha: "2026-07-15", documento: "F003-4002", ruc: RUC_ANCRO, razon: "TRANSPORTES ANCRO PRUEBA S.A.C.", descripcion: "[P0759] 295/80R22.5 18PR FENIXWAY VALOR 89", cantidad: 6, precio: 248, costo: 192, margen: "22.58%" },
  { fecha: "2026-08-20", documento: "F003-4003", ruc: RUC_ANCRO, razon: "TRANSPORTES ANCRO PRUEBA S.A.C.", descripcion: "[P0433] 295/80R22.5 18PR FENIXWAY FLAMA 66 DEL", cantidad: 2, precio: 250, costo: 195, margen: "22.00%" },
  { fecha: "2026-09-12", documento: "F003-4004", ruc: RUC_ANCRO, razon: "TRANSPORTES ANCRO PRUEBA S.A.C.", descripcion: "[P0759] 295/80R22.5 18PR FENIXWAY VALOR 89", cantidad: 8, precio: 255, costo: 199.15, margen: "21.90%" },
  { fecha: "2026-10-01", documento: "F003-4005", ruc: RUC_ANCRO, razon: "TRANSPORTES ANCRO PRUEBA S.A.C.", descripcion: "[P0434] 11R22.5 18PR FENIXWAY VALOR 96 MIX", cantidad: 4, precio: 1050, costo: 800, moneda: "PEN", margen: "23.81%" },
  // nota de crédito: no es una venta
  { fecha: "2026-10-05", tipoDoc: "Nota Crédito", documento: "F003-91", ocProveedor: "Reversión de: F003-4004, DEVOLUCION DE MERCADERIA", ruc: RUC_ANCRO, razon: "TRANSPORTES ANCRO PRUEBA S.A.C.", descripcion: "[P0759] 295/80R22.5 18PR FENIXWAY VALOR 89", cantidad: 1, precio: 255, costo: 199.15, totalSoles: 0, margen: "0.00%" },
  { fecha: "2026-10-02", documento: "F003-5003", ruc: RUC_FUERA, razon: "EMPRESA FUERA DEL PADRON EIRL", descripcion: "[P0336] 215/75R17.5 18PR FENIXWAY VALOR 99 MIX", cantidad: 6, precio: 126.42, costo: 90, margen: "28.81%" },
  // leasing: el banco compra para un cliente final
  { fecha: "2026-10-04", documento: "F003-6001", ruc: RUC_BANCO, razon: "BANCO DE CREDITO DEL PERU", descripcion: "[P0759] 295/80R22.5 18PR FENIXWAY VALOR 89", cantidad: 10, precio: 258, costo: 200, margen: "22.48%" },
  { fecha: "2026-10-04", documento: "F003-6001", ruc: RUC_BANCO, razon: "BANCO DE CREDITO DEL PERU", descripcion: "[SERV.BALAN] SERVICIO DE BALANCEO VEHICULAR", cantidad: 10, precio: 20, moneda: "PEN", margen: "SERVICIO SIN COSTO" },
];

let seq = 0;
let client: FakeWhatsAppClient;
let portal: JsonPortalStore;
let bot: BotHandler;
let queue: string[];
let ids: Record<string, number>;
const saved: Record<string, string | undefined> = {};

const text = (body: string, from = FRANK): InboundMessage => ({ id: `wamid.vt${++seq}`, from, timestamp: "1", type: "text", text: body, forwarded: false });
function voice(transcript: string): InboundMessage {
  queue.push(transcript);
  const id = `aud-vt-${++seq}`;
  client.media.set(id, { data: Buffer.from("OggS-fake"), mimeType: "audio/ogg; codecs=opus" });
  return { id: `wamid.vt${seq}`, from: FRANK, timestamp: "1", type: "audio", forwarded: false, media: { id, mimeType: "audio/ogg; codecs=opus" } };
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

beforeEach(async () => {
  for (const k of ["LLM_DISABLED", "PHOTOS_DISABLED", "DEEPGRAM_API_KEY", "PORTAL_SESSION_SECRET"]) saved[k] = process.env[k];
  process.env.LLM_DISABLED = "1";
  process.env.PHOTOS_DISABLED = "1";
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  process.env.DEEPGRAM_API_KEY = "dg-test-key";
  client = new FakeWhatsAppClient();
  portal = JsonPortalStore.memory();
  queue = [];
  const frank = await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  await portal.upsertUser({ nombre: "Técnico Prueba", whatsapp: TECNICO, rol: "tecnico" });
  const r = await portal.upsertCompanies([
    { ruc: RUC_ANCRO, razonSocial: "TRANSPORTES ANCRO PRUEBA S.A.C.", sector: "carga", departamento: "LIMA", unidades: 20, llantasPiso: 200 },
    { ruc: RUC_ANDINO, razonSocial: "TRANSPORTES ANDINO PRUEBA S.A.C.", sector: "carga", departamento: "LIMA", unidades: 10, llantasPiso: 100 },
    { ruc: RUC_ANDINO_SUR, razonSocial: "TRANSPORTES ANDINO SUR PRUEBA S.A.C.", sector: "carga", departamento: "CUSCO", unidades: 8, llantasPiso: 80 },
  ]);
  ids = r.ids;
  await seedOdoo(portal, VENTAS, frank);
  const deepgramFetch = (async () => {
    const transcript = queue.shift();
    if (transcript === undefined) throw new Error("cola de transcripciones vacía");
    return new Response(JSON.stringify({ metadata: { duration: 6 }, results: { channels: [{ alternatives: [{ transcript, confidence: 0.9 }] }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  configureReportBot({ llm: null, deepgramFetch, downloadMedia: (id) => client.downloadMedia(id) });
  configureSalesBot({ prices: null });
  bot = new BotHandler({ client, store: JsonStore.memory(), settings, portalStore: portal });
});

afterEach(() => {
  configureReportBot(null);
  configureSalesBot(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("ventas en el bot: reconocimiento de los comandos", () => {
  it("«ultima venta …» es comando aunque lleve la medida (sin tildes ni mayúsculas); «cliente final …» también", () => {
    expect(parsePortalCommand("ultima venta ancro 295/80R22.5")).toEqual({ name: "ultima_venta", args: "ancro 295/80R22.5" });
    expect(parsePortalCommand("Última venta Ancro")).toEqual({ name: "ultima_venta", args: "Ancro" });
    expect(parsePortalCommand("ULTIMAS VENTAS 20999000077")).toEqual({ name: "ultima_venta", args: "20999000077" });
    expect(parsePortalCommand("cliente final F003-4050 transportes x")).toEqual({ name: "cliente_final", args: "F003-4050 transportes x" });
    // los demás comandos con medida siguen siendo pedidos
    expect(parsePortalCommand("empresa zbuss 295/80R22.5")).toBeNull();
    expect(parsePortalCommand("cliente: Transportes X")).toBeNull();
  });

  it("separa empresa y medida (escrita o dictada) y la factura de la empresa", () => {
    expect(parseUltimaVenta("ancro 295/80R22.5")).toEqual({ empresa: "ancro", medida: "295/80R22.5" });
    expect(parseUltimaVenta("a Ancro de doscientos noventa y cinco ochenta veintidós punto cinco.")).toEqual({ empresa: "a Ancro", medida: "295/80R22.5" });
    expect(parseUltimaVenta("transportes ancro prueba")).toEqual({ empresa: "transportes ancro prueba", medida: null });
    expect(parseClienteFinal("F003-4050 transportes x")).toEqual({ documento: "F003-4050", empresa: "transportes x" });
    expect(parseClienteFinal("f003 4050 20999000077")).toEqual({ documento: "F003-4050", empresa: "20999000077" });
    expect(parseClienteFinal("transportes x F003-4050")).toEqual({ documento: "F003-4050", empresa: "transportes x" });
    expect(parseClienteFinal("B BOL-00000007 juan perez")).toEqual({ documento: "B BOL-00000007", empresa: "juan perez" });
    expect(parseClienteFinal("transportes x")).toBeNull();
  });

  it("los dos están en *ayuda portal*", () => {
    expect(PORTAL_HELP).toContain("*ultima venta ZBUSS 295/80R22.5*");
    expect(PORTAL_HELP).toContain("*cliente final F003-4050 ZBUSS*");
  });
});

describe("ultima venta", () => {
  it("las 3 últimas de esa medida, la más reciente primero, con precio, costo y margen en la moneda de la factura", async () => {
    const out = await say("ultima venta ancro 295/80R22.5");
    const lines = out.split("\n");
    expect(lines[0]).toBe("🧾 *Últimas ventas a TRANSPORTES ANCRO PRUEBA* · 295/80R22.5");
    expect(lines.filter((l) => l.startsWith("• "))).toEqual([
      "• 12/09/2026 · Fenixway Valor 89 295/80R22.5 · 8 u. · precio US$ 255.00 · costo US$ 199.15 · margen 21.90%",
      "• 20/08/2026 · Fenixway Flama 66 295/80R22.5 · 2 u. · precio US$ 250.00 · costo US$ 195.00 · margen 22.00%",
      "• 15/07/2026 · Fenixway Valor 89 295/80R22.5 · 6 u. · precio US$ 248.00 · costo US$ 192.00 · margen 22.58%",
    ]);
    // ni la nota de crédito, ni la 4.ª más antigua, ni otra medida
    expect(out).not.toContain("01/06/2026");
    expect(out).not.toContain("11R22.5");
  });

  it("sin medida: las 3 últimas de cualquier medida (en soles la de soles)", async () => {
    const out = await say("Última venta transportes ancro");
    const items = out.split("\n").filter((l) => l.startsWith("• "));
    expect(items).toHaveLength(3);
    expect(items[0]).toBe("• 01/10/2026 · Fenixway Valor 96 11R22.5 · 4 u. · precio S/ 1,050.00 · costo S/ 800.00 · margen 23.81%");
  });

  it("cliente fuera del padrón: se busca por razón social (o RUC) en las ventas", async () => {
    expect(await say("ultima venta fuera del padron")).toContain("• 02/10/2026 · Fenixway Valor 99 215/75R17.5 · 6 u. · precio US$ 126.42");
    expect(await say(`ultima venta ${RUC_FUERA} 215/75R17.5`)).toContain("🧾 *Última venta a EMPRESA FUERA DEL PADRON*");
  });

  it("sin ventas de esa medida, o sin ventas: una respuesta corta que dice qué hacer", async () => {
    expect(await say("ultima venta ancro 315/80R22.5")).toBe(`No hay ventas de *315/80R22.5* a *TRANSPORTES ANCRO PRUEBA* en lo cargado de Odoo. Sí hay de otras medidas: escribe *ultima venta ${RUC_ANCRO}*.`);
    expect(await say("ultima venta transportes andino prueba")).toContain("No hay ventas de neumáticos a *TRANSPORTES ANDINO PRUEBA*");
    expect(await say("ultima venta empresa inexistente")).toContain("No encontré «empresa inexistente» en el padrón ni en las ventas cargadas");
  });

  it("varias empresas en el padrón: la lista para elegir y, al elegir, las ventas", async () => {
    const out = await say("ultima venta andino");
    expect(out).toContain("Encontré 2 empresas con «andino»");
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("choose_company");
    expect(await say("1")).toMatch(/No hay ventas de neumáticos a \*TRANSPORTES ANDINO (SUR )?PRUEBA\*/);
  });

  it("un técnico no la ve (lleva costo y margen)", async () => {
    const out = await say(text("ultima venta ancro 295/80R22.5", TECNICO));
    expect(out).toBe("Las ventas (con costo y margen) las ven el vendedor, el supervisor y el administrador.");
  });

  it("por voz: «última venta a Ancro de doscientos noventa y cinco ochenta veintidós punto cinco» es el mismo comando", async () => {
    const out = await say(voice("Última venta a Ancro de doscientos noventa y cinco ochenta veintidós punto cinco."));
    expect(out).toContain("🧾 *Últimas ventas a TRANSPORTES ANCRO PRUEBA* · 295/80R22.5");
    expect(out).toContain("• 12/09/2026 · Fenixway Valor 89 295/80R22.5 · 8 u. · precio US$ 255.00 · costo US$ 199.15 · margen 21.90%");
    // no se tomó como cotización ni como reporte
    expect(out).not.toContain("Entendí:\n");
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
  });
});

describe("cliente final", () => {
  it("la factura del banco pasa a contar para la empresa (y deja de contar para el banco)", async () => {
    expect((await lastTyreSales(portal, RUC_ANCRO, { medida: "295/80R22.5", limit: 1 }))[0].fecha).toBe("2026-09-12");
    const out = await say("cliente final F003-6001 transportes ancro");
    expect(out).toBe("✅ *F003-6001* (10 neumáticos) ahora cuenta para *TRANSPORTES ANCRO PRUEBA* (vía leasing con BANCO DE CREDITO DEL PERU).");
    const [last] = await lastTyreSales(portal, RUC_ANCRO, { medida: "295/80R22.5", limit: 1 });
    expect(last).toMatchObject({ fecha: "2026-10-04", ruc: RUC_BANCO });
    expect(last.detalle?.clienteFinalCompanyId).toBe(ids[RUC_ANCRO]);
    expect(await lastTyreSales(portal, RUC_BANCO)).toEqual([]);
    // la última venta a ANCRO ya la incluye, "vía leasing"
    expect(await say("ultima venta ancro 295/80R22.5")).toContain("• 04/10/2026 · Fenixway Valor 89 295/80R22.5 · 10 u. · precio US$ 258.00 · costo US$ 200.00 · margen 22.48% · vía leasing con BANCO DE CREDITO DEL PERU");
  });

  it("con el RUC y la factura escrita de otra forma; reasignar dice para quién contaba antes", async () => {
    await say("cliente final F003-6001 transportes ancro");
    const out = await say(`cliente final f003 6001 ${RUC_ANDINO}`);
    expect(out).toBe("✅ *F003-6001* (10 neumáticos) ahora cuenta para *TRANSPORTES ANDINO PRUEBA* (vía leasing con BANCO DE CREDITO DEL PERU).\nAntes contaba para *TRANSPORTES ANCRO PRUEBA*.");
  });

  it("una factura que no es de leasing, una que no existe, o sin empresa: lo dice", async () => {
    expect(await say("cliente final F003-4004 transportes andino prueba")).toBe(`La *F003-4004* es de *TRANSPORTES ANCRO PRUEBA* (RUC ${RUC_ANCRO}), que no es una entidad de leasing: sus neumáticos ya cuentan para ese cliente.`);
    expect(await say("cliente final F003-9999 ancro")).toContain("No encontré la factura *F003-9999*");
    expect(await say("cliente final F003-6001")).toContain("¿Para qué empresa es la *F003-6001*?");
    expect(await say("cliente final transportes ancro")).toContain("¿Qué factura?");
  });

  it("empresa ambigua: la lista; al elegir, se asigna", async () => {
    const out = await say("cliente final F003-6001 andino");
    expect(out).toContain("Encontré 2 empresas con «andino»");
    expect(await say("2")).toMatch(/^✅ \*F003-6001\* \(10 neumáticos\) ahora cuenta para \*TRANSPORTES ANDINO (SUR )?PRUEBA\*/);
  });

  it("un técnico no puede asignarla", async () => {
    expect(await say(text("cliente final F003-6001 ancro", TECNICO))).toBe("Las ventas (con costo y margen) las ven el vendedor, el supervisor y el administrador.");
    expect((await lastTyreSales(portal, RUC_BANCO)).length).toBe(1);
  });
});
