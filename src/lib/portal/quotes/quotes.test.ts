import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ingestExcel } from "../../ingest/tabular";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import type { InboundMessage } from "../../whatsapp/webhook";
import { JsonPortalStore } from "../store";
import type { Activity, Opportunity, PortalStore, PortalUser } from "../store/types";
import { confirmQuoteLink, LINK_STATE_KEY, markQuoteForwarded, quoteNumberMatches, setCompanyCreditTerms, shortQuoteNumber } from "./link";
import { businessDaysBetween, followUpMessage, quoteFollowUpsFor, recordQuoteFollowUp, selectQuoteFollowUps } from "./reminders";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7, paymentType: "Factura crédito", paymentTerm: "30 días" },
  salespeople: { default: "51955344340", "51955344340": { name: "Frank Melek Rodríguez Mirano", title: "Key Account Manager", phone: "955 344 340", email: "frank.rodriguez@360tyres.pe" } },
});

const FRANK = "51955344340";
const RUC_ANDES = "20999000011";
const RUC_OTRA = "20999000022";

let rows: Awaited<ReturnType<typeof ingestExcel>>["rows"];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ["LLM_DISABLED", "PHOTOS_DISABLED", "RESEND_API_KEY", "EMAIL_REDIRECT_TO"]) saved[k] = process.env[k];
  process.env.LLM_DISABLED = "1";
  process.env.PHOTOS_DISABLED = "1";
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_REDIRECT_TO;
  rows = (await ingestExcel(fs.readFileSync(path.resolve(process.cwd(), "samples/proveedor-a-lista.xlsx")), { provider: "Llantas del Sur", sourceRef: "a.xlsx", priceDate: "2026-10-01" })).rows;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface Harness {
  bot: BotHandler;
  client: FakeWhatsAppClient;
  emails: string[];
  logs: string[];
  say(text: string): Promise<string[]>;
}

async function harness(portal: PortalStore): Promise<Harness> {
  const store = JsonStore.memory();
  await store.upsertRows(rows);
  const client = new FakeWhatsAppClient();
  const emails: string[] = [];
  const logs: string[] = [];
  const bot = new BotHandler({
    client,
    store,
    settings,
    portalStore: portal,
    log: (m) => logs.push(m),
    sendEmail: async (quote, _att, draft) => {
      emails.push(`${quote.number} -> ${draft.to}`);
      return { sent: true, id: "test" };
    },
  });
  let n = 0;
  const say = async (text: string) => {
    const before = client.sent.length;
    const msg: InboundMessage = { id: `wamid.b4.${++n}`, from: FRANK, timestamp: "1", type: "text", text, forwarded: false };
    await bot.handle(msg);
    return client.sent.slice(before).map((m) => (m.kind === "text" ? m.body! : `[${m.kind}] ${m.fileName}`));
  };
  return { bot, client, emails, logs, say };
}

let portal: JsonPortalStore;
let frank: PortalUser;
let andesId: number;

async function seedPortal(opts: { user?: boolean } = {}): Promise<void> {
  portal = JsonPortalStore.memory();
  if (opts.user !== false) frank = await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  const r = await portal.upsertCompanies([
    { ruc: RUC_ANDES, razonSocial: "TRANSPORTES ANDES DEL PERU S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 12, llantasPiso: 72 },
    { ruc: RUC_OTRA, razonSocial: "EMPRESA COSTA NORTE E.I.R.L.", sector: "carga", departamento: "PIURA", unidades: 30, llantasPiso: 300 },
  ]);
  andesId = r.ids[RUC_ANDES];
}

const REQ_RUC = `Michelin 11R22.5 XZE2+ x4 para Transportes Andes del Peru SAC, juan@andes.com\nRUC ${RUC_ANDES}`;
const WARN_SIN_EVALUAR = "⚠️ Crédito de *TRANSPORTES ANDES DEL PERU*: sin evaluar. Antes de dar plazo, evalúalo en la ficha del portal.";
const REQ_NAME = "Michelin 11R22.5 XZE2+ x4 para Transportes Andes del Peru SAC, juan@andes.com";

function ctxFor(store: PortalStore, user: PortalUser, now = new Date()) {
  const replies: string[] = [];
  return { replies, ctx: { store, user, from: FRANK, reply: async (b: string) => void replies.push(b), now, log: () => undefined } };
}

async function quoteActs(store: PortalStore, tipo: string): Promise<Activity[]> {
  return (await store.listActivities({ companyId: andesId })).filter((a) => a.tipo === tipo);
}

describe("cotización enlazada", () => {
  beforeEach(async () => {
    await seedPortal();
  });

  it("RUC exacto en el pedido: enlaza directo, crea la oportunidad (dueño = vendedor) y avisa después del cotizador", async () => {
    const h = await harness(portal);
    await h.say(REQ_RUC);
    const out = await h.say("ok");
    // sin fila de crédito = sin evaluar: el mismo mensaje del portal suma el aviso (C4)
    expect(out.at(-1)).toBe(`🔗 Cotización *0001* enlazada a *TRANSPORTES ANDES DEL PERU S.A.C.* en el portal (Prospecto).\n${WARN_SIN_EVALUAR}`);
    expect(out.slice(0, -1).some((m) => m.startsWith("[document]"))).toBe(true);
    const opp = (await portal.getOpenOpportunity(andesId, frank.id))!;
    expect(opp).toMatchObject({ ownerUserId: frank.id, quoteNumber: "COT-0001", etapa: "prospecto" });
    const [act] = await quoteActs(portal, "cotizacion");
    expect(act).toMatchObject({ userId: frank.id, opportunityId: opp.id, canal: "whatsapp" });
    expect(act.texto).toMatch(/^Cotización COT-0001 · US\$ [\d,.]+ · 4 × 11R22\.5 Michelin XZE2\+/);
    expect(act.data).toMatchObject({ quoteNumber: "COT-0001", items: 1, customerEmail: "juan@andes.com", via: "ruc" });

    // presentar de nuevo la misma cotización (precio cambiado) no duplica el enlace ni el aviso
    const again = await h.say("precio 480");
    expect(again.some((m) => m.includes("🔗"))).toBe(false);
    expect(await quoteActs(portal, "cotizacion")).toHaveLength(1);
  });

  it("aviso de crédito en el mensaje de enlace: rechazado -> ⛔; aprobado o en evaluación -> sin aviso", async () => {
    await portal.saveCredit(andesId, { estado: "rechazado", notas: "deuda vencida" }, null);
    let h = await harness(portal);
    await h.say(REQ_RUC);
    let out = await h.say("ok");
    expect(out.at(-1)).toBe(
      "🔗 Cotización *0001* enlazada a *TRANSPORTES ANDES DEL PERU S.A.C.* en el portal (Prospecto).\n⛔ Crédito RECHAZADO para *TRANSPORTES ANDES DEL PERU*: no ofrezcas plazo sin revisar la ficha del portal.",
    );

    for (const estado of ["aprobado", "en_evaluacion"] as const) {
      await seedPortal();
      await portal.saveCredit(andesId, { estado, linea: 50000, moneda: "USD", plazoDias: 45 }, null);
      h = await harness(portal);
      await h.say(REQ_RUC);
      out = await h.say("ok");
      expect(out.at(-1)).toBe("🔗 Cotización *0001* enlazada a *TRANSPORTES ANDES DEL PERU S.A.C.* en el portal (Prospecto).");
    }
  });

  it("enviar (correo) mueve a Cotización enviada y registra cotizacion_enviada una sola vez", async () => {
    const h = await harness(portal);
    await h.say(REQ_RUC);
    await h.say("ok");
    const out = await h.say("enviar");
    expect(out).toEqual([expect.stringMatching(/^Enviado ✔ Cotización COT-0001 a juan@andes\.com/)]);
    const opp = (await portal.getOpenOpportunity(andesId, frank.id))!;
    expect(opp.etapa).toBe("cotizacion_enviada");
    const sent = await quoteActs(portal, "cotizacion_enviada");
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toMatchObject({ quoteNumber: "COT-0001", via: "correo" });

    // reenviada después: ya estaba enviada, no duplica
    const { ctx, replies } = ctxFor(portal, frank);
    expect(await markQuoteForwarded(ctx, "1")).toBe(true);
    expect(replies[0]).toMatch(/ya estaba registrada como enviada \(Cotización enviada\)/);
    expect(await quoteActs(portal, "cotizacion_enviada")).toHaveLength(1);
  });

  it("enviar no hace retroceder una oportunidad que ya estaba más adelante", async () => {
    const opp = await portal.createOpportunity({ companyId: andesId, ownerUserId: frank.id, etapa: "negociacion" });
    const h = await harness(portal);
    await h.say(REQ_RUC);
    await h.say("ok");
    await h.say("enviar");
    const after = (await portal.getOpportunity(opp.id))!;
    expect(after.etapa).toBe("negociacion");
    expect(after.quoteNumber).toBe("COT-0001");
    expect(await quoteActs(portal, "cotizacion_enviada")).toHaveLength(1);
  });

  it("por nombre: pregunta aparte y enlaza con *enlazar*; el próximo pedido del mismo cliente se enlaza directo", async () => {
    const h = await harness(portal);
    await h.say(REQ_NAME);
    const out = await h.say("ok");
    expect(out.at(-1)).toBe(`¿La cotización *0001* es para *TRANSPORTES ANDES DEL PERU S.A.C.* (RUC ${RUC_ANDES}) del portal? Responde *enlazar* o ignóralo.`);
    expect(await portal.getOpenOpportunity(andesId)).toBeNull();
    const conv = await portal.getPortalConversation(FRANK);
    expect(conv?.state[LINK_STATE_KEY]).toMatchObject({ kind: "link_quote", quoteNumber: "COT-0001", companyId: andesId });
    expect(conv?.state.pending).toBeUndefined(); // no pisa otra pregunta del bot

    // volver a presentarla no repite la pregunta
    expect((await h.say("precio 480")).some((m) => m.includes("enlazar"))).toBe(false);

    const { ctx, replies } = ctxFor(portal, frank);
    expect(await confirmQuoteLink(ctx, "")).toBe(true);
    expect(replies).toEqual([`🔗 Listo: cotización *0001* enlazada a *TRANSPORTES ANDES DEL PERU S.A.C.* (Prospecto).\n${WARN_SIN_EVALUAR}`]);
    expect((await portal.getOpenOpportunity(andesId, frank.id))?.quoteNumber).toBe("COT-0001");
    expect((await portal.getPortalConversation(FRANK))?.state?.[LINK_STATE_KEY]).toBeUndefined();
    expect(await confirmQuoteLink(ctx, "")).toBe(false); // ya no hay propuesta

    await h.say("cancelar");
    await h.say("Michelin 11R22.5 XZE2+ x2 para Transportes Andes del Peru SAC, juan@andes.com");
    const second = await h.say("ok");
    expect(second.at(-1)).toMatch(/^🔗 Cotización \*0002\* enlazada a \*TRANSPORTES ANDES DEL PERU S\.A\.C\.\*/);
    expect((await portal.getOpenOpportunity(andesId, frank.id))?.quoteNumber).toBe("COT-0002");
  });

  it("enlazar con otro número no enlaza; la propuesta vence a las 2 horas", async () => {
    const h = await harness(portal);
    await h.say(REQ_NAME);
    await h.say("ok");
    const { ctx, replies } = ctxFor(portal, frank);
    expect(await confirmQuoteLink(ctx, "7")).toBe(false);
    expect(replies[0]).toMatch(/es la \*0001\*/);
    const late = ctxFor(portal, frank, new Date(Date.now() + 3 * 60 * 60 * 1000));
    expect(await confirmQuoteLink(late.ctx, "")).toBe(false);
    expect(await portal.getOpenOpportunity(andesId)).toBeNull();
  });

  it("reenviada 032: marca enviada por WhatsApp y mueve la etapa", async () => {
    const h = await harness(portal);
    await h.say(REQ_RUC);
    await h.say("ok");
    const { ctx, replies } = ctxFor(portal, frank);
    expect(await markQuoteForwarded(ctx, "la cotización 001")).toBe(true);
    expect(replies[0]).toBe("📤 Cotización *0001* de *TRANSPORTES ANDES DEL PERU* registrada como enviada (Cotización enviada).");
    expect((await portal.getOpenOpportunity(andesId, frank.id))?.etapa).toBe("cotizacion_enviada");
    expect((await quoteActs(portal, "cotizacion_enviada"))[0].data).toMatchObject({ via: "whatsapp" });
    expect(await markQuoteForwarded(ctx, "999")).toBe(false);
    expect(replies[1]).toMatch(/No encuentro la cotización \*999\*/);
  });

  it("sin usuario del portal, con el store caído o sin empresa: mismas salidas que sin portal", async () => {
    const script = [REQ_RUC, "ok", "enviar", REQ_NAME, "ok"];
    const run = async (store: PortalStore) => {
      const h = await harness(store);
      const out: string[][] = [];
      for (const t of script) out.push(await h.say(t));
      return { out, emails: h.emails, logs: h.logs };
    };
    const baseline = await run(JsonPortalStore.memory());
    await seedPortal({ user: false });
    const noUser = await run(portal);
    const down = new Proxy({} as PortalStore, { get: () => () => Promise.reject(new Error("db caída")) });
    const broken = await run(down);
    const empty = JsonPortalStore.memory();
    await empty.upsertUser({ nombre: "Frank", whatsapp: FRANK, rol: "vendedor" });
    const noCompany = await run(empty);
    expect(noUser.out).toEqual(baseline.out);
    expect(broken.out).toEqual(baseline.out);
    expect(noCompany.out).toEqual(baseline.out);
    expect(broken.emails).toEqual(baseline.emails);
    expect(broken.logs.some((l) => l.includes("db caída"))).toBe(true);
    expect(await portal.listOpportunities()).toEqual([]);
    expect(baseline.out[0].join("\n")).toContain("Plazo 30 días por defecto");
  });
});

describe("condiciones de crédito por empresa", () => {
  beforeEach(async () => {
    await seedPortal();
    await setCompanyCreditTerms(portal, andesId, 45);
  });

  it("setCompanyCreditTerms valida y guarda", async () => {
    expect((await portal.getCompany(andesId))?.creditTermsDays).toBe(45);
    await expect(setCompanyCreditTerms(portal, andesId, 4.5)).rejects.toThrow(/inválido/);
    expect((await setCompanyCreditTerms(portal, andesId, null))?.creditTermsDays).toBeNull();
  });

  it("RUC con plazo en el portal: 45 días en vez de 30, con aviso", async () => {
    const h = await harness(portal);
    const opts = (await h.say(REQ_RUC)).join("\n");
    expect(opts).toContain("📒 plazo 45 días (condiciones de *TRANSPORTES ANDES DEL PERU S.A.C.* en el portal)");
    expect(opts).not.toContain("por defecto");
    const quote = (await h.say("ok")).join("\n");
    expect(quote).toContain("Plazo: 45 días");
  });

  it("lo escrito en el pedido gana", async () => {
    const h = await harness(portal);
    const opts = (await h.say(`${REQ_RUC}\nplazo: 60 días`)).join("\n");
    expect(opts).not.toContain("en el portal");
    expect((await h.say("ok")).join("\n")).toContain("Plazo: 60 días");
  });

  it("la memoria del cliente gana; sin RUC ni enlace previo queda el de la config", async () => {
    const h = await harness(portal);
    // sin RUC y sin enlace previo: config (30 días)
    expect((await h.say(REQ_NAME)).join("\n")).toContain("Plazo 30 días por defecto");
    await h.say("cancelar");
    // pedido con plazo propio: queda en la memoria del cliente
    await h.say(`${REQ_NAME}\nplazo: 15 días`);
    await h.say("ok");
    await h.say("cancelar");
    const opts = (await h.say(`Michelin 11R22.5 XZE2+ x2, juan@andes.com\nRUC ${RUC_ANDES}`)).join("\n");
    expect(opts).toContain("plazo 15 días");
    expect(opts).not.toContain("en el portal");
  });

  it("cliente enlazado antes (sin RUC en el pedido): usa el plazo de su empresa", async () => {
    const h = await harness(portal);
    await setCompanyCreditTerms(portal, andesId, null);
    await h.say(REQ_RUC.replace("x4", "x1"));
    await h.say("ok"); // enlaza (RUC); sin plazo en el portal todavía -> 30 días
    await h.say("cancelar");
    await setCompanyCreditTerms(portal, andesId, 45);
    const opts = (await h.say("Michelin 11R22.5 XZE2+ x2 para Transportes Andes del Peru SAC")).join("\n");
    expect(opts).toContain("📒 plazo 45 días (condiciones de *TRANSPORTES ANDES DEL PERU S.A.C.* en el portal)");
  });
});

describe("días hábiles", () => {
  const d = (iso: string) => new Date(iso);
  it("lunes a jueves = 3; mismo día = 0; hacia atrás = 0", () => {
    expect(businessDaysBetween(d("2026-11-09T15:00:00Z"), d("2026-11-12T15:00:00Z"))).toBe(3);
    expect(businessDaysBetween(d("2026-11-09T15:00:00Z"), d("2026-11-09T23:00:00Z"))).toBe(0);
    expect(businessDaysBetween(d("2026-11-12T15:00:00Z"), d("2026-11-09T15:00:00Z"))).toBe(0);
  });
  it("el fin de semana no cuenta: viernes -> miércoles = 3, viernes -> lunes = 1", () => {
    expect(businessDaysBetween(d("2026-11-13T15:00:00Z"), d("2026-11-18T15:00:00Z"))).toBe(3);
    expect(businessDaysBetween(d("2026-11-13T15:00:00Z"), d("2026-11-16T15:00:00Z"))).toBe(1);
    expect(businessDaysBetween(d("2026-11-13T15:00:00Z"), d("2026-11-15T15:00:00Z"))).toBe(0);
  });
  it("feriado no cuenta", () => {
    expect(businessDaysBetween(d("2026-12-07T15:00:00Z"), d("2026-12-10T15:00:00Z"), ["2026-12-08"])).toBe(2);
  });
  it("fechas en hora de Lima: el domingo 23:00 Lima ya es lunes UTC pero sigue siendo domingo", () => {
    // domingo 15/11 23:00 Lima = lunes 16/11 04:00 UTC -> jueves 19/11 = lun, mar, mié, jue = 4
    expect(businessDaysBetween(d("2026-11-16T04:00:00Z"), d("2026-11-19T15:00:00Z"))).toBe(4);
  });
});

describe("recordatorio de cotización sin respuesta", () => {
  const at = (iso: string) => new Date(iso);
  const opp = (o: Partial<Opportunity> = {}): Opportunity => ({
    id: 1,
    companyId: 10,
    ownerUserId: 5,
    etapa: "cotizacion_enviada",
    probabilidad: 50,
    montoEstimado: null,
    cierreEsperado: null,
    proximaAccion: null,
    proximaAccionAt: null,
    quoteNumber: "COT-0032",
    createdAt: at("2026-11-01T15:00:00Z"),
    updatedAt: at("2026-11-09T15:00:00Z"),
    closedAt: null,
    ...o,
  });
  let nid = 0;
  const act = (tipo: string, when: string, data: Record<string, unknown> | null = { quoteNumber: "COT-0032" }, companyId = 10): Activity => ({ id: ++nid, companyId, opportunityId: 1, userId: 5, tipo, texto: "", canal: "whatsapp", data, occurredAt: at(when), createdAt: at(when) });
  const base = [act("cotizacion", "2026-11-09T15:00:00Z"), act("cotizacion_enviada", "2026-11-09T16:00:00Z")];
  const sel = (o: { opportunities?: Opportunity[]; activities?: Activity[]; now?: string; holidays?: string[] } = {}) =>
    selectQuoteFollowUps({ opportunities: o.opportunities ?? [opp()], activities: o.activities ?? base, now: at(o.now ?? "2026-11-12T14:00:00Z"), businessDays: 3, holidays: o.holidays ?? [] });

  it("a los 3 días hábiles sin respuesta: aviso; antes no", () => {
    expect(sel({ now: "2026-11-11T20:00:00Z" })).toEqual([]);
    const [f] = sel();
    expect(f).toMatchObject({ opportunityId: 1, companyId: 10, ownerUserId: 5, quoteNumber: "COT-0032", businessDays: 3, sent: true });
    expect(followUpMessage({ ...f, razonSocial: "ZBUSS S.A.C." })).toBe("⏰ La cotización *0032* a *ZBUSS* (enviada) lleva 3 días hábiles sin respuesta. ¿Le hacemos seguimiento? Registra lo que pase con un reporte.");
  });
  it("feriado en medio: un día más", () => {
    expect(sel({ holidays: ["2026-11-10"] })).toEqual([]);
    expect(sel({ holidays: ["2026-11-10"], now: "2026-11-13T14:00:00Z" })).toHaveLength(1);
  });
  it("actividad posterior de la empresa (de cualquiera) = respuesta; la de otra empresa no", () => {
    expect(sel({ activities: [...base, act("llamada", "2026-11-10T15:00:00Z", null)] })).toEqual([]);
    expect(sel({ activities: [...base, act("llamada", "2026-11-10T15:00:00Z", null, 99)] })).toHaveLength(1);
    expect(sel({ activities: [...base, act("llamada", "2026-11-08T15:00:00Z", null)] })).toHaveLength(1);
  });
  it("cambio de etapa, cerrada, sin enlace o ya avisada: nada", () => {
    expect(sel({ opportunities: [opp({ etapa: "negociacion" })] })).toEqual([]);
    expect(sel({ opportunities: [opp({ closedAt: at("2026-11-10T15:00:00Z"), etapa: "cerrado_perdido" })] })).toEqual([]);
    expect(sel({ opportunities: [opp({ quoteNumber: null })] })).toEqual([]);
    expect(sel({ activities: [act("cotizacion_enviada", "2026-11-09T16:00:00Z")] })).toEqual([]);
    expect(sel({ activities: [...base, act("recordatorio_cotizacion", "2026-11-12T13:00:00Z")] })).toEqual([]);
    const history = [{ id: 1, opportunityId: 1, etapa: "visita_realizada" as const, enteredAt: at("2026-11-10T15:00:00Z"), leftAt: null, changedBy: 5 }];
    expect(selectQuoteFollowUps({ opportunities: [opp({ etapa: "visita_realizada" })], activities: base, now: at("2026-11-12T14:00:00Z"), businessDays: 3, stageHistory: history })).toEqual([]);
  });
  it("enlazada sin enviar cuenta desde el enlace", () => {
    const [f] = sel({ opportunities: [opp({ etapa: "prospecto" })], activities: [act("cotizacion", "2026-11-06T15:00:00Z")], now: "2026-11-11T14:00:00Z" });
    expect(f).toMatchObject({ businessDays: 3, sent: false });
  });

  it("quoteFollowUpsFor sobre el store y recordQuoteFollowUp evita repetir", async () => {
    await seedPortal();
    const h = await harness(portal);
    await h.say(REQ_RUC);
    await h.say("ok");
    await h.say("enviar");
    const sentAt = (await quoteActs(portal, "cotizacion_enviada"))[0].occurredAt;
    const later = new Date(sentAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    const list = await quoteFollowUpsFor(portal, frank.id, later, { businessDays: 3, holidays: [] });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ quoteNumber: "COT-0001", razonSocial: "TRANSPORTES ANDES DEL PERU S.A.C.", companyId: andesId });
    await recordQuoteFollowUp(portal, list[0], later);
    expect(await quoteFollowUpsFor(portal, frank.id, later, { businessDays: 3, holidays: [] })).toEqual([]);
  });
});

describe("números de cotización", () => {
  it("como los escribe el vendedor", () => {
    expect(shortQuoteNumber("OCTUBRE 2026 - 032")).toBe("032");
    expect(quoteNumberMatches("OCTUBRE 2026 - 032", "032")).toBe(true);
    expect(quoteNumberMatches("OCTUBRE 2026 - 032", "32")).toBe(true);
    expect(quoteNumberMatches("OCTUBRE 2026 - 032", "octubre 2026 - 032")).toBe(true);
    expect(quoteNumberMatches("OCTUBRE 2026 - 032", "033")).toBe(false);
    expect(quoteNumberMatches("COT-0032", "cotización 32")).toBe(true);
  });
});
