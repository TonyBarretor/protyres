/**
 * File-backed store for local use and the CLI (./data/store.json).
 * Good enough for a single-process pilot; the deployed bot uses Postgres (see pg-store.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { PriceRow } from "../ingest/types";
import type { Quote } from "../quote/types";
import type { ConversationState, PriceStore, ProviderSummary, ReplaceScope } from "./types";

interface Data {
  prices: Record<string, PriceRow>;
  quotes: Record<string, Quote>;
  conversations: Record<string, ConversationState>;
  counters: { quote: number };
  processed: string[];
  syncMarks: Record<string, string>;
}

const EMPTY: Data = { prices: {}, quotes: {}, conversations: {}, counters: { quote: 0 }, processed: [], syncMarks: {} };

export class JsonStore implements PriceStore {
  private data: Data;
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * `file` is the writable store. On a read-only deployment (Vercel) writes fall back to the OS temp dir,
   * and a bundled read-only seed (data/seed.json, produced by `npm run ingest`) provides the initial prices.
   */
  constructor(private file: string | null, seed: string | null = null) {
    this.data = structuredClone(EMPTY);
    if (!file) return;
    const tmp = JsonStore.tmpPathFor(file);
    const candidates = [tmp, file, seed].filter((f): f is string => !!f && fs.existsSync(f));
    for (const f of candidates) {
      try {
        this.data = { ...structuredClone(EMPTY), ...JSON.parse(JsonStore.readMaybeGz(f)) };
        if (f === tmp) this.file = tmp;
        return;
      } catch {
        if (f !== seed) fs.copyFileSync(f, `${f}.corrupt-${Date.now()}`); // corrupt file: keep a backup, try the next
      }
    }
  }

  private static readMaybeGz(f: string): string {
    const buf = fs.readFileSync(f);
    return f.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  }

  static tmpPathFor(file: string): string {
    return path.join(os.tmpdir(), `protyres-${path.basename(file)}`);
  }

  /** In-memory store (tests). */
  static memory(): JsonStore {
    return new JsonStore(null);
  }

  private persist(): void {
    if (!this.file) return;
    try {
      this.writeTo(this.file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EROFS" && code !== "EACCES" && code !== "EPERM") throw err;
      this.file = JsonStore.tmpPathFor(this.file); // read-only filesystem: keep state in the temp dir
      this.writeTo(this.file);
    }
  }

  private writeTo(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, file);
  }

  private run<T>(fn: () => T): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  upsertRows(rows: PriceRow[], opts?: { replace?: ReplaceScope }): Promise<{ inserted: number; removed: number }> {
    return this.run(() => {
      let removed = 0;
      if (opts?.replace) {
        const r = opts.replace;
        for (const [id, row] of Object.entries(this.data.prices)) {
          if (row.provider === r.provider && (!r.sourceRef || row.sourceRef.split("#")[0] === r.sourceRef) && (!r.source || row.source === r.source) && (!r.kind || row.kind === r.kind)) {
            delete this.data.prices[id];
            removed++;
          }
        }
      }
      for (const row of rows) this.data.prices[row.id] = row;
      this.persist();
      return { inserted: rows.length, removed };
    });
  }

  allRows(): Promise<PriceRow[]> {
    return this.run(() => Object.values(this.data.prices));
  }

  findBySize(canonicals: string[]): Promise<PriceRow[]> {
    const set = new Set(canonicals);
    return this.run(() => Object.values(this.data.prices).filter((r) => set.has(r.size)));
  }

  getRows(ids: string[]): Promise<PriceRow[]> {
    return this.run(() => ids.map((id) => this.data.prices[id]).filter((r): r is PriceRow => !!r));
  }

  providers(): Promise<ProviderSummary[]> {
    return this.run(() => {
      const map = new Map<string, ProviderSummary & { sourceSet: Set<string> }>();
      for (const r of Object.values(this.data.prices)) {
        const key = `${r.provider}|${r.kind}`;
        const cur = map.get(key) ?? { provider: r.provider, kind: r.kind, rows: 0, sources: [], lastPriceDate: "", sourceSet: new Set<string>() };
        cur.rows++;
        cur.sourceSet.add(r.source);
        if (r.priceDate > cur.lastPriceDate) cur.lastPriceDate = r.priceDate;
        map.set(key, cur);
      }
      return [...map.values()].map(({ sourceSet, ...p }) => ({ ...p, sources: [...sourceSet] }));
    });
  }

  nextQuoteCounter(start = 1): Promise<number> {
    return this.run(() => {
      if (this.data.counters.quote < start - 1) this.data.counters.quote = start - 1;
      this.data.counters.quote += 1;
      this.persist();
      return this.data.counters.quote;
    });
  }

  saveQuote(quote: Quote): Promise<void> {
    return this.run(() => {
      this.data.quotes[quote.number] = quote;
      this.persist();
    });
  }

  getQuote(number: string): Promise<Quote | null> {
    return this.run(() => this.data.quotes[number] ?? null);
  }

  listQuotes(limit = 50): Promise<Quote[]> {
    return this.run(() => Object.values(this.data.quotes).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit));
  }

  getConversation(phone: string): Promise<ConversationState | null> {
    return this.run(() => this.data.conversations[phone] ?? null);
  }

  setConversation(phone: string, state: ConversationState | null): Promise<void> {
    return this.run(() => {
      if (state) this.data.conversations[phone] = state;
      else delete this.data.conversations[phone];
      this.persist();
    });
  }

  markProcessed(messageId: string): Promise<boolean> {
    return this.run(() => {
      if (this.data.processed.includes(messageId)) return false;
      this.data.processed.push(messageId);
      if (this.data.processed.length > 2000) this.data.processed.splice(0, this.data.processed.length - 2000);
      this.persist();
      return true;
    });
  }

  getSyncMarks(): Promise<Record<string, string>> {
    return this.run(() => ({ ...this.data.syncMarks }));
  }

  setSyncMark(fileId: string, modifiedTime: string): Promise<void> {
    return this.run(() => {
      this.data.syncMarks[fileId] = modifiedTime;
      this.persist();
    });
  }

  async close(): Promise<void> {
    await this.queue;
  }
}
