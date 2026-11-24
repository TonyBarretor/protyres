/**
 * Corrida L — `direccion <empresa>` (texto y voz) y la dirección en la ficha de `empresa`. Empresas y SUNAT inventados.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import type { InboundMessage } from "../../whatsapp/webhook";
import { JsonPortalStore } from "../store";
import type { SunatLocalInput, SunatRecordInput } from "../store/types";
import { setCompanyDireccion } from "../match/company";
import { PORTAL_HELP } from "./commands/ayuda";
import { configureReportBot } from "./report";
import { parsePortalCommand, routeIntent } from "./router";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
  salespeople: { "51900000001": { name: "Frank Rodríguez" } },
});
const FRANK = "51900000001";
const ZB = "20999000055";
const BAJA = "20999000066";
const SIN = "20999000077";
let seq = 0;
const text = (body: string): InboundMessage => ({ id: `wamid.d${++seq}`, from: FRANK, timestamp: "1", type: "text", text: body, forwarded: false });

let client: FakeWhatsAppClient;
let portal: JsonPortalStore;
let bot: BotHandler;
const saved: Record<string, string | undefined> = {};

const rec = (ruc: string, o: Partial<SunatRecordInput> = {}): SunatRecordInput => ({
  ruc,
  encontrado: true,
  razonSocial: null,
  estado: "ACTIVO",
  condicion: "HABIDO",
  ubigeo: "150103",
  departamento: "LIMA",
  provincia: "LIMA",
  distrito: "ATE",
  direccion: "Av. Nicolas Ayllon 3820, Urb. Santa Raquel, Ate, Lima",
  piezas: null,
  anexos: 0,
  fecha: "2026-11-23",
  ...o,
});
const local = (ruc: string, ubigeo: string, dep: string, direccion: string): SunatLocalInput => ({ ruc, ubigeo, departamento: dep, provincia: null, distrito: null, direccion, piezas: { tipoVia: null, nombreVia: null, tipoZona: null, nombreZona: null, numero: null, interior: null, lote: null, dpto: null, manzana: null, kilometro: null }, fecha: "2026-11-23" });

beforeEach(async () => {
  for (const k of ["PORTAL_SESSION_SECRET", "PORTAL_BASE_URL", "LLM_DISABLED", "DEEPGRAM_API_KEY"]) saved[k] = process.env[k];
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  process.env.PORTAL_BASE_URL = "https://portal.example.pe";
  process.env.LLM_DISABLED = "1";
  client = new FakeWhatsAppClient();
  portal = JsonPortalStore.memory();
  await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  await portal.upsertCompanies([
    { ruc: ZB, razonSocial: "ZETA BUSES PRUEBA S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 40 },
    { ruc: BAJA, razonSocial: "CARGAS DADAS DE BAJA PRUEBA S.A.", sector: "carga", departamento: "AREQUIPA", unidades: 20 },
    { ruc: SIN, razonSocial: "SIN SUNAT PRUEBA E.I.R.L.", sector: "carga", departamento: "PIURA", unidades: 12 },
  ]);
  await portal.upsertSunat([rec(ZB, { anexos: 8 }), rec(BAJA, { estado: "BAJA DE OFICIO", condicion: "NO HABIDO", ubigeo: "040103", departamento: "AREQUIPA", provincia: "AREQUIPA", distrito: "CAYMA", direccion: "Calle Los Arces 505, Cayma, Arequipa" })]);
  await portal.replaceSunatLocales(
    [ZB],
    [
      local(ZB, "040103", "AREQUIPA", "Av. Uno 1, Cayma, Arequipa"),
      local(ZB, "040103", "AREQUIPA", "Av. Dos 2, Cayma, Arequipa"),
      local(ZB, "150140", "LIMA", "Jr. Tres 3, Santiago de Surco, Lima"),
      local(ZB, "150131", "LIMA", "Calle Cuatro 4, San Isidro, Lima"),
      local(ZB, "200101", "PIURA", "Av. Cinco 5, Piura"),
      local(ZB, "200101", "PIURA", "Av. Seis 6, Piura"),
      local(ZB, "130101", "LA LIBERTAD", "Av. Siete 7, Trujillo, La Libertad"),
      local(ZB, "040103", "AREQUIPA", "Av. Ocho 8, Cayma, Arequipa"),
    ],
  );
  bot = new BotHandler({ client, store: JsonStore.memory(), settings, portalStore: portal });
});

afterEach(() => {
  configureReportBot({});
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const last = () => client.texts().at(-1) ?? "";

describe("router: `direccion`", () => {
  it("escrito y dictado; no se roba un campo del pedido ni una dirección escrita", () => {
    expect(parsePortalCommand("direccion zbuss")).toEqual({ name: "direccion", args: "zbuss" });
    expect(parsePortalCommand("Dirección de ZBUSS")).toEqual({ name: "direccion", args: "ZBUSS" });
    expect(parsePortalCommand("Dónde queda ZBUSS")).toEqual({ name: "direccion", args: "ZBUSS" });
    expect(parsePortalCommand("¿Dónde queda zeta buses?")?.name).toBe("direccion");
    expect(parsePortalCommand("como llego a zbuss")).toEqual({ name: "direccion", args: "zbuss" });
    // campo del cotizador o respuesta del pedido: no
    expect(parsePortalCommand("Dirección: Av. Argentina 123")).toBeNull();
    expect(parsePortalCommand("dirección de entrega Av. Argentina 123")).toBeNull();
    expect(parsePortalCommand("direccion fiscal Jr. Lima 100")).toBeNull();
    expect(parsePortalCommand("dirección Av. Argentina 2833 Callao")).toBeNull();
    expect(routeIntent({ text: "direccion zbuss", state: "idle", isPortalUser: true }).intent).toBe("portal_command");
  });
});

describe("`direccion <empresa>`", () => {
  it("domicilio fiscal, Según SUNAT al…, aviso de la flota, locales resumidos (los del departamento de la flota primero) y Cómo llegar", async () => {
    await bot.handle(text("direccion zeta buses"));
    const out = last();
    expect(out).toContain("*ZETA BUSES PRUEBA S.A.C.*");
    expect(out).toContain("Domicilio fiscal: Av. Nicolas Ayllon 3820, Urb. Santa Raquel, Ate, Lima");
    expect(out).toContain("Según SUNAT al 23/11/2026");
    expect(out).toContain("El domicilio fiscal puede no ser donde opera la flota");
    expect(out).toContain("https://www.google.com/maps/search/?api=1&query=Av.%20Nicolas%20Ayllon%203820");
    expect(out).toContain("Locales anexos (8)");
    // los de Lima (donde está su flota) primero y destacados; 5 listados y el resto resumido por departamento
    const lines = out.split("\n");
    const firstLocal = lines.findIndex((l) => l.startsWith("• "));
    expect(lines[firstLocal]).toContain("Calle Cuatro 4, San Isidro, Lima");
    expect(lines[firstLocal]).toContain("*en LIMA*");
    expect(lines.filter((l) => l.startsWith("• "))).toHaveLength(5);
    expect(out).toContain("…y 3 más (2 en Piura, 1 en La Libertad)");
    expect(out).not.toContain("SUNAT:");
  });

  it("estado de alerta en rojo", async () => {
    await bot.handle(text("dirección de cargas dadas de baja"));
    expect(last()).toContain("⛔ SUNAT: BAJA DE OFICIO · NO HABIDO");
  });

  it("la dirección de operación manda y se dice; la fiscal debajo", async () => {
    const zb = (await portal.getCompanyByRuc(ZB))!;
    const frank = (await portal.getUserByWhatsapp(FRANK))!;
    await setCompanyDireccion(portal, frank, zb.id, "Av. Separadora Industrial 2000, Ate (patio)");
    await bot.handle(text("direccion zeta buses"));
    const out = last();
    expect(out).toContain("Dirección de operación (la anotó el vendedor): Av. Separadora Industrial 2000, Ate (patio)");
    expect(out).toContain("Domicilio fiscal: Av. Nicolas Ayllon 3820");
    expect(out).toContain("query=Av.%20Separadora%20Industrial%202000");
  });

  it("sin dato de SUNAT: lo dice y ofrece la búsqueda aproximada", async () => {
    await bot.handle(text("direccion sin sunat prueba"));
    expect(last()).toContain("No tengo su domicilio fiscal de SUNAT");
    expect(last()).toContain("búsqueda aproximada");
  });

  it("por voz: «¿Dónde queda Zeta Buses?» corre el comando (no es un reporte)", async () => {
    process.env.DEEPGRAM_API_KEY = "dg-test-key";
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ metadata: { duration: 2 }, results: { channels: [{ alternatives: [{ transcript: "¿Dónde queda Zeta Buses?", confidence: 0.95 }] }] } }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    configureReportBot({ llm: null, deepgramFetch: fetchImpl, downloadMedia: async () => ({ data: Buffer.from("OggS"), mimeType: "audio/ogg" }) });
    await bot.handle({ id: `wamid.d${++seq}`, from: FRANK, timestamp: "1", type: "audio", forwarded: false, media: { id: "aud-d1", mimeType: "audio/ogg" } });
    const all = client.texts().join("\n");
    expect(all).toContain("Domicilio fiscal: Av. Nicolas Ayllon 3820");
    expect(all).not.toContain("Reporte de");
  });

  it("la ficha de `empresa` incluye la dirección (y el aviso de SUNAT)", async () => {
    await bot.handle(text("empresa zeta buses"));
    expect(last()).toContain("📍 Av. Nicolas Ayllon 3820, Urb. Santa Raquel, Ate, Lima _(domicilio fiscal, SUNAT al 23/11/2026)_");
    await bot.handle(text("empresa cargas dadas de baja"));
    expect(last()).toContain("⛔ SUNAT: BAJA DE OFICIO · NO HABIDO");
  });

  it("`ayuda portal` lista `direccion`", () => {
    expect(PORTAL_HELP).toContain("*direccion ZBUSS*");
  });
});
