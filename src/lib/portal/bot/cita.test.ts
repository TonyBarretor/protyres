import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import type { InboundMessage } from "../../whatsapp/webhook";
import { JsonPortalStore } from "../store";
import type { Company } from "../store/types";
import { seedUsers } from "../users";
import { routePortal } from ".";
import { isWindowError, NO_TECH_NUMBER, parseCitaArgs } from "./commands/cita";
import { parseIcsLines } from "./ics";
import { getPending } from "./state";

// miércoles 11/11/2026 09:00 en Lima
const NOW = new Date("2026-11-11T14:00:00Z");
const FRANK = "51900000001";
const OTRO = "51900000003";
const DANYER = "51900000077";
const CLIENTE = "51988888888";
const RUC_ANDES = "20999000011";
const RUC_ANDES_SUR = "20999000022";
const BASE_ENV = { PORTAL_BASE_URL: "https://portal.example.pe", PORTAL_SESSION_SECRET: "test-secret-0123456789abcdef" };

interface Out {
  to: string;
  kind: "text" | "document";
  body?: string;
  file?: Buffer;
  fileName?: string;
  caption?: string;
  mimeType?: string;
}

let store: JsonPortalStore;
let out: Out[];
let frankId: number;
let ids: Record<string, number>;
let failTextTo: Error | null;
let failMime: string | null;

beforeEach(async () => {
  store = JsonPortalStore.memory();
  out = [];
  failTextTo = null;
  failMime = null;
  frankId = (await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" })).id;
  await store.upsertUser({ nombre: "Otro Vendedor", whatsapp: OTRO, rol: "vendedor" });
  const r = await store.upsertCompanies([
    { ruc: RUC_ANDES, razonSocial: "TRANSPORTES ANDES DEL PERU S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 12, llantasPiso: 72 },
    { ruc: RUC_ANDES_SUR, razonSocial: "EMPRESA ANDES SUR E.I.R.L.", sector: "carga", departamento: "AREQUIPA", unidades: 30, llantasPiso: 300 },
  ]);
  ids = r.ids;
  await store.setOwner(ids[RUC_ANDES], frankId);
  await store.setOwner(ids[RUC_ANDES_SUR], frankId);
  await store.addContact({ companyId: ids[RUC_ANDES], nombre: "Carlos Quispe", cargo: "jefe de flota", telefono: "987654321", email: null, createdBy: frankId });
});

async function send(text: string, opts: { env?: Record<string, string | undefined>; now?: Date; from?: string } = {}): Promise<boolean> {
  const from = opts.from ?? FRANK;
  return routePortal({
    from,
    text,
    store,
    now: opts.now ?? NOW,
    env: { ...BASE_ENV, ...opts.env },
    reply: async (body) => void out.push({ to: from, kind: "text", body }),
    sendDocument: async (file, fileName, caption, mimeType) => {
      if (failMime && mimeType === failMime) throw new Error(`WhatsApp media upload 400: unsupported ${mimeType}`);
      out.push({ to: from, kind: "document", file, fileName, caption, mimeType });
    },
    sendTextTo: async (to, body) => {
      if (failTextTo) throw failTextTo;
      out.push({ to, kind: "text", body });
    },
  });
}

const texts = (to = FRANK) => out.filter((m) => m.kind === "text" && m.to === to).map((m) => m.body ?? "");
const lastText = () => texts().at(-1) ?? "";

describe("parseCitaArgs", () => {
  it("separa empresa, fecha, lugar y con danyer", () => {
    const r = parseCitaArgs("zbuss martes 10am en su base de Ate con danyer", NOW);
    expect(r).toMatchObject({ empresa: "zbuss", lugar: "su base de Ate", conTecnico: true, allDay: false });
    expect((r as { date: Date }).date.toISOString()).toBe("2026-11-17T15:00:00.000Z");
    expect(parseCitaArgs("Transportes Andes el martes a las 10 con el ing. Danyer Saavedra", NOW)).toMatchObject({ empresa: "Transportes Andes", lugar: null, conTecnico: true });
    expect(parseCitaArgs("andes mañana 3pm con técnico en Lurín", NOW)).toMatchObject({ empresa: "andes", lugar: "Lurín", conTecnico: true });
    expect(parseCitaArgs("andes, con el ingeniero, 15/11 9:00", NOW)).toMatchObject({ empresa: "andes", conTecnico: true });
    expect(parseCitaArgs("andes en su base de Ate martes 10am", NOW)).toMatchObject({ empresa: "andes", lugar: "su base de Ate", conTecnico: false });
    expect(parseCitaArgs("20999000011 viernes al mediodía", NOW)).toMatchObject({ empresa: "20999000011", lugar: null, conTecnico: false });
    expect(parseCitaArgs("andes martes", NOW)).toMatchObject({ empresa: "andes", allDay: true });
    expect(parseCitaArgs("andes", NOW)).toHaveProperty("error");
    expect(parseCitaArgs("martes 10am", NOW)).toHaveProperty("error");
  });

  it("errores de ventana de 24 h", () => {
    expect(isWindowError(new Error("WhatsApp API 400: (#131047) Re-engagement message"))).toBe(true);
    expect(isWindowError(new Error("WhatsApp API 401: invalid token"))).toBe(false);
  });
});

describe("comando cita", () => {
  it("crea la cita, mueve a Cita agendada, próxima acción Visita, actividad, .ics sin leyenda y resumen aparte", async () => {
    expect(await send("cita transportes andes martes 10am en su base de Ate")).toBe(true);
    const andes = ids[RUC_ANDES];
    const [appt] = await store.listAppointments({ companyId: andes });
    expect(appt).toMatchObject({ userId: frankId, lugar: "su base de Ate", conTecnico: false, estado: "programada" });
    expect(appt.startsAt.toISOString()).toBe("2026-11-17T15:00:00.000Z");
    const opp = (await store.getOpenOpportunity(andes))!;
    expect(opp).toMatchObject({ etapa: "cita_agendada", proximaAccion: "Visita" });
    expect(opp.proximaAccionAt?.toISOString()).toBe("2026-11-17T15:00:00.000Z");
    expect(appt.opportunityId).toBe(opp.id);
    expect((await store.stageHistory(opp.id)).map((h) => h.etapa)).toEqual(["prospecto", "cita_agendada"]);
    const [act] = await store.listActivities({ companyId: andes });
    expect(act).toMatchObject({ tipo: "cita", canal: "whatsapp", userId: frankId, opportunityId: opp.id });
    expect(act.occurredAt.toISOString()).toBe(NOW.toISOString());

    // orden: documento sin leyenda, luego el resumen
    expect(out.map((m) => m.kind)).toEqual(["document", "text"]);
    const doc = out[0];
    expect(doc.caption).toBe("");
    expect(doc.mimeType).toBe("text/calendar");
    expect(doc.fileName).toBe("cita-transportes-andes-del-peru-20261117.ics");
    const lines = parseIcsLines(doc.file!.toString("utf8"));
    const vevent = lines.slice(lines.findIndex((l) => l.name === "BEGIN" && l.value === "VEVENT"));
    const ev = (n: string) => vevent.find((l) => l.name === n)!;
    expect(ev("SUMMARY").value).toBe("Visita: TRANSPORTES ANDES DEL PERU S.A.C.");
    expect(ev("DTSTART")).toMatchObject({ params: { TZID: "America/Lima" }, value: "20261117T100000" });
    expect(ev("DTEND").value).toBe("20261117T110000"); // 60 min de config/portal.json
    expect(ev("LOCATION").value).toBe("su base de Ate");
    expect(ev("UID").value).toBe(`cita-${appt.id}-${RUC_ANDES}@portal.360tyres`);
    expect(ev("DESCRIPTION").value).toContain("Contacto: Carlos Quispe (jefe de flota) · 987654321");
    expect(ev("DESCRIPTION").value).toContain(`Ficha: https://portal.example.pe/portal/empresas/${andes}`);
    expect(lastText()).toBe(
      // corrida D: termina con la línea de avance
      "📅 Cita con *TRANSPORTES ANDES DEL PERU S.A.C.* el *martes 17/11 10:00* en su base de Ate · Agrégala a tu calendario de Outlook abriendo el archivo.\nOportunidad: Prospecto → *Cita agendada* · próxima acción: Visita\n✅ Paso 3 de 7 con TRANSPORTES ANDES DEL PERU: cita agendada. Sigue: reportar la visita.",
    );
  });

  it("no retrocede una oportunidad que ya pasó de Cita agendada", async () => {
    const andes = ids[RUC_ANDES];
    const opp = await store.createOpportunity({ companyId: andes, ownerUserId: frankId, etapa: "prospecto", createdBy: frankId, at: NOW });
    await store.moveStage(opp.id, "cotizacion_enviada", frankId, NOW);
    await send("cita 20999000011 jueves 4 de la tarde");
    const now = (await store.getOpportunity(opp.id))!;
    expect(now.etapa).toBe("cotizacion_enviada");
    expect(now.proximaAccion).toBe("Visita");
    expect(await store.listAppointments({ companyId: andes })).toHaveLength(1);
    expect(lastText()).toContain("Oportunidad: sigue en *Cotización enviada*");
  });

  it("con danyer sin número configurado: lo dice y no falla", async () => {
    await send("cita andes del peru mañana 3pm con danyer", { env: { PORTAL_TECH_LEAD_NUMBER: "" } });
    const [appt] = await store.listAppointments({ companyId: ids[RUC_ANDES] });
    expect(appt.conTecnico).toBe(true);
    expect(lastText()).toContain(NO_TECH_NUMBER);
    expect(out.filter((m) => m.to !== FRANK)).toEqual([]);
    const [act] = await store.listActivities({ companyId: ids[RUC_ANDES] });
    expect(act.data).toMatchObject({ conTecnico: true, avisoTecnico: { status: "sin_numero" } });
  });

  it("con danyer y número: lo registra como técnico, le avisa y lo anota", async () => {
    await send("cita andes del peru mañana 3pm en Lurín con el ing. danyer", { env: { PORTAL_TECH_LEAD_NUMBER: "+51 900 000 077" } });
    const tech = await store.getUserByWhatsapp(DANYER);
    expect(tech).toMatchObject({ nombre: "Danyer Saavedra", rol: "tecnico", activo: true });
    const aviso = texts(DANYER);
    expect(aviso).toHaveLength(1);
    expect(aviso[0]).toContain("Frank Rodríguez");
    expect(aviso[0]).toContain("*TRANSPORTES ANDES DEL PERU S.A.C.*");
    expect(aviso[0]).toContain("*jueves 12/11 15:00* en Lurín");
    expect(aviso[0]).toContain(`https://portal.example.pe/portal/empresas/${ids[RUC_ANDES]}`);
    expect(lastText()).toContain("👷 Avisé al Ing. Danyer Saavedra por WhatsApp.");
    const doc = out.find((m) => m.kind === "document")!;
    expect(parseIcsLines(doc.file!.toString("utf8")).find((l) => l.name === "DESCRIPTION")!.value).toContain("Con el Ing. Danyer Saavedra (Dpto. Técnico)");
    const [act] = await store.listActivities({ companyId: ids[RUC_ANDES] });
    expect(act.data).toMatchObject({ avisoTecnico: { status: "enviado", to: DANYER } });
  });

  it("con danyer fuera de la ventana de 24 h: se lo dice al vendedor", async () => {
    failTextTo = new Error("WhatsApp API 400: (#131047) Re-engagement message");
    await send("cita andes del peru mañana 3pm con danyer", { env: { PORTAL_TECH_LEAD_NUMBER: DANYER } });
    expect(lastText()).toContain("últimas 24 h");
    const [act] = await store.listActivities({ companyId: ids[RUC_ANDES] });
    expect(act.data).toMatchObject({ avisoTecnico: { status: "ventana", to: DANYER } });
    expect(await store.listAppointments({ companyId: ids[RUC_ANDES] })).toHaveLength(1);
  });

  it("si el número del técnico ya es de otro usuario, se respeta ese usuario", async () => {
    await send("cita andes del peru mañana 3pm con danyer", { env: { PORTAL_TECH_LEAD_NUMBER: OTRO } });
    expect((await store.getUserByWhatsapp(OTRO))?.rol).toBe("vendedor");
    expect(texts(OTRO)).toHaveLength(1);
  });

  it("sendTextTo nunca escribe a un número que no es usuario interno", async () => {
    // número configurado que no se puede registrar (usuario desactivado) -> no se envía
    await store.upsertUser({ nombre: "Cliente", whatsapp: CLIENTE, rol: "vendedor", activo: false });
    await send("cita andes del peru mañana 3pm con danyer", { env: { PORTAL_TECH_LEAD_NUMBER: CLIENTE } });
    expect(out.filter((m) => m.to === CLIENTE)).toEqual([]);
    expect(lastText()).toContain("No pude avisar al Ing. Danyer Saavedra");
  });

  it("varias empresas: lista y la cita sigue al elegir", async () => {
    await send("cita andes martes 10am en Ate con danyer", { env: { PORTAL_TECH_LEAD_NUMBER: "" } });
    expect(lastText()).toContain("Encontré 2 empresas");
    expect((await getPending(store, FRANK, NOW))?.kind).toBe("choose_company");
    await send("2");
    const chosen = (await store.getCompanyByRuc(RUC_ANDES)) as Company;
    const both = [...(await store.listAppointments({ companyId: ids[RUC_ANDES] })), ...(await store.listAppointments({ companyId: ids[RUC_ANDES_SUR] }))];
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ lugar: "Ate", conTecnico: true });
    expect(both[0].startsAt.toISOString()).toBe("2026-11-17T15:00:00.000Z");
    expect(chosen).toBeTruthy();
    expect(lastText()).toContain(NO_TECH_NUMBER);
    expect(await getPending(store, FRANK, NOW)).toBeNull();
  });

  it("sin hora: la pide y sigue con la respuesta", async () => {
    await send("cita transportes andes martes en su base");
    expect(lastText()).toContain("¿A qué hora es la cita con *TRANSPORTES ANDES DEL PERU S.A.C.* el martes 17/11?");
    expect(await store.listAppointments({})).toHaveLength(0);
    await send("a las 3 y media");
    const [appt] = await store.listAppointments({});
    expect(appt.startsAt.toISOString()).toBe("2026-11-17T20:30:00.000Z");
    expect(appt.lugar).toBe("su base");
    expect(lastText()).toContain("*martes 17/11 15:30*");
  });

  it("fecha pasada, sin fecha o empresa ajena: no crea nada", async () => {
    await send("cita transportes andes hoy 8am");
    expect(lastText()).toContain("ya pasó");
    await send("cita transportes andes la próxima semana");
    expect(lastText()).toContain("No entendí el día y la hora");
    await send("cita transportes andes martes 10am", { from: OTRO });
    expect(texts(OTRO).at(-1)).toContain("no es tuya");
    expect(await store.listAppointments({})).toHaveLength(0);
  });

  it("si WhatsApp no acepta text/calendar, reenvía el .ics como text/plain", async () => {
    failMime = "text/calendar";
    await send("cita transportes andes martes 10am");
    const docs = out.filter((m) => m.kind === "document");
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ mimeType: "text/plain", caption: "", fileName: "cita-transportes-andes-del-peru-20261117.ics" });
  });
});

describe("cita por el BotHandler (enganche de sendTextTo)", () => {
  const settings: Settings = SettingsSchema.parse({
    company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
    pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
    quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
  });
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["PORTAL_TECH_LEAD_NUMBER", "PORTAL_BASE_URL", "PORTAL_SESSION_SECRET"]) saved[k] = process.env[k];
    Object.assign(process.env, BASE_ENV, { PORTAL_TECH_LEAD_NUMBER: DANYER });
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("el aviso a Danyer sale por el cliente de WhatsApp del handler y queda en el historial", async () => {
    const client = new FakeWhatsAppClient();
    const quoter = JsonStore.memory();
    const bot = new BotHandler({ client, store: quoter, settings, portalStore: store });
    const msg: InboundMessage = { id: "wamid.cita1", from: FRANK, timestamp: "1", type: "text", text: "cita transportes andes 15/11/2099 10am con danyer", forwarded: false };
    await bot.handle(msg);
    expect(client.sent.map((m) => [m.to, m.kind])).toEqual([
      [DANYER, "text"],
      [FRANK, "document"],
      [FRANK, "text"],
    ]);
    expect(client.sent[1].caption).toBe("");
    expect(client.sent[2].body).toContain("👷 Avisé al Ing. Danyer Saavedra");
    const log = await quoter.listMessages(DANYER);
    expect(log.some((m) => m.direction === "out" && /Cita con el Dpto. Técnico/.test(m.body ?? ""))).toBe(true);
  });
});

describe("siembra del jefe técnico", () => {
  it("config.users con whatsappEnv PORTAL_TECH_LEAD_NUMBER lo registra como tecnico", async () => {
    const s = JsonPortalStore.memory();
    const users = [{ nombre: "Danyer Saavedra", rol: "tecnico" as const, whatsappEnv: "PORTAL_TECH_LEAD_NUMBER" }];
    expect((await seedUsers(s, { users, env: {} })).warnings[0]).toMatch(/Danyer Saavedra.*PORTAL_TECH_LEAD_NUMBER/);
    const r = await seedUsers(s, { users, env: { PORTAL_TECH_LEAD_NUMBER: DANYER } });
    expect(r.users.map((u) => [u.nombre, u.rol, u.whatsapp])).toEqual([["Danyer Saavedra", "tecnico", DANYER]]);
  });
});
