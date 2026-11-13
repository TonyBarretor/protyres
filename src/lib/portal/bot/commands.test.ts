import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import type { InboundMessage } from "../../whatsapp/webhook";
import { JsonPortalStore } from "../store";
import type { FleetVehicleInput, PortalStore } from "../store/types";
import { parseContactArgs } from "./commands/contacto";
import { findCompanies } from "./companies";
import { AMBIGUOUS_QUESTION, mentionsKnownCompany } from ".";
import { REPORT_PLACEHOLDER, setReportHandler } from "./registry";
import { getPending } from "./state";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
});

const FRANK = "51900000001";
const JUAN = "51900000002";
const OTRO = "51900000003";
const STRANGER = "51900000099";
let seq = 0;
const text = (from: string, body: string): InboundMessage => ({ id: `wamid.c${++seq}`, from, timestamp: "1", type: "text", text: body, forwarded: false });
const audio = (from: string): InboundMessage => ({ id: `wamid.a${++seq}`, from, timestamp: "1", type: "audio", forwarded: false, media: { id: "aud1", mimeType: "audio/ogg" } });

/** Empresas inventadas (RUC y razón social ficticios). */
const RUC_ANDES = "20999000011";
const RUC_ANDES_SUR = "20999000022";
const RUC_NORTE = "20999000033";
const RUC_ROCA = "20999000044";

function vehicle(companyId: number, placa: string, marca: string, medida: string | null, confianza: "alta" | "media" | "baja" | null): FleetVehicleInput {
  return { companyId, placa, marca, clase: "OMNIBUS", anio: 2018, ejes: 2, llantas: 6, llantasFuente: "20241231", pesoBruto: 18000, chasis: null, departamento: "LIMA", origen: "pasajeros", medidaProbable: medida, confianza };
}

let client: FakeWhatsAppClient;
let portal: JsonPortalStore;
let bot: BotHandler;
let ids: Record<string, number>;
const saved: Record<string, string | undefined> = {};

async function seed(store: PortalStore) {
  const r = await store.upsertCompanies([
    { ruc: RUC_ANDES, razonSocial: "TRANSPORTES ANDES DEL PERU S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 12, llantasPiso: 72 },
    { ruc: RUC_ANDES_SUR, razonSocial: "EMPRESA ANDES SUR E.I.R.L.", sector: "carga", departamento: "AREQUIPA", unidades: 30, llantasPiso: 300 },
    { ruc: RUC_NORTE, razonSocial: "EXPRESO NORTEÑO S.A.", sector: "mixto", departamento: "PIURA", unidades: 40, llantasPiso: 400 },
    { ruc: RUC_ROCA, razonSocial: "E.T. LA ROCA S.R.L.", sector: "carga", departamento: "LIMA", unidades: 15, llantasPiso: 150 },
  ]);
  ids = r.ids;
  const andes = r.ids[RUC_ANDES];
  await store.upsertFleet([
    ...Array.from({ length: 6 }, (_, i) => vehicle(andes, `AAA-10${i}`, "VOLVO", "295/80R22.5", "media")),
    ...Array.from({ length: 4 }, (_, i) => vehicle(andes, `BBB-10${i}`, "SCANIA", "295/80R22.5", "media")),
    vehicle(andes, "CCC-100", "MERCEDES BENZ", "11R22.5", "baja"),
    vehicle(andes, "DDD-100", "KING LONG", null, null),
  ]);
  await store.insertSales([{ fecha: "2026-09-01", ruc: RUC_ANDES, cantidad: 24, origen: "demo", isDemo: true }]);
}

beforeEach(async () => {
  for (const k of ["PORTAL_SESSION_SECRET", "PORTAL_BASE_URL", "LLM_DISABLED"]) saved[k] = process.env[k];
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  process.env.PORTAL_BASE_URL = "https://portal.example.pe";
  process.env.LLM_DISABLED = "1";
  client = new FakeWhatsAppClient();
  portal = JsonPortalStore.memory();
  await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  await portal.upsertUser({ nombre: "Juan Bustios", whatsapp: JUAN, rol: "supervisor" });
  await portal.upsertUser({ nombre: "Otro Vendedor", whatsapp: OTRO, rol: "vendedor" });
  await seed(portal);
  bot = new BotHandler({ client, store: JsonStore.memory(), settings, portalStore: portal });
});

afterEach(() => {
  setReportHandler(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const last = () => client.texts().at(-1) ?? "";
const frankId = async () => (await portal.getUserByWhatsapp(FRANK))!.id;

describe("búsqueda de empresas", () => {
  it("RUC exacto, inicio de RUC, nombre sin tildes ni S.A.C., nombre con signos", async () => {
    expect((await findCompanies(portal, RUC_ANDES)).rows.map((c) => c.ruc)).toEqual([RUC_ANDES]);
    expect((await findCompanies(portal, "2099900")).total).toBe(4);
    expect((await findCompanies(portal, "transportes andes del peru sac")).rows.map((c) => c.ruc)).toEqual([RUC_ANDES]);
    expect((await findCompanies(portal, "norteno")).rows.map((c) => c.ruc)).toEqual([RUC_NORTE]);
    expect((await findCompanies(portal, "Expreso Norteño")).rows.map((c) => c.ruc)).toEqual([RUC_NORTE]);
    expect((await findCompanies(portal, "et la roca")).rows.map((c) => c.ruc)).toEqual([RUC_ROCA]);
    expect((await findCompanies(portal, "andes")).total).toBe(2);
    expect((await findCompanies(portal, "20999999999")).total).toBe(0);
  });

  it("mentionsKnownCompany: nombre de empresa (sin S.A.C.) dentro de un texto", async () => {
    expect(await mentionsKnownCompany(portal, "expreso norteño quedó en revisar")).toBe(true);
    expect(await mentionsKnownCompany(portal, "buenas tardes a todos")).toBe(false);
  });
});

describe("parseContactArgs", () => {
  it("separa empresa, nombre, cargo, teléfono y correo en cualquier orden", () => {
    expect(parseContactArgs("ANDES: Juan Pérez, jefe de flota, 987 654 321")).toEqual({ empresa: "ANDES", nombre: "Juan Pérez", cargo: "jefe de flota", telefono: "987654321", email: null });
    expect(parseContactArgs("Andes: Ana Ruiz, ana@andes.pe, +51 987-654-321, compras")).toEqual({ empresa: "Andes", nombre: "Ana Ruiz", cargo: "compras", telefono: "+51987654321", email: "ana@andes.pe" });
    expect(parseContactArgs("Andes: Luis")).toEqual({ empresa: "Andes", nombre: "Luis", cargo: null, telefono: null, email: null });
    expect(parseContactArgs("Andes Juan Pérez")).toHaveProperty("error");
    expect(parseContactArgs(": Juan")).toHaveProperty("error");
    expect(parseContactArgs("Andes: 987654321")).toHaveProperty("error");
  });
});

describe("comandos del portal por WhatsApp", () => {
  it("empresa: una coincidencia -> ficha corta con enlace; varias -> lista y se elige con el número", async () => {
    await bot.handle(text(FRANK, "empresa expreso norteño"));
    expect(last()).toContain("*EXPRESO NORTEÑO S.A.*");
    expect(last()).toContain(`RUC ${RUC_NORTE}`);
    expect(last()).toContain("Unidades: *40*");
    expect(last()).toContain(`https://portal.example.pe/portal/empresas/${ids[RUC_NORTE]}`);
    expect(last()).toContain(`asignarme ${RUC_NORTE}`);

    await bot.handle(text(FRANK, "Empresa andes"));
    expect(last()).toContain("Encontré 2 empresas");
    expect(last()).toContain("*1.* EMPRESA ANDES SUR E.I.R.L."); // más unidades primero
    expect(last()).toContain("*2.* TRANSPORTES ANDES DEL PERU S.A.C.");
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("choose_company");
    await bot.handle(text(FRANK, "2"));
    expect(last()).toContain("*TRANSPORTES ANDES DEL PERU S.A.C.*");
    expect(await getPending(portal, FRANK, new Date())).toBeNull();

    await bot.handle(text(FRANK, "empresa zzzz"));
    expect(last()).toContain("No encontré «zzzz»");
  });

  it("asignarme por RUC: dueño, oportunidad en Prospecto, actividad y ficha completa", async () => {
    await bot.handle(text(FRANK, `asignarme ${RUC_ANDES}`));
    const reply = last();
    expect(reply).toContain("Empresa asignada a ti");
    expect(reply).toContain("*TRANSPORTES ANDES DEL PERU S.A.C.*");
    expect(reply).toContain("Llantas en piso: *72* _(dato MTC)_");
    expect(reply).toContain("Flota por marca: VOLVO 6 · SCANIA 4 ·");
    expect(reply).toContain("295/80R22.5 (10 unid., confianza media)");
    expect(reply).toContain("11R22.5 (1 unid., confianza baja)");
    expect(reply).toContain("Participación 12 meses: 24 llantas *DEMO*");
    expect(reply).toContain("Contactos: ninguno aún");
    expect(reply).toContain("Oportunidad: *Prospecto*");
    expect(reply).toContain(`/portal/empresas/${ids[RUC_ANDES]}`);
    const company = await portal.getCompany(ids[RUC_ANDES]);
    expect(company?.ownerUserId).toBe(await frankId());
    const opps = await portal.listOpportunities({ companyId: ids[RUC_ANDES] });
    expect(opps.map((o) => [o.etapa, o.ownerUserId])).toEqual([["prospecto", await frankId()]]);
    const acts = await portal.listActivities({ companyId: ids[RUC_ANDES] });
    expect(acts.map((a) => [a.tipo, a.canal, a.texto])).toEqual([["nota", "whatsapp", "Frank Rodríguez se asignó la empresa."]]);

    // otra vez: ya era suya, sin duplicar oportunidad ni actividad
    await bot.handle(text(FRANK, "asignarme transportes andes del peru"));
    expect(last()).toContain("Ya era tuya");
    expect((await portal.listOpportunities({ companyId: ids[RUC_ANDES] })).length).toBe(1);
    expect((await portal.listActivities({ companyId: ids[RUC_ANDES] })).length).toBe(1);
  });

  it("asignarme: un vendedor no quita la empresa de otro; el supervisor sí la reasigna", async () => {
    await bot.handle(text(OTRO, `asignarme ${RUC_NORTE}`));
    await bot.handle(text(FRANK, `asignarme ${RUC_NORTE}`));
    expect(last()).toContain("ya es de Otro Vendedor");
    expect((await portal.getCompany(ids[RUC_NORTE]))?.ownerUserId).toBe((await portal.getUserByWhatsapp(OTRO))!.id);
    await bot.handle(text(JUAN, `asignarme ${RUC_NORTE}`));
    expect(last()).toContain("Empresa asignada a ti");
    const juanId = (await portal.getUserByWhatsapp(JUAN))!.id;
    expect((await portal.getCompany(ids[RUC_NORTE]))?.ownerUserId).toBe(juanId);
    const opps = await portal.listOpportunities({ companyId: ids[RUC_NORTE] });
    expect(opps.map((o) => o.ownerUserId)).toEqual([juanId]); // la misma oportunidad pasa al nuevo dueño
  });

  it("asignarme con varias coincidencias: lista y luego el número asigna", async () => {
    await bot.handle(text(FRANK, "asignarme andes"));
    expect(last()).toContain("Encontré 2 empresas");
    await bot.handle(text(FRANK, "1"));
    expect(last()).toContain("Empresa asignada a ti");
    expect((await portal.getCompany(ids[RUC_ANDES_SUR]))?.ownerUserId).toBe(await frankId());
  });

  it("contacto: guarda en una empresa propia; pide asignarla si no es suya; desambigua", async () => {
    await bot.handle(text(FRANK, "contacto expreso norteño: Juan Pérez, jefe de flota, 987654321"));
    expect(last()).toContain("no es tuya");
    expect(await portal.listContacts(ids[RUC_NORTE])).toEqual([]);

    await bot.handle(text(FRANK, `asignarme ${RUC_NORTE}`));
    await bot.handle(text(FRANK, "contacto expreso norteño: Juan Pérez, jefe de flota, 987 654 321"));
    expect(last()).toContain("✔ Contacto guardado en *EXPRESO NORTEÑO S.A.*");
    expect(last()).toContain("Juan Pérez · jefe de flota · 987654321");
    const [c] = await portal.listContacts(ids[RUC_NORTE]);
    expect([c.nombre, c.cargo, c.telefono, c.email, c.createdBy]).toEqual(["Juan Pérez", "jefe de flota", "987654321", null, await frankId()]);

    await bot.handle(text(FRANK, `asignarme ${RUC_ANDES}`));
    await bot.handle(text(FRANK, "contacto andes: Ana Ruiz, compras, ana@andes.pe"));
    expect(last()).toContain("Encontré 2 empresas");
    await bot.handle(text(FRANK, "2"));
    expect(last()).toContain("Contacto guardado en *TRANSPORTES ANDES DEL PERU S.A.C.*");
    expect((await portal.listContacts(ids[RUC_ANDES]))[0].email).toBe("ana@andes.pe");

    // la ficha ya muestra el contacto
    await bot.handle(text(FRANK, `asignarme ${RUC_ANDES}`));
    expect(last()).toContain("• Ana Ruiz (compras) · ana@andes.pe");

    await bot.handle(text(FRANK, "contacto andes Juan"));
    expect(last()).toContain("contacto ZBUSS: Juan Pérez");
  });

  it("hoy: acciones vencidas y de hoy, citas y enlace", async () => {
    const now = new Date();
    const fid = await frankId();
    const opp = await portal.createOpportunity({ companyId: ids[RUC_ANDES], ownerUserId: fid, proximaAccion: "Llamar al jefe de flota", proximaAccionAt: new Date(now.getTime() - 3 * 86400_000) });
    await portal.createOpportunity({ companyId: ids[RUC_NORTE], ownerUserId: fid, proximaAccion: "Enviar catálogo" });
    await portal.addAppointment({ companyId: ids[RUC_ANDES], opportunityId: opp.id, userId: fid, startsAt: new Date(now.getTime() + 2 * 86400_000), lugar: "Base Ate", conTecnico: true });
    await bot.handle(text(FRANK, "hoy"));
    const reply = last();
    expect(reply).toContain("*Acciones*");
    expect(reply).toContain("⚠️ TRANSPORTES ANDES DEL PERU S.A.C.: Llamar al jefe de flota _(vencida");
    expect(reply).toContain("*Próximas citas (7 días)*");
    expect(reply).toContain("(con técnico)");
    expect(reply).toContain("*Sin fecha*");
    expect(reply).toContain("EXPRESO NORTEÑO S.A.: Enviar catálogo");
    expect(reply).toContain("https://portal.example.pe/portal/hoy");

    await bot.handle(text(OTRO, "hoy"));
    expect(last()).toContain("No tienes acciones ni citas");
  });

  it("ayuda portal y comandos de bloques siguientes", async () => {
    await bot.handle(text(FRANK, "ayuda portal"));
    for (const c of ["*portal*", "*empresa", "*asignarme", "*contacto", "*hoy*", "*cita", "*oc", "*avance*", "*prepropuesta", "*aprende", "*nota de voz*"]) expect(last()).toContain(c);
    await bot.handle(text(FRANK, "avance"));
    expect(last()).toContain("💰 *Vendido");
    await bot.handle(text(FRANK, "ayuda"));
    expect(last()).toContain("Cotizador Protyres"); // la ayuda del cotizador no cambia
  });

  it("un número no registrado: solo `portal` responde; lo demás sigue al cotizador como siempre", async () => {
    await bot.handle(text(STRANGER, "portal"));
    expect(last()).toContain("no está registrado");
    await bot.handle(text(STRANGER, "empresa andes"));
    expect(last()).not.toContain("Encontré");
    expect(last()).not.toContain("no está registrado");
    await bot.handle(text(STRANGER, "llamé al gerente de expreso norteño"));
    expect(last()).not.toContain(REPORT_PLACEHOLDER);
    await bot.handle(audio(STRANGER));
    expect(last()).toBe("Por ahora no leo audios ni videos. Reenvíame el texto, PDF, Excel o una foto.");
  });
});

describe("reportes, ambigüedad y pasos pendientes", () => {
  it("texto de reporte -> borrador con resumen y paso pendiente (empresa del padrón aunque no sea del vendedor)", async () => {
    await bot.handle(text(FRANK, "Visité Expreso Norteño, me atendió el jefe de flota"));
    expect(last()).toContain("*Reporte de visita* — EXPRESO NORTEÑO");
    expect(last()).toContain("¿Está bien? Responde *sí* o corrige");
    const p = await getPending(portal, FRANK, new Date());
    expect(p).toMatchObject({ kind: "report_draft", text: "Visité Expreso Norteño, me atendió el jefe de flota", field: null });
  });

  it("nombrar una empresa conocida cuenta como reporte (sin tipo claro: pregunta una cosa)", async () => {
    await bot.handle(text(FRANK, "expreso norteño revisa el lunes"));
    expect(last()).toBe("¿Fue una *visita*, una *llamada* o solo una *nota*?");
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("report_draft");
  });

  it("nota de voz de un usuario del portal -> reporte (no 'no leo audios')", async () => {
    let got: { text: string; audio: unknown } | null = null;
    setReportHandler(async (ctx, t, opts) => {
      got = { text: t, audio: opts.audio };
      await ctx.reply("ok voz");
    });
    await bot.handle(audio(FRANK));
    expect(last()).toBe("ok voz");
    expect(got).toEqual({ text: "", audio: { id: "aud1", mimeType: "audio/ogg" } });
  });

  it("ambiguo: pregunta; 'cotización' pasa el texto original al cotizador", async () => {
    await bot.handle(text(FRANK, "Visité Transportes ABC, necesitan 295/80R22.5 x4"));
    expect(last()).toBe(AMBIGUOUS_QUESTION);
    await bot.handle(text(FRANK, "cotización"));
    expect(last()).toContain("Cotización nueva");
    expect(last()).toContain("295/80R22.5");
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
  });

  it("ambiguo: 'reporte' va al intérprete con la hora del mensaje original", async () => {
    let got: { text: string; at: Date } | null = null;
    setReportHandler(async (ctx, t, opts) => {
      got = { text: t, at: opts.occurredAt };
      await ctx.reply("reporte recibido");
    });
    await bot.handle({ ...text(FRANK, "Visité Transportes ABC, necesitan 295/80R22.5 x4"), timestamp: "1762800000" });
    await bot.handle(text(FRANK, "reporte"));
    expect(last()).toBe("reporte recibido");
    expect(got).toEqual({ text: "Visité Transportes ABC, necesitan 295/80R22.5 x4", at: new Date(1762800000 * 1000) });
  });

  it("cancelar limpia el paso del portal y el cotizador responde como siempre", async () => {
    await bot.handle(text(FRANK, "empresa andes"));
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("choose_company");
    await bot.handle(text(FRANK, "cancelar"));
    expect(last()).toBe("Listo, cancelado. ¿Qué cotizamos?");
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
    await bot.handle(text(FRANK, "2")); // ya no hay lista: al cotizador
    expect(last()).not.toContain("ANDES");
  });

  it("con una lista pendiente, un pedido va al cotizador y la lista pasa a pausa (corrida D: ya no se descarta en silencio)", async () => {
    await bot.handle(text(FRANK, "empresa andes"));
    await bot.handle(text(FRANK, "Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com"));
    expect(client.texts().at(-2)).toContain("Cotización nueva");
    expect(last()).toBe("⏸ Dejaste pendiente: elegir la empresa para ver su ficha (falta elegir entre 2).");
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
  });

  it("un comando del portal a mitad de una cotización no la toca", async () => {
    await bot.handle(text(FRANK, "Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com"));
    await bot.handle(text(FRANK, "empresa expreso norteño"));
    expect(last()).toContain("*EXPRESO NORTEÑO S.A.*");
    await bot.handle(text(FRANK, "visité expreso norteño")); // a mitad del flujo: cotizador, no reporte
    expect(last()).not.toContain(REPORT_PLACEHOLDER);
  });

  it("si el store del portal falla, el cotizador sigue; un comando del portal da error", async () => {
    const broken = new Proxy(portal, {
      get(target, prop) {
        if (prop === "getUserByWhatsapp") return async () => Promise.reject(new Error("base caída"));
        return Reflect.get(target, prop);
      },
    });
    const logs: string[] = [];
    const b = new BotHandler({ client, store: JsonStore.memory(), settings, portalStore: broken, log: (m) => logs.push(m) });
    await b.handle(text(FRANK, "llamé al gerente de expreso norteño"));
    expect(last()).not.toContain("Ocurrió un error");
    expect(logs.some((l) => l.includes("base caída"))).toBe(true);
    await b.handle(text(FRANK, "cancelar"));
    expect(last()).toBe("Listo, cancelado. ¿Qué cotizamos?");
    await b.handle(text(FRANK, "hoy"));
    expect(last()).toContain("Ocurrió un error: base caída");
  });
});
