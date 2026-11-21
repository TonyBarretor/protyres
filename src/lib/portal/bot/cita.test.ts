import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import type { InboundMessage } from "../../whatsapp/webhook";
import { configureCalendarMailer, type CalendarInviteMail } from "../calendar/mail";
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
  // corrida J, punto 4: el resumen va primero y el .ics queda como respaldo después (el camino principal es la invitación
  // por correo; aquí el correo no está configurado y el resumen lo dice en una línea)
  it("crea la cita, mueve a Cita agendada, próxima acción Visita, actividad, resumen y .ics sin leyenda de respaldo", async () => {
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

    // orden: el resumen, luego el documento sin leyenda (respaldo)
    expect(out.map((m) => m.kind)).toEqual(["text", "document"]);
    const doc = out[1];
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
      "📅 Cita con *TRANSPORTES ANDES DEL PERU S.A.C.* el *martes 17/11 10:00* en su base de Ate.\n✉️ No te envié la invitación por correo: el correo del bot no está configurado. Agrégala a Outlook abriendo el archivo .ics que te mando abajo.\nOportunidad: Prospecto → *Cita agendada* · próxima acción: Visita\n✅ Paso 3 de 7 con TRANSPORTES ANDES DEL PERU: cita agendada. Sigue: reportar la visita.",
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

describe("cita duplicada (misma empresa, fecha y hora)", () => {
  const ics = (m: Out) => parseIcsLines(m.file!.toString("utf8"));
  const icsValue = (m: Out, name: string) => {
    const lines = ics(m);
    return lines.slice(lines.findIndex((l) => l.name === "BEGIN" && l.value === "VEVENT")).find((l) => l.name === name)?.value;
  };

  it("no crea una segunda cita: avisa que ya existe y ofrece reprogramar", async () => {
    await send("cita transportes andes martes 10am en su base de Ate");
    out = [];
    expect(await send("cita andes del peru el martes a las 10")).toBe(true);
    const appts = await store.listAppointments({ companyId: ids[RUC_ANDES] });
    expect(appts).toHaveLength(1);
    expect(out.map((m) => m.kind)).toEqual(["text"]); // sin segundo .ics
    expect(lastText()).toContain("Ya existe una cita con *TRANSPORTES ANDES DEL PERU S.A.C.* el *martes 17/11 10:00* en su base de Ate");
    expect(lastText()).toContain("No creé otra");
    expect(lastText()).toMatch(/reprogramar/i);
    expect((await store.listActivities({ companyId: ids[RUC_ANDES] })).filter((a) => a.tipo === "cita")).toHaveLength(1);
    expect((await getPending(store, FRANK, NOW))?.kind).toBe("cita_reprogramar");
  });

  it("también al completar la hora en un segundo paso", async () => {
    await send("cita transportes andes martes 10am");
    await send("cita transportes andes martes");
    out = [];
    await send("10am");
    expect(await store.listAppointments({ companyId: ids[RUC_ANDES] })).toHaveLength(1);
    expect(lastText()).toContain("Ya existe una cita");
  });

  it("otra hora u otra empresa a la misma hora sí crean cita", async () => {
    await send("cita transportes andes martes 10am");
    await send("cita transportes andes martes 11am");
    await send("cita andes sur martes 10am");
    expect(await store.listAppointments({ companyId: ids[RUC_ANDES] })).toHaveLength(2);
    expect(await store.listAppointments({ companyId: ids[RUC_ANDES_SUR] })).toHaveLength(1);
  });

  it("una cita cancelada no cuenta como duplicada", async () => {
    await send("cita transportes andes martes 10am");
    const [a] = await store.listAppointments({ companyId: ids[RUC_ANDES] });
    await store.updateAppointment(a.id, { estado: "cancelada" });
    await send("cita transportes andes martes 10am");
    expect(await store.listAppointments({ companyId: ids[RUC_ANDES], estado: "programada" })).toHaveLength(1);
  });

  it("Reprogramar -> pide día y hora -> mueve la misma cita y reenvía el .ics con el mismo UID", async () => {
    await send("cita transportes andes martes 10am en su base de Ate");
    const [orig] = await store.listAppointments({ companyId: ids[RUC_ANDES] });
    const firstIcs = out.find((m) => m.kind === "document")!;
    await send("cita transportes andes martes 10am");
    out = [];
    const later = new Date(NOW.getTime() + 60_000);
    await send("reprogramar", { now: later });
    expect(lastText()).toContain("¿Para qué día y hora");
    expect((await getPending(store, FRANK, later))?.kind).toBe("cita_reprogramar_fecha");
    expect(await send("jueves 19/11 4pm", { now: later })).toBe(true);
    const appts = await store.listAppointments({ companyId: ids[RUC_ANDES] });
    expect(appts).toHaveLength(1);
    expect(appts[0].id).toBe(orig.id);
    expect(appts[0].startsAt.toISOString()).toBe("2026-11-19T21:00:00.000Z");
    expect(appts[0].lugar).toBe("su base de Ate");
    const opp = (await store.getOpenOpportunity(ids[RUC_ANDES]))!;
    expect(opp.proximaAccionAt?.toISOString()).toBe("2026-11-19T21:00:00.000Z");
    const doc = out.find((m) => m.kind === "document")!;
    expect(icsValue(doc, "UID")).toBe(icsValue(firstIcs, "UID"));
    expect(Number(icsValue(doc, "SEQUENCE"))).toBeGreaterThan(0);
    expect(icsValue(doc, "DTSTART")).toBe("20261119T160000");
    expect(lastText()).toContain("🔁 Reprogramé la cita con *TRANSPORTES ANDES DEL PERU S.A.C.*: del martes 17/11 10:00 al *jueves 19/11 16:00*");
    const acts = (await store.listActivities({ companyId: ids[RUC_ANDES] })).filter((a) => a.tipo === "cita");
    expect(acts).toHaveLength(2);
    expect(acts[0].texto).toContain("reprogramada");
    expect(await getPending(store, FRANK, later)).toBeNull();
  });

  it("se puede responder directamente con el nuevo día y hora", async () => {
    await send("cita transportes andes martes 10am");
    await send("cita transportes andes martes 10am");
    await send("mejor el miércoles 18/11 9am");
    const appts = await store.listAppointments({ companyId: ids[RUC_ANDES] });
    expect(appts.map((a) => a.startsAt.toISOString())).toEqual(["2026-11-18T14:00:00.000Z"]);
  });

  it("si después manda otra cosa, la oferta se deja sin preguntar y el mensaje se atiende (la cita sigue igual)", async () => {
    await send("cita transportes andes martes 10am");
    await send("cita transportes andes martes 10am");
    out = [];
    await send("Visité Andes, hablé con Carlos. Quedamos en mandarle la cotización el jueves.");
    expect(lastText()).not.toContain("¿A qué hora");
    expect((await store.listAppointments({ companyId: ids[RUC_ANDES] }))[0].startsAt.toISOString()).toBe("2026-11-17T15:00:00.000Z");
    out = [];
    await send("cita transportes andes martes 10am");
    await send("hoy");
    expect(lastText()).not.toContain("cotización nueva");
    expect(lastText()).not.toContain("Dejaste pendiente");
    expect(await getPending(store, FRANK, NOW)).toBeNull();
    expect(await store.listAppointments({ companyId: ids[RUC_ANDES] })).toHaveLength(1);
  });

  it("Dejarla así: no cambia nada", async () => {
    await send("cita transportes andes martes 10am");
    await send("cita transportes andes martes 10am");
    out = [];
    await send("dejarla");
    expect(lastText()).toContain("Queda la cita");
    const appts = await store.listAppointments({ companyId: ids[RUC_ANDES] });
    expect(appts.map((a) => a.startsAt.toISOString())).toEqual(["2026-11-17T15:00:00.000Z"]);
    expect(out.some((m) => m.kind === "document")).toBe(false);
    expect(await getPending(store, FRANK, NOW)).toBeNull();
  });

  it("reprogramar a una hora pasada o ya ocupada por otra cita de la empresa: no la mueve", async () => {
    await send("cita transportes andes martes 10am");
    await send("cita transportes andes martes 11am");
    await send("cita transportes andes martes 10am");
    await send("martes 17/11 11am");
    expect(lastText()).toContain("Ya existe una cita");
    await send("hoy 8am"); // NOW = 09:00 en Lima
    expect(lastText()).toContain("ya pasó");
    const appts = await store.listAppointments({ companyId: ids[RUC_ANDES] });
    expect(appts.map((a) => a.startsAt.toISOString())).toEqual(["2026-11-17T15:00:00.000Z", "2026-11-17T16:00:00.000Z"]);
    expect((await getPending(store, FRANK, NOW))?.kind).toBe("cita_reprogramar");
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
    for (const k of ["PORTAL_TECH_LEAD_NUMBER", "PORTAL_BASE_URL", "PORTAL_SESSION_SECRET", "RESEND_API_KEY", "EMAIL_FROM"]) saved[k] = process.env[k];
    Object.assign(process.env, BASE_ENV, { PORTAL_TECH_LEAD_NUMBER: DANYER });
    delete process.env.RESEND_API_KEY; // nunca un correo real desde las pruebas
    delete process.env.EMAIL_FROM;
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
      [FRANK, "text"],
      [FRANK, "document"],
    ]);
    expect(client.sent[2].caption).toBe("");
    expect(client.sent[1].body).toContain("👷 Avisé al Ing. Danyer Saavedra");
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

// ── corrida J, punto 4: la invitación por correo (Outlook clásico: Aceptar) ──

describe("invitación de la cita por correo", () => {
  const MAIL_ENV = { RESEND_API_KEY: "re_test_x", EMAIL_FROM: "Cotizaciones <cotizaciones@mail.ejemplo-verificado.pe>" };
  let mails: CalendarInviteMail[];
  let mailFail: Error | string | null;

  beforeEach(async () => {
    mails = [];
    mailFail = null;
    // envío simulado: nunca sale un correo real
    configureCalendarMailer(async (m) => {
      if (mailFail instanceof Error) throw mailFail;
      if (mailFail) return { sent: false, error: mailFail };
      mails.push(m);
      return { sent: true, id: `sim-${mails.length}` };
    });
    await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor", email: "Frank.Rodriguez@Example.pe" });
  });
  afterEach(() => configureCalendarMailer(null));

  const calPart = (m: CalendarInviteMail) => {
    const lines = parseIcsLines(m.ics);
    const ev = lines.slice(lines.findIndex((l) => l.name === "BEGIN" && l.value === "VEVENT"));
    return { method: lines.find((l) => l.name === "METHOD")!.value, get: (n: string) => ev.find((l) => l.name === n)?.value, all: (n: string) => ev.filter((l) => l.name === n).map((l) => l.value) };
  };

  it("crear: invitación REQUEST al correo del vendedor; el mensaje lo dice y el .ics queda de respaldo", async () => {
    await send("cita transportes andes martes 10am en su base de Ate", { env: MAIL_ENV });
    const [appt] = await store.listAppointments({ companyId: ids[RUC_ANDES] });
    expect(mails).toHaveLength(1);
    const m = mails[0];
    expect(m.from).toBe(MAIL_ENV.EMAIL_FROM); // el mismo remitente del proyecto, sin uno nuevo
    expect(m.to).toEqual(["frank.rodriguez@example.pe"]);
    expect(m.method).toBe("REQUEST");
    expect(m.fileName).toBe("cita-transportes-andes-del-peru-20261117.ics");
    expect(m.subject).toContain("TRANSPORTES ANDES DEL PERU S.A.C.");
    expect(m.text).toContain("pulsa Aceptar");
    const c = calPart(m);
    expect(c.method).toBe("REQUEST");
    expect(c.get("UID")).toBe(`cita-${appt.id}-${RUC_ANDES}@portal.360tyres`);
    expect(c.get("SEQUENCE")).toBe("0");
    expect(c.get("ORGANIZER")).toBe("mailto:cotizaciones@mail.ejemplo-verificado.pe");
    expect(c.all("ATTENDEE")).toEqual(["mailto:frank.rodriguez@example.pe"]);
    expect(c.get("DTSTART")).toBe("20261117T100000");
    expect(c.get("LOCATION")).toBe("su base de Ate");

    expect(out.map((o) => o.kind)).toEqual(["text", "document"]);
    expect(lastText()).toContain("📅 Cita con *TRANSPORTES ANDES DEL PERU S.A.C.* el *martes 17/11 10:00* en su base de Ate.");
    expect(lastText()).toContain("Te envié la invitación a tu correo; ábrela en Outlook y pulsa Aceptar");
    expect(lastText()).toContain("archivo .ics de abajo es solo de respaldo");
    expect(lastText()).not.toContain("Agrégala a tu calendario de Outlook abriendo el archivo");
    const doc = out.find((o) => o.kind === "document")!;
    expect(doc.fileName).toMatch(/\.ics$/);
    const [act] = await store.listActivities({ companyId: ids[RUC_ANDES] });
    expect(act.data).toMatchObject({ invitacion: { status: "enviado", to: ["frank.rodriguez@example.pe"] } });
  });

  it("con danyer: el técnico (usuario interno con correo) recibe la misma invitación; nunca un contacto de la empresa", async () => {
    await store.upsertUser({ nombre: "Danyer Saavedra", whatsapp: DANYER, rol: "tecnico", email: "danyer@example.pe" });
    await store.addContact({ companyId: ids[RUC_ANDES], nombre: "Cliente Externo", cargo: null, telefono: null, email: "cliente@andes.example", createdBy: frankId });
    await send("cita andes del peru mañana 3pm con danyer", { env: { ...MAIL_ENV, PORTAL_TECH_LEAD_NUMBER: DANYER } });
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual(["frank.rodriguez@example.pe", "danyer@example.pe"]);
    expect(calPart(mails[0]).all("ATTENDEE")).toEqual(["mailto:frank.rodriguez@example.pe", "mailto:danyer@example.pe"]);
    // el contacto puede ir en el texto de la descripción, pero nunca como destinatario ni invitado
    expect(mails[0].to.join(" ")).not.toContain("cliente@andes.example");
    expect(calPart(mails[0]).all("ATTENDEE").join(" ")).not.toContain("cliente@andes.example");
    expect(lastText()).toContain("También se la envié al Ing. Danyer Saavedra.");
  });

  it("con danyer sin correo registrado: va solo al vendedor y lo dice", async () => {
    await send("cita andes del peru mañana 3pm con danyer", { env: { ...MAIL_ENV, PORTAL_TECH_LEAD_NUMBER: DANYER } });
    expect(mails[0].to).toEqual(["frank.rodriguez@example.pe"]);
    expect(lastText()).toContain("El Ing. Danyer Saavedra no tiene correo registrado");
  });

  it("con danyer sin número ni usuario técnico: no repite lo del correo (ya se dice que falta su número)", async () => {
    await send("cita andes del peru mañana 3pm con danyer", { env: { ...MAIL_ENV, PORTAL_TECH_LEAD_NUMBER: "" } });
    expect(mails[0].to).toEqual(["frank.rodriguez@example.pe"]);
    expect(lastText()).toContain(NO_TECH_NUMBER);
    expect(lastText()).not.toContain("no tiene correo registrado");
  });

  it("reprogramar: actualización REQUEST con el mismo UID y SEQUENCE mayor (Outlook la mueve, no la duplica)", async () => {
    await send("cita transportes andes martes 10am", { env: MAIL_ENV });
    await send("cita transportes andes martes 10am", { env: MAIL_ENV });
    out = [];
    const later = new Date(NOW.getTime() + 90_000);
    await send("reprogramar", { now: later, env: MAIL_ENV });
    out = [];
    await send("jueves 19/11 4pm", { now: later, env: MAIL_ENV });
    expect(mails).toHaveLength(2);
    const [a, b] = mails.map(calPart);
    expect(b.method).toBe("REQUEST");
    expect(b.get("UID")).toBe(a.get("UID"));
    expect(Number(b.get("SEQUENCE"))).toBeGreaterThan(Number(a.get("SEQUENCE")));
    expect(b.get("DTSTART")).toBe("20261119T160000");
    expect(b.get("ORGANIZER")).toBe(a.get("ORGANIZER"));
    expect(mails[1].subject).toMatch(/reprogramada/i);
    expect(lastText()).toContain("🔁 Reprogramé la cita con *TRANSPORTES ANDES DEL PERU S.A.C.*");
    expect(lastText()).toContain("Te envié la actualización a tu correo; ábrela en Outlook y pulsa Aceptar");
    expect(out.map((o) => o.kind)).toEqual(["text", "document"]);
  });

  it("cita cancelar <empresa>: la cita queda cancelada y sale la cancelación (METHOD:CANCEL, mismo UID, SEQUENCE mayor)", async () => {
    await send("cita transportes andes martes 10am", { env: MAIL_ENV });
    const [appt] = await store.listAppointments({ companyId: ids[RUC_ANDES] });
    out = [];
    const later = new Date(NOW.getTime() + 120_000);
    expect(await send("cita cancelar transportes andes", { now: later, env: MAIL_ENV })).toBe(true);
    expect((await store.getAppointment(appt.id))!.estado).toBe("cancelada");
    expect(mails).toHaveLength(2);
    const [a, c] = mails.map(calPart);
    expect(mails[1].method).toBe("CANCEL");
    expect(c.method).toBe("CANCEL");
    expect(c.get("STATUS")).toBe("CANCELLED");
    expect(c.get("UID")).toBe(a.get("UID"));
    expect(Number(c.get("SEQUENCE"))).toBeGreaterThan(Number(a.get("SEQUENCE")));
    expect(c.all("ATTENDEE")).toEqual(a.all("ATTENDEE"));
    expect(lastText()).toContain("Cancelé la cita con *TRANSPORTES ANDES DEL PERU S.A.C.* del *martes 17/11 10:00*");
    expect(lastText()).toContain("Te envié la cancelación a tu correo");
    const opp = (await store.getOpenOpportunity(ids[RUC_ANDES]))!;
    expect(opp.proximaAccion).toBeNull(); // apuntaba a la cita cancelada
    const acts = (await store.listActivities({ companyId: ids[RUC_ANDES] })).filter((x) => x.tipo === "cita");
    expect(acts[0].texto).toContain("cancelada");
    // ya no hay cita que cancelar
    await send("cita cancelar transportes andes", { now: later, env: MAIL_ENV });
    expect(lastText()).toContain("No hay citas programadas con *TRANSPORTES ANDES DEL PERU S.A.C.*");
    expect(mails).toHaveLength(2);
  });

  it("reprogramar y cancelar en el mismo segundo: cada envío lleva una SEQUENCE mayor que el anterior", async () => {
    await send("cita transportes andes martes 10am", { env: MAIL_ENV });
    await send("cita transportes andes martes 10am", { env: MAIL_ENV });
    await send("jueves 19/11 4pm", { env: MAIL_ENV });
    await send("cita cancelar transportes andes", { env: MAIL_ENV });
    expect(mails.map((m) => m.method)).toEqual(["REQUEST", "REQUEST", "CANCEL"]);
    const seq = mails.map((m) => Number(calPart(m).get("SEQUENCE")));
    expect(seq[1]).toBeGreaterThan(seq[0]);
    expect(seq[2]).toBeGreaterThan(seq[1]);
  });

  it("cita cancelar con dos citas programadas: pide el día y la hora, y con ellos cancela esa", async () => {
    await send("cita transportes andes martes 10am", { env: MAIL_ENV });
    await send("cita transportes andes jueves 4pm", { env: MAIL_ENV });
    await send("cita cancelar transportes andes", { env: MAIL_ENV });
    expect(lastText()).toContain("tiene 2 citas programadas");
    expect((await store.listAppointments({ companyId: ids[RUC_ANDES], estado: "programada" })).length).toBe(2);
    await send("cita cancelar transportes andes jueves 4pm", { env: MAIL_ENV });
    const left = await store.listAppointments({ companyId: ids[RUC_ANDES], estado: "programada" });
    expect(left.map((x) => x.startsAt.toISOString())).toEqual(["2026-11-17T15:00:00.000Z"]);
  });

  it("cita cancelar de una empresa ajena: no la toca", async () => {
    await send("cita transportes andes martes 10am", { env: MAIL_ENV });
    await send("cita cancelar transportes andes", { from: OTRO, env: MAIL_ENV });
    expect(texts(OTRO).at(-1)).toContain("no es tuya");
    expect((await store.listAppointments({ companyId: ids[RUC_ANDES], estado: "programada" })).length).toBe(1);
  });

  it("el correo falla (error o excepción): la cita se crea igual, una línea lo dice y queda el archivo", async () => {
    mailFail = "The domain is not verified";
    await send("cita transportes andes martes 10am", { env: MAIL_ENV });
    expect(await store.listAppointments({ companyId: ids[RUC_ANDES] })).toHaveLength(1);
    expect(lastText()).toContain("⚠️ No pude enviarte la invitación por correo. Agrégala a Outlook abriendo el archivo .ics que te mando abajo.");
    expect(out.map((o) => o.kind)).toEqual(["text", "document"]);
    out = [];
    mailFail = new Error("ECONNRESET");
    await send("cita andes sur martes 10am", { env: MAIL_ENV });
    expect(await store.listAppointments({ companyId: ids[RUC_ANDES_SUR] })).toHaveLength(1);
    expect(lastText()).toContain("No pude enviarte la invitación por correo");
    expect(out.map((o) => o.kind)).toEqual(["text", "document"]);
  });

  it("vendedor sin correo registrado: lo dice en una línea y queda el archivo", async () => {
    await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor", email: null });
    await send("cita transportes andes martes 10am", { env: MAIL_ENV });
    expect(mails).toHaveLength(0);
    expect(lastText()).toContain("✉️ No tengo tu correo para enviarte la invitación");
    expect(out.map((o) => o.kind)).toEqual(["text", "document"]);
  });

  it("enlaces Outlook web / Google Calendar: solo para el usuario que los tiene encendidos", async () => {
    await send("cita transportes andes martes 10am", { env: MAIL_ENV });
    expect(lastText()).not.toContain("calendar.google.com");
    await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor", calendarLinks: true });
    await send("cita andes sur martes 10am", { env: MAIL_ENV });
    expect(lastText()).toContain("Agregar a Outlook web: https://outlook.office.com/calendar/action/compose?");
    expect(lastText()).toContain("Agregar a Google Calendar: https://calendar.google.com/calendar/render?action=TEMPLATE");
    expect((await store.getUserByWhatsapp(FRANK))!.email).toBe("frank.rodriguez@example.pe"); // el upsert sin email lo conserva
  });

  it("sin remitente válido (EMAIL_FROM @360tyres.pe): no envía, lo dice y lo anota", async () => {
    configureCalendarMailer(null);
    await send("cita transportes andes martes 10am", { env: { RESEND_API_KEY: "re_x", EMAIL_FROM: "Citas <citas@360tyres.pe>" } });
    expect(lastText()).toContain("✉️ No te envié la invitación por correo: el correo del bot no está configurado.");
    const [act] = await store.listActivities({ companyId: ids[RUC_ANDES] });
    expect(act.data).toMatchObject({ invitacion: { status: "apagado" } });
  });
});

describe("correo de los usuarios (siembra)", () => {
  it("Frank toma el correo de salespeople (config/pilot.json); email explícito; volver a sembrar sin correo no lo borra", async () => {
    const s = JsonPortalStore.memory();
    const salespeople = { [FRANK]: { name: "Frank Melek Rodríguez Mirano", email: "Frank.Rodriguez@360tyres.pe" } };
    const users = [
      { nombre: "Frank Rodríguez", rol: "vendedor" as const, whatsappSalesperson: "Frank" },
      { nombre: "Danyer Saavedra", rol: "tecnico" as const, whatsappEnv: "PORTAL_TECH_LEAD_NUMBER", email: "danyer@example.pe", calendarLinks: true },
    ];
    const r = await seedUsers(s, { users, salespeople, env: { PORTAL_TECH_LEAD_NUMBER: DANYER } });
    expect(r.users.map((u) => [u.nombre, u.email, u.calendarLinks])).toEqual([
      ["Frank Rodríguez", "frank.rodriguez@360tyres.pe", false],
      ["Danyer Saavedra", "danyer@example.pe", true],
    ]);
    expect(r.entries.map((e) => e.action)).toEqual(["crear", "crear"]);
    // otra siembra igual: sin cambios
    expect((await seedUsers(s, { users, salespeople, env: { PORTAL_TECH_LEAD_NUMBER: DANYER } })).entries.map((e) => e.action)).toEqual(["igual", "igual"]);
    // sin correo en la configuración: el del store se conserva
    await seedUsers(s, { users: [{ nombre: "Danyer Saavedra", rol: "tecnico", whatsappEnv: "PORTAL_TECH_LEAD_NUMBER" }], env: { PORTAL_TECH_LEAD_NUMBER: DANYER } });
    expect((await s.getUserByWhatsapp(DANYER))!.email).toBe("danyer@example.pe");
    expect((await s.getUserByWhatsapp(DANYER))!.calendarLinks).toBe(true);
    // el aviso al técnico (upsert sin correo) tampoco lo borra
    await s.upsertUser({ nombre: "Danyer Saavedra", whatsapp: DANYER, rol: "tecnico" });
    expect((await s.getUserByWhatsapp(DANYER))!.email).toBe("danyer@example.pe");
  });

  it("un correo mal escrito no se guarda", async () => {
    const s = JsonPortalStore.memory();
    const u = await s.upsertUser({ nombre: "X", whatsapp: "51900000099", rol: "vendedor", email: "no es correo" });
    expect(u.email).toBeNull();
    expect(u.calendarLinks).toBe(false);
  });
});
