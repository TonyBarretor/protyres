/**
 * Store contract tests. The JSON store always runs; the Postgres store runs when TEST_DATABASE_URL is set,
 * e.g.  TEST_DATABASE_URL=postgres://postgres@localhost:5433/protyres npm test
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestExcel } from "../ingest/tabular";
import { SettingsSchema } from "../settings";
import { buildQuote, itemFromCandidate } from "../quote/build";
import { rankLine } from "../quote/match";
import { parseRequestRegex } from "../quote/request";
import { JsonStore } from "./json-store";
import { quoteCounterKey, type PriceStore } from "./types";

const settings = SettingsSchema.parse({ company: { name: "X" }, pricing: {}, quote: {} });

function contract(name: string, make: () => Promise<PriceStore>) {
  describe(`${name} store`, () => {
    let store: PriceStore;
    beforeAll(async () => {
      store = await make();
    });
    afterAll(async () => {
      await store.close();
    });

    it("upserts, replaces by source, queries", async () => {
      const res = await ingestExcel(fs.readFileSync(path.resolve(process.cwd(), "samples/proveedor-a-lista.xlsx")), { provider: "Llantas del Sur", sourceRef: "a.xlsx", priceDate: "2026-10-01" });
      const first = await store.upsertRows(res.rows, { replace: { provider: "Llantas del Sur", sourceRef: "a.xlsx" } });
      expect(first.inserted).toBe(res.rows.length);
      // same file again -> old rows removed, same count inserted
      const again = await store.upsertRows(res.rows, { replace: { provider: "Llantas del Sur", sourceRef: "a.xlsx" } });
      expect(again.removed).toBe(res.rows.length);
      const all = await store.allRows();
      expect(all.length).toBe(res.rows.length);
      const by = await store.findBySize(["11R22.5"]);
      expect(by.length).toBeGreaterThanOrEqual(3);
      expect(by.every((r) => r.size === "11R22.5")).toBe(true);
      const got = await store.getRows([by[0].id, "nope"]);
      expect(got.length).toBe(1);
      expect(got[0].cost).toBe(by[0].cost);
      const p = await store.providers();
      expect(p.find((x) => x.provider === "Llantas del Sur")?.rows).toBe(res.rows.length);
      expect(p[0].kind).toBe("provider");
      expect(p[0].lastPriceDate).toBe("2026-10-01");
    });

    it("quote numbers, quotes, conversations, processed ids, sync marks", async () => {
      const c1 = await store.nextQuoteCounter(16);
      const c2 = await store.nextQuoteCounter(16);
      expect(c1).toBe(16);
      expect(c2).toBe(17);
      const n1 = `T-${c1}`;
      const rows = await store.findBySize(["11R22.5"]);
      const req = parseRequestRegex("11R22.5 x2 para A, a@b.com");
      const cands = rankLine(rows, req.lines[0], req, settings.pricing, { today: "2026-10-06" });
      const quote = buildQuote({ number: n1, request: req, items: [itemFromCandidate(cands[0], 2, settings)], settings, today: "2026-10-06" });
      await store.saveQuote(quote);
      quote.status = "sent";
      quote.sentAt = new Date().toISOString();
      await store.saveQuote(quote);
      expect((await store.getQuote(n1))?.status).toBe("sent");
      expect((await store.listQuotes(5)).some((q) => q.number === n1)).toBe(true);

      await store.setConversation("519", { phone: "519", step: "choose", pending: [{ candidateIds: ["a"], chosen: 0, quantity: 1 }], updatedAt: "x" });
      expect((await store.getConversation("519"))?.step).toBe("choose");
      await store.setConversation("519", null);
      expect(await store.getConversation("519")).toBeNull();

      const id = `m-${Date.now()}`;
      expect(await store.markProcessed(id)).toBe(true);
      expect(await store.markProcessed(id)).toBe(false);

      await store.setSyncMark("f1", "2026-10-06T00:00:00Z");
      await store.setSyncMark("f1", "2026-10-07T00:00:00Z");
      expect((await store.getSyncMarks()).f1).toBe("2026-10-07T00:00:00Z");
    });

    it("per-salesman quote counters fall back to the global one, and can be set", async () => {
      const g = await store.nextQuoteCounter(16); // global counter, whatever came before
      const a1 = await store.nextQuoteCounter(16, quoteCounterKey("51955344340")); // no own counter yet: next global value
      expect(a1).toBe(g + 1);
      const b1 = await store.nextQuoteCounter(16, quoteCounterKey("51903162116")); // another salesman: takes the next global, no clash
      expect(b1).toBe(g + 2);
      expect(await store.nextQuoteCounter(16, quoteCounterKey("51955344340"))).toBe(a1 + 1); // own counter from now on
      await store.setQuoteCounter(451, quoteCounterKey("51955344340"));
      expect(await store.nextQuoteCounter(16, quoteCounterKey("51955344340"))).toBe(452);
      expect(await store.nextQuoteCounter(16, quoteCounterKey("51903162116"))).toBe(b1 + 1); // untouched
    });

    it("lists quotes by company and salesman, stores sent files, deletes quotes", async () => {
      const rows = await store.findBySize(["11R22.5"]);
      const make = async (number: string, text: string, by: string, createdAt: string) => {
        const req = parseRequestRegex(text);
        const cands = rankLine(rows, req.lines[0], req, settings.pricing, { today: "2026-10-06" });
        const q = buildQuote({ number, request: req, items: [itemFromCandidate(cands[0], 1, settings)], settings, today: "2026-10-06", requestedBy: by });
        q.createdAt = createdAt;
        await store.saveQuote(q);
        return q;
      };
      await make("L-1", "11R22.5 x1 para PROSEGUR SA, a@prosegur.pe", "51955344340", "2026-10-10T10:00:00Z");
      await make("L-2", "11R22.5 x1 para Transportes ABC SAC, b@abc.pe", "51955344340", "2026-10-11T10:00:00Z");
      await make("L-3", "11R22.5 x1 para Prosegur S.A., c@prosegur.pe", "51903162116", "2026-10-12T10:00:00Z");
      expect((await store.listQuotes({ company: "prosegur" })).map((q) => q.number)).toEqual(["L-3", "L-1"]);
      expect((await store.listQuotes({ company: "PROSEGUR S.A." })).map((q) => q.number)).toEqual(["L-3", "L-1"]);
      expect((await store.listQuotes({ requestedBy: "51955344340", limit: 1 })).map((q) => q.number)).toEqual(["L-2"]);
      expect((await store.listQuotes({ company: "Prosegur", requestedBy: "51955344340" })).map((q) => q.number)).toEqual(["L-1"]);

      await store.saveQuoteFile({ quoteNumber: "L-1", kind: "xlsx", fileName: "a.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: Buffer.from("x1").toString("base64") });
      await store.saveQuoteFile({ quoteNumber: "L-1", kind: "pdf", fileName: "L-1.pdf", mimeType: "application/pdf", data: Buffer.from("p1").toString("base64") });
      await store.saveQuoteFile({ quoteNumber: "L-1", kind: "pdf", fileName: "L-1 bis.pdf", mimeType: "application/pdf", data: Buffer.from("p2").toString("base64") }); // resend: replaced
      const files = await store.getQuoteFiles("L-1");
      expect(files.map((f) => [f.kind, f.fileName, Buffer.from(f.data, "base64").toString()])).toEqual([
        ["pdf", "L-1 bis.pdf", "p2"],
        ["xlsx", "a.xlsx", "x1"],
      ]);
      await store.deleteQuote("L-1");
      expect(await store.getQuote("L-1")).toBeNull();
      expect(await store.getQuoteFiles("L-1")).toEqual([]);
    });

    it("deletes a provider's rows (name matched loosely) and its Drive sync marks", async () => {
      const res = await ingestExcel(fs.readFileSync(path.resolve(process.cwd(), "samples/proveedor-a-lista.xlsx")), { provider: "Llantas del Sur", sourceRef: "a.xlsx", priceDate: "2026-10-01" });
      await store.upsertRows(res.rows, { replace: { provider: "Llantas del Sur", sourceRef: "a.xlsx" } });
      await store.setSyncMark("drive-a", "2026-10-07T00:00:00Z", "Llantas del Sur");
      await store.setSyncMark("drive-b", "2026-10-07T00:00:00Z", "JCH");
      const out = await store.deleteProvider("llantas del sur");
      expect(out).toEqual({ rows: res.rows.length, syncMarks: 1 });
      expect((await store.providers()).some((p) => p.provider === "Llantas del Sur")).toBe(false);
      const marks = await store.getSyncMarks();
      expect(marks["drive-a"]).toBeUndefined();
      expect(marks["drive-b"]).toBe("2026-10-07T00:00:00Z");
      expect(await store.deleteProvider("Nadie")).toEqual({ rows: 0, syncMarks: 0 });
    });
  });
}

contract("json", async () => JsonStore.memory());

const url = process.env.TEST_DATABASE_URL;
if (url) {
  contract("postgres", async () => {
    const { PgStore } = await import("./pg-store");
    const s = await PgStore.connect(url);
    // clean slate
    const postgres = (await import("postgres")).default;
    const c = postgres(url);
    await c`truncate prices, quotes, conversations, counters, processed_messages, sync_marks, quote_files`;
    await c.end();
    return s;
  });
} else {
  describe.skip("postgres store (set TEST_DATABASE_URL)", () => {
    it("skipped", () => {});
  });
}
