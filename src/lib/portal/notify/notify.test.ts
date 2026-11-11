import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ingestExcel } from "../../ingest/tabular";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import type { InboundMessage } from "../../whatsapp/webhook";
import { noticesOf } from "../bot/state";
import { ACT_FOLLOW_UP } from "../quotes/reminders";
import { __setPortalStoreForTests, JsonPortalStore } from "../store";
import type { PortalUser } from "../store/types";
import { buildDailyDigest } from "./daily";
import { NOTICES_HEADER } from "./notices";
import { runDailyDigest } from "./send";
import { GET } from "../../../app/api/cron/daily/route";

const NOW = new Date("2026-11-10T13:00:00.000Z"); // martes 8:00 en Lima
const FRANK = "51900000001";
const PEDRO = "51900000002";
const JUAN = "51900000003";
const OPTS = { businessDays: 3, holidays: [] as string[], env: { PORTAL_BASE_URL: "https://portal.example.pe" } };
const WINDOW_ERR = new Error("WhatsApp API 400: (#131047) Re-engagement message");

let portal: JsonPortalStore;
let frank: PortalUser;
let pedro: PortalUser;
let juan: PortalUser;
let zbuss: number;
let andes: number;

async function seed(): Promise<void> {
  portal = JsonPortalStore.memory();
  frank = await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  pedro = await portal.upsertUser({ nombre: "Pedro Gómez", whatsapp: PEDRO, rol: "vendedor" });
  juan = await portal.upsertUser({ nombre: "Juan Bustios", whatsapp: JUAN, rol: "supervisor" });
  await portal.upsertUser({ nombre: "Tony Barreto", whatsapp: "51900000004", rol: "admin" });
  const r = await portal.upsertCompanies([
    { ruc: "20999999901", razonSocial: "ZBUSS PRUEBA S.A.C.", unidades: 80 },
    { ruc: "20999999902", razonSocial: "TRANSPORTES ANDES FICTICIO E.I.R.L.", unidades: 20 },
  ]);
  zbuss = r.ids["20999999901"];
  andes = r.ids["20999999902"];
}

/** Frank: 2 citas hoy (y una mañana, una cancelada), una acción vencida, una de hoy, una de mañana y una cotización por seguir. */
async function seedFrankDay(): Promise<void> {
  await portal.addAppointment({ companyId: zbuss, userId: frank.id, startsAt: new Date("2026-11-10T15:00:00Z"), lugar: "su base de Ate", conTecnico: true });
  await portal.addAppointment({ companyId: andes, userId: frank.id, startsAt: new Date("2026-11-11T04:30:00Z") }); // 23:30 del martes en Lima
  await portal.addAppointment({ companyId: andes, userId: frank.id, startsAt: new Date("2026-11-11T05:30:00Z") }); // miércoles 00:30 en Lima
  await portal.addAppointment({ companyId: zbuss, userId: frank.id, startsAt: new Date("2026-11-10T17:00:00Z"), estado: "cancelada" });
  await portal.createOpportunity({ companyId: zbuss, ownerUserId: frank.id, proximaAccion: "Llamar a logística", proximaAccionAt: new Date("2026-11-08T15:00:00Z") });
  await portal.createOpportunity({ companyId: andes, ownerUserId: frank.id, proximaAccion: "Mandar ficha técnica", proximaAccionAt: new Date("2026-11-10T20:00:00Z") });
  await portal.createOpportunity({ companyId: andes, ownerUserId: frank.id, proximaAccion: "Visitar taller", proximaAccionAt: new Date("2026-11-11T20:00:00Z") });
  const opp = await portal.createOpportunity({ companyId: andes, ownerUserId: frank.id, etapa: "cotizacion_enviada", quoteNumber: "COT-0032" });
  await portal.addActivity({ companyId: andes, opportunityId: opp.id, userId: frank.id, tipo: "cotizacion", data: { quoteNumber: "COT-0032" }, occurredAt: new Date("2026-11-04T15:00:00Z") });
}

describe("buildDailyDigest", () => {
  beforeEach(seed);

  it("vendedor: citas de hoy en hora de Lima, vencidas, de hoy y seguimientos", async () => {
    await seedFrankDay();
    const d = await buildDailyDigest(portal, frank, NOW, OPTS);
    expect(d).not.toBeNull();
    const t = d!.text;
    expect(t).toContain("*Buenos días, Frank*");
    expect(t).toContain("martes, 10 de noviembre");
    expect(t).toContain("*Citas de hoy*\n• 10:00 ZBUSS PRUEBA — su base de Ate (con técnico)\n• 23:30 TRANSPORTES ANDES FICTICIO");
    expect(t).not.toContain("00:30");
    expect(t).not.toContain("12:00"); // la cancelada
    expect(t).toContain("*Acciones vencidas*\n• ⚠️ ZBUSS PRUEBA: Llamar a logística _(del 08/11/2026)_");
    expect(t).toContain("*Acciones de hoy*\n• TRANSPORTES ANDES FICTICIO: Mandar ficha técnica");
    expect(t).not.toContain("Visitar taller");
    expect(t).toContain("*Cotizaciones por seguir*\n⏰ La cotización *0032*");
    expect(t).toContain("https://portal.example.pe/portal/hoy");
    expect(d!.counts).toEqual({ citas: 2, vencidas: 1, deHoy: 1, seguimientos: 1 });
    expect(d!.followUps.map((f) => f.quoteNumber)).toEqual(["COT-0032"]);
  });

  it("nada que contar -> null", async () => {
    expect(await buildDailyDigest(portal, pedro, NOW, OPTS)).toBeNull();
    await portal.addAppointment({ companyId: zbuss, userId: pedro.id, startsAt: new Date("2026-11-11T15:00:00Z") }); // mañana
    expect(await buildDailyDigest(portal, pedro, NOW, OPTS)).toBeNull();
    expect(await buildDailyDigest(portal, juan, NOW, OPTS)).toBeNull(); // supervisor sin nada propio ni del equipo
  });

  it("supervisor: resumen corto del equipo", async () => {
    await seedFrankDay();
    const d = await buildDailyDigest(portal, juan, NOW, OPTS);
    expect(d!.text).toContain("*Buenos días, Juan*");
    expect(d!.text).toContain("*Equipo hoy*\n• Frank Rodríguez: 2 citas · 1 vencida · 1 seguimiento\n• Pedro Gómez: sin pendientes");
    expect(d!.text).not.toContain("*Citas de hoy*");
    expect(d!.followUps).toEqual([]); // los de Frank se registran con el resumen de Frank
  });
});

describe("runDailyDigest", () => {
  beforeEach(async () => {
    await seed();
    await seedFrankDay();
  });

  it("envía a vendedores y supervisor con algo, registra el seguimiento una sola vez y no repite el día", async () => {
    const client = new FakeWhatsAppClient();
    const r = await runDailyDigest({ store: portal, client, now: NOW, ...OPTS });
    expect(r).toMatchObject({ enviados: 2, sinNada: 1, fueraDeVentana: 0, errores: 0, dryRun: false });
    expect(client.sent.map((m) => m.to).sort()).toEqual([FRANK, JUAN]);
    const follow = (await portal.listActivities({ companyId: andes })).filter((a) => a.tipo === ACT_FOLLOW_UP);
    expect(follow).toHaveLength(1);
    expect(follow[0].data).toMatchObject({ quoteNumber: "COT-0032" });

    const again = await runDailyDigest({ store: portal, client, now: new Date(NOW.getTime() + 60_000), ...OPTS });
    expect(again).toMatchObject({ enviados: 0, yaEnviados: 2 });
    const tomorrow = await runDailyDigest({ store: portal, client, now: new Date(NOW.getTime() + 24 * 3600_000), ...OPTS });
    expect(tomorrow.enviados).toBeGreaterThan(0);
    expect(client.texts().at(-2) + client.texts().at(-1)!).not.toContain("*0032*"); // ya avisada
    expect((await portal.listActivities({ companyId: andes })).filter((a) => a.tipo === ACT_FOLLOW_UP)).toHaveLength(1);
  });

  it("dry run: devuelve los textos sin enviar ni registrar", async () => {
    const r = await runDailyDigest({ store: portal, now: NOW, dryRun: true, ...OPTS });
    expect(r.resultados.filter((x) => x.status === "simulado").map((x) => x.nombre).sort()).toEqual(["Frank Rodríguez", "Juan Bustios"]);
    expect(r.enviados).toBe(0);
    expect((await portal.listActivities({ companyId: andes })).filter((a) => a.tipo === ACT_FOLLOW_UP)).toHaveLength(0);
    expect(await portal.getPortalConversation(FRANK)).toBeNull();
  });

  it("otro error: cuenta como error, no registra el seguimiento y sigue con los demás", async () => {
    const client = new FakeWhatsAppClient();
    const send = client.sendText.bind(client);
    client.sendText = async (to, body) => (to === FRANK ? Promise.reject(new Error("WhatsApp API 500: boom")) : send(to, body));
    const r = await runDailyDigest({ store: portal, client, now: NOW, ...OPTS });
    expect(r).toMatchObject({ enviados: 1, errores: 1, fueraDeVentana: 0 });
    expect((await portal.listActivities({ companyId: andes })).filter((a) => a.tipo === ACT_FOLLOW_UP)).toHaveLength(0);
    expect(noticesOf(await portal.getPortalConversation(FRANK))).toEqual([]);
  });
});

// ── ventana de 24 h: aviso pendiente -> siguiente mensaje (cotizador intacto) ──

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
  salespeople: { default: FRANK, [FRANK]: { name: "Frank Rodríguez", title: "Key Account Manager", phone: "900 000 001", email: "frank@example.pe" } },
});

const SCRIPT = ["Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com", "ok", "@fwd hola", "cancelar"];

async function conversation(withWindowFailure: boolean): Promise<{ sent: string[][]; notices: number }> {
  await seed();
  await seedFrankDay();
  const store = JsonStore.memory();
  const xls = await ingestExcel(fs.readFileSync(path.resolve(process.cwd(), "samples/proveedor-a-lista.xlsx")), { provider: "Llantas del Sur", sourceRef: "a.xlsx", priceDate: "2026-10-01" });
  await store.upsertRows(xls.rows);
  const client = new FakeWhatsAppClient();
  const bot = new BotHandler({ client, store, settings, portalStore: portal, sendEmail: async () => ({ sent: true, id: "t" }) });
  if (withWindowFailure) {
    const cron = await runDailyDigest({ store: portal, client: { sendText: async () => Promise.reject(WINDOW_ERR) }, now: NOW, ...OPTS });
    expect(cron).toMatchObject({ enviados: 0, fueraDeVentana: 2 });
    expect(noticesOf(await portal.getPortalConversation(FRANK))).toHaveLength(1);
    // el seguimiento quedó en el aviso: registrado una vez
    expect((await portal.listActivities({ companyId: andes })).filter((a) => a.tipo === ACT_FOLLOW_UP)).toHaveLength(1);
  }
  const notices = noticesOf(await portal.getPortalConversation(FRANK)).length;
  const sent: string[][] = [];
  let n = 0;
  for (const line of SCRIPT) {
    const before = client.sent.length;
    const fwd = line.startsWith("@fwd ");
    const msg: InboundMessage = { id: `wamid.n${++n}`, from: FRANK, timestamp: "1", type: "text", text: fwd ? line.slice(5) : line, forwarded: fwd };
    await bot.handle(msg);
    sent.push(client.sent.slice(before).map((m) => `${m.kind}|${m.fileName ?? ""}|${m.caption ?? ""}|${m.body ?? ""}`));
  }
  return { sent, notices };
}

describe("aviso pendiente por la ventana de 24 h", () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of ["LLM_DISABLED", "PHOTOS_DISABLED", "RESEND_API_KEY", "EMAIL_REDIRECT_TO"]) saved[k] = process.env[k];
    process.env.LLM_DISABLED = "1";
    process.env.PHOTOS_DISABLED = "1";
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_REDIRECT_TO;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("el siguiente mensaje recibe el aviso aparte y luego la respuesta del cotizador idéntica a la de sin avisos", async () => {
    const plain = await conversation(false);
    const withNotice = await conversation(true);
    expect(plain.notices).toBe(0);
    expect(withNotice.notices).toBe(1);
    const [first, ...rest] = withNotice.sent;
    expect(first[0]).toContain(NOTICES_HEADER);
    expect(first[0]).toContain("*Buenos días, Frank*");
    expect(first[0]).toContain("*0032*");
    expect(first.slice(1)).toEqual(plain.sent[0]);
    expect(plain.sent[0].length).toBeGreaterThan(0);
    expect(rest).toEqual(plain.sent.slice(1)); // una sola vez
    expect(noticesOf(await portal.getPortalConversation(FRANK))).toEqual([]);
  });

  it("también a mitad de una cotización (salida temprana al cotizador) y en un reenviado", async () => {
    await seed();
    const client = new FakeWhatsAppClient();
    const bot = new BotHandler({ client, store: JsonStore.memory(), settings, portalStore: portal });
    await portal.setPortalConversation(FRANK, { notices: [{ text: "aviso uno", createdAt: NOW.toISOString() }, { text: "aviso dos", createdAt: NOW.toISOString() }] });
    await bot.handle({ id: "wamid.f1", from: FRANK, timestamp: "1", type: "text", text: "hola", forwarded: true });
    expect(client.texts()[0]).toBe(`${NOTICES_HEADER}\n\naviso uno\n\naviso dos`);
    expect(client.texts().length).toBeGreaterThan(1);
    expect(await portal.getPortalConversation(FRANK)).toBeNull();
  });
});

describe("GET /api/cron/daily", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    for (const k of ["CRON_SECRET", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]) saved[k] = process.env[k];
    await seed();
    await seedFrankDay();
    __setPortalStoreForTests(portal);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    __setPortalStoreForTests(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const call = (auth?: string, q = "") => GET(new Request(`http://localhost/api/cron/daily${q}`, { headers: auth ? { authorization: auth } : {} }));

  it("sin CRON_SECRET -> 500 con mensaje", async () => {
    delete process.env.CRON_SECRET;
    const res = await call("Bearer x");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("CRON_SECRET");
  });

  it("secreto incorrecto o ausente -> 401", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await call("Bearer otro")).status).toBe(401);
    expect((await call()).status).toBe(401);
  });

  it("?dry=1 -> textos sin enviar (sin WhatsApp configurado)", async () => {
    process.env.CRON_SECRET = "s3cret";
    delete process.env.WHATSAPP_TOKEN;
    const res = await call("Bearer s3cret", "?dry=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, dryRun: true });
    expect(body.jobs.resumen.ok).toBe(true);
    const textos = body.jobs.resumen.report.resultados.filter((r: { status: string }) => r.status === "simulado");
    expect(textos.length).toBeGreaterThan(0);
    expect(textos[0].text).toContain("Buenos días");
    expect((await portal.listActivities({ companyId: andes })).filter((a) => a.tipo === ACT_FOLLOW_UP)).toHaveLength(0);
  });

  it("sin WhatsApp configurado y sin dry -> 500 claro", async () => {
    process.env.CRON_SECRET = "s3cret";
    delete process.env.WHATSAPP_TOKEN;
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("WHATSAPP_TOKEN");
  });
});
