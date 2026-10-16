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
import { foldKey, photoKey, type ConversationState, type ListQuotesOptions, type PriceStore, type ProductPhoto, type ProviderSummary, type QuoteFile, type ReplaceScope, type StoredContractItem } from "./types";

interface Data {
  prices: Record<string, PriceRow>;
  quotes: Record<string, Quote>;
  conversations: Record<string, ConversationState>;
  /** "quote" (global) and "quote:<phone>" (per salesman) */
  counters: Record<string, number>;
  processed: string[];
  syncMarks: Record<string, string>;
  /** Drive file id -> provider of the file (to clear its mark when the provider is deleted). */
  syncProviders: Record<string, string>;
  photos: Record<string, ProductPhoto>;
  /** "<quote number>|<kind>" -> document */
  quoteFiles: Record<string, QuoteFile>;
  /** "<customer>|<item id>" -> contract item (overrides config/customers.json) */
  contractPrices: Record<string, StoredContractItem & { customer: string }>;
}

const EMPTY: Data = { prices: {}, quotes: {}, conversations: {}, counters: { quote: 0 }, processed: [], syncMarks: {}, syncProviders: {}, photos: {}, quoteFiles: {}, contractPrices: {} };

const digits = (s: string | undefined) => (s ?? "").replace(/\D/g, "");

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

  rowsWithPhoto(brand: string, model: string): Promise<PriceRow[]> {
    const key = photoKey(brand, model);
    if (key.startsWith("|") || key.endsWith("|")) return Promise.resolve([]);
    return this.run(() => Object.values(this.data.prices).filter((r) => r.photoUrl && photoKey(r.brand, r.model) === key).slice(0, 5));
  }

  getPhoto(brand: string, model: string): Promise<ProductPhoto | null> {
    return this.getPhotoByKey(photoKey(brand, model));
  }

  getPhotoByKey(key: string): Promise<ProductPhoto | null> {
    return this.run(() => this.data.photos[key] ?? null);
  }

  setPhoto(photo: ProductPhoto): Promise<void> {
    return this.run(() => {
      this.data.photos[photo.key] = photo;
      this.persist();
    });
  }

  photoKeys(): Promise<Set<string>> {
    return this.run(() => new Set(Object.keys(this.data.photos)));
  }

  findLastQuoteForCustomer(opts: { email?: string; company?: string; unit?: string }): Promise<Quote | null> {
    return this.run(() => {
      const email = opts.email?.toLowerCase();
      const company = opts.company?.toLowerCase();
      const unit = opts.unit ? foldKey(opts.unit) : "";
      if (!email && !company) return null;
      const hits = Object.values(this.data.quotes)
        .filter((q) => (email && q.customer.email?.toLowerCase() === email) || (company && q.customer.company?.toLowerCase() === company))
        .filter((q) => !unit || foldKey(q.unit) === unit)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return hits[0] ?? null;
    });
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

  deleteProvider(name: string): Promise<{ rows: number; syncMarks: number }> {
    const key = foldKey(name);
    return this.run(() => {
      let rows = 0;
      let syncMarks = 0;
      for (const [id, row] of Object.entries(this.data.prices)) {
        if (foldKey(row.provider) !== key) continue;
        delete this.data.prices[id];
        rows++;
      }
      for (const [fileId, provider] of Object.entries(this.data.syncProviders)) {
        if (foldKey(provider) !== key) continue;
        delete this.data.syncProviders[fileId];
        if (fileId in this.data.syncMarks) syncMarks++;
        delete this.data.syncMarks[fileId];
      }
      if (rows || syncMarks) this.persist();
      return { rows, syncMarks };
    });
  }

  nextQuoteCounter(start = 1, key?: string): Promise<number> {
    return this.run(() => {
      const c = this.data.counters;
      const bump = (name: string) => (c[name] = Math.max(c[name] ?? 0, start - 1) + 1);
      let value: number;
      if (key && key !== "quote" && c[key] !== undefined) value = bump(key);
      else {
        // first quote of this salesman: continue from the global counter (and advance it)
        value = bump("quote");
        if (key) c[key] = value;
      }
      this.persist();
      return value;
    });
  }

  setQuoteCounter(value: number, key = "quote"): Promise<void> {
    return this.run(() => {
      this.data.counters[key] = value;
      this.persist();
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

  deleteQuote(number: string): Promise<void> {
    return this.run(() => {
      delete this.data.quotes[number];
      for (const k of Object.keys(this.data.quoteFiles)) if (this.data.quoteFiles[k].quoteNumber === number) delete this.data.quoteFiles[k];
      this.persist();
    });
  }

  listQuotes(opts: number | ListQuotesOptions = {}): Promise<Quote[]> {
    const o: ListQuotesOptions = typeof opts === "number" ? { limit: opts } : opts;
    const company = o.company ? foldKey(o.company) : "";
    const by = o.requestedBy ? digits(o.requestedBy) : "";
    return this.run(() =>
      Object.values(this.data.quotes)
        .filter((q) => (!company || foldKey(q.customer.company).includes(company)) && (!by || digits(q.requestedBy) === by))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, o.limit ?? 50),
    );
  }

  saveQuoteFile(file: QuoteFile): Promise<void> {
    return this.run(() => {
      this.data.quoteFiles[`${file.quoteNumber}|${file.kind}`] = { ...file, createdAt: file.createdAt ?? new Date().toISOString() };
      this.persist();
    });
  }

  getQuoteFiles(quoteNumber: string): Promise<QuoteFile[]> {
    return this.run(() =>
      Object.values(this.data.quoteFiles)
        .filter((f) => f.quoteNumber === quoteNumber)
        .sort((a, b) => (a.kind < b.kind ? -1 : 1)),
    );
  }

  getContractItems(customer: string): Promise<StoredContractItem[]> {
    return this.run(() =>
      Object.values(this.data.contractPrices)
        .filter((r) => r.customer === customer)
        .map(({ customer: _c, ...item }) => structuredClone(item))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  }

  setContractItem(customer: string, item: StoredContractItem): Promise<void> {
    return this.run(() => {
      const id = item.id.trim().toLowerCase();
      this.data.contractPrices[`${customer}|${id}`] = { ...structuredClone(item), id, customer, updatedAt: item.updatedAt ?? new Date().toISOString() };
      this.persist();
    });
  }

  deleteContractItem(customer: string, itemId: string): Promise<boolean> {
    return this.run(() => {
      const key = `${customer}|${itemId.trim().toLowerCase()}`;
      if (!(key in this.data.contractPrices)) return false;
      delete this.data.contractPrices[key];
      this.persist();
      return true;
    });
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

  setSyncMark(fileId: string, modifiedTime: string, provider?: string): Promise<void> {
    return this.run(() => {
      this.data.syncMarks[fileId] = modifiedTime;
      if (provider) this.data.syncProviders[fileId] = provider;
      this.persist();
    });
  }

  async close(): Promise<void> {
    await this.queue;
  }
}
