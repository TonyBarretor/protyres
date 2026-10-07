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
import type { PriceStore } from "./types";

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
    await c`truncate prices, quotes, conversations, counters, processed_messages, sync_marks`;
    await c.end();
    return s;
  });
} else {
  describe.skip("postgres store (set TEST_DATABASE_URL)", () => {
    it("skipped", () => {});
  });
}
