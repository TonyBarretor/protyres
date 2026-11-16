/**
 * Procesos en pausa y precedencia del enrutador (corrida D, puntos 4 y 7), por el BotHandler con el WhatsApp de pruebas.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PriceRow } from "../../ingest/types";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient, type OutboundMessage } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import { parseWebhook, type InboundMessage } from "../../whatsapp/webhook";
import { JsonPortalStore } from "../store";
import type { PortalUser } from "../store/types";
import { buildDailyDigest } from "../notify/daily";
import { configureOrderBot, type OcStep } from "./commands/oc";
import { overLimit } from "./pause";
import { processSteps } from "./progress";
import { configureReportBot } from "./report";
import { classifyIntent, routeIntent } from "./router";
import { getPending, pausedOf, setPending, type PausedProcess, type PortalConvState } from "./state";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
});

const FRANK = "51900000001";
/** Empresas inventadas. */
const RUC_ZETA = "20999000055";
const RUC_ROCA = "20999000044";
const TODAY = "2026-11-11";

const ROWS: PriceRow[] = [
  { id: "own-valor87", provider: "360 Tyres", kind: "own", description: "295/80R22.5 FENIXWAY VALOR 87", brand: "Fenixway", model: "Valor 87", size: "295/80R22.5", sizeDisplay: "295/80R22.5", sizeRaw: "295/80R22.5", isTyre: true, ply: 18, cost: 472, priceIncludesTax: true, currency: "USD", stock: null, priceDate: TODAY, source: "excel", sourceRef: "t.xlsx" },
];

let seq = 0;
let client: FakeWhatsAppClient;
let prices: JsonStore;
let portal: JsonPortalStore;
let bot: BotHandler;
let frank: PortalUser;
let ids: Record<string, number>;
const saved: Record<string, string | undefined> = {};

const textMsg = (body: string): InboundMessage => ({ id: `wamid.p${++seq}`, from: FRANK, timestamp: "1", type: "text", text: body, forwarded: false });

/** Pulsa el botón `title` del último interactivo (webhook real, id `pt:…`). */
function press(title: string): InboundMessage {
  const last = client.interactives().at(-1);
  if (!last) throw new Error("no hubo interactivo");
  const hit = last.type === "button" ? last.buttons.find((b) => b.title === title) : last.sections.flatMap((s) => s.rows).find((r) => r.title === title);
  if (!hit) throw new Error(`no hay botón ${title}`);
  const interactive = last.type === "button" ? { type: "button_reply", button_reply: { id: hit.id, title: hit.title } } : { type: "list_reply", list_reply: { id: hit.id, title: hit.title } };
  const payload = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { messages: [{ id: `wamid.p${++seq}`, from: FRANK, timestamp: "1", type: "interactive", interactive }] } }] }] };
  return parseWebhook(payload).messages[0];
}

/** Pulsa un botón por su id (sin el prefijo `pt:`), como si viniera de un recordatorio anterior. */
function pressId(id: string, title = id): InboundMessage {
  const interactive = { type: "button_reply", button_reply: { id: `pt:${id}`, title } };
  const payload = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { messages: [{ id: `wamid.p${++seq}`, from: FRANK, timestamp: "1", type: "interactive", interactive }] } }] }] };
  return parseWebhook(payload).messages[0];
}

async function say(m: InboundMessage | string): Promise<OutboundMessage[]> {
  const before = client.sent.length;
  await bot.handle(typeof m === "string" ? textMsg(m) : m);
  return client.sent.slice(before);
}
const bodies = (out: OutboundMessage[]) => out.filter((m) => m.kind === "text" || m.kind === "interactive").map((m) => m.body ?? "");
const all = (out: OutboundMessage[]) => bodies(out).join("\n---\n");
const lastOut = (out: OutboundMessage[]) => out.filter((m) => m.kind === "text" || m.kind === "interactive").at(-1);
const lastBody = (out: OutboundMessage[]) => lastOut(out)?.body ?? "";
const paused = async () => pausedOf(await portal.getPortalConversation(FRANK));
/** Reglas del enrutador registradas en `messages` (filas kind "route"), en orden. */
const rules = async () => (await prices.listMessages(FRANK, 500)).filter((m) => m.kind === "route").map((m) => m.routeRule);
const ORDER_TO_FECHA = ["Av. Industrial 300, Lurín", "la misma", "Pedro Soto 999888777", "ninguna"];
// corrida H: + observaciones del despacho (pie de los bloques de stock / proveedor)
const ORDER_REST = ["20/11", "sí", "no", "cliente", "contado", "ninguna", "ninguna"];
/** `oc roca 7788` hasta la pregunta de la fecha de entrega. */
async function orderToFecha(): Promise<OcStep> {
  await say("oc roca 7788");
  await say("4 x Fenixway Valor 87 295/80R22.5");
  let out: OutboundMessage[] = [];
  for (const a of ORDER_TO_FECHA) out = await say(a);
  expect(lastBody(out)).toContain("Fecha de entrega?");
  return (await getPending(portal, FRANK, new Date())) as OcStep;
}

beforeEach(async () => {
  for (const k of ["PORTAL_SESSION_SECRET", "PORTAL_BASE_URL", "LLM_DISABLED", "PHOTOS_DISABLED", "DEEPGRAM_API_KEY"]) saved[k] = process.env[k];
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  process.env.PORTAL_BASE_URL = "https://portal.example.pe";
  process.env.LLM_DISABLED = "1";
  process.env.PHOTOS_DISABLED = "1";
  delete process.env.DEEPGRAM_API_KEY;
  client = new FakeWhatsAppClient();
  prices = JsonStore.memory();
  await prices.upsertRows(ROWS);
  portal = JsonPortalStore.memory();
  frank = await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  const r = await portal.upsertCompanies([
    { ruc: RUC_ZETA, razonSocial: "TRANSPORTES ZETA BUS S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 40, llantasPiso: 240 },
    { ruc: RUC_ROCA, razonSocial: "E.T. LA ROCA S.R.L.", sector: "carga", departamento: "LIMA", unidades: 15, llantasPiso: 150 },
  ]);
  ids = r.ids;
  for (const ruc of [RUC_ZETA, RUC_ROCA]) await portal.setOwner(ids[ruc], frank.id);
  const opp = await portal.createOpportunity({ companyId: ids[RUC_ZETA], ownerUserId: frank.id, etapa: "prospecto", createdBy: frank.id, at: new Date("2026-11-01T15:00:00Z") });
  await portal.moveStage(opp.id, "cita_agendada", frank.id, new Date("2026-11-05T15:00:00Z"));
  configureReportBot({ llm: null, logMessage: (e) => prices.logMessage(e) });
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

describe("punto 4: reporte pendiente de confirmar + cotización", () => {
  it("el borrador no se pierde ni se guarda; el cotizador responde y al final va el recordatorio con *Sí, guardar* / *Descartar*", async () => {
    await say("Visité Zeta Bus, me atendió el jefe de flota, todo bien");
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("report_draft");
    const out = await say("Fenixway Valor 87 295/80R22.5 x4");
    // el cotizador respondió normal (la cotización) y DESPUÉS el recordatorio
    expect(all(out)).toContain("Fenixway");
    const reminder = lastOut(out)!;
    expect(reminder.kind).toBe("interactive");
    expect(reminder.body).toContain("⏸ Dejaste pendiente: reporte de visita de TRANSPORTES ZETA BUS");
    expect(reminder.interactive).toMatchObject({ type: "button", buttons: [{ title: "Sí, guardar" }, { title: "Descartar" }] });
    // ni guardado ni perdido
    expect(await portal.listActivities({ companyId: ids[RUC_ZETA] })).toHaveLength(0);
    const conv = await portal.getPortalConversation(FRANK);
    expect(JSON.stringify(conv?.state)).toContain("report_draft");
    expect(await getPending(portal, FRANK, new Date())).toBeNull(); // no se queda capturando el "sí" del cotizador
    expect((await rules()).at(-1)).toBe("2_medida");

    // *Sí, guardar* guarda el reporte (aunque el cotizador siga con su cotización abierta) y termina con la línea de avance
    const saved = await say(press("Sí, guardar"));
    expect(lastBody(saved)).toContain("✔ Guardado: visita — *TRANSPORTES ZETA BUS*");
    expect(lastBody(saved)).toMatch(/\n✅ Paso 4 de 7 con TRANSPORTES ZETA BUS: visita reportada \(paso 2 omitido\)\. Sigue: enviar la cotización\.$/);
    expect(await portal.listActivities({ companyId: ids[RUC_ZETA] })).toHaveLength(1);
    expect(await paused()).toEqual([]);
  });

  it("*Descartar* lo dice y no guarda nada", async () => {
    await say("Visité Zeta Bus, me atendió el jefe de flota, todo bien");
    await say("Fenixway Valor 87 295/80R22.5 x4");
    const out = await say(press("Descartar"));
    expect(lastBody(out)).toBe("🗑 Descarté: reporte de visita de TRANSPORTES ZETA BUS. No guardé nada.");
    expect(await portal.listActivities({ companyId: ids[RUC_ZETA] })).toHaveLength(0);
    expect(await paused()).toEqual([]);
    // el botón ya no responde a nada
    expect(lastBody(await say(pressId("guardar 1", "Sí, guardar")))).toContain("Ese botón ya no está vigente");
  });
});

describe("precedencia del enrutador (P1-P5), caso por caso", () => {
  it("P1: palabra explícita al inicio -> cotización aunque haya una pregunta en curso; la cita pasa a pausa", async () => {
    await say("cita zeta bus");
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("cita_fecha");
    const out = await say("cotízame 4 llantas Fenixway Valor 87 295/80R22.5 para Transportes Beta");
    expect(all(out)).toContain("Cotización nueva");
    expect(lastBody(out)).toBe("⏸ Dejaste pendiente: cita con TRANSPORTES ZETA BUS (falta día y hora).");
    expect((await rules()).at(-1)).toBe("1_palabra");
    // puro: con o sin paso, y también en la fase de ítems de oc
    expect(routeIntent({ text: "cotiza 8 x Fenixway 315/80R22.5 a 254", state: "idle", isPortalUser: true, pendingPortalStep: { kind: "oc_pedido", captureText: true } })).toEqual({ intent: "quote", rule: "1_palabra" });
    expect(routeIntent({ text: "Cotízame, visité ZBUSS y quieren 4 llantas", state: "idle", isPortalUser: true })).toEqual({ intent: "quote", rule: "1_palabra" });
    expect(classifyIntent({ text: "cotización", state: "idle", isPortalUser: true, pendingPortalStep: { kind: "intent_choice" } })).toBe("portal_flow"); // la palabra sola responde la pregunta
  });

  it("P2: medida + cantidad/marca/precio -> cotización y el pedido en curso pasa a pausa (después de la respuesta del cotizador)", async () => {
    await orderToFecha();
    const out = await say("Fenixway Valor 87 295/80R22.5 x4 para Transportes Beta");
    const quoteAt = bodies(out).findIndex((b) => b.includes("Cotización nueva"));
    const reminderAt = bodies(out).findIndex((b) => b.startsWith("⏸"));
    expect(quoteAt).toBeGreaterThanOrEqual(0);
    expect(reminderAt).toBe(bodies(out).length - 1);
    expect(lastBody(out)).toBe("⏸ Dejaste pendiente: pedido de la OC 7788 de E.T. LA ROCA (falta fecha de entrega).");
    expect((await rules()).at(-1)).toBe("2_medida");
    const pure = (text: string) => routeIntent({ text, state: "idle", isPortalUser: true, pendingPortalStep: { kind: "cita_fecha" } }).rule;
    expect(["11R22.5 x10", "Michelin 215/75R17.5", "295/80R22.5 a 254", "295/80R22.5 precio 480"].map(pure)).toEqual(["2_medida", "2_medida", "2_medida", "2_medida"]);
  });

  it("P3: el mensaje encaja como respuesta a la pregunta (una fecha con números) -> respuesta", async () => {
    await say("cita zeta bus");
    const out = await say("15/12 10:00");
    expect(lastBody(out)).toContain("📅 Cita con *TRANSPORTES ZETA BUS S.A.C.*");
    expect((await rules()).at(-1)).toBe("3_respuesta");
    expect(await paused()).toEqual([]);
    // en las preguntas del pedido, "entrega: …" o "20 soles x llanta" siguen siendo respuesta
    const q = { kind: "oc_pedido", keepText: true };
    expect(routeIntent({ text: "360, 20 soles x llanta", state: "idle", isPortalUser: true, pendingPortalStep: q })).toEqual({ intent: "portal_flow", rule: "3_respuesta" });
  });

  it("P4: una medida sola con un reporte esperando (encaja en ambas) -> pregunta con dos botones; *Es mi respuesta* corrige el borrador", async () => {
    await say("Visité Zeta Bus, me atendió el jefe de flota, todo bien");
    const out = await say("295/80R22.5");
    const q = lastOut(out)!;
    expect(q.body).toContain("¿«295/80R22.5» es una *cotización nueva* o tu *respuesta*");
    expect(q.interactive).toMatchObject({ type: "button", buttons: [{ id: "pt:cotizacion nueva", title: "Cotización nueva" }, { id: "pt:es mi respuesta", title: "Es mi respuesta" }] });
    expect((await rules()).at(-1)).toBe("4_ambiguo");
    expect(all(out)).not.toContain("Cotización nueva ·"); // el cotizador no lo vio
    const answered = await say(press("Es mi respuesta"));
    expect(lastBody(answered)).toContain("*Reporte de visita* — TRANSPORTES ZETA BUS");
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("report_draft");
  });

  it("P4: *Cotización nueva* -> el cotizador lo cotiza y el reporte pasa a pausa", async () => {
    await say("Visité Zeta Bus, me atendió el jefe de flota, todo bien");
    expect(lastBody(await say("295/80R22.5 para Transportes Beta"))).toContain("*cotización nueva* o tu *respuesta*");
    const out = await say(press("Cotización nueva"));
    expect(all(out)).toContain("Cotización nueva · Transportes Beta"); // el cotizador lo cotizó como siempre
    expect(lastBody(out)).toBe("⏸ Dejaste pendiente: reporte de visita de TRANSPORTES ZETA BUS (falta confirmar).");
    expect((await paused()).map((p) => p.step.kind)).toEqual(["report_draft"]);
  });

  it("P5: no se entiende como respuesta -> lo dice y ofrece las dos opciones; nunca descarta el mensaje", async () => {
    await say(`contacto ${RUC_ROCA} jefe de flota 987654321`);
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("contacto_nombre");
    const out = await say("ok 123");
    expect(lastBody(out)).toContain("No entendí «ok 123» como respuesta a lo que te pregunté (contacto de E.T. LA ROCA: falta el nombre)");
    expect(lastOut(out)!.interactive).toMatchObject({ buttons: [{ title: "Cotización nueva" }, { title: "Es mi respuesta" }] });
    expect((await rules()).at(-1)).toBe("5_no_entendido");
    // *Es mi respuesta*: sigue sin ser un nombre -> lo dice y repite la pregunta (el paso sigue en pie)
    const again = await say(press("Es mi respuesta"));
    expect(lastBody(again)).toBe("No entendí «ok 123» como respuesta.\n\n¿Cómo se llama el contacto de *E.T. LA ROCA S.R.L.* (Jefe de flota · 987654321)? Escribe su nombre.");
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("contacto_nombre");
    const saved = await say("Carlos Quispe");
    expect(lastBody(saved)).toContain("✔ Contacto guardado en *E.T. LA ROCA S.R.L.*");
  });
});

describe("interrupción de un pedido con una cotización y reanudación", () => {
  it("el pedido pasa a pausa con lo respondido; *Continuar* repite la pregunta en curso y el pedido termina igual", async () => {
    const before = await orderToFecha();
    await say("Fenixway Valor 87 295/80R22.5 x4 para Transportes Beta");
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
    const [p] = await paused();
    expect(p).toMatchObject({ ref: "1", companyId: ids[RUC_ROCA], label: "pedido de la OC 7788 de E.T. LA ROCA", missing: "falta fecha de entrega" });
    // con la cotización a medio armar no se puede retomar todavía (las respuestas irían al cotizador)
    expect(lastBody(await say(pressId("continuar 1", "Continuar")))).toContain("termínala (p. ej. *ok*)");
    await say("ok"); // el cotizador guarda la cotización (revisión): ya se puede
    const out = await say(pressId("continuar 1", "Continuar"));
    expect(lastBody(out)).toBe("▶️ Retomo: pedido de la OC 7788 de E.T. LA ROCA.\n\n📅 Fecha de entrega? (p. ej. *20/11*, *viernes* o *48 h post OC*)");
    expect((await prices.getConversation(FRANK))?.step ?? "idle").toBe("idle");
    const step = (await getPending(portal, FRANK, new Date())) as OcStep;
    expect(step.orderId).toBe(before.orderId);
    expect(step.answers).toEqual(before.answers); // conserva lo respondido
    expect(step.items).toEqual(before.items);
    let last: OutboundMessage[] = [];
    for (const a of ORDER_REST) last = await say(a);
    expect(last.some((m) => m.kind === "document" && /^Pedido ATC/.test(m.fileName ?? ""))).toBe(true);
    expect(lastBody(last)).toContain("Entrega: ");
    expect(lastBody(last)).toContain("Av. Industrial 300, Lurín");
    expect(await paused()).toEqual([]);
    expect((await rules()).filter((r) => r === "reanudar")).toHaveLength(2);
  });

  it("`oc <RUC>` también lo retoma (como antes)", async () => {
    const before = await orderToFecha();
    await say("Fenixway Valor 87 295/80R22.5 x4 para Transportes Beta");
    await say("cancelar"); // cierra la cotización del cotizador; el pedido sigue en pausa
    expect(await paused()).toHaveLength(1);
    const out = await say(`oc ${RUC_ROCA}`);
    expect(lastBody(out)).toContain("▶️ Retomo el pedido de la OC *7788* de *E.T. LA ROCA*.");
    expect(((await getPending(portal, FRANK, new Date())) as OcStep).answers).toEqual(before.answers);
    expect(await paused()).toEqual([]);
  });
});

describe("orden de compra sin cotización previa", () => {
  it("el pedido termina con la línea de avance: paso 7 con el paso 5 omitido; `estado` lo muestra", async () => {
    const roca = ids[RUC_ROCA];
    await portal.addContact({ companyId: roca, nombre: "Rosa Díaz", cargo: "jefa de flota", telefono: "987654321" });
    const opp = await portal.createOpportunity({ companyId: roca, ownerUserId: frank.id, etapa: "prospecto", createdBy: frank.id });
    await portal.addAppointment({ companyId: roca, opportunityId: opp.id, userId: frank.id, startsAt: new Date("2026-11-10T15:00:00Z"), lugar: null, conTecnico: false, estado: "programada" });
    await portal.addActivity({ companyId: roca, opportunityId: opp.id, userId: frank.id, tipo: "visita", texto: "Visita", canal: "whatsapp", occurredAt: new Date("2026-11-10T15:00:00Z") });
    await say("oc roca 7788");
    await say("4 x Fenixway Valor 87 295/80R22.5");
    let out: OutboundMessage[] = [];
    for (const a of ["Av. Industrial 300, Lurín", "la misma", "igual", "ninguna", "20/11", "sí", "no", "cliente", "contado", "ninguna", "ninguna"]) out = await say(a);
    expect(out.some((m) => m.kind === "document")).toBe(true);
    expect(lastBody(out).split("\n").at(-1)).toBe("✅ Paso 7 de 7 con E.T. LA ROCA: pedido a Patricia generado (paso 5 omitido). Proceso completo.");
    const estado = lastBody(await say("estado roca"));
    expect(estado).toContain("📋 *Estado con E.T. LA ROCA*");
    expect(estado).toContain("✅ 4. Visita — hecho");
    expect(estado).toContain("⏭️ 5. Cotización — omitido");
    expect(estado).toContain("✅ 7. Pedido a Patricia — hecho");
    expect(estado).not.toContain("✅ Paso"); // consulta: sin línea de avance
    // proceso completo con una cita aún en agenda: no se presenta como "próxima acción"
    await portal.addAppointment({ companyId: roca, opportunityId: opp.id, userId: frank.id, startsAt: new Date("2026-12-01T15:00:00Z"), lugar: null, conTecnico: false, estado: "programada" });
    const done = lastBody(await say("estado roca"));
    expect(done).toContain("Proceso completo. Cita en agenda:");
    expect(done).not.toContain("Próxima acción");
  });

  it("processSteps (puro): sin hacer antes del último hecho = omitido; Cerrado ganado no implica la cotización", () => {
    const base = { owned: true, contacts: 1, appointments: 1, visits: 1, quotes: 0, orders: 1, pedidos: 1, opportunity: null };
    expect(processSteps(base).map((s) => s.state)).toEqual(["hecho", "hecho", "hecho", "hecho", "omitido", "hecho", "hecho"]);
    expect(processSteps({ ...base, orders: 0, pedidos: 0, visits: 0 }).map((s) => s.state)).toEqual(["hecho", "hecho", "hecho", "pendiente", "pendiente", "pendiente", "pendiente"]);
  });
});

describe("varios procesos en pausa", () => {
  it("dos empresas a la vez: los dos en `hoy`; cada uno se retoma por su referencia", async () => {
    await say("oc roca 7788");
    await say("4 x Fenixway Valor 87 295/80R22.5");
    let out = await say("cita zeta bus"); // un comando nuevo: el pedido pasa a pausa y se recuerda al final
    expect(bodies(out)[0]).toContain("¿Qué día y a qué hora es la cita con *TRANSPORTES ZETA BUS S.A.C.*?");
    expect(lastBody(out)).toBe("⏸ Dejaste pendiente: pedido de la OC 7788 de E.T. LA ROCA (falta la dirección fiscal).");
    out = await say("cotízame 4 llantas Fenixway Valor 87 295/80R22.5");
    expect(lastBody(out)).toBe("⏸ Dejaste pendiente: cita con TRANSPORTES ZETA BUS (falta día y hora).");
    expect((await paused()).map((p) => [p.ref, p.companyId])).toEqual([
      ["1", ids[RUC_ROCA]],
      ["2", ids[RUC_ZETA]],
    ]);
    const hoy = lastBody(await say("hoy"));
    expect(hoy).toContain("*En pausa*");
    expect(hoy).toContain("• *1.* pedido de la OC 7788 de E.T. LA ROCA (falta la dirección fiscal) · vence ");
    expect(hoy).toContain("• *2.* cita con TRANSPORTES ZETA BUS (falta día y hora) · vence ");
    expect(hoy).not.toContain("✅ Paso");
    await say("cancelar");
    out = await say("continuar 2");
    expect(lastBody(out)).toBe("▶️ Retomo: cita con TRANSPORTES ZETA BUS.\n\n¿Qué día y a qué hora es la cita con *TRANSPORTES ZETA BUS S.A.C.*? (p. ej. *martes 10am* o *15/11 9:00*)");
    out = await say("15/12 10:00");
    expect(lastBody(out)).toContain("📅 Cita con *TRANSPORTES ZETA BUS S.A.C.*");
    out = await say("continuar roca");
    expect(lastBody(out)).toContain("Dirección fiscal de *E.T. LA ROCA*?");
    expect(await paused()).toEqual([]);
  });

  it("límite: 1 por empresa -> pide resolver el más antiguo con sus botones (y no pierde ninguno)", async () => {
    await say("Visité Zeta Bus, me atendió el jefe de flota, todo bien");
    await say("cita zeta bus"); // el reporte pasa a pausa
    const out = await say("cotízame 4 llantas Fenixway Valor 87 295/80R22.5"); // la cita también: 2 con Zeta Bus
    const msg = lastOut(out)!;
    expect(msg.body).toBe(
      "⏸ Dejaste pendiente: cita con TRANSPORTES ZETA BUS (falta día y hora).\nTienes 2 procesos en pausa con la misma empresa (máximo 1). Resuelve primero el más antiguo: reporte de visita de TRANSPORTES ZETA BUS (falta confirmar).",
    );
    expect(msg.interactive).toMatchObject({ buttons: [{ id: "pt:guardar 1", title: "Sí, guardar" }, { id: "pt:descartar 1", title: "Descartar" }] });
    expect(await paused()).toHaveLength(2);
  });

  it("límite: 3 por vendedor (puro)", () => {
    const p = (ref: string, companyId: number | null): PausedProcess => ({ ref, step: { kind: "x", createdAt: "" }, companyId, label: `p${ref}`, missing: "falta algo", pausedAt: new Date().toISOString() });
    expect(overLimit([p("1", 1), p("2", 2), p("3", null)])).toBeNull();
    expect(overLimit([p("1", 1), p("2", 2), p("3", null), p("4", 4)])).toMatchObject({ oldest: { ref: "1" }, why: "Tienes 4 procesos en pausa (máximo 3)." });
    expect(overLimit([p("1", 1), p("2", 2), p("3", 1)])).toMatchObject({ oldest: { ref: "1" }, why: "Tienes 2 procesos en pausa con la misma empresa (máximo 1)." });
  });
});

describe("caducidad (48 h) con aviso", () => {
  async function age(hours: number) {
    const conv = await portal.getPortalConversation(FRANK);
    const st = conv!.state as PortalConvState;
    const old = new Date(Date.now() - hours * 3600_000).toISOString();
    await portal.setPortalConversation(FRANK, { ...st, paused: (st.paused ?? []).map((p) => ({ ...p, pausedAt: old })) });
  }

  it("a las 48 h se descarta avisando en el siguiente mensaje (la OC queda cancelada); antes, el resumen diario lo lista", async () => {
    await say("oc roca 7788");
    const step = (await getPending(portal, FRANK, new Date())) as OcStep;
    await say("proveedores"); // comando del cotizador: el pedido pasa a pausa
    await say("cancelar");
    expect(await paused()).toHaveLength(1);
    await age(47);
    const digest = await buildDailyDigest(portal, frank, new Date());
    expect(digest!.text).toContain("*En pausa en el bot*");
    expect(digest!.text).toContain("• pedido de la OC 7788 de E.T. LA ROCA (faltan los ítems) · vence ");
    expect(lastBody(await say("hoy"))).toContain("*En pausa*"); // a las 47 h sigue
    await age(49);
    expect((await buildDailyDigest(portal, frank, new Date()))!.text).toContain("• ⌛ pedido de la OC 7788 de E.T. LA ROCA: venció (48 h)");
    const out = await say("hoy");
    expect(bodies(out)[0]).toBe("⌛ Venció (48 h sin retomarlo) y lo descarté: pedido de la OC 7788 de E.T. LA ROCA (faltan los ítems). No guardé nada.");
    expect(lastBody(out)).not.toContain("*En pausa*");
    expect(await paused()).toEqual([]);
    expect((await portal.getPurchaseOrder(step.orderId))!.status).toBe("cancelada");
  });

  it("un paso pendiente que venció a las 2 h no se pierde: pasa a pausa y se recuerda", async () => {
    await say("cita zeta bus");
    const step = (await getPending(portal, FRANK, new Date()))!;
    await setPending(portal, FRANK, { ...step, createdAt: new Date(Date.now() - 3 * 3600_000).toISOString() }, new Date());
    const out = await say("hoy");
    expect(lastBody(out)).toBe("⏸ Dejaste pendiente: cita con TRANSPORTES ZETA BUS (falta día y hora).");
    expect((await paused()).map((p) => p.step.kind)).toEqual(["cita_fecha"]);
  });
});

describe("línea de avance: presente al completar un paso, ausente en consultas y en el cotizador", () => {
  it("contacto -> paso 2 con el botón *Agendar cita*; empresa / hoy / cotizador sin línea", async () => {
    const out = await say("contacto roca: Carlos Quispe, jefe de flota, 987654321");
    const msg = lastOut(out)!;
    expect(msg.body).toContain("✔ Contacto guardado en *E.T. LA ROCA S.R.L.*");
    expect(msg.body!.split("\n").at(-1)).toBe("✅ Paso 2 de 7 con E.T. LA ROCA: contacto registrado. Sigue: agendar la cita.");
    expect(msg.interactive).toMatchObject({ buttons: [{ id: `pt:cita ${RUC_ROCA}`, title: "Agendar cita" }] });
    // el botón pregunta el día y la hora de la cita
    expect(lastBody(await say(press("Agendar cita")))).toContain("¿Qué día y a qué hora es la cita con *E.T. LA ROCA S.R.L.*?");
    await say("cancelar");
    for (const q of ["empresa roca", "hoy", "avance", "Fenixway Valor 87 295/80R22.5 x4 para Transportes Beta"]) expect([q, all(await say(q)).includes("✅ Paso")]).toEqual([q, false]);
  });

  it("asignarme -> paso 1; `estado` con texto de más: los 7 pasos y la próxima acción con fecha", async () => {
    const r = await portal.upsertCompanies([{ ruc: "20999000099", razonSocial: "EXPRESO OMEGA S.A.C.", sector: "carga", departamento: "LIMA", unidades: 10, llantasPiso: 60 }]);
    const out = await say("asignarme expreso omega");
    expect(lastBody(out).split("\n").at(-1)).toBe("✅ Paso 1 de 7 con EXPRESO OMEGA: empresa asignada. Sigue: registrar un contacto.");
    expect(r.ids["20999000099"]).toBeTruthy();
    const opp = (await portal.getOpenOpportunity(ids[RUC_ZETA]))!;
    await portal.updateOpportunity(opp.id, { proximaAccion: "Visita", proximaAccionAt: new Date("2026-12-15T15:00:00Z") });
    const estado = lastBody(await say("estado zeta bus y dime qué sigue"));
    expect(estado.split("\n").slice(0, 9)).toEqual([
      "📋 *Estado con TRANSPORTES ZETA BUS*",
      "No usé: «y dime qué sigue».",
      "✅ 1. Asignada — hecho",
      "⏭️ 2. Contacto — omitido",
      "✅ 3. Cita — hecho",
      "⬜ 4. Visita — pendiente",
      "⬜ 5. Cotización — pendiente",
      "⬜ 6. Orden de compra — pendiente",
      "⬜ 7. Pedido a Patricia — pendiente",
    ]);
    expect(estado).toContain("Próxima acción: *Visita* — ");
  });
});

