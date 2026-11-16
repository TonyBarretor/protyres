/**
 * Corrida H, punto 2 — store del cotizador (PgStore) contra Postgres real: las mismas escrituras que en el store JSON
 * dan las mismas lecturas; numeración de cotizaciones en paralelo sin repetidos; uso del modelo y de la voz registrado y
 * leído de vuelta por los topes del día; transacción de drizzle (carga de lista) que falla a la mitad.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ingestExcel } from "../lib/ingest/tabular";
import type { PriceRow } from "../lib/ingest/types";
import { buildQuote, itemFromCandidate } from "../lib/quote/build";
import { rankLine } from "../lib/quote/match";
import { parseRequestRegex } from "../lib/quote/request";
import { SettingsSchema } from "../lib/settings";
import { JsonStore } from "../lib/store/json-store";
import { PgStore } from "../lib/store/pg-store";
import { quoteCounterKey, type PriceStore } from "../lib/store/types";
import { __setLimitsForTests, audioBudget, meteredModelCall, modelBudgetOk, recordAudio, runWithUsage, UsageCapExceeded, VOICE_CAP_REPLY, type UsageContext } from "../lib/guard/usage";
import { loadPortalConfig } from "../lib/portal/config";
import { testDbUrl, truncateAll } from "./harness";
import { bothTraces, diffTraces } from "./parity";

let pg: PgStore;

beforeAll(async () => {
  await truncateAll(testDbUrl());
  pg = await PgStore.connect(testDbUrl());
});
afterAll(async () => {
  await pg?.close();
});

const settings = SettingsSchema.parse({ company: { name: "X" }, pricing: {}, quote: {} });
const T0 = new Date("2026-11-11T15:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

async function sampleRows(): Promise<PriceRow[]> {
  const res = await ingestExcel(fs.readFileSync(path.resolve(process.cwd(), "samples/proveedor-a-lista.xlsx")), { provider: "Llantas del Sur", sourceRef: "a.xlsx", priceDate: "2026-10-01" });
  return res.rows;
}

const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));

async function scenario(s: PriceStore, trace: (label: string, v: unknown) => void): Promise<void> {
  const rows = await sampleRows();
  // ── lista de precios ──
  trace("prices.upsert", await s.upsertRows(rows, { replace: { provider: "Llantas del Sur", sourceRef: "a.xlsx" } }));
  trace("prices.reupsert", await s.upsertRows(rows, { replace: { provider: "Llantas del Sur", sourceRef: "a.xlsx" } }));
  const wh: PriceRow = { ...rows[0], id: "wh-1", provider: "JCH", stock: 78, stockByWarehouse: { Arriola: 8, "Lurín": 70 }, photoUrl: "https://example.pe/f.jpg", sourceRef: "jch.xlsx#Hoja1" };
  await s.upsertRows([wh]);
  trace("prices.all", byId(await s.allRows()));
  trace("prices.bySize", byId(await s.findBySize(["11R22.5", "295/80R22.5"])));
  trace("prices.getRows", byId(await s.getRows(["wh-1", "no-existe"])));
  trace("prices.providers", (await s.providers()).sort((a, b) => a.provider.localeCompare(b.provider)));
  trace("prices.withPhoto", byId(await s.rowsWithPhoto(wh.brand, wh.model)));

  // ── fotos ──
  await s.setPhoto({ key: "fenixway|flama 77", brand: "Fenixway", model: "Flama 77", data: "QUJD", mimeType: "image/jpeg", source: "whatsapp", createdAt: new Date().toISOString() }); // los que llaman siempre pasan "ahora"
  await s.setPhoto({ key: "fenixway|flama 77", brand: "Fenixway", model: "Flama 77", url: "https://example.pe/f77.jpg", source: "web", createdAt: new Date().toISOString() });
  trace("photo.get", await s.getPhoto("Fenixway", "Flama 77"));
  trace("photo.byKey", await s.getPhotoByKey("fenixway|flama 77"));
  trace("photo.keys", [...(await s.photoKeys())].sort());

  // ── numeración ──
  trace("counter.global", [await s.nextQuoteCounter(16), await s.nextQuoteCounter(16)]);
  const frank = quoteCounterKey("51900000001");
  const juan = quoteCounterKey("51900000002");
  trace("counter.salesmen", [await s.nextQuoteCounter(16, frank), await s.nextQuoteCounter(16, juan), await s.nextQuoteCounter(16, frank), await s.nextQuoteCounter(16)]);
  await s.setQuoteCounter(451, frank);
  trace("counter.set", [await s.nextQuoteCounter(16, frank), await s.nextQuoteCounter(16, juan)]);

  // ── cotizaciones y archivos ──
  const found = await s.findBySize(["11R22.5"]);
  const make = async (number: string, text: string, by: string, createdAt: string) => {
    const req = parseRequestRegex(text);
    const cands = rankLine(found, req.lines[0], req, settings.pricing, { today: "2026-10-06" });
    const q = buildQuote({ number, request: req, items: [itemFromCandidate(cands[0], 2, settings)], settings, today: "2026-10-06", requestedBy: by });
    q.createdAt = createdAt;
    await s.saveQuote(q);
    return q;
  };
  const q1 = await make("L-1", "11R22.5 x2 para PROSEGUR SA, a@prosegur.pe\nunidad: Ayacucho", "51900000001", "2026-10-10T10:00:00Z");
  await make("L-2", "11R22.5 x1 para Transportes ABC SAC, b@abc.pe", "51900000001", "2026-10-11T10:00:00Z");
  await make("L-3", "11R22.5 x1 para Prosegur S.A., c@prosegur.pe\nunidad: Cusco", "51900000002", "2026-10-12T10:00:00Z");
  q1.status = "sent";
  q1.sentAt = "2026-10-10T11:00:00.000Z";
  await s.saveQuote(q1);
  trace("quote.get", await s.getQuote("L-1"));
  trace("quote.list", (await s.listQuotes()).map((q) => q.number));
  trace("quote.listCompany", (await s.listQuotes({ company: "PROSEGUR S.A." })).map((q) => q.number));
  trace("quote.listBy", (await s.listQuotes({ requestedBy: "+51 900 000 001", limit: 1 })).map((q) => q.number));
  trace("quote.last", (await s.findLastQuoteForCustomer({ company: "prosegur" }))?.number);
  trace("quote.lastUnit", (await s.findLastQuoteForCustomer({ company: "Prosegur", unit: "ayacucho" }))?.number);
  trace("quote.lastEmail", (await s.findLastQuoteForCustomer({ email: "b@abc.pe" }))?.number);
  await s.saveQuoteFile({ quoteNumber: "L-1", kind: "xlsx", fileName: "a.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: "eDE=" });
  await s.saveQuoteFile({ quoteNumber: "L-1", kind: "pdf", fileName: "L-1.pdf", mimeType: "application/pdf", data: "cDE=" });
  await s.saveQuoteFile({ quoteNumber: "L-1", kind: "pdf", fileName: "L-1 bis.pdf", mimeType: "application/pdf", data: "cDI=" });
  trace("files.get", (await s.getQuoteFiles("L-1")).map((f) => [f.kind, f.fileName, f.data]));
  await s.deleteQuote("L-2");
  trace("quote.deleted", [await s.getQuote("L-2"), (await s.listQuotes()).map((q) => q.number)]);

  // ── precios de contrato ──
  await s.setContractItem("prosegur", { id: "V99", brand: "Fenixway", model: "Valor 99", size: "215/75R17.5", ply: 18, application: "MIXT", price: 125.5, currency: "USD", aliases: ["v99"], updatedBy: "51900000001" });
  await s.setContractItem("prosegur", { id: "f77", application: "POST" });
  await s.setContractItem("prosegur", { id: "v99", price: 126 });
  trace("contract.get", (await s.getContractItems("prosegur")).map(({ updatedAt: _u, ...i }) => i));
  trace("contract.delete", [await s.deleteContractItem("prosegur", "F77"), await s.deleteContractItem("prosegur", "f77")]);

  // ── registro de mensajes, conversación, procesados ──
  for (let i = 1; i <= 4; i++) await s.logMessage({ phone: "51900000001", direction: i % 2 ? "in" : "out", kind: "text", body: `m${i}`, quoteNumber: i > 2 ? "L-1" : undefined, routeRule: i === 1 ? "cotizacion" : undefined } as never);
  trace("messages.list", (await s.listMessages("+51 900 000 001", 3)).map(({ id: _i, createdAt: _c, ...m }) => m));
  await s.setConversation("51900000001", { phone: "51900000001", step: "choose", pending: [{ candidateIds: ["a"], chosen: 0, quantity: 1 }], updatedAt: "x" });
  trace("conv.get", await s.getConversation("51900000001"));
  await s.setConversation("51900000001", null);
  trace("conv.cleared", await s.getConversation("51900000001"));
  trace("processed", [await s.markProcessed("wamid.1"), await s.markProcessed("wamid.1"), await s.markProcessed("guard:tope:x")]);

  // ── uso medido, descartados, modo sombra ──
  await s.recordUsage({ phone: "+51 900 000 001", purpose: "reporte", model: "claude-haiku", inputTokens: 1000, outputTokens: 200, costUsd: 0.0012, at: at(0) });
  await s.recordUsage({ phone: "51900000001", purpose: "voz", model: "nova-3", audioSeconds: 42.5, costUsd: 0.0031, at: at(1) });
  await s.recordUsage({ phone: "sistema", purpose: "lista_precios", model: "claude-haiku", inputTokens: 5, outputTokens: 1, costUsd: 0.00001, at: at(2) });
  await s.recordUsage({ phone: "51900000001", purpose: "reporte", model: "claude-haiku", inputTokens: 1, outputTokens: 1, costUsd: 0, at: at(-60 * 24) });
  trace("usage.summary", (await s.usageSummary(at(-1))).sort((a, b) => `${a.phone}${a.purpose}`.localeCompare(`${b.phone}${b.purpose}`)));
  await s.logBlocked({ phone: "+51 999 1", kind: "text", reason: "no_registrado", at: at(3) });
  await s.logBlocked({ phone: "519991", kind: "audio", reason: "no_registrado", at: at(4) });
  await s.logBlocked({ phone: "519992", kind: "text", reason: "rafaga", at: at(5) });
  trace("blocked.summary", (await s.blockedSummary(at(-1))).sort((a, b) => a.reason.localeCompare(b.reason)));
  const view = { items: [{ medida: "295/80R22.5", cantidad: 8 }], cliente: "ZBUSS" } as never;
  await s.logQuoteShadow({ phone: "+51 900 000 001", text: "8 llantas", rules: view, model: null, diffs: [], rejected: ["marca inventada: Xyz"], modelError: "invalido", at: at(6) });
  await s.logQuoteShadow({ phone: "51900000001", text: "4 llantas", rules: view, model: view, diffs: [{ campo: "cliente" }] as never, rejected: [], at: at(7) });
  trace("shadow.list", (await s.listQuoteShadow({ since: at(0) })).map(({ id: _i, ...r }) => r));

  // ── marcas de Drive y borrar proveedor ──
  await s.setSyncMark("drive-a", "2026-10-06T00:00:00Z", "Llantas del Sur");
  await s.setSyncMark("drive-a", "2026-10-07T00:00:00Z");
  await s.setSyncMark("drive-b", "2026-10-07T00:00:00Z", "JCH");
  trace("sync.marks", await s.getSyncMarks());
  trace("provider.delete", await s.deleteProvider("llantas del sur"));
  trace("provider.after", [(await s.providers()).map((p) => p.provider), await s.getSyncMarks(), await s.deleteProvider("Nadie")]);
}

describe("store del cotizador: JSON y Postgres dan lo mismo", () => {
  it("todas las escrituras y sus lecturas", async () => {
    const { json, pg: p } = await bothTraces<PriceStore>(JsonStore.memory(), pg, scenario);
    expect(diffTraces(json, p)).toEqual([]);
  });
});

describe("numeración de cotizaciones en paralelo", () => {
  it("contador global: 25 a la vez, sin repetidos ni huecos", async () => {
    const base = await pg.nextQuoteCounter(1);
    const got = await Promise.all(Array.from({ length: 25 }, () => pg.nextQuoteCounter(1)));
    expect([...got].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => base + 1 + i));
  });

  it("primera cotización de un vendedor, varias a la vez: sin repetidos", async () => {
    for (let round = 0; round < 3; round++) {
      const key = quoteCounterKey(`5190000${round}777`);
      const got = await Promise.all(Array.from({ length: 12 }, () => pg.nextQuoteCounter(1, key)));
      expect(new Set(got).size).toBe(got.length);
      // y la siguiente sigue después de todas
      expect(await pg.nextQuoteCounter(1, key)).toBeGreaterThan(Math.max(...got));
    }
  });

  it("primera cotización de un vendedor desde varias instancias a la vez (como Vercel): sin repetidos", async () => {
    // cada instancia de la función tiene su propio pool: las consultas de una llamada se intercalan con las de otra
    const others = await Promise.all([PgStore.connect(testDbUrl()), PgStore.connect(testDbUrl())]);
    const stores = [pg, ...others];
    try {
      const dups: string[] = [];
      for (let round = 0; round < 15; round++) {
        const key = quoteCounterKey(`5197${String(round).padStart(2, "0")}00000`);
        const got = await Promise.all(Array.from({ length: 9 }, (_, i) => new Promise<number>((ok, ko) => setTimeout(() => stores[i % 3].nextQuoteCounter(1, key).then(ok, ko), (i * 7) % 5))));
        if (new Set(got).size !== got.length) dups.push(`${key}: ${got.join(",")}`);
      }
      expect(dups).toEqual([]);
    } finally {
      await Promise.all(others.map((s) => s.close()));
    }
  });

  it("vendedores distintos a la vez: cada uno sin repetidos en su contador", async () => {
    const keys = ["51911111111", "51922222222", "51933333333"].map(quoteCounterKey);
    const calls = keys.flatMap((k) => Array.from({ length: 8 }, () => k));
    const got = await Promise.all(calls.map((k) => pg.nextQuoteCounter(1, k).then((n) => [k, n] as const)));
    for (const k of keys) {
      const mine = got.filter(([kk]) => kk === k).map(([, n]) => n);
      expect(new Set(mine).size).toBe(mine.length);
    }
  });
});

describe("transacciones del cotizador", () => {
  it("carga de lista que falla a la mitad: no borra la lista anterior", async () => {
    const rows = (await sampleRows()).map((r) => ({ ...r, provider: "Falla SAC", id: `falla-${r.id}` }));
    await pg.upsertRows(rows, { replace: { provider: "Falla SAC" } });
    const broken = rows.map((r, i) => (i === 3 ? { ...r, cost: "no-es-numero" as unknown as number } : r));
    await expect(pg.upsertRows(broken, { replace: { provider: "Falla SAC" } })).rejects.toThrow();
    expect((await pg.providers()).find((p) => p.provider === "Falla SAC")?.rows).toBe(rows.length);
    // la conexión volvió al pool limpia: varias consultas a la vez siguen funcionando
    const n = await Promise.all(Array.from({ length: 10 }, () => pg.getRows([rows[0].id])));
    expect(n.every((x) => x.length === 1)).toBe(true);
  });

  it("dos cargas de la misma lista a la vez terminan con una sola copia", async () => {
    const rows = (await sampleRows()).map((r) => ({ ...r, provider: "Paralelo SAC", id: `par-${r.id}` }));
    await Promise.all([pg.upsertRows(rows, { replace: { provider: "Paralelo SAC" } }), pg.upsertRows(rows, { replace: { provider: "Paralelo SAC" } })]);
    expect((await pg.providers()).find((p) => p.provider === "Paralelo SAC")?.rows).toBe(rows.length);
  });

  it("procesados: el mismo mensaje 10 veces a la vez se atiende una sola vez", async () => {
    const r = await Promise.all(Array.from({ length: 10 }, () => pg.markProcessed("wamid.paralelo")));
    expect(r.filter(Boolean)).toHaveLength(1);
  });
});

describe("topes del día leídos de Postgres", () => {
  afterEach(() => __setLimitsForTests(null));
  const base = loadPortalConfig().limits;

  for (const kind of ["json", "pg"] as const) {
    it(`modelo y voz: registra, lee de vuelta y corta en el tope (${kind})`, async () => {
      __setLimitsForTests({ ...base, perUserDaily: { llmCalls: 2, llmTokens: 1_000_000, audioMinutes: 1 }, globalDaily: { llmCalls: 1000, llmTokens: 100_000_000, audioMinutes: 1000 } });
      const store: PriceStore = kind === "pg" ? pg : JsonStore.memory();
      const phone = kind === "pg" ? "51955500001" : "51955500002";
      const admin: string[] = [];
      const ctx: UsageContext = { phone, sink: store, notices: new Set(), notifyAdmin: async (t) => void admin.push(t) };
      const call = async () => ({ usage: { input_tokens: 100, output_tokens: 20 } });
      await runWithUsage(ctx, () => meteredModelCall("reporte", "claude-haiku-4-5-20251001", call));
      await runWithUsage(ctx, () => meteredModelCall("reporte", "claude-haiku-4-5-20251001", call));
      expect(await runWithUsage(ctx, () => modelBudgetOk("reporte"))).toBe(false);
      await expect(runWithUsage(ctx, () => meteredModelCall("reporte", "claude-haiku-4-5-20251001", call))).rejects.toBeInstanceOf(UsageCapExceeded);
      expect(await runWithUsage(ctx, () => audioBudget(30))).toBeNull();
      await runWithUsage(ctx, () => recordAudio(45, "nova-3"));
      expect(await runWithUsage(ctx, () => audioBudget(30))).toBe(VOICE_CAP_REPLY);
      const mine = (await store.usageSummary(new Date(Date.now() - 3600_000))).filter((r) => r.phone === phone);
      expect(mine.reduce((n, r) => n + r.llmCalls, 0)).toBe(2);
      expect(mine.reduce((n, r) => n + r.audioSeconds, 0)).toBe(45);
      expect(ctx.notices.size).toBe(1);
    });
  }
});
