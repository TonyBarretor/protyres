/**
 * Corrida K, punto 5 — Match Venta en el bot, por el BotHandler con el WhatsApp de pruebas y el mundo inventado de
 * src/lib/portal/match/__fixtures__/world.ts (más flotas de relleno para paginar):
 *  - router: `match`, `match 295/80R22.5`, `match P0433`, "¿a quién le vendo mi stock?", `prioridad …`, `quitar prioridad …`,
 *    `avance match`; un pedido con cantidad o un reporte no son el comando;
 *  - `match`: productos prioritarios con disponible y empresas, lista para elegir (límites de WhatsApp);
 *  - `match <producto>`: las 5 mejores con "estimado", desglose, venta real aparte, RUC; *más* trae las siguientes; las de
 *    otro vendedor no aparecen; medida que el padrón no infiere: se dice;
 *  - agendar desde el bot: día y hora opcional, asignación atómica con dos vendedores a la vez, sin oportunidades duplicadas;
 *  - prioridad por código, por medida + modelo y por voz; `avance match` cuenta lo cotizado sin tocar el cotizador.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PriceRow } from "../../ingest/types";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import { BUTTON_TITLE_MAX, LIST_ROW_DESCRIPTION_MAX, LIST_ROW_TITLE_MAX, LIST_ROWS_MAX } from "../../whatsapp/interactive";
import { parseWebhook, type InboundMessage } from "../../whatsapp/webhook";
import { load, STOCK, vehicles, world as makeWorld, type World } from "../match/__fixtures__/world";
import { JsonPortalStore } from "../store";
import { PORTAL_HELP } from "./commands/ayuda";
import { configureMatchBot, matchQuery, rowName } from "./commands/match";
import { configureOrderBot } from "./commands/oc";
import { configureReportBot } from "./report";
import { classifyIntent, parsePortalCommand } from "./router";
import { getPending } from "./state";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
});

const FRANK = "51900000001";
const JUAN = "51900000002";
const SUPER = "51900000003";
const OTRO = "51900000004";
const TECNICO = "51900000005";

/** 8 flotas de relleno con 295/80R22.5 (para paginar): RUC 2088800000N. */
const EXTRA = Array.from({ length: 8 }, (_, i) => `208880000${String(i).padStart(2, "0")}`);

let seq = 0;
let client: FakeWhatsAppClient;
let w: World;
let prices: JsonStore;
let bot: BotHandler;
let transcript = "";
const saved: Record<string, string | undefined> = {};

const textMsg = (body: string, from = FRANK): InboundMessage => ({ id: `wamid.k${++seq}`, from, timestamp: "1", type: "text", text: body, forwarded: false });
const audioMsg = (from = FRANK): InboundMessage => ({ id: `wamid.k${++seq}`, from, timestamp: "1", type: "audio", forwarded: false, media: { id: `aud-k${seq}`, mimeType: "audio/ogg" } });

/** Pulsa un botón o una fila del último interactivo (por título o id). */
function press(title: string, from = FRANK, c = client): InboundMessage {
  const last = c.interactives().at(-1);
  if (!last) throw new Error("no hubo interactivo");
  const opts = last.type === "button" ? last.buttons : last.sections.flatMap((s) => s.rows);
  const hit = opts.find((r) => r.title === title || r.id === `pt:${title}`);
  if (!hit) throw new Error(`no hay opción ${title}: ${opts.map((o) => o.title).join(", ")}`);
  const kind = last.type === "button" ? "button_reply" : "list_reply";
  const interactive = { type: kind, [kind]: { id: hit.id, title: hit.title } };
  const payload = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { messages: [{ id: `wamid.k${++seq}`, from, timestamp: "1", type: "interactive", interactive }] } }] }] };
  return parseWebhook(payload).messages[0];
}

const say = async (m: InboundMessage | string, from = FRANK, b = bot, c = client) => {
  const before = c.sent.length;
  await b.handle(typeof m === "string" ? textMsg(m, from) : m);
  return c.sent.slice(before);
};
const voice = async (text: string, from = FRANK) => {
  transcript = text;
  return say(audioMsg(from), from);
};
type Out = Awaited<ReturnType<typeof say>>;
const bodyOf = (out: Out) =>
  out
    .filter((m) => m.kind === "text" || m.kind === "interactive")
    .map((m) => m.body ?? "")
    .join("\n---\n");
const rowsOf = (out: Out) => {
  const list = out.find((m) => m.kind === "interactive" && m.interactive?.type === "list");
  return list && list.interactive?.type === "list" ? list.interactive.sections.flatMap((s) => s.rows) : [];
};
const buttonsOf = (out: Out) => {
  const b = out.find((m) => m.kind === "interactive" && m.interactive?.type === "button");
  return b && b.interactive?.type === "button" ? b.interactive.buttons : [];
};
function checkLimits(out: Out) {
  for (const m of out) {
    if (m.interactive?.type === "list") {
      const rows = m.interactive.sections.flatMap((s) => s.rows);
      expect(rows.length).toBeLessThanOrEqual(LIST_ROWS_MAX);
      for (const r of rows) {
        expect(r.title.length, r.title).toBeLessThanOrEqual(LIST_ROW_TITLE_MAX);
        expect((r.description ?? "").length).toBeLessThanOrEqual(LIST_ROW_DESCRIPTION_MAX);
      }
    }
    if (m.interactive?.type === "button") {
      expect(m.interactive.buttons.length).toBeLessThanOrEqual(3);
      for (const b of m.interactive.buttons) expect(b.title.length).toBeLessThanOrEqual(BUTTON_TITLE_MAX);
    }
  }
}

/** Precio propio de la Flama 66 (para cotizarla) además del stock. */
const OWN: PriceRow = { ...STOCK[0], id: "own-flama66", kind: "own", code: undefined, provider: "360 Tyres", cost: 300, priceIncludesTax: true, stock: null, stockByWarehouse: undefined, source: "excel", sourceRef: "lista.xlsx" };

beforeEach(async () => {
  for (const k of ["LLM_DISABLED", "PHOTOS_DISABLED", "PORTAL_SESSION_SECRET", "PORTAL_BASE_URL", "DEEPGRAM_API_KEY"]) saved[k] = process.env[k];
  process.env.LLM_DISABLED = "1";
  process.env.PHOTOS_DISABLED = "1";
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  process.env.PORTAL_BASE_URL = "https://portal.example.pe";
  process.env.DEEPGRAM_API_KEY = "dg-test-key";
  client = new FakeWhatsAppClient();
  w = await makeWorld(JsonPortalStore.memory());
  await w.store.upsertUser({ nombre: "Otro Vendedor", whatsapp: OTRO, rol: "vendedor" });
  await w.store.upsertUser({ nombre: "Danyer Técnico", whatsapp: TECNICO, rol: "tecnico" });
  const r = await w.store.upsertCompanies(EXTRA.map((ruc, i) => ({ ruc, razonSocial: `FLOTA RELLENO ${String.fromCharCode(65 + i)} SAC`, sector: "carga" as const, departamento: "LIMA", unidades: 10 + i })));
  await w.store.upsertFleet(EXTRA.flatMap((ruc, i) => vehicles(r.ids[ruc], 10 + i, "295/80R22.5", "CAMION", 10, `X${i}`)));
  prices = JsonStore.memory();
  await prices.upsertRows([...STOCK, OWN]);
  await load(w);
  configureMatchBot({ priceStore: prices });
  configureOrderBot({ priceStore: prices, settings });
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ metadata: { duration: 2 }, results: { channels: [{ alternatives: [{ transcript, confidence: 0.95 }] }] } }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
  configureReportBot({ llm: null, deepgramFetch: fetchImpl, downloadMedia: async () => ({ data: Buffer.from("OggS"), mimeType: "audio/ogg" }), logMessage: (e) => prices.logMessage(e) });
  bot = new BotHandler({ client, store: prices, settings, portalStore: w.store });
});

afterEach(() => {
  configureMatchBot(null);
  configureOrderBot(null);
  configureReportBot(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("router: comandos de Match Venta", () => {
  it("escritos y dictados", () => {
    const cases: [string, string, string][] = [
      ["match", "match", ""],
      ["Match 295/80R22.5", "match", "295/80R22.5"],
      ["match P0433", "match", "P0433"],
      ["match venta", "match", ""],
      ["¿A quién le vendo mi stock?", "match", "mi stock?"],
      ["a quién le puedo ofrecer las flama 66", "match", "las flama 66"],
      ["¿Qué tengo que vender?", "match", "?"],
      ["prioridad P0428", "prioridad", "P0428"],
      ["prioridad 295 flama 66", "prioridad", "295 flama 66"],
      ["Ponle prioridad a la Flama 66", "prioridad", "a la Flama 66"],
      ["quitar prioridad P0428", "quitar_prioridad", "P0428"],
      ["Quítale la prioridad a la flama 77", "quitar_prioridad", "a la flama 77"],
      ["prioridad 315/80R22.5 flama 77", "prioridad", "315/80R22.5 flama 77"],
      ["avance match", "avance_match", ""],
    ];
    for (const [t, name, args] of cases) expect(parsePortalCommand(t), t).toEqual({ name, args });
    expect(parsePortalCommand("avance")?.name).toBe("avance");
    expect(parsePortalCommand("avance de octubre")?.name).toBe("avance");
  });

  it("un pedido con cantidad o un reporte no son el comando", () => {
    for (const t of ["match 295/80R22.5 x4", "prioridad 295/80R22.5 x4 para ZBUSS", "Visité ZBUSS, a quién le vendo la flama", "matches de fútbol"]) {
      expect(["match", "prioridad", "quitar_prioridad"], t).not.toContain(parsePortalCommand(t)?.name);
    }
    expect(classifyIntent({ text: "match 295/80R22.5 x4", state: "idle", isPortalUser: true })).toBe("quote");
    expect(classifyIntent({ text: "match", state: "idle", isPortalUser: false })).toBe("passthrough");
  });

  it("lo que sigue al comando, sin relleno", () => {
    expect(matchQuery("mi stock?")).toBe("");
    expect(matchQuery("el stock prioritario")).toBe("");
    expect(matchQuery("las flama 66")).toBe("flama 66");
    expect(matchQuery("P0433")).toBe("P0433");
  });
});

describe("match: productos prioritarios", () => {
  it("disponible en Lima, empresas que hacen match y una lista para elegir", async () => {
    const out = await say("match");
    const body = bodyOf(out);
    expect(body).toContain("*Match Venta*");
    expect(body).toContain("llantas prioritarias");
    expect(body).toContain("*295/80R22.5 Fenixway Flama 66* (T0433): 100 en Lima");
    expect(body).toMatch(/\(T0433\): 100 en Lima · \d+ empresas \(1 ya te compró\)/);
    expect(body).toContain("estimado");
    // la camioneta: el padrón no permite inferir la medida (se dice)
    expect(body).toMatch(/ℹ️ .*padr[oó]n/);
    const rows = rowsOf(out);
    expect(rows.map((r) => r.id)).toContain("pt:match T0433");
    checkLimits(out);
    expect(body).not.toMatch(/[a-z]+[A-Z][a-z]+\(|undefined|null|NaN/);
  });

  it("antes del primer cálculo: una línea clara", async () => {
    const empty = JsonPortalStore.memory();
    await empty.upsertUser({ nombre: "Frank Prueba", whatsapp: FRANK, rol: "vendedor" });
    const c2 = new FakeWhatsAppClient();
    const b2 = new BotHandler({ client: c2, store: prices, settings, portalStore: empty });
    expect(bodyOf(await say("match", FRANK, b2, c2))).toContain("Aún no se calculó Match Venta");
  });
});

describe("match <producto>", () => {
  it("las 5 mejores con % estimado, desglose, venta real aparte y RUC; sin las de otro vendedor", async () => {
    const out = await say("match T0433");
    const body = bodyOf(out);
    expect(body).toContain("🎯 *295/80R22.5 Fenixway Flama 66* (T0433)");
    expect(body).toContain("*1. BUSES DEL SUR DEMO SAC* — *");
    expect(body).toMatch(/\*\d+%\* estimado/);
    expect(body).toContain("90% de su flota usa 295/80R22.5");
    expect(body).toContain("✅ Ya te compró 60");
    expect(body).toContain("RUC 20000000001");
    expect(body).toContain("Ate, Lima");
    expect(body).not.toContain("TRANSPORTES DE JUAN");
    expect(body).not.toContain("MUNICIPALIDAD");
    expect(body).toMatch(/1–5 de \d+\. \*más\* trae las siguientes/);
    const rows = rowsOf(out);
    expect(rows.slice(0, 5).map((r) => r.id)).toEqual(["pt:1", "pt:2", "pt:3", "pt:4", "pt:5"]);
    expect(rows.at(-1)?.id).toBe("pt:más");
    checkLimits(out);
    expect((await getPending(w.store, FRANK, new Date()))?.kind).toBe("match");
  });

  it("por medida y por modelo; una medida sin prioridad lo dice", async () => {
    expect(bodyOf(await say("match 295/80R22.5"))).toContain("(T0433)");
    expect(bodyOf(await say("match flama 66"))).toContain("(T0433)");
    expect(bodyOf(await say("match 11R22.5"))).toContain("No encuentro «11R22.5» entre tus llantas prioritarias");
    // flama a secas: dos prioritarias (66 y 77) -> se elige de una lista
    const many = await say("match flama");
    expect(rowsOf(many).map((r) => r.id).sort()).toEqual(["pt:match T0428", "pt:match T0433"]);
  });

  it("`más` trae las siguientes sin repetir y al final «no hay más»; otro vendedor nunca ve la de Juan", async () => {
    const seen: string[] = [];
    const names = (out: Out) => [...bodyOf(out).matchAll(/\*\d+\. ([^*]+)\*/g)].map((m) => m[1]);
    const b1 = await say("match T0433");
    seen.push(...names(b1));
    const b2 = await say(press("Ver 5 más"));
    expect(bodyOf(b2)).toMatch(/6–\d+ de \d+/);
    seen.push(...names(b2));
    let last = b2;
    for (let guard = 0; /\*más\* trae/.test(bodyOf(last)) && guard < 5; guard++) {
      last = await say("más");
      seen.push(...names(last));
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain("TRANSPORTES DE JUAN DEMO SAC");
    expect(seen).toContain("FLOTA RELLENO A SAC");
    expect(bodyOf(await say("más"))).toContain("No hay más empresas");
  });

  it("supervisor ve también las de otro vendedor", async () => {
    let all = "";
    all += bodyOf(await say("match T0433", SUPER));
    for (let i = 0; i < 4; i++) all += bodyOf(await say("más", SUPER));
    expect(all).toContain("TRANSPORTES DE JUAN DEMO SAC");
  });

  it("técnico: la lista sin acciones", async () => {
    const out = await say("match T0433", TECNICO);
    expect(rowsOf(out)).toEqual([]);
    expect(bodyOf(out)).toContain("Solo vendedores y supervisores asignan empresas y agendan visitas.");
  });

  it("medida que el padrón no infiere (camioneta): lo dice y muestra quién ya la compró", async () => {
    const body = bodyOf(await say("match T1527"));
    expect(body).toMatch(/ℹ️ .*padr[oó]n/);
    expect(body).toContain("*Clientes que ya compraron esta medida*");
    expect(body).toContain("CAMIONETAS FUERA DEL PADRON DEMO");
  });
});

describe("agendar desde el bot", () => {
  it("elegir, *Agendar visita*, *Mañana*, *Sin hora*: asigna, crea la oportunidad y liga la visita al producto", async () => {
    await say("match T0433");
    const pick = await say(press("BUSES DEL SUR DEMO"));
    expect(bodyOf(pick)).toContain("*BUSES DEL SUR DEMO SAC* · RUC 20000000001");
    expect(buttonsOf(pick).map((b) => b.title)).toEqual(["Asignármela", "Agendar visita", "Más empresas"]);
    checkLimits(pick);
    const ask = await say(press("Agendar visita"));
    expect(buttonsOf(ask).map((b) => b.title)).toEqual(["Hoy", "Mañana", "Otra fecha"]);
    const hour = await say(press("Mañana"));
    expect(buttonsOf(hour).map((b) => b.title)).toEqual(["Sin hora"]);
    const done = bodyOf(await say(press("Sin hora")));
    expect(done).toContain("📅 Visita a *BUSES DEL SUR DEMO SAC*");
    expect(done).toContain("09:00");
    expect(done).toContain("ofrecer 295/80R22.5 Fenixway Flama 66: ya te compró 60");
    expect(done).toContain("La empresa quedó asignada a ti.");
    const id = w.ids["20000000001"];
    expect((await w.store.getCompany(id))?.ownerUserId).toBe(w.frank.id);
    expect(await w.store.listOpportunities({ companyId: id, open: true })).toHaveLength(1);
    const visits = await w.store.listMatchVisits({ companyId: id });
    expect(visits).toHaveLength(1);
    expect(visits[0].productCode).toBe("T0433");
    // otra vez el mismo día: no se duplica
    await say("1");
    await say(press("Agendar visita"));
    expect(bodyOf(await say("mañana 10am"))).toContain("Ya tenías esa visita");
    expect(await w.store.listMatchVisits({ companyId: id })).toHaveLength(1);
    expect(await w.store.listOpportunities({ companyId: id, open: true })).toHaveLength(1);
  });

  it("día y hora escritos de una vez; *Asignármela* y luego agendar", async () => {
    await say("match T0433");
    await say("2");
    const assigned = await say(press("Asignármela"));
    expect(bodyOf(assigned)).toContain("✔ Empresa asignada a ti.");
    expect(buttonsOf(assigned).map((b) => b.title)).toContain("Agendar visita");
    await say(press("Agendar visita"));
    await say(press("Otra fecha"));
    const done = bodyOf(await say("viernes 3pm"));
    expect(done).toContain("📅 Visita a");
    expect(done).toContain("15:00");
    expect(done).not.toContain("quedó asignada a ti");
  });

  it("dos vendedores agendan la misma empresa sin dueño a la vez: solo uno se la lleva, una sola oportunidad", async () => {
    const c2 = new FakeWhatsAppClient();
    const b2 = new BotHandler({ client: c2, store: prices, settings, portalStore: w.store });
    const ruc = "20000000001";
    const prep = async (from: string, b: BotHandler, c: FakeWhatsAppClient) => {
      await say("match T0433", from, b, c);
      const row = c.interactives().at(-1)!;
      const hit = row.type === "list" ? row.sections.flatMap((s) => s.rows).find((r) => r.title.startsWith("BUSES DEL SUR")) : null;
      await say(hit!.id.replace("pt:", ""), from, b, c);
      await say("agendar", from, b, c);
      await say("mañana", from, b, c);
    };
    await prep(FRANK, bot, client);
    await prep(OTRO, b2, c2);
    await Promise.all([say("10am", FRANK, bot, client), say("11am", OTRO, b2, c2)]);
    const replies = [...client.texts(), ...c2.texts()];
    expect(replies.filter((t) => t.includes("📅 Visita a *BUSES DEL SUR DEMO SAC*"))).toHaveLength(1);
    expect(replies.filter((t) => t.includes("ya es de"))).toHaveLength(1);
    const id = w.ids[ruc];
    const owner = (await w.store.getCompany(id))!.ownerUserId;
    const open = await w.store.listOpportunities({ companyId: id, open: true });
    expect(open).toHaveLength(1);
    expect(open[0].ownerUserId).toBe(owner);
    expect(await w.store.listMatchVisits({ companyId: id })).toHaveLength(1);
  });

  it("por voz: «la dos» y «agéndala mañana a las diez»", async () => {
    await say("match T0433");
    const pick = bodyOf(await voice("la dos"));
    expect(pick).toContain("🎙 Escuché: la dos");
    expect(pick).toContain("¿Qué hago?");
    const done = bodyOf(await voice("agéndala mañana a las diez"));
    expect(done).toContain("📅 Visita a");
    expect(done).toContain("10:00");
  });
});

describe("prioridad", () => {
  it("por código, por medida + modelo y por voz; quitar también", async () => {
    const off = bodyOf(await say("quitar prioridad T0428"));
    expect(off).toContain("✔ Quité la prioridad de *315/80R22.5 Fenixway Flama 77* (T0428).");
    expect((await w.store.listMatchProducts()).find((p) => p.code === "T0428")?.prioridad).toBe(false);
    expect(bodyOf(await say("match"))).not.toContain("(T0428)");

    const on = await say("prioridad 315 flama 77");
    expect(bodyOf(on)).toContain("✔ *315/80R22.5 Fenixway Flama 77* (T0428) es prioridad: 23 disponibles en Lima.");
    expect(buttonsOf(on).map((b) => b.id)).toEqual(["pt:match T0428"]);
    expect(bodyOf(await say("match"))).toContain("(T0428)");

    const v = bodyOf(await voice("quítale la prioridad a la flama setenta y siete"));
    expect(v).toContain("Quité la prioridad");
    expect((await w.store.listMatchProducts()).find((p) => p.code === "T0428")?.prioridad).toBe(false);
    expect(bodyOf(await voice("prioridad trescientos quince flama setenta y siete"))).toContain("es prioridad");
    expect((await w.store.matchPriorityLog("T0428")).map((l) => l.accion).slice(0, 4)).toEqual(["activar", "quitar", "activar", "quitar"]);
  });

  it("varias coincidencias: lista para elegir; nada: lo dice; técnico: no puede", async () => {
    const many = await say("quitar prioridad flama");
    expect(rowsOf(many).map((r) => r.id).sort()).toEqual(["pt:quitar prioridad T0428", "pt:quitar prioridad T0433"]);
    checkLimits(many);
    expect(bodyOf(await say(press("315/80R22.5 Flama 77")))).toContain("Quité la prioridad");
    expect(bodyOf(await say("prioridad zzz valor 99"))).toContain("No encuentro «zzz valor 99» en el stock propio");
    expect(bodyOf(await say("prioridad T0433", TECNICO))).toContain("Tu rol no puede marcar prioridades.");
  });
});

describe("por voz", () => {
  it("«¿A quién le vendo mi stock?» y «a quién le ofrezco las flama sesenta y seis»", async () => {
    const a = bodyOf(await voice("¿A quién le vendo mi stock?"));
    expect(a).toContain("*Match Venta*");
    expect(a).not.toContain("Reporte de");
    const b = bodyOf(await voice("A quién le ofrezco las flama sesenta y seis"));
    expect(b).toContain("🎯 *295/80R22.5 Fenixway Flama 66* (T0433)");
    expect(bodyOf(await voice("más"))).toMatch(/6–\d+ de/);
  });
});

describe("avance match", () => {
  it("por producto; al cotizar una prioritaria el precio no cambia y lo cotizado cuenta", async () => {
    const before = bodyOf(await say("avance match"));
    expect(before).toContain("*Avance Match Venta*");
    expect(before).toContain("• *295/80R22.5 Fenixway Flama 66* (T0433): disponible 100 · cotizado 0 · pedido 0 · quedan 100");
    await say("Fenixway Flama 66 295/80R22.5 x4 para BUSES DEL SUR DEMO SAC");
    await say("ok");
    const [q] = await prices.listQuotes({ limit: 5 });
    expect(q.items[0].quantity).toBe(4);
    // el precio es el de la lista: Match Venta no lo toca
    const plain = JsonStore.memory();
    await plain.upsertRows([OWN]);
    const c3 = new FakeWhatsAppClient();
    const plainPortal = JsonPortalStore.memory();
    await plainPortal.upsertUser({ nombre: "Frank Prueba", whatsapp: FRANK, rol: "vendedor" });
    const b3 = new BotHandler({ client: c3, store: plain, settings, portalStore: plainPortal });
    await b3.handle(textMsg("Fenixway Flama 66 295/80R22.5 x4 para BUSES DEL SUR DEMO SAC"));
    await b3.handle(textMsg("ok"));
    const [q3] = await plain.listQuotes({ limit: 5 });
    if (!q3) throw new Error(c3.texts().join("\n---\n"));
    expect(q.items.map((i) => i.unitPrice)).toEqual(q3.items.map((i) => i.unitPrice));
    const after = bodyOf(await say("avance match"));
    expect(after).toContain("(T0433): disponible 100 · cotizado 4");
  });
});

describe("nombre de la fila", () => {
  it("distingue empresas con el mismo prefijo largo", () => {
    expect(rowName("EMPRESA DE TRANSPORTES PERU BUS S.A.")).toBe("E.T. PERU BUS");
    expect(rowName("EMPRESA DE TRANSPORTES Y SERVICIOS GENERALES SAGITARIO SRL")).toBe("E.T. SAGITARIO");
    expect(rowName("EMPRESA DE TRANSPORTES TERRESTRES ISSA S.A.C. - ETTISSA")).toBe("E.T. ISSA");
    expect(rowName("BUSES DEL SUR DEMO SAC")).toBe("BUSES DEL SUR DEMO");
  });
});

describe("ayuda", () => {
  it("lista los comandos nuevos", () => {
    for (const c of ["*match*", "*match P0433*", "*prioridad P0428*", "*quitar prioridad P0428*", "*avance match*"]) expect(PORTAL_HELP).toContain(c);
  });
});
