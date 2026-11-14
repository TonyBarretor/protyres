/**
 * Corrida G, punto 5 (bot) y punto 6 (aviso): `mejores` por el BotHandler con el WhatsApp de pruebas.
 *  - las 5 primeras con nivel y explicación, como estimación, y una lista cuyas filas son `asignarme <RUC>`;
 *  - `más` trae las siguientes 5 sin repetir y al final "no hay más"; las de otro vendedor nunca aparecen;
 *  - por voz "¿Cuáles son mis mejores flotas?" llega al comando; un reporte o pedido que dice "mejores" no;
 *  - sin puntajes calculados, una línea clara (y ningún aviso);
 *  - el aviso de validar el ranking se da una sola vez por usuario (en `mejores` o `hoy`), nunca al técnico.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsSchema, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import { LIST_ROW_DESCRIPTION_MAX, LIST_ROW_TITLE_MAX } from "../../whatsapp/interactive";
import { parseWebhook, type InboundMessage } from "../../whatsapp/webhook";
import { defaultScoringConfig } from "../scoring/config";
import { explainLine } from "../scoring/explain";
import { recalcScores } from "../scoring/recalc";
import { JsonPortalStore } from "../store";
import type { PortalUser } from "../store/types";
import { PORTAL_HELP } from "./commands/ayuda";
import { MEJORES_NOT_READY } from "./commands/mejores";
import { RANKING_NOTICE_KEY } from "./ranking-notice";
import { configureReportBot } from "./report";
import { classifyIntent, parsePortalCommand } from "./router";
import { getPending } from "./state";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
});

const FRANK = "51900000001";
const OTRO = "51900000003";
const TECNICO = "51900000005";
const SUPER = "51900000007";

let seq = 0;
let client: FakeWhatsAppClient;
let portal: JsonPortalStore;
let prices: JsonStore;
let bot: BotHandler;
let frank: PortalUser;
let otro: PortalUser;
const saved: Record<string, string | undefined> = {};

/** 14 empresas inventadas con tamaños distintos (puntajes distintos); RUC 2099920000N. */
const RUCS = Array.from({ length: 14 }, (_, i) => `209992${String(i).padStart(5, "0")}`);

const textMsg = (body: string, from = FRANK): InboundMessage => ({ id: `wamid.m${++seq}`, from, timestamp: "1", type: "text", text: body, forwarded: false });

function press(title: string, from = FRANK): InboundMessage {
  const last = client.interactives().at(-1);
  if (!last || last.type !== "list") throw new Error("no hubo lista");
  const hit = last.sections.flatMap((s) => s.rows).find((r) => r.title === title || r.id === `pt:${title}`);
  if (!hit) throw new Error(`no hay fila ${title}`);
  const interactive = { type: "list_reply", list_reply: { id: hit.id, title: hit.title } };
  const payload = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { messages: [{ id: `wamid.m${++seq}`, from, timestamp: "1", type: "interactive", interactive }] } }] }] };
  return parseWebhook(payload).messages[0];
}

const say = async (m: InboundMessage | string, from = FRANK) => {
  const before = client.sent.length;
  await bot.handle(typeof m === "string" ? textMsg(m, from) : m);
  return client.sent.slice(before);
};
const bodyOf = (out: Awaited<ReturnType<typeof say>>) =>
  out
    .filter((m) => m.kind === "text" || m.kind === "interactive")
    .map((m) => m.body ?? "")
    .join("\n---\n");
const listRows = (out: Awaited<ReturnType<typeof say>>) => {
  const list = out.find((m) => m.kind === "interactive" && m.interactive?.type === "list");
  return list && list.interactive?.type === "list" ? list.interactive.sections.flatMap((s) => s.rows) : [];
};

async function seedScores(): Promise<void> {
  await recalcScores(portal, defaultScoringConfig(), { now: new Date() });
}

/** RUCs en el orden del ranking (mayor puntaje primero). */
async function rankedRucs(): Promise<string[]> {
  const all = await Promise.all(RUCS.map((r) => portal.getCompanyByRuc(r)));
  return all
    .filter((c) => c && c.score !== null)
    .sort((a, b) => (b!.score ?? 0) - (a!.score ?? 0) || a!.id - b!.id)
    .map((c) => c!.ruc);
}

beforeEach(async () => {
  for (const k of ["LLM_DISABLED", "PHOTOS_DISABLED", "PORTAL_SESSION_SECRET", "PORTAL_BASE_URL", "DEEPGRAM_API_KEY"]) saved[k] = process.env[k];
  process.env.LLM_DISABLED = "1";
  process.env.PHOTOS_DISABLED = "1";
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  process.env.PORTAL_BASE_URL = "https://portal.example.pe";
  delete process.env.DEEPGRAM_API_KEY;
  client = new FakeWhatsAppClient();
  portal = JsonPortalStore.memory();
  prices = JsonStore.memory();
  frank = await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  otro = await portal.upsertUser({ nombre: "Otro Vendedor", whatsapp: OTRO, rol: "vendedor" });
  await portal.upsertUser({ nombre: "Danyer Técnico", whatsapp: TECNICO, rol: "tecnico" });
  await portal.upsertUser({ nombre: "Sara Supervisora", whatsapp: SUPER, rol: "supervisor" });
  await portal.upsertCompanies(
    RUCS.map((ruc, i) => ({
      ruc,
      razonSocial: `FLOTA PRUEBA ${String.fromCharCode(65 + i)} S.A.C.`,
      sector: i % 2 ? ("carga" as const) : ("pasajeros" as const),
      departamento: i % 3 ? "LIMA" : "AREQUIPA",
      unidades: 10 + 15 * i,
      llantasPiso: 60 + 90 * i,
    })),
  );
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

describe("router: `mejores` y sus variantes cercanas", () => {
  it("el comando, escrito o dictado", () => {
    for (const t of ["mejores", "Mejores", "mis mejores", "mis mejores flotas", "¿Cuáles son mis mejores flotas?", "cuales son las mejores flotas", "¿Qué flotas me convienen?", "mejores flotas"]) {
      expect(parsePortalCommand(t)?.name, t).toBe("mejores");
    }
  });
  it("un reporte o un pedido que dice «mejores» no es el comando", () => {
    for (const t of ["les ofrecí nuestras mejores llantas", "Visité ZBUSS, les ofrecí nuestras mejores llantas", "mejores precios para 295/80R22.5 x4", "las mejores llantas para buses"]) {
      expect(parsePortalCommand(t), t).toBeNull();
    }
    expect(classifyIntent({ text: "Visité ZBUSS, les ofrecí nuestras mejores llantas", state: "idle", isPortalUser: true })).toBe("report");
    expect(classifyIntent({ text: "mejores precios para 295/80R22.5 x4", state: "idle", isPortalUser: true })).toBe("quote");
    // quien no es usuario del portal sigue en el cotizador
    expect(classifyIntent({ text: "mejores", state: "idle", isPortalUser: false })).toBe("passthrough");
  });
});

describe("mejores", () => {
  it("sin puntajes calculados: una línea clara, sin lista ni aviso (el aviso queda para después)", async () => {
    const out = await say("mejores");
    expect(bodyOf(out)).toBe(MEJORES_NOT_READY);
    expect(MEJORES_NOT_READY).not.toMatch(/npm|[A-Z]{3,}_[A-Z]/);
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
    expect(await portal.markUserNotice(frank.id, RANKING_NOTICE_KEY)).toBe(true);
  });

  it("las 5 primeras con nivel y explicación, como estimación; la lista asigna con `asignarme <RUC>`", async () => {
    await seedScores();
    const ranked = await rankedRucs();
    const out = await say("mejores");
    const list = out.find((m) => m.kind === "interactive")!;
    expect(list.body).toContain("*Tus mejores flotas*");
    expect(list.body).toContain("1–5 de 14");
    expect(list.body!.toLowerCase()).toContain("estimación");
    const first = (await portal.getCompanyByRuc(ranked[0]))!;
    expect(list.body).toContain(`*1. ${first.razonSocial}* · Nivel ${first.nivel}`);
    expect(list.body).toContain(explainLine(first.scoreDetalle));
    const rows = listRows(out);
    expect(rows.slice(0, 5).map((r) => r.id)).toEqual(ranked.slice(0, 5).map((r) => `pt:asignarme ${r}`));
    expect(rows.at(-1)).toMatchObject({ id: "pt:más" });
    expect(rows.length).toBeLessThanOrEqual(10);
    for (const r of rows) {
      expect(r.title.length).toBeLessThanOrEqual(LIST_ROW_TITLE_MAX);
      expect((r.description ?? "").length).toBeLessThanOrEqual(LIST_ROW_DESCRIPTION_MAX);
    }
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("mejores");

    // elegir una fila = escribir `asignarme <RUC>`
    const pressed = press("FLOTA PRUEBA " + first.razonSocial.split(" ")[2]);
    expect(pressed.text).toBe(`asignarme ${ranked[0]}`);
    expect(bodyOf(await say(pressed))).toContain("✔ Empresa asignada a ti.");
    expect((await portal.getCompanyByRuc(ranked[0]))?.ownerUserId).toBe(frank.id);
  });

  it("`más` trae las siguientes 5 sin repetir; al final, «no hay más»; las de otro vendedor nunca aparecen", async () => {
    await seedScores();
    const ranked = await rankedRucs();
    // la segunda mejor es de otro vendedor: no debe aparecer en la lista de Frank
    const ajena = (await portal.getCompanyByRuc(ranked[1]))!;
    await portal.setOwner(ajena.id, otro.id);

    const seen: string[] = [];
    const ids = (out: Awaited<ReturnType<typeof say>>) => listRows(out).filter((r) => r.id.startsWith("pt:asignarme ")).map((r) => r.id.replace("pt:asignarme ", ""));
    const b1 = await say("mejores");
    seen.push(...ids(b1));
    expect(bodyOf(b1)).toContain("1–5 de 13");
    const b2 = await say("más");
    expect(bodyOf(b2)).toContain("6–10 de 13");
    seen.push(...ids(b2));
    const b3 = await say(press("más"));
    expect(bodyOf(b3)).toContain("11–13 de 13");
    expect(listRows(b3).some((r) => r.id === "pt:más")).toBe(false);
    seen.push(...ids(b3));
    expect(seen).toHaveLength(13);
    expect(new Set(seen).size).toBe(13);
    expect(seen).not.toContain(ajena.ruc);
    for (const out of [b1, b2, b3]) expect(bodyOf(out)).not.toContain(ajena.razonSocial);
    expect(seen).toEqual(ranked.filter((r) => r !== ajena.ruc));

    const end = bodyOf(await say("más"));
    expect(end).toContain("No hay más");
    expect(await getPending(portal, FRANK, new Date())).toBeNull();
  });

  it("con la lista a la vista, otro texto sigue su camino (un reporte es reporte)", async () => {
    await seedScores();
    await say("mejores");
    const out = bodyOf(await say("Visité FLOTA PRUEBA C, hablé con el jefe de flota"));
    expect(out).not.toContain("Tus mejores flotas");
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("report_draft");
  });

  it("técnico: la lista sin filas para asignarse", async () => {
    await seedScores();
    const out = await say("mejores", TECNICO);
    expect(out.some((m) => m.kind === "interactive")).toBe(false);
    const body = bodyOf(out);
    expect(body).toContain("*Tus mejores flotas*");
    expect(body).toContain("Solo vendedores y supervisores se asignan empresas.");
    expect(body).not.toContain("validar-ranking");
  });

  it("por voz: «¿Cuáles son mis mejores flotas?» corre el comando (no es un reporte)", async () => {
    await seedScores();
    process.env.DEEPGRAM_API_KEY = "dg-test-key";
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ metadata: { duration: 2 }, results: { channels: [{ alternatives: [{ transcript: "¿Cuáles son mis mejores flotas?", confidence: 0.95 }] }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    configureReportBot({ llm: null, deepgramFetch: fetchImpl, downloadMedia: async () => ({ data: Buffer.from("OggS"), mimeType: "audio/ogg" }), logMessage: (e) => prices.logMessage(e) });
    const audio: InboundMessage = { id: `wamid.m${++seq}`, from: FRANK, timestamp: "1", type: "audio", forwarded: false, media: { id: "aud-m1", mimeType: "audio/ogg" } };
    const out = await say(audio);
    const body = bodyOf(out);
    expect(body).toContain("*Tus mejores flotas*");
    expect(body).not.toContain("Reporte de");
    expect(listRows(out).length).toBeGreaterThan(0);
    expect((await getPending(portal, FRANK, new Date()))?.kind).toBe("mejores");
  });

  it("`ayuda portal` lista `mejores`", async () => {
    expect(PORTAL_HELP).toContain("*mejores*");
  });
});

describe("aviso de validar el ranking (una sola vez)", () => {
  it("en `mejores`: enlace que entra directo a /portal/validar-ranking; la segunda vez y en `hoy` ya no", async () => {
    await seedScores();
    const first = bodyOf(await say("mejores"));
    expect(first).toContain("https://portal.example.pe/portal/login?t=");
    expect(first).toContain("next=%2Fportal%2Fvalidar-ranking");
    expect(first).toContain("afinar el ranking");
    const again = bodyOf(await say("mejores"));
    expect(again).not.toContain("validar-ranking");
    expect(again).not.toContain("afinar el ranking");
    expect(bodyOf(await say("hoy"))).not.toContain("afinar el ranking");
  });

  it("en `hoy` si no lo vio antes (supervisor también); sin puntajes, nada", async () => {
    expect(bodyOf(await say("hoy", SUPER))).not.toContain("afinar el ranking");
    await seedScores();
    const out = bodyOf(await say("hoy", SUPER));
    expect(out).toContain("📅 *Hoy*");
    expect(out).toContain("afinar el ranking");
    expect(bodyOf(await say("hoy", SUPER))).not.toContain("afinar el ranking");
  });

  it("el técnico no recibe el aviso", async () => {
    await seedScores();
    expect(bodyOf(await say("hoy", TECNICO))).not.toContain("afinar el ranking");
  });

  it("si el aviso falla (la base no responde), `hoy` igual responde", async () => {
    await seedScores();
    portal.markUserNotice = async () => {
      throw new Error("relation user_notices does not exist");
    };
    const out = bodyOf(await say("hoy"));
    expect(out).toContain("📅 *Hoy*");
    expect(out).not.toContain("user_notices");
  });
});
