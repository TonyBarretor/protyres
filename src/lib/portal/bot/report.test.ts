/**
 * Reportes por el bot (B3): voz (Deepgram simulado) -> transcripción en `messages` -> borrador (Anthropic simulado) ->
 * corrección -> `sí` -> actividad + etapa + próxima acción + contacto. También: sin clave de Deepgram, empresa ambigua
 * (lista numerada, reglas), `aprende`, y el `sí` del cotizador frente al borrador pendiente.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PriceRow } from "../../ingest/types";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import type { ConversationState } from "../../store/types";
import { FakeWhatsAppClient } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import type { InboundMessage } from "../../whatsapp/webhook";
import type { ExtractedReport, LlmClient } from "../report/extract";
import { JsonPortalStore } from "../store";
import { configureReportBot, REPORT_DISCARDED, VOICE_OFF } from "./report";
import { getPending, setPending } from "./state";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
});

const FRANK = "51900000001";
/** Empresas inventadas. */
const RUC_ZETA = "20999000055";
const RUC_ANDINO = "20999000066";
const RUC_ANDINO_CARGO = "20999000077";

let seq = 0;
const ts = (iso: string) => String(Math.floor(Date.parse(iso) / 1000));
const text = (body: string, at?: string): InboundMessage => ({ id: `wamid.r${++seq}`, from: FRANK, timestamp: at ? ts(at) : "1", type: "text", text: body, forwarded: false });
const audio = (mediaId: string, at: string): InboundMessage => ({ id: `wamid.r${++seq}`, from: FRANK, timestamp: ts(at), type: "audio", forwarded: false, media: { id: mediaId, mimeType: "audio/ogg; codecs=opus" } });

let client: FakeWhatsAppClient;
let prices: JsonStore;
let portal: JsonPortalStore;
let bot: BotHandler;
let frankId: number;
let ids: Record<string, number>;
const saved: Record<string, string | undefined> = {};

/** Anthropic simulado: devuelve en orden los reportes de la cola (como tool_use) y guarda lo que se le pidió. */
function fakeLlm(queue: ExtractedReport[]): LlmClient & { calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        const input = queue.shift();
        if (!input) throw new Error("cola del modelo vacía");
        return { content: [{ type: "tool_use", id: `tu_${calls.length}`, name: "registrar_reporte", input } as Anthropic.ToolUseBlock] };
      },
    },
  };
}

/** Deepgram simulado: responde `transcript` y guarda la URL (keyterms). */
function fakeDeepgram(transcript: string) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    expect((init?.headers as Record<string, string>).Authorization).toBe("Token dg-test-key");
    return new Response(JSON.stringify({ metadata: { duration: 9.5 }, results: { channels: [{ alternatives: [{ transcript, confidence: 0.94 }] }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

beforeEach(async () => {
  for (const k of ["PORTAL_SESSION_SECRET", "PORTAL_BASE_URL", "LLM_DISABLED", "DEEPGRAM_API_KEY"]) saved[k] = process.env[k];
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  process.env.PORTAL_BASE_URL = "https://portal.example.pe";
  process.env.LLM_DISABLED = "1";
  delete process.env.DEEPGRAM_API_KEY;
  client = new FakeWhatsAppClient();
  prices = JsonStore.memory();
  portal = JsonPortalStore.memory();
  frankId = (await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" })).id;
  const r = await portal.upsertCompanies([
    { ruc: RUC_ZETA, razonSocial: "TRANSPORTES ZETA BUS S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 40, llantasPiso: 240 },
    { ruc: RUC_ANDINO, razonSocial: "EXPRESO ANDINO S.A.C.", sector: "pasajeros", departamento: "CUSCO", unidades: 20, llantasPiso: 120 },
    { ruc: RUC_ANDINO_CARGO, razonSocial: "EXPRESO ANDINO CARGO S.A.C.", sector: "carga", departamento: "CUSCO", unidades: 25, llantasPiso: 250 },
  ]);
  ids = r.ids;
  for (const ruc of [RUC_ZETA, RUC_ANDINO, RUC_ANDINO_CARGO]) await portal.setOwner(ids[ruc], frankId);
  // Zeta Bus: asignada el 1/11 (Prospecto) y con cita agendada desde el 5/11
  const opp = await portal.createOpportunity({ companyId: ids[RUC_ZETA], ownerUserId: frankId, etapa: "prospecto", createdBy: frankId, at: new Date("2026-11-01T15:00:00Z") });
  await portal.moveStage(opp.id, "cita_agendada", frankId, new Date("2026-11-05T15:00:00Z"));
  configureReportBot({ llm: null, logMessage: (e) => prices.logMessage(e) });
  bot = new BotHandler({ client, store: prices, settings, portalStore: portal });
});

afterEach(() => {
  configureReportBot(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const texts = () => client.texts();
const last = () => texts().at(-1) ?? "";

const VISITA: ExtractedReport = {
  empresa: { nombre: "Zeta Bus", ruc: null },
  tipo: "visita",
  contacto: { nombre: "Carlos Quispe", cargo: "Jefe de flota" },
  interes: { medidas: ["295/80R22.5"], posicion: "direccional", cantidades: "40 buses", notas: "Quieren probar Fenixway" },
  proximaAccion: { texto: "Enviar cotización", fecha: "2026-11-12T10:00:00-05:00" },
  etapaSugerida: "visita_realizada",
  ocurrioEn: "2026-11-10T16:00:00-05:00",
  confianza: "alta",
  faltantes: [],
};

describe("reporte por voz con confirmación", () => {
  it("audio -> transcripción (en messages) -> borrador -> corrección -> sí -> actividad, etapa, próxima acción y contacto", async () => {
    process.env.DEEPGRAM_API_KEY = "dg-test-key";
    const said = "Visité Zeta Bus ayer a las cuatro, me atendió Carlos Quispe, jefe de flota. Usan 295/80R22.5 y quieren probar fenix way. Quedamos en enviar la cotización mañana a las diez.";
    const dg = fakeDeepgram(said);
    const llm = fakeLlm([VISITA, { ...VISITA, contacto: { nombre: "Luis Ramos", cargo: "Gerente general" } }]);
    configureReportBot({ llm, deepgramFetch: dg.fetchImpl, downloadMedia: (id) => client.downloadMedia(id), logMessage: (e) => prices.logMessage(e) });
    client.media.set("aud-1", { data: Buffer.from("OggS-fake-audio"), mimeType: "audio/ogg; codecs=opus" });

    await bot.handle(audio("aud-1", "2026-11-10T23:00:00Z"));
    const [heard, summary] = texts();
    expect(heard).toBe(`🎙️ Entendí: «${said}»`);
    expect(summary).toContain("*Reporte de visita* — TRANSPORTES ZETA BUS (RUC 20999000055)");
    expect(summary).toContain("• Contacto: Carlos Quispe — Jefe de flota");
    expect(summary).toContain("• Próxima acción: Enviar cotización");
    expect(summary).toMatch(/¿Está bien\? Responde \*sí\* o corrige$/);
    // keyterms: empresas del vendedor + términos fijos
    const url = decodeURIComponent(dg.urls[0].replace(/\+/g, " "));
    expect(url).toContain("model=nova-3");
    expect(url).toContain("keyterm=TRANSPORTES ZETA BUS");
    expect(url).toContain("keyterm=Fenixway");
    // el modelo recibió la transcripción con el vocabulario aplicado y las empresas del vendedor
    expect(JSON.stringify(llm.calls[0].messages)).toContain("quieren probar Fenixway");
    expect(String(llm.calls[0].system)).toContain("EXPRESO ANDINO CARGO S.A.C. (RUC 20999000077)");
    // transcripción en messages
    const logged = await prices.listMessages(FRANK, 20);
    expect(logged.find((m) => m.kind === "transcript")).toMatchObject({ direction: "in", body: said });
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("report_draft");

    await bot.handle(text("no, fue con el gerente, Luis Ramos"));
    expect(last()).toContain("• Contacto: Luis Ramos — Gerente general");
    expect(last()).toContain("¿Está bien? Responde *sí* o corrige");
    expect(JSON.stringify(llm.calls[1].messages)).toContain("no, fue con el gerente, Luis Ramos");

    const before = Date.now();
    await bot.handle(text("sí"));
    expect(last()).toContain("✔ Guardado: visita — *TRANSPORTES ZETA BUS*");
    expect(last()).toContain("• Etapa: Cita agendada → *Visita realizada*");
    expect(last()).toContain("• Contacto nuevo: Luis Ramos (Gerente general)");
    expect(last()).toContain("• Próxima acción: Enviar cotización — ");
    expect(await getPending(portal, FRANK, new Date())).toBeNull();

    const acts = await portal.listActivities({ companyId: ids[RUC_ZETA] });
    expect(acts).toHaveLength(1);
    const a = acts[0];
    expect(a).toMatchObject({ tipo: "visita", canal: "voz", userId: frankId });
    expect(a.occurredAt.toISOString()).toBe("2026-11-10T21:00:00.000Z"); // lo dicho ("ayer a las cuatro"), no la hora del audio
    expect(a.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(a.texto).toContain("Visita con Luis Ramos — Gerente general.");
    const opp = (await portal.getOpenOpportunity(ids[RUC_ZETA]))!;
    expect(a.opportunityId).toBe(opp.id);
    expect(opp.etapa).toBe("visita_realizada");
    expect(opp.proximaAccion).toBe("Enviar cotización");
    expect(opp.proximaAccionAt?.toISOString()).toBe("2026-11-12T15:00:00.000Z");
    const hist = await portal.stageHistory(opp.id);
    expect(hist.map((h) => h.etapa)).toEqual(["prospecto", "cita_agendada", "visita_realizada"]);
    expect(hist[2]).toMatchObject({ changedBy: frankId, enteredAt: new Date("2026-11-10T21:00:00Z") });
    expect(hist[1].leftAt).toEqual(new Date("2026-11-10T21:00:00Z"));
    expect((await portal.listContacts(ids[RUC_ZETA])).map((c) => c.nombre)).toEqual(["Luis Ramos"]);
  });

  it("sin DEEPGRAM_API_KEY: pide texto, no descarga ni deja borrador", async () => {
    let downloads = 0;
    configureReportBot({ llm: null, downloadMedia: async () => (downloads++, { data: Buffer.from("x"), mimeType: "audio/ogg" }), logMessage: (e) => prices.logMessage(e) });
    await bot.handle(audio("aud-2", "2026-11-11T14:00:00Z"));
    expect(texts()).toEqual([VOICE_OFF]);
    expect(downloads).toBe(0);
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
  });

  it("error de Deepgram: mensaje claro y pide texto", async () => {
    process.env.DEEPGRAM_API_KEY = "dg-test-key";
    const failing = (async () => new Response(JSON.stringify({ err_msg: "bad audio" }), { status: 400 })) as typeof fetch;
    configureReportBot({ llm: null, deepgramFetch: failing, downloadMedia: async () => ({ data: Buffer.from("x"), mimeType: "audio/ogg" }), logMessage: (e) => prices.logMessage(e) });
    await bot.handle(audio("aud-3", "2026-11-11T14:00:00Z"));
    expect(last()).toBe("No pude transcribir tu nota de voz. Escríbeme el reporte en texto, por favor.");
  });
});

describe("reporte por texto (reglas, sin modelo)", () => {
  it("empresa ambigua: pregunta con lista numerada; la respuesta elige y el sí guarda (oportunidad nueva)", async () => {
    await bot.handle(text("Llamé a Andino, el jefe de mantenimiento dice que lo visite el lunes", "2026-11-10T14:30:00Z"));
    expect(last()).toBe(`¿Con cuál empresa fue? Responde con el número:\n1. EXPRESO ANDINO CARGO (RUC ${RUC_ANDINO_CARGO})\n2. EXPRESO ANDINO (RUC ${RUC_ANDINO})`);
    await bot.handle(text("1"));
    expect(last()).toContain(`*Reporte de llamada* — EXPRESO ANDINO CARGO (RUC ${RUC_ANDINO_CARGO})`);
    expect(last()).toContain("¿Está bien? Responde *sí* o corrige");
    await bot.handle(text("sí"));
    expect(last()).toContain("✔ Guardado: llamada — *EXPRESO ANDINO CARGO*");
    expect(last()).toContain("• Oportunidad nueva en *Prospecto*");
    const acts = await portal.listActivities({ companyId: ids[RUC_ANDINO_CARGO] });
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ tipo: "llamada", canal: "whatsapp" });
    expect(acts[0].occurredAt.toISOString()).toBe("2026-11-10T14:30:00.000Z"); // hora del mensaje
    expect(await portal.getOpenOpportunity(ids[RUC_ANDINO_CARGO])).toMatchObject({ etapa: "prospecto", ownerUserId: frankId });
  });

  it("visita sin etapa sugerida mueve a Visita realizada; no retrocede nunca", async () => {
    await bot.handle(text("Visité Zeta Bus, todo bien", "2026-11-11T14:30:00Z"));
    expect(last()).toContain("*Reporte de visita* — TRANSPORTES ZETA BUS");
    await bot.handle(text("ok"));
    expect(last()).toContain("• Etapa: Cita agendada → *Visita realizada*");
    const opp = (await portal.getOpenOpportunity(ids[RUC_ZETA]))!;
    await portal.moveStage(opp.id, "negociacion", frankId);
    await bot.handle(text("Visité Zeta Bus otra vez"));
    await bot.handle(text("sí"));
    expect(last()).toContain("• Etapa: Negociación (sin cambio)");
    expect((await portal.getOpenOpportunity(ids[RUC_ZETA]))!.etapa).toBe("negociacion");
  });

  it("no descarta; un texto que no es sí/no corrige el borrador", async () => {
    await bot.handle(text("Visité Zeta Bus, me atendió el jefe de flota"));
    await bot.handle(text("fue una llamada"));
    expect(last()).toContain("*Reporte de llamada*");
    await bot.handle(text("no"));
    expect(last()).toBe(REPORT_DISCARDED);
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
    expect(await portal.listActivities({ companyId: ids[RUC_ZETA] })).toHaveLength(0);
  });

  it("aprende X = Y guarda el término y se aplica al siguiente reporte", async () => {
    await bot.handle(text("aprende zeta vus = Zeta Bus"));
    expect(last()).toBe("Aprendido: zeta vus = Zeta Bus");
    expect((await portal.listVocabulary()).map((v) => [v.term, v.meaning, v.addedBy])).toEqual([["zeta vus", "Zeta Bus", frankId]]);
    await bot.handle(text("Visité zeta vus, hablé con el gerente"));
    expect(last()).toContain("*Reporte de visita* — TRANSPORTES ZETA BUS");
  });
});

describe("el sí del cotizador y el borrador del reporte", () => {
  it("cotizador en idle: el sí va al borrador del portal", async () => {
    await bot.handle(text("Visité Zeta Bus, todo bien"));
    await bot.handle(text("sí"));
    expect(last()).toContain("✔ Guardado");
  });

  it("cotizador en review_quote: el sí va al cotizador y el borrador queda intacto", async () => {
    await bot.handle(text("Visité Zeta Bus, todo bien"));
    const pending = await getPending(portal, FRANK, new Date());
    expect(pending?.kind).toBe("report_draft");
    await prices.setConversation(FRANK, { phone: FRANK, step: "review_quote", updatedAt: new Date().toISOString() } as ConversationState);
    await bot.handle(text("sí"));
    expect(last()).not.toContain("✔ Guardado");
    expect(await portal.listActivities({ companyId: ids[RUC_ZETA] })).toHaveLength(0);
    expect(await getPending(portal, FRANK, new Date())).toEqual(pending);
  });

  it("un borrador del marcador anterior (sin draft) se interpreta al responder", async () => {
    await setPending(portal, FRANK, { kind: "report_draft", text: "Visité Zeta Bus", occurredAt: "2026-11-11T14:00:00.000Z", audio: null }, new Date());
    await bot.handle(text("sí"));
    expect(last()).toContain("*Reporte de visita* — TRANSPORTES ZETA BUS");
  });
});

describe("revisión B: nota de voz con el cotizador a mitad de flujo", () => {
  const STRANGER = "51911111111";
  const ROWS: PriceRow[] = [
    { id: "own-valor87", provider: "360 Tyres", kind: "own", description: "295/80R22.5 FENIXWAY VALOR 87", brand: "Fenixway", model: "Valor 87", size: "295/80R22.5", sizeDisplay: "295/80R22.5", sizeRaw: "295/80R22.5", isTyre: true, ply: 18, cost: 472, priceIncludesTax: true, currency: "USD", stock: null, priceDate: "2026-11-10", source: "excel", sourceRef: "t.xlsx" },
  ];
  const as = (from: string, m: InboundMessage): InboundMessage => ({ ...m, from });
  /** Pedido -> ok (review_quote) -> nota de voz -> sí, desde `from`; las respuestas de cada paso (sin el número de cotización). */
  async function run(from: string): Promise<string[][]> {
    const steps: InboundMessage[] = [text("Fenixway Valor 87 295/80R22.5 x4 para Transportes Beta, compras@beta.pe"), text("ok"), audio("aud-rq", "2026-11-11T15:00:00Z"), text("sí")];
    const out: string[][] = [];
    for (const m of steps) {
      const before = client.sent.length;
      await bot.handle(as(from, m));
      out.push(client.sent.slice(before).map((s) => `${s.kind}:${"body" in s ? (s.body ?? "") : ""}${s.fileName ?? ""}`.replace(/COT-\d+/g, "COT-N")));
    }
    return out;
  }

  it("cotización en review_quote -> audio -> sí: el cotizador responde como a cualquier número; el portal no arma borrador", async () => {
    process.env.DEEPGRAM_API_KEY = "dg-test-key";
    const dg = fakeDeepgram("Visité Zeta Bus, me atendió el jefe de flota, quedamos en llamar el lunes");
    configureReportBot({ llm: null, deepgramFetch: dg.fetchImpl, downloadMedia: (id) => client.downloadMedia(id), logMessage: (e) => prices.logMessage(e) });
    client.media.set("aud-rq", { data: Buffer.from("OggS"), mimeType: "audio/ogg" });
    await prices.upsertRows(ROWS);

    const stranger = await run(STRANGER);
    const frank = await run(FRANK);
    expect((await prices.getConversation(STRANGER))?.step ?? "idle").toBe((await prices.getConversation(FRANK))?.step ?? "idle");
    // desde la nota de voz, mismas respuestas que un número que no es del portal
    expect(frank.slice(2)).toEqual(stranger.slice(2));
    expect(frank.flat().join("\n")).not.toContain("🎙️ Entendí");
    expect(frank.flat().join("\n")).not.toContain("Reporte de visita");
    expect(dg.urls).toHaveLength(0); // ni siquiera se transcribió
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
    expect(await portal.listActivities({ companyId: ids[RUC_ZETA] })).toHaveLength(0);
  });
});

describe("revisión B: reporte sobre una empresa de otro vendedor", () => {
  it("guarda solo la actividad, no toca su oportunidad y dice de quién es", async () => {
    const juan = await portal.upsertUser({ nombre: "Juan Bustios", whatsapp: "51900000009", rol: "vendedor" });
    await portal.setOwner(ids[RUC_ZETA], juan.id);
    const opp = (await portal.getOpenOpportunity(ids[RUC_ZETA]))!;
    await bot.handle(text("Visité Zeta Bus, me atendió el jefe de flota", "2026-11-11T14:30:00Z"));
    expect(last()).toContain("*Reporte de visita* — TRANSPORTES ZETA BUS");
    await bot.handle(text("sí"));
    expect(last()).toContain("✔ Guardado: visita — *TRANSPORTES ZETA BUS*");
    expect(last()).toContain("La empresa es de Juan Bustios: guardé la actividad sin mover su oportunidad.");
    const after = (await portal.getOpportunity(opp.id))!;
    expect(after.etapa).toBe("cita_agendada"); // no avanzó a Visita realizada
    expect(await portal.listOpportunities({ companyId: ids[RUC_ZETA] })).toHaveLength(1);
    const acts = await portal.listActivities({ companyId: ids[RUC_ZETA] });
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ tipo: "visita", opportunityId: null, userId: frankId });
  });

  it("empresa sin dueño: no crea oportunidad y pide asignársela", async () => {
    const c = await portal.upsertCompanies([{ ruc: "20999000088", razonSocial: "TRANSPORTES OMEGA SUR S.A.C.", sector: "carga", departamento: "LIMA", unidades: 30, llantasPiso: 300 }]);
    const id = c.ids["20999000088"];
    await bot.handle(text("Visité Transportes Omega Sur, todo bien"));
    expect(last()).toContain("TRANSPORTES OMEGA SUR");
    await bot.handle(text("sí"));
    expect(last()).toContain("La empresa no tiene dueño (*asignarme 20999000088* para tomarla): guardé la actividad sin mover su oportunidad.");
    expect(await portal.listOpportunities({ companyId: id })).toHaveLength(0);
    expect(await portal.listActivities({ companyId: id })).toHaveLength(1);
  });
});
