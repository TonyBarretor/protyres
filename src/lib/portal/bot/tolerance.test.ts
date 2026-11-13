/**
 * Tolerancia a texto de más (corrida D, punto 3): los comandos reconocen la empresa (nombre o RUC), el n° de OC, la fecha
 * y los datos del contacto aunque venga texto adicional; lo que sobra se dice en UNA línea ("No usé: «…».") y se sigue;
 * lo que falta se pregunta en vez de fallar entero. Casos reales del piloto (`oc zbuss 4500123 y responde las preguntas
 * del pedido` respondía "No encontré … en el padrón").
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import type { InboundMessage } from "../../whatsapp/webhook";
import { JsonPortalStore } from "../store";
import type { PortalUser } from "../store/types";
import { configureOrderBot } from "./commands/oc";
import { splitCompany } from "./companies";
import { getPending } from "./state";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
});

const FRANK = "51900000001";
/** Empresas inventadas. */
const RUC_ZB = "20999000077";
const RUC_ANDES = "20999000011";
const RUC_ANDES_SUR = "20999000022";
// martes 10/11/2026 10:00 en Lima
const NOW = new Date("2026-11-10T15:00:00.000Z");

let seq = 0;
let client: FakeWhatsAppClient;
let portal: JsonPortalStore;
let prices: JsonStore;
let bot: BotHandler;
let frank: PortalUser;
let ids: Record<string, number>;
const saved: Record<string, string | undefined> = {};

const say = async (body: string) => {
  const before = client.sent.length;
  const msg: InboundMessage = { id: `wamid.t${++seq}`, from: FRANK, timestamp: "1", type: "text", text: body, forwarded: false };
  await bot.handle(msg);
  return client.sent
    .slice(before)
    .filter((m) => m.kind === "text" || m.kind === "interactive")
    .map((m) => m.body ?? "")
    .join("\n---\n");
};

beforeEach(async () => {
  for (const k of ["LLM_DISABLED", "PHOTOS_DISABLED", "PORTAL_SESSION_SECRET", "PORTAL_BASE_URL"]) saved[k] = process.env[k];
  process.env.LLM_DISABLED = "1";
  process.env.PHOTOS_DISABLED = "1";
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  process.env.PORTAL_BASE_URL = "https://portal.example.pe";
  client = new FakeWhatsAppClient();
  portal = JsonPortalStore.memory();
  prices = JsonStore.memory();
  frank = await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  const r = await portal.upsertCompanies([
    { ruc: RUC_ZB, razonSocial: "ZETABUS S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 85, llantasPiso: 510 },
    { ruc: RUC_ANDES, razonSocial: "TRANSPORTES ANDES DEL PERU S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 12, llantasPiso: 72 },
    { ruc: RUC_ANDES_SUR, razonSocial: "EMPRESA ANDES SUR E.I.R.L.", sector: "carga", departamento: "AREQUIPA", unidades: 30, llantasPiso: 300 },
  ]);
  ids = r.ids;
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

const own = async () => portal.setOwner(ids[RUC_ZB], frank.id);

describe("splitCompany: la empresa al inicio y lo que sobra", () => {
  it("nombre, RUC, relleno al inicio, cortesía al final, y nada si no hay empresa", async () => {
    expect(await splitCompany(portal, "zetabus y responde las preguntas del pedido")).toEqual({ query: "zetabus", rest: "y responde las preguntas del pedido" });
    expect(await splitCompany(portal, "a la empresa Zetabus por favor")).toEqual({ query: "Zetabus", rest: "" });
    expect(await splitCompany(portal, `el ${RUC_ZB}, gracias`)).toEqual({ query: RUC_ZB, rest: "" });
    expect(await splitCompany(portal, "andes")).toEqual({ query: "andes", rest: "" });
    expect(await splitCompany(portal, "andes del peru que me toca")).toEqual({ query: "andes del peru", rest: "que me toca" });
    expect(await splitCompany(portal, "nadie conocida aquí")).toBeNull();
  });
});

describe("oc con texto de más", () => {
  it("`oc zetabus 4500123 y responde las preguntas del pedido`: reconoce empresa y n° de OC, dice lo que no usó y sigue", async () => {
    await own();
    const out = await say("oc zetabus 4500123 y responde las preguntas del pedido");
    expect(out).not.toContain("en el padrón");
    expect(out).toContain("OC *4500123* de *ZETABUS* registrada");
    expect(out).toContain("No usé: «y responde las preguntas del pedido».");
    const [order] = await portal.listPurchaseOrders({ companyId: ids[RUC_ZB] });
    expect(order).toMatchObject({ numero: "4500123", status: "recibida" });
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("oc_pedido");
  });

  it("n° de OC antes de la empresa, y RUC con palabras alrededor", async () => {
    await own();
    let out = await say("oc 4500999 de zetabus porfa");
    expect(out).toContain("OC *4500999* de *ZETABUS* registrada");
    expect(out).not.toContain("No usé");
    await say("cancelar");
    out = await say(`oc la empresa ${RUC_ZB} n° 4501000 urgente`);
    expect(out).toContain("OC *4501000* de *ZETABUS* registrada");
    expect(out).toContain("No usé: «urgente».");
  });
});

describe("empresa y asignarme con texto de más", () => {
  it("`empresa zetabus y dame su ficha` -> ficha + una línea con lo no usado", async () => {
    const out = await say("empresa zetabus y dame su ficha");
    expect(out).toContain("🏢 *ZETABUS S.A.C.*");
    expect(out).toContain("No usé: «y dame su ficha».");
  });

  it("`asignarme a zetabus por favor` y `asígname la empresa zetabus que la visito mañana`", async () => {
    let out = await say("asignarme a zetabus por favor");
    expect(out).toContain("✔ Empresa asignada a ti.");
    expect(out).not.toContain("No usé");
    expect((await portal.getCompany(ids[RUC_ZB]))?.ownerUserId).toBe(frank.id);
    out = await say("asígname la empresa zetabus que la visito mañana");
    expect(out).toContain("✔ Ya era tuya.");
    expect(out).toContain("No usé: «que la visito mañana».");
  });

  it("varias coincidencias con texto de más: la lista lleva la línea de lo no usado", async () => {
    const out = await say("asignarme andes para trabajarla");
    expect(out).toContain("Encontré 2 empresas con «andes»");
    expect(out).toContain("No usé: «para trabajarla».");
  });
});

describe("cita con texto de más o con datos faltantes", () => {
  it("`cita zetabus para revisar llantas martes 10am`: la cita se agenda y dice lo que no usó", async () => {
    await own();
    const out = await say("cita zetabus para revisar llantas el viernes 10am");
    expect(out).toContain("📅 Cita con *ZETABUS S.A.C.*");
    expect(out).toContain("No usé: «para revisar llantas».");
  });

  it("sin fecha: pregunta el día y la hora, y la respuesta agenda la cita", async () => {
    await own();
    let out = await say("cita zetabus");
    expect(out).toContain("¿Qué día y a qué hora es la cita con *ZETABUS S.A.C.*?");
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("cita_fecha");
    out = await say("el viernes a las 10am");
    expect(out).toContain("📅 Cita con *ZETABUS S.A.C.*");
    expect(await portal.listAppointments({ companyId: ids[RUC_ZB] })).toHaveLength(1);
  });

  it("sin empresa: pregunta con qué empresa, y la respuesta agenda la cita", async () => {
    await own();
    let out = await say("cita el viernes 10am");
    expect(out).toContain("¿Con qué empresa es la cita");
    out = await say("zetabus");
    expect(out).toContain("📅 Cita con *ZETABUS S.A.C.*");
  });
});

describe("contacto sin el formato exacto", () => {
  it("`contacto zetabus Carlos Quispe jefe de flota 987654321` (sin dos puntos ni comas)", async () => {
    await own();
    const out = await say("contacto zetabus Carlos Quispe jefe de flota 987654321");
    expect(out).toContain("✔ Contacto guardado en *ZETABUS S.A.C.*");
    const [c] = await portal.listContacts(ids[RUC_ZB]);
    expect(c).toMatchObject({ nombre: "Carlos Quispe", cargo: "Jefe de flota", telefono: "987654321" });
  });

  it("falta el nombre: lo pregunta y guarda con la respuesta", async () => {
    await own();
    let out = await say("contacto zetabus: 987 654 321");
    expect(out).toContain("¿Cómo se llama el contacto");
    out = await say("Rosa Díaz");
    expect(out).toContain("✔ Contacto guardado en *ZETABUS S.A.C.*");
    const [c] = await portal.listContacts(ids[RUC_ZB]);
    expect(c).toMatchObject({ nombre: "Rosa Díaz", telefono: "987654321" });
  });

  it("falta la empresa: la pregunta y guarda con la respuesta", async () => {
    await own();
    let out = await say("contacto Carlos Quispe, jefe de flota, 987654321");
    expect(out).toContain("¿De qué empresa es Carlos Quispe?");
    out = await say("zetabus");
    expect(out).toContain("✔ Contacto guardado en *ZETABUS S.A.C.*");
  });
});
