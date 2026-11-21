/**
 * Corrida J por el bot (BotHandler.handle, como el webhook): `nueva empresa` por texto y por voz, RUC inválido y
 * duplicado, el reporte de visita / la OC / *Enlazar* que terminan creando la empresa sin perder lo dictado, *Buscar otra
 * vez*, y el reporte sobre una empresa sin dueño (*Asignármela y guardar todo* / *Guardar solo la nota*).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PriceRow } from "../../ingest/types";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import type { InboundMessage } from "../../whatsapp/webhook";
import { JsonPortalStore } from "../store";
import { configureOrderBot } from "./commands/oc";
import { configureReportBot } from "./report";
import { getPending } from "./state";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7, paymentType: "Factura crédito", paymentTerm: "30 días" },
  salespeople: { "51900000001": { name: "Frank Rodríguez" } },
});

const FRANK = "51900000001";
/** Empresas y RUC inventados (los nuevos, con dígito verificador válido). */
const RUC_ZETA = "20999000055";
const RUC_OMEGA = "20999000088";
const RUC_SOL = "20600000013";
const RUC_LUNA = "20612345679";
const RUC_NUEVO = "20500000008";
const TODAY = new Date().toISOString().slice(0, 10);

const ROWS: PriceRow[] = [
  {
    id: "own-valor87",
    provider: "360 Tyres",
    kind: "own",
    brand: "Fenixway",
    model: "Valor 87",
    size: "295/80R22.5",
    cost: 472,
    description: "295/80R22.5 FENIXWAY VALOR 87",
    sizeDisplay: "295/80R22.5",
    sizeRaw: "295/80R22.5",
    isTyre: true,
    ply: 18,
    priceIncludesTax: true,
    currency: "USD",
    stock: null,
    priceDate: TODAY,
    source: "excel",
    sourceRef: "test.xlsx",
  },
];

let seq = 0;
const text = (body: string): InboundMessage => ({ id: `wamid.j${++seq}`, from: FRANK, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: body, forwarded: false });
const button = (id: string, title: string): InboundMessage => ({ id: `wamid.j${++seq}`, from: FRANK, timestamp: String(Math.floor(Date.now() / 1000)), type: "interactive", text: id, interactiveId: `pt:${id}`, interactiveType: "button_reply", interactiveTitle: title, forwarded: false });
const audio = (mediaId: string): InboundMessage => ({ id: `wamid.j${++seq}`, from: FRANK, timestamp: String(Math.floor(Date.now() / 1000)), type: "audio", forwarded: false, media: { id: mediaId, mimeType: "audio/ogg; codecs=opus" } });

let client: FakeWhatsAppClient;
let prices: JsonStore;
let portal: JsonPortalStore;
let bot: BotHandler;
let frankId: number;
let ids: Record<string, number>;
let transcript = "";
const saved: Record<string, string | undefined> = {};

const deepgram = (async () => new Response(JSON.stringify({ metadata: { duration: 6 }, results: { channels: [{ alternatives: [{ transcript, confidence: 0.95 }] }] } }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

beforeEach(async () => {
  for (const k of ["PORTAL_SESSION_SECRET", "PORTAL_BASE_URL", "LLM_DISABLED", "DEEPGRAM_API_KEY", "PHOTOS_DISABLED"]) saved[k] = process.env[k];
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  process.env.PORTAL_BASE_URL = "https://portal.example.pe";
  process.env.LLM_DISABLED = "1";
  process.env.PHOTOS_DISABLED = "1";
  process.env.DEEPGRAM_API_KEY = "dg-test-key";
  client = new FakeWhatsAppClient();
  prices = JsonStore.memory();
  await prices.upsertRows(ROWS);
  portal = JsonPortalStore.memory();
  frankId = (await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" })).id;
  const r = await portal.upsertCompanies([
    { ruc: RUC_ZETA, razonSocial: "TRANSPORTES ZETA BUS S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 40, llantasPiso: 240 },
    { ruc: RUC_OMEGA, razonSocial: "TRANSPORTES OMEGA SUR S.A.C.", sector: "carga", departamento: "LIMA", unidades: 30, llantasPiso: 300 },
  ]);
  ids = r.ids;
  await portal.setOwner(ids[RUC_ZETA], frankId);
  configureReportBot({ llm: null, deepgramFetch: deepgram, downloadMedia: async () => ({ data: Buffer.from("OggS-prueba"), mimeType: "audio/ogg" }), logMessage: (e) => prices.logMessage(e) });
  configureOrderBot({ priceStore: prices, settings });
  bot = new BotHandler({ client, store: prices, settings, portalStore: portal });
});

afterEach(() => {
  configureReportBot(null);
  configureOrderBot(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const last = () => client.texts().at(-1) ?? "";
/** Todo lo que el bot respondió desde `from` (textos e interactivos). */
const since = (from: number) => client.texts().slice(from).join("\n---\n");
const say = async (body: string) => {
  const n = client.texts().length;
  await bot.handle(text(body));
  return since(n);
};
const lastButtons = () => {
  const m = client.interactives().at(-1);
  return m?.type === "button" ? m.buttons.map((b) => b.title) : [];
};

async function companyByRuc(ruc: string) {
  return portal.getCompanyByRuc(ruc);
}

describe("nueva empresa por texto", () => {
  it("pregunta una cosa a la vez, valida el RUC y la crea asignada al vendedor con oportunidad en Prospecto", async () => {
    expect(await say("nueva empresa")).toContain("¿Cuál es el *RUC*?");
    expect(await say("2060000001")).toContain("tiene 10 dígitos");
    expect(await say("20600000014")).toContain("no es válido");
    expect(await say(RUC_SOL)).toContain("¿Cuál es la *razón social*?");
    expect(await say("Transportes de Carga Sol SAC")).toContain("¿De qué *sector*?");
    expect(lastButtons()).toEqual(["Carga", "Pasajeros", "Mixto"]);
    expect(await say("carga")).toContain("¿En qué *departamento*?");
    expect(await say("Narnia")).toContain("No reconozco «Narnia» como departamento");
    let out = await say("junín");
    expect(out).toContain("*Empresa nueva* (no está en el padrón del MTC)");
    expect(out).toContain("TRANSPORTES DE CARGA SOL SAC");
    expect(out).toContain(`RUC ${RUC_SOL} · Carga · Junín`);
    expect(lastButtons()).toEqual(["Crear empresa", "Corregir", "No crear"]);
    // opcionales en el resumen
    out = await say("15 unidades");
    expect(out).toContain("Unidades: 15");
    out = await say("contacto Juan Pérez, jefe de flota, 987 654 321");
    expect(out).toContain("Contacto: Juan Pérez (jefe de flota) · 987654321");
    out = await say("contacto: Juan Pérez, jefe de flota, 987 654 321"); // con dos puntos (como sugiere el resumen) también
    expect(out).toContain("Contacto: Juan Pérez (jefe de flota) · 987654321");
    out = await say("sí");
    expect(out).toContain("✔ Empresa creada y asignada a ti: *TRANSPORTES DE CARGA SOL SAC*");
    expect(out).toContain("su flota no viene del MTC");
    const c = (await companyByRuc(RUC_SOL))!;
    expect(c).toMatchObject({ origen: "manual", ownerUserId: frankId, createdBy: frankId, sector: "carga", departamento: "JUNIN", unidades: 15 });
    expect((await portal.listOpportunities({ companyId: c.id })).map((o) => o.etapa)).toEqual(["prospecto"]);
    expect((await portal.listContacts(c.id)).map((x) => [x.nombre, x.cargo, x.telefono])).toEqual([["Juan Pérez", "jefe de flota", "987654321"]]);
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
    // y ya se encuentra como cualquier empresa
    expect(await say("empresa carga sol")).toContain("TRANSPORTES DE CARGA SOL SAC");
  });

  it("todo en un mensaje; *corregir* y *No crear*", async () => {
    let out = await say(`nueva empresa ${RUC_LUNA} Expreso Luna, pasajeros, Arequipa`);
    expect(out).toContain("EXPRESO LUNA");
    expect(out).toContain(`RUC ${RUC_LUNA} · Pasajeros · Arequipa`);
    expect(await say("corregir")).toContain("¿Qué corrijo?");
    out = await say("razón social Expreso Luna Llena EIRL");
    expect(out).toContain("EXPRESO LUNA LLENA EIRL");
    expect(await say("no")).toContain("Listo, no creé la empresa.");
    expect(await companyByRuc(RUC_LUNA)).toBeNull();
  });

  it("RUC que ya existe: muestra esa empresa en vez de duplicar", async () => {
    const out = await say(`nueva empresa ${RUC_ZETA}`);
    expect(out).toContain("Ese RUC ya está en el portal: no la dupliqué.");
    expect(out).toContain("TRANSPORTES ZETA BUS S.A.C.");
    expect(await portal.countCompanies()).toBe(2);
  });

  it("RUC inválido escrito con el comando: lo dice y vuelve a pedirlo", async () => {
    expect(await say("nueva empresa 20600000019 Transportes Error SAC")).toMatch(/El RUC 20600000019 no es válido.*¿Cuál es el \*RUC\*\?/s);
    expect(await getPending(portal, FRANK, new Date())).toMatchObject({ kind: "new_company", field: "ruc" });
  });
});

describe("nueva empresa por voz", () => {
  it("dictada con el comando: los datos salen de la transcripción y la actividad queda con canal voz", async () => {
    transcript = "Nueva empresa, RUC 20 612 345 679, Expreso Luna, son buses, en La Libertad.";
    await bot.handle(audio("aud-1"));
    const out = client.texts().join("\n");
    expect(out).toContain("🎙️");
    expect(out).toContain(`RUC ${RUC_LUNA} · Pasajeros · La Libertad`);
    expect(out).toContain("EXPRESO LUNA");
    transcript = "Sí, créala.";
    await bot.handle(audio("aud-2"));
    expect(last()).toContain("✔ Empresa creada y asignada a ti: *EXPRESO LUNA*");
    const c = (await companyByRuc(RUC_LUNA))!;
    expect((await portal.listActivities({ companyId: c.id }))[0].canal).toBe("voz");
  });
});

describe("el flujo que no encontró la empresa sigue al crearla", () => {
  it("reporte de visita: No encontré -> Crear empresa nueva -> alta -> el reporte sigue y se guarda completo", async () => {
    let out = await say("Visité a un cliente nuevo, hablé con Rosa Díaz, jefa de mantenimiento, quieren probar Fenixway en direccional");
    expect(out).toContain("¿Con qué empresa fue?");
    out = await say("Transportes Nuevo Sol");
    expect(out).toContain("No encontré «Transportes Nuevo Sol» en el padrón");
    expect(lastButtons()).toEqual(["Crear empresa nueva", "Buscar otra vez"]);
    // *Crear empresa nueva*: la razón social ya viene de lo buscado
    out = await say("nueva empresa");
    expect(out).toContain("¿Cuál es el *RUC*?");
    await say(RUC_NUEVO);
    await say("carga");
    out = await say("Lima");
    expect(out).toContain("TRANSPORTES NUEVO SOL");
    out = await say("sí");
    expect(out).toContain("✔ Empresa creada y asignada a ti: *TRANSPORTES NUEVO SOL*");
    expect(out).toContain("Sigo con tu reporte:");
    expect(out).toContain("*Reporte de visita* — TRANSPORTES NUEVO SOL");
    out = await say("sí");
    expect(out).toContain("✔ Guardado: visita — *TRANSPORTES NUEVO SOL*");
    const c = (await companyByRuc(RUC_NUEVO))!;
    expect(c.ownerUserId).toBe(frankId);
    const acts = await portal.listActivities({ companyId: c.id });
    expect(acts.map((a) => a.tipo)).toContain("visita");
    expect((await portal.listOpportunities({ companyId: c.id, open: true })).map((o) => o.etapa)).toEqual(["visita_realizada"]);
    expect((await portal.listContacts(c.id)).map((x) => x.nombre)).toEqual(["Rosa Díaz"]);
  });

  it("reporte de visita: *Buscar otra vez* y luego la empresa correcta", async () => {
    await say("Visité a un cliente, todo bien, quedamos en llamarlo");
    await say("Omega Norte");
    expect(lastButtons()).toEqual(["Crear empresa nueva", "Buscar otra vez"]);
    expect(await say("buscar otra vez")).toContain("¿Con qué empresa fue? Escribe el nombre o el RUC.");
    await say("Omega Sur");
    const pending = await getPending(portal, FRANK, new Date());
    expect((pending?.draft as { companyId: number } | undefined)?.companyId).toBe(ids[RUC_OMEGA]);
    expect(await portal.countCompanies()).toBe(2);
  });

  it("oc: No encontré -> Crear empresa nueva -> la OC sigue con la empresa creada y su número", async () => {
    let out = await say("oc sol naciente 4500999");
    expect(out).toContain("No encontré «sol naciente» en el padrón");
    expect(lastButtons()).toEqual(["Crear empresa nueva", "Buscar otra vez"]);
    out = await say(`nueva empresa ${RUC_NUEVO}`);
    expect(out).toContain("¿De qué *sector*?");
    await say("mixto");
    out = await say("Lima");
    expect(out).toContain("SOL NACIENTE");
    out = await say("sí");
    expect(out).toContain("✔ Empresa creada y asignada a ti");
    expect(out).toContain("OC *4500999* de *SOL NACIENTE* registrada");
    const c = (await companyByRuc(RUC_NUEVO))!;
    expect((await portal.listPurchaseOrders({ companyId: c.id })).map((o) => o.numero)).toEqual(["4500999"]);
  });

  it("enlazar: cotización para un cliente fuera del portal -> *enlazar* -> Crear empresa nueva -> enlazada", async () => {
    const quoteOut = await say("Fenixway Valor 87 295/80R22.5 x4 para Transportes Nuevo Sol");
    expect(quoteOut).not.toContain("🔗"); // el cotizador no cambia
    await say("ok");
    let out = await say("enlazar");
    expect(out).toContain("No encontré «Transportes Nuevo Sol» en el padrón");
    out = await say("nueva empresa");
    expect(out).toContain("¿Cuál es el *RUC*?");
    await say(RUC_NUEVO);
    await say("carga");
    await say("Lima");
    out = await say("sí");
    expect(out).toContain("✔ Empresa creada y asignada a ti");
    expect(out).toMatch(/🔗 Listo: cotización \*0001\* enlazada a \*TRANSPORTES NUEVO SOL\*/);
    const c = (await companyByRuc(RUC_NUEVO))!;
    expect((await portal.getOpenOpportunity(c.id))?.quoteNumber).toBe("COT-0001");
  });

  it("enlazar a una empresa sin dueño se la asigna al vendedor", async () => {
    await say(`Fenixway Valor 87 295/80R22.5 x4 para Transportes Omega Sur RUC ${RUC_OMEGA}`);
    const out = await say("ok");
    expect(out).toContain("Quedó asignada a ti.");
    expect((await companyByRuc(RUC_OMEGA))!.ownerUserId).toBe(frankId);
  });
});

describe("reporte sobre una empresa sin dueño", () => {
  it("*Asignármela y guardar todo*: la asigna y guarda oportunidad, contacto, etapa y próxima acción en un paso", async () => {
    await say("Visité Transportes Omega Sur, hablé con Carlos Quispe, jefe de flota. Quedamos en llamarlo el viernes 10am");
    let out = await say("sí");
    expect(out).toContain("*TRANSPORTES OMEGA SUR* no tiene dueño. ¿Qué guardo?");
    expect(out).toContain("*Asignármela y guardar todo*");
    expect(out).toContain("*Guardar solo la nota*");
    expect(lastButtons()).toEqual(["Asignar y guardar", "Guardar solo la nota"]);
    out = await say("asignármela");
    expect(out).toContain("✔ Guardado: visita — *TRANSPORTES OMEGA SUR*");
    expect(out).toContain("• Empresa asignada a ti");
    expect(out).toContain("• Oportunidad nueva en *Visita realizada*");
    expect(out).toContain("• Contacto nuevo: Carlos Quispe");
    const id = ids[RUC_OMEGA];
    expect((await portal.getCompany(id))!.ownerUserId).toBe(frankId);
    const opps = await portal.listOpportunities({ companyId: id });
    expect(opps.map((o) => [o.etapa, o.ownerUserId])).toEqual([["visita_realizada", frankId]]);
    expect(opps[0].proximaAccion).toBeTruthy();
    expect((await portal.listContacts(id)).map((c) => c.nombre)).toEqual(["Carlos Quispe"]);
    const acts = await portal.listActivities({ companyId: id });
    expect(acts.some((a) => (a.data as { evento?: string } | null)?.evento === "asignacion")).toBe(true);
  });

  it("empresa del padrón nombrada en un reporte largo (una palabra): se reconoce y ofrece asignársela", async () => {
    await portal.upsertCompanies([{ ruc: "20100521734", razonSocial: "LABOCER S.A.", sector: "carga", departamento: "LIMA", unidades: 25, llantasPiso: 150 }]);
    let out = await say("Visité Labocer, hablé con Ana Torres, jefa de logística; les interesa Fenixway");
    expect(out).toContain("*Reporte de visita* — LABOCER (RUC 20100521734)");
    out = await say("sí");
    expect(out).toContain("*LABOCER* no tiene dueño. ¿Qué guardo?");
  });

  it("con un proceso en pausa, el botón *Asignar y guardar* sigue siendo la respuesta (no el verbo «guardar» de la pausa)", async () => {
    expect(await say("nueva empresa")).toContain("¿Cuál es el *RUC*?");
    // un reporte en vez del RUC: el alta queda en pausa y sigue el reporte
    let out = await say("Visité Transportes Omega Sur, hablé con Carlos Quispe, jefe de flota");
    expect(out).toContain("*Reporte de visita* — TRANSPORTES OMEGA SUR");
    expect(out).toContain("Dejaste pendiente: alta de la empresa");
    expect(await say("sí")).toContain("no tiene dueño. ¿Qué guardo?");
    const n = client.texts().length;
    await bot.handle(button("asignármela", "Asignar y guardar"));
    out = since(n);
    expect(out).toContain("• Empresa asignada a ti");
    expect((await portal.getCompany(ids[RUC_OMEGA]))!.ownerUserId).toBe(frankId);
  });

  it("si otro vendedor la tomó mientras elegía: aviso claro y solo la nota", async () => {
    const juan = await portal.upsertUser({ nombre: "Juan Bustios", whatsapp: "51900000009", rol: "vendedor" });
    await say("Visité Transportes Omega Sur, hablé con Carlos Quispe, jefe de flota");
    await say("sí");
    await portal.setOwner(ids[RUC_OMEGA], juan.id); // la toma otro antes de que Frank pulse
    const out = await say("asignármela");
    expect(out).toContain("⚠️ *TRANSPORTES OMEGA SUR* acaba de quedar asignada a Juan Bustios: no pude asignártela. Guardé solo la actividad, sin oportunidad ni contacto.");
    expect((await portal.getCompany(ids[RUC_OMEGA]))!.ownerUserId).toBe(juan.id);
    expect(await portal.listOpportunities({ companyId: ids[RUC_OMEGA] })).toEqual([]);
  });
});
