/**
 * Corrida H, punto 2 — el bot de punta a punta (BotHandler.handle, el mismo del webhook) contra Postgres real: un
 * recorrido de vendedor con empresas inventadas (asignarme, contacto, cita y reprogramación, reporte escrito y por voz,
 * cotización numerada y enlazada, OC y pedido, estado, avance, mejores, hoy, vocabulario) con los stores JSON y con los
 * de Postgres. Lo que el vendedor lee tiene que ser lo mismo en los dos; y nada termina en "Ocurrió un error".
 * Además: dos vendedores que se asignan la misma empresa a la vez.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PriceRow } from "../lib/ingest/types";
import { SettingsSchema, type Settings } from "../lib/settings";
import { JsonStore } from "../lib/store/json-store";
import { PgStore } from "../lib/store/pg-store";
import type { PriceStore } from "../lib/store/types";
import { FakeWhatsAppClient, type OutboundMessage } from "../lib/whatsapp/client";
import { BotHandler } from "../lib/whatsapp/handler";
import { parseWebhook, type InboundMessage } from "../lib/whatsapp/webhook";
import { JsonPortalStore } from "../lib/portal/store/json-portal-store";
import { PgPortalStore } from "../lib/portal/store/pg-portal-store";
import type { FleetVehicleInput, PortalStore } from "../lib/portal/store/types";
import { configureReportBot } from "../lib/portal/bot/report";
import { configureOrderBot } from "../lib/portal/bot/commands/oc";
import { recalcScores } from "../lib/portal/scoring/recalc";
import { loadPortalConfig } from "../lib/portal/config";
import { testDbUrl, truncateAll } from "./harness";
import { diffTraces } from "./parity";

const FRANK = "51900000001";
const OTRO = "51900000003";
const RUC_ANDES = "20999000011";
const RUC_ROCA = "20999000044";
const RUC_NORTE = "20999000033";
const TODAY = new Date().toISOString().slice(0, 10);

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7, paymentType: "Factura crédito", paymentTerm: "30 días" },
  salespeople: { default: FRANK, [FRANK]: { name: "Frank Prueba", title: "Key Account Manager", phone: "900 000 001", email: "frank@example.pe" }, [OTRO]: { name: "Otro Vendedor" } },
});

function row(p: Partial<PriceRow> & Pick<PriceRow, "id" | "provider" | "kind" | "brand" | "model" | "size" | "cost">): PriceRow {
  return {
    description: `${p.size} ${p.brand} ${p.model}`.toUpperCase(), sizeDisplay: p.size, sizeRaw: p.size, isTyre: true, ply: 18, priceIncludesTax: p.kind === "own",
    currency: "USD", stock: p.kind === "provider" ? 40 : null, priceDate: TODAY, source: "excel", sourceRef: "test.xlsx", ...p,
  };
}

const ROWS: PriceRow[] = [
  row({ id: "own-valor87", provider: "360 Tyres", kind: "own", brand: "Fenixway", model: "Valor 87", size: "295/80R22.5", cost: 472 }),
  row({ id: "own-flama77", provider: "360 Tyres", kind: "own", brand: "Fenixway", model: "Flama 77", size: "295/80R22.5", cost: 460 }),
  row({ id: "prov-flama77", provider: "Llantas del Sur", kind: "provider", brand: "Fenixway", model: "Flama 77", size: "315/80R22.5", cost: 200 }),
];

function vehicle(companyId: number, placa: string, medida: string): FleetVehicleInput {
  return { companyId, placa, marca: "VOLVO", clase: "OMNIBUS", anio: 2018, ejes: 2, llantas: 6, llantasFuente: "20241231", pesoBruto: 18000, chasis: null, departamento: "LIMA", origen: "pasajeros", medidaProbable: medida, confianza: "media" };
}

async function seed(portal: PortalStore, prices: PriceStore): Promise<void> {
  await prices.upsertRows(ROWS);
  await portal.upsertUser({ nombre: "Frank Prueba", whatsapp: FRANK, rol: "vendedor" });
  await portal.upsertUser({ nombre: "Otro Vendedor", whatsapp: OTRO, rol: "vendedor" });
  const r = await portal.upsertCompanies([
    { ruc: RUC_ANDES, razonSocial: "TRANSPORTES ANDES DEL PERU S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 12, llantasPiso: 72 },
    { ruc: RUC_ROCA, razonSocial: "E.T. LA ROCA S.R.L.", sector: "carga", departamento: "LIMA", unidades: 15, llantasPiso: 150 },
    { ruc: RUC_NORTE, razonSocial: "EXPRESO NORTEÑO S.A.", sector: "mixto", departamento: "PIURA", unidades: 40, llantasPiso: 400 },
  ]);
  await portal.upsertFleet([...Array.from({ length: 6 }, (_, i) => vehicle(r.ids[RUC_ANDES], `AAA-10${i}`, "295/80R22.5")), ...Array.from({ length: 4 }, (_, i) => vehicle(r.ids[RUC_NORTE], `NNN-10${i}`, "11R22.5"))]);
  await portal.insertSales([{ fecha: TODAY, ruc: RUC_ROCA, cantidad: 8, origen: "excel", sourceRef: "xlsx:seed" }]);
  await recalcScores(portal, loadPortalConfig().scoring, { prices });
}

/**
 * La mitad JSON y la de Postgres deben correr el mismo día de Lima: el guion dice "20/11" y "hoy", y si la medianoche cae
 * entre las dos, la entrega pasa a leerse como el año siguiente y la agenda cambia de día (pasó 1 vez en 30 corridas).
 * No se usa un reloj falso porque Postgres sella filas con now() del servidor. Cerca de la medianoche se espera a que pase.
 */
async function notNearLimaMidnight(windowMs = 10 * 60_000): Promise<void> {
  const lima = new Date(Date.now() - 5 * 3600_000); // Lima es UTC−5 todo el año
  const msToMidnight = 86_400_000 - ((lima.getUTCHours() * 60 + lima.getUTCMinutes()) * 60_000 + lima.getUTCSeconds() * 1000 + lima.getUTCMilliseconds());
  if (msToMidnight < windowMs) await new Promise((r) => setTimeout(r, msToMidnight + 5_000));
}

/** Lo que el vendedor (y otros números) reciben, sin lo que cambia de una corrida a otra (enlaces con token). */
function visible(m: OutboundMessage): unknown {
  // la hora del mensaje ("16:51") cambia entre la corrida JSON y la de Postgres: las horas de Lima de estos minutos
  const now = Date.now();
  const clock = new Set(Array.from({ length: 21 }, (_, i) => new Date(now + (i - 15) * 60_000).toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit", hour12: false })));
  const clean = (s: string | undefined) => s?.replace(/https?:\/\/\S+/g, "<enlace>").replace(/\b\d{2}:\d{2}\b/g, (t) => (clock.has(t) ? "<hora>" : t));
  const buttons = m.interactive ? (m.interactive.type === "button" ? m.interactive.buttons.map((b) => b.title) : m.interactive.sections.flatMap((s) => s.rows).map((r) => r.title)) : undefined;
  return { to: m.to, kind: m.kind, body: clean(m.body), fileName: m.fileName, caption: clean(m.caption), buttons };
}

interface Run {
  client: FakeWhatsAppClient;
  bot: BotHandler;
  /** Respuestas por línea del guion. */
  trace: Record<string, unknown>;
}


/**
 * Guion: líneas de texto; "@botón || texto" pulsa ese botón del último interactivo (como WhatsApp) o, si no está,
 * manda el texto; "@voz <texto>" manda una nota de voz cuya transcripción (la de Deepgram) es <texto>; "@resto <botón>" pulsa ese botón mientras el
 * último mensaje del bot lo ofrezca (hasta 5 veces).
 */
const SCRIPT = [
  "cancelar",
  "portal",
  "empresa andes del peru",
  "@Asignarme || asignarme andes del peru",
  "contacto andes del peru: Carlos Quispe, jefe de flota, 987 654 321",
  "cita andes del peru martes 10am en su base de Ate",
  "cita andes del peru martes 10am",
  "@Reprogramar || reprogramar",
  "jueves 4pm",
  "Visité TRANSPORTES ANDES DEL PERU, hablé con Carlos Quispe, jefe de flota. Tienen 12 ómnibus y quieren probar Fenixway en direccional. Quedamos en mandarle la cotización el jueves.",
  "@Sí, guardar || sí",
  "@voz Llamé a transportes andes del perú, hablé con Carlos Quispe, quedamos en visitarlos el jueves para revisar la flota.",
  "@Sí, guardar || sí",
  "Fenixway Valor 87 295/80R22.5 x8 precio 254 para TRANSPORTES ANDES DEL PERU S.A.C.",
  "ok",
  "@Enlazar || enlazar",
  "Fenixway Flama 77 295/80R22.5 x4 para E.T. LA ROCA S.R.L.",
  "ok",
  "@voz cotización para la roca cuatro llantas fenixway valor 87 295 80 r 22.5",
  "cancelar",
  "oc andes del peru 4500123",
  "@Sí || sí",
  "Av. Nicolás Ayllón 2480, Ate, Lima",
  "@La misma || la misma",
  "@Igual || igual",
  "@Ninguna || ninguna",
  "20/11",
  "@Sí || sí",
  "@No || no",
  "@Cliente || cliente",
  "@Igual || igual",
  "@Ninguna || ninguna",
  // preguntas que se agreguen al final del pedido (observaciones del despacho…): *Ninguna* mientras la ofrezca
  "@resto Ninguna",
  "estado andes del peru",
  "avance",
  "mejores",
  "más",
  "hoy",
  "aprende flamita = Flama 77",
  "ayuda portal",
];

async function runScript(portal: PortalStore, prices: PriceStore): Promise<Run> {
  const client = new FakeWhatsAppClient();
  configureOrderBot({ priceStore: prices, settings });
  let transcript = "";
  const voiceFetch = (async () =>
    new Response(JSON.stringify({ metadata: { duration: 7 }, results: { channels: [{ alternatives: [{ transcript, confidence: 0.95 }] }] } }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
  configureReportBot({ llm: null, deepgramFetch: voiceFetch, downloadMedia: async () => ({ data: Buffer.from("OggS-prueba"), mimeType: "audio/ogg" }) });
  // 30 s y no los 4 s de producción: contra el pooler remoto un pico de latencia vencía el enlace de la cotización solo en
  // la corrida de Postgres (corrida J, punto 6)
  const bot = new BotHandler({ client, store: prices, settings, portalStore: portal, portalTimeoutMs: 30_000, burstClock: (() => { let t = Date.now(); return () => (t += 5000); })() });
  const trace: Record<string, unknown> = {};
  let seq = 0;
  const lines = SCRIPT.flatMap((l) => (l.startsWith("@resto ") ? Array.from({ length: 5 }, () => l) : [l]));
  for (let [i, line] of lines.entries()) {
    const before = client.sent.length;
    if (line.startsWith("@resto ")) {
      const title = line.slice(7);
      const last = client.sent.at(-1)?.interactive;
      if (last?.type !== "button" || !last.buttons.some((b) => b.title === title)) continue;
      line = `@${title} || ${title.toLowerCase()}`;
    }
    const base = { id: `wamid.pg${++seq}.${Math.random().toString(36).slice(2)}`, from: FRANK, timestamp: String(Math.floor(Date.now() / 1000)), forwarded: false };
    let msg: InboundMessage;
    const btn = line.match(/^@(.+?)\s*\|\|\s*(.+)$/);
    if (line.startsWith("@voz ")) {
      transcript = line.slice(5);
      msg = { ...base, type: "audio", media: { id: `aud-${seq}`, mimeType: "audio/ogg" } };
    }
    else if (btn) {
      const last = client.interactives().at(-1);
      const hit = last?.type === "button" ? last.buttons.find((b) => b.title === btn[1]) : last?.sections.flatMap((s) => s.rows).find((r) => r.title === btn[1]);
      if (hit) {
        const kind = last!.type === "button" ? "button_reply" : "list_reply";
        const payload = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [{ id: base.id, from: FRANK, timestamp: base.timestamp, type: "interactive", interactive: { type: kind, [kind]: { id: hit.id, title: hit.title } } }] } }] }] };
        msg = parseWebhook(payload).messages[0];
      } else msg = { ...base, type: "text", text: btn[2] };
    } else msg = { ...base, type: "text", text: line };
    await bot.handle(msg);
    trace[`${String(i).padStart(2, "0")} ${line.slice(0, 50)}`] = client.sent.slice(before).map(visible);
  }
  configureOrderBot(null);
  configureReportBot(null);
  return { client, bot, trace };
}

let pgPortal: PgPortalStore;
let pgPrices: PgStore;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ["LLM_DISABLED", "PHOTOS_DISABLED", "DEEPGRAM_API_KEY", "PORTAL_SESSION_SECRET", "PORTAL_BASE_URL"]) saved[k] = process.env[k];
  process.env.LLM_DISABLED = "1";
  process.env.PHOTOS_DISABLED = "1";
  process.env.DEEPGRAM_API_KEY = "prueba"; // la transcripción la devuelve voiceFetch: nada sale de la máquina
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  process.env.PORTAL_BASE_URL = "https://portal.example.pe";
  await truncateAll(testDbUrl());
  pgPortal = PgPortalStore.connect(testDbUrl());
  pgPrices = await PgStore.connect(testDbUrl());
});
afterAll(async () => {
  await pgPortal?.close();
  await pgPrices?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("bot completo: JSON y Postgres responden lo mismo", () => {
  it("recorrido del vendedor", async () => {
    await notNearLimaMidnight();
    const jsonPortal = JsonPortalStore.memory();
    const jsonPrices = JsonStore.memory();
    await seed(jsonPortal, jsonPrices);
    const json = await runScript(jsonPortal, jsonPrices);
    await seed(pgPortal, pgPrices);
    const pg = await runScript(pgPortal, pgPrices);

    const errors = pg.client.texts().filter((t) => /Ocurrió un error|problema temporal/.test(t));
    expect(errors).toEqual([]);
    if (process.env.PGTEST_DUMP) (await import("node:fs")).writeFileSync(process.env.PGTEST_DUMP, JSON.stringify(pg.trace, null, 1));
    expect(diffTraces(json.trace, pg.trace)).toEqual([]);

    // y quedó escrito en Postgres
    const andes = (await pgPortal.getCompanyByRuc(RUC_ANDES))!;
    const frank = (await pgPortal.getUserByWhatsapp(FRANK))!;
    expect(andes.ownerUserId).toBe(frank.id);
    expect(await pgPortal.listContacts(andes.id)).toHaveLength(1);
    const appts = await pgPortal.listAppointments({ companyId: andes.id });
    expect(appts).toHaveLength(1);
    expect(appts[0].startsAt.getUTCHours()).toBe(21); // reprogramada a las 4 pm de Lima
    const acts = await pgPortal.listActivities({ companyId: andes.id });
    expect(acts.map((a) => a.tipo)).toEqual(expect.arrayContaining(["visita", "cita", "nota"]));
    const opp = (await pgPortal.getOpenOpportunity(andes.id)) ?? (await pgPortal.listOpportunities({ companyId: andes.id }))[0];
    expect(opp.quoteNumber).toBe("COT-0001");
    expect((await pgPortal.listPurchaseOrders({ companyId: andes.id })).map((o) => o.numero)).toEqual(["4500123"]);
    expect((await pgPortal.getOrderProfile(andes.id))?.data).toMatchObject({ direccionFiscal: "Av. Nicolás Ayllón 2480, Ate, Lima" });
    expect((await pgPrices.listQuotes()).map((q) => q.number).sort()).toEqual(["COT-0001", "COT-0002"]);
    expect((await pgPortal.listVoiceTranscripts({ phone: FRANK })).length).toBeGreaterThan(0);
    expect((await pgPrices.usageSummary(new Date(Date.now() - 3600_000))).find((r) => r.phone === FRANK && r.purpose === "voz")?.audioSeconds).toBe(14);
    expect((await pgPrices.listMessages(FRANK, 500)).length).toBeGreaterThan(SCRIPT.length);
    expect((await pgPortal.listVocabulary()).map((v) => v.term)).toContain("flamita");
    // Límite propio: el guion completo hace cientos de idas y vueltas al pooler remoto y, con los pasos de la corrida J
    // (placa, empresas, citas), tarda 90–110 s; con el límite global de 120 s fallaba por tiempo 3 de cada 30 veces.
    // Incluye la espera de notNearLimaMidnight (hasta 10 min).
  }, 900_000);
});

describe("vendedores que se asignan la misma empresa a la vez", () => {
  it("solo uno la toma y queda una sola oportunidad abierta", async () => {
    // tres instancias (como funciones de Vercel a la vez), cada una con sus stores y su vendedor
    const TERCERO = "51900000004";
    await pgPortal.upsertUser({ nombre: "Tercer Vendedor", whatsapp: TERCERO, rol: "vendedor" });
    const s3 = SettingsSchema.parse({ ...settings, salespeople: { ...settings.salespeople, [TERCERO]: { name: "Tercer Vendedor" } } });
    const extra = await Promise.all([0, 1].map(async () => ({ portal: PgPortalStore.connect(testDbUrl()), prices: await PgStore.connect(testDbUrl()) })));
    const stores = [{ portal: pgPortal as PortalStore, prices: pgPrices as PriceStore }, ...extra];
    const sellers = [FRANK, OTRO, TERCERO];
    const problems: string[] = [];
    try {
      for (let round = 0; round < 6; round++) {
        const ruc = `2099990${String(round).padStart(4, "0")}`;
        const { ids } = await pgPortal.upsertCompanies([{ ruc, razonSocial: `CARRERA ${round} S.A.C.`, unidades: 30 }]);
        const clients = sellers.map(() => new FakeWhatsAppClient());
        const bots = sellers.map((_, i) => new BotHandler({ client: clients[i], store: stores[i].prices, settings: s3, portalStore: stores[i].portal }));
        const msg = (from: string): InboundMessage => ({ id: `wamid.race.${round}.${from}`, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: `asignarme ${ruc}`, forwarded: false });
        await Promise.all(bots.map((b, i) => b.handle(msg(sellers[i]))));
        const replies = clients.flatMap((c) => c.texts());
        const won = replies.filter((t) => t.includes("Empresa asignada a ti")).length;
        const open = await pgPortal.listOpportunities({ companyId: ids[ruc], open: true });
        const owner = (await pgPortal.getCompany(ids[ruc]))!.ownerUserId;
        if (won !== 1 || open.length !== 1 || open[0]?.ownerUserId !== owner) problems.push(`ronda ${round}: ${won} "asignada a ti", ${open.length} oportunidades abiertas (dueños ${open.map((o) => o.ownerUserId).join(",")}; empresa ${owner})`);
      }
      expect(problems).toEqual([]);
    } finally {
      await Promise.all(extra.map(async (x) => {
        await x.portal.close();
        await x.prices.close();
      }));
    }
  });
});
