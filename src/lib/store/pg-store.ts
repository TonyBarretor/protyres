/**
 * Postgres store (Supabase) via Drizzle. Create the tables with `npm run db:push`.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../db/schema";
import type { PriceRow, PriceSource } from "../ingest/types";
import type { Quote } from "../quote/types";
import { foldKey, photoKey, type ConversationState, type ListQuotesOptions, type PriceStore, type ProductPhoto, type ProviderSummary, type QuoteFile, type ReplaceScope } from "./types";

type Db = PostgresJsDatabase<typeof schema>;

function toRow(r: typeof schema.prices.$inferSelect): PriceRow {
  return {
    id: r.id,
    provider: r.provider,
    kind: r.kind as PriceRow["kind"],
    code: r.code ?? undefined,
    description: r.description,
    brand: r.brand,
    model: r.model,
    size: r.size,
    sizeDisplay: r.sizeDisplay,
    sizeRaw: r.sizeRaw,
    isTyre: r.isTyre,
    loadIndex: r.loadIndex ?? undefined,
    speedIndex: r.speedIndex ?? undefined,
    ply: r.ply ?? undefined,
    position: (r.position as PriceRow["position"]) ?? undefined,
    tube: (r.tube as PriceRow["tube"]) ?? undefined,
    cost: r.cost === null ? null : Number(r.cost),
    priceIncludesTax: r.priceIncludesTax,
    maxDiscountPct: r.maxDiscountPct === null ? undefined : Number(r.maxDiscountPct),
    currency: r.currency,
    stock: r.stock,
    priceDate: r.priceDate,
    source: r.source as PriceSource,
    sourceRef: r.sourceRef,
    notes: r.notes ?? undefined,
    photoUrl: r.photoUrl ?? undefined,
    sheetUrl: r.sheetUrl ?? undefined,
    raw: r.raw ?? undefined,
  };
}

/** SQL twin of foldKey(): lower case, accents removed, only a-z0-9 ("Prosegur S.A." -> "prosegursa"). */
const FOLD = (col: unknown) => sql`regexp_replace(translate(lower(${col}), 'áàäâãéèëêíìïîóòöôõúùüûñç', 'aaaaaeeeeiiiiooooouuuunc'), '[^a-z0-9]', '', 'g')`;

/** Postgres "undefined column" (a column added by `npm run db:migrate` that has not been applied yet); Drizzle wraps it in `cause`. */
const isMissingColumn = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return (e?.code ?? e?.cause?.code) === "42703";
};

export class PgStore implements PriceStore {
  private constructor(
    private db: Db,
    private sqlClient: ReturnType<typeof postgres>,
  ) {}

  static async connect(url: string): Promise<PgStore> {
    const client = postgres(url, { prepare: false, max: 5 }); // prepare:false works with Supabase's pooler
    const db = drizzle(client, { schema });
    return new PgStore(db, client);
  }

  async upsertRows(rows: PriceRow[], opts?: { replace?: ReplaceScope }): Promise<{ inserted: number; removed: number }> {
    let removed = 0;
    await this.db.transaction(async (tx) => {
      if (opts?.replace) {
        const r = opts.replace;
        const conds = [eq(schema.prices.provider, r.provider)];
        if (r.sourceRef) conds.push(sql`split_part(${schema.prices.sourceRef}, '#', 1) = ${r.sourceRef}`);
        if (r.source) conds.push(eq(schema.prices.source, r.source));
        if (r.kind) conds.push(eq(schema.prices.kind, r.kind));
        const del = await tx.delete(schema.prices).where(and(...conds)).returning({ id: schema.prices.id });
        removed = del.length;
      }
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200).map((r) => ({
          id: r.id,
          provider: r.provider,
          kind: r.kind,
          code: r.code ?? null,
          description: r.description,
          brand: r.brand,
          model: r.model,
          size: r.size,
          sizeDisplay: r.sizeDisplay,
          sizeRaw: r.sizeRaw,
          isTyre: r.isTyre,
          loadIndex: r.loadIndex ?? null,
          speedIndex: r.speedIndex ?? null,
          ply: r.ply ?? null,
          position: r.position ?? null,
          tube: r.tube ?? null,
          cost: r.cost === null ? null : r.cost.toFixed(2),
          priceIncludesTax: r.priceIncludesTax,
          maxDiscountPct: r.maxDiscountPct === undefined ? null : r.maxDiscountPct.toFixed(2),
          currency: r.currency,
          stock: r.stock,
          priceDate: r.priceDate,
          source: r.source,
          sourceRef: r.sourceRef,
          notes: r.notes ?? null,
          photoUrl: r.photoUrl ?? null,
          sheetUrl: r.sheetUrl ?? null,
          raw: r.raw ?? null,
          updatedAt: new Date(),
        }));
        if (chunk.length === 0) continue;
        await tx
          .insert(schema.prices)
          .values(chunk)
          .onConflictDoUpdate({
            target: schema.prices.id,
            set: {
              description: sql`excluded.description`,
              brand: sql`excluded.brand`,
              model: sql`excluded.model`,
              size: sql`excluded.size`,
              sizeDisplay: sql`excluded.size_display`,
              sizeRaw: sql`excluded.size_raw`,
              isTyre: sql`excluded.is_tyre`,
              cost: sql`excluded.cost`,
              priceIncludesTax: sql`excluded.price_includes_tax`,
              maxDiscountPct: sql`excluded.max_discount_pct`,
              currency: sql`excluded.currency`,
              stock: sql`excluded.stock`,
              priceDate: sql`excluded.price_date`,
              sourceRef: sql`excluded.source_ref`,
              loadIndex: sql`excluded.load_index`,
              speedIndex: sql`excluded.speed_index`,
              ply: sql`excluded.ply`,
              position: sql`excluded.position`,
              tube: sql`excluded.tube`,
              notes: sql`excluded.notes`,
              photoUrl: sql`excluded.photo_url`,
              sheetUrl: sql`excluded.sheet_url`,
              raw: sql`excluded.raw`,
              updatedAt: sql`now()`,
            },
          });
      }
    });
    return { inserted: rows.length, removed };
  }

  async allRows(): Promise<PriceRow[]> {
    return (await this.db.select().from(schema.prices)).map(toRow);
  }

  async findBySize(canonicals: string[]): Promise<PriceRow[]> {
    if (canonicals.length === 0) return [];
    return (await this.db.select().from(schema.prices).where(inArray(schema.prices.size, canonicals))).map(toRow);
  }

  async getRows(ids: string[]): Promise<PriceRow[]> {
    if (ids.length === 0) return [];
    return (await this.db.select().from(schema.prices).where(inArray(schema.prices.id, ids))).map(toRow);
  }

  async rowsWithPhoto(brand: string, model: string): Promise<PriceRow[]> {
    const [b, m] = photoKey(brand, model).split("|");
    if (!b || !m) return [];
    const rows = await this.db
      .select()
      .from(schema.prices)
      .where(and(sql`${schema.prices.photoUrl} is not null`, sql`${FOLD(schema.prices.brand)} = ${b}`, sql`${FOLD(schema.prices.model)} = ${m}`))
      .limit(5);
    return rows.map(toRow);
  }

  async getPhoto(brand: string, model: string): Promise<ProductPhoto | null> {
    const [row] = await this.db.select().from(schema.photos).where(eq(schema.photos.key, photoKey(brand, model))).limit(1);
    if (!row) return null;
    return {
      key: row.key,
      brand: row.brand,
      model: row.model,
      url: row.url ?? undefined,
      data: row.data ?? undefined,
      mimeType: row.mimeType ?? undefined,
      sheetUrl: row.sheetUrl ?? undefined,
      sheetData: row.sheetData ?? undefined,
      source: row.source as ProductPhoto["source"],
      origin: row.origin ?? undefined,
      code: row.code ?? undefined,
      addedBy: row.addedBy ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async setPhoto(p: ProductPhoto): Promise<void> {
    const values = { key: p.key, brand: p.brand, model: p.model, url: p.url ?? null, data: p.data ?? null, mimeType: p.mimeType ?? null, sheetUrl: p.sheetUrl ?? null, sheetData: p.sheetData ?? null, source: p.source, origin: p.origin ?? null, code: p.code ?? null, addedBy: p.addedBy ?? null, createdAt: new Date(p.createdAt) };
    await this.db
      .insert(schema.photos)
      .values(values)
      .onConflictDoUpdate({ target: schema.photos.key, set: { ...values, createdAt: new Date() } });
  }

  async photoKeys(): Promise<Set<string>> {
    const rows = await this.db.select({ key: schema.photos.key }).from(schema.photos);
    return new Set(rows.map((r) => r.key));
  }

  async findLastQuoteForCustomer(opts: { email?: string; company?: string }): Promise<Quote | null> {
    const conds = [];
    if (opts.email) conds.push(sql`lower(${schema.quotes.customerEmail}) = ${opts.email.toLowerCase()}`);
    if (opts.company) conds.push(sql`lower(${schema.quotes.data}->'customer'->>'company') = ${opts.company.toLowerCase()}`);
    if (conds.length === 0) return null;
    const where = conds.length === 1 ? conds[0] : sql`(${conds[0]}) or (${conds[1]})`;
    const [row] = await this.db.select().from(schema.quotes).where(where).orderBy(desc(schema.quotes.createdAt)).limit(1);
    return row ? (row.data as Quote) : null;
  }

  async providers(): Promise<ProviderSummary[]> {
    const rows = await this.db
      .select({
        provider: schema.prices.provider,
        kind: schema.prices.kind,
        rows: sql<number>`count(*)::int`,
        sources: sql<string[]>`array_agg(distinct ${schema.prices.source})`,
        lastPriceDate: sql<string>`max(${schema.prices.priceDate})`,
      })
      .from(schema.prices)
      .groupBy(schema.prices.provider, schema.prices.kind);
    return rows.map((r) => ({ provider: r.provider, kind: r.kind, rows: Number(r.rows), sources: r.sources ?? [], lastPriceDate: r.lastPriceDate ?? "" }));
  }

  async deleteProvider(name: string): Promise<{ rows: number; syncMarks: number }> {
    const key = foldKey(name);
    if (!key) return { rows: 0, syncMarks: 0 };
    const del = await this.db.delete(schema.prices).where(sql`${FOLD(schema.prices.provider)} = ${key}`).returning({ id: schema.prices.id });
    let syncMarks = 0;
    try {
      const marks = await this.db.delete(schema.syncMarks).where(sql`${FOLD(schema.syncMarks.provider)} = ${key}`).returning({ fileId: schema.syncMarks.fileId });
      syncMarks = marks.length;
    } catch (err) {
      if (!isMissingColumn(err)) throw err;
    }
    return { rows: del.length, syncMarks };
  }

  async nextQuoteCounter(start = 1, key?: string): Promise<number> {
    const s = Math.max(1, start);
    const bump = sql`greatest(${schema.counters.value}, ${s - 1}) + 1`;
    if (key && key !== "quote") {
      // the salesman's own counter, once it exists
      const [own] = await this.db.update(schema.counters).set({ value: bump }).where(eq(schema.counters.name, key)).returning({ value: schema.counters.value });
      if (own) return own.value;
    }
    const [row] = await this.db
      .insert(schema.counters)
      .values({ name: "quote", value: s })
      .onConflictDoUpdate({ target: schema.counters.name, set: { value: bump } })
      .returning({ value: schema.counters.value });
    if (key && key !== "quote") {
      // first quote of this salesman: his counter starts from the global value just taken
      await this.db
        .insert(schema.counters)
        .values({ name: key, value: row.value })
        .onConflictDoUpdate({ target: schema.counters.name, set: { value: sql`greatest(${schema.counters.value}, ${row.value})` } });
    }
    return row.value;
  }

  async setQuoteCounter(value: number, key = "quote"): Promise<void> {
    await this.db.insert(schema.counters).values({ name: key, value }).onConflictDoUpdate({ target: schema.counters.name, set: { value } });
  }

  async saveQuote(quote: Quote): Promise<void> {
    await this.db
      .insert(schema.quotes)
      .values({
        number: quote.number,
        status: quote.status,
        customerEmail: quote.customer.email ?? null,
        total: quote.total.toFixed(2),
        currency: quote.currency,
        requestedBy: quote.requestedBy ?? null,
        data: quote,
        createdAt: new Date(quote.createdAt),
        sentAt: quote.sentAt ? new Date(quote.sentAt) : null,
      })
      .onConflictDoUpdate({
        target: schema.quotes.number,
        set: { status: quote.status, customerEmail: quote.customer.email ?? null, total: quote.total.toFixed(2), data: quote, sentAt: quote.sentAt ? new Date(quote.sentAt) : null },
      });
  }

  async getQuote(number: string): Promise<Quote | null> {
    const [row] = await this.db.select().from(schema.quotes).where(eq(schema.quotes.number, number)).limit(1);
    return row ? (row.data as Quote) : null;
  }

  async deleteQuote(number: string): Promise<void> {
    await this.db.delete(schema.quoteFiles).where(eq(schema.quoteFiles.quoteNumber, number));
    await this.db.delete(schema.quotes).where(eq(schema.quotes.number, number));
  }

  async listQuotes(opts: number | ListQuotesOptions = {}): Promise<Quote[]> {
    const o: ListQuotesOptions = typeof opts === "number" ? { limit: opts } : opts;
    const conds = [];
    if (o.company) conds.push(sql`${FOLD(sql`(${schema.quotes.data}->'customer'->>'company')`)} like ${`%${foldKey(o.company)}%`}`);
    if (o.requestedBy) conds.push(sql`regexp_replace(coalesce(${schema.quotes.requestedBy}, ''), '[^0-9]', '', 'g') = ${o.requestedBy.replace(/\D/g, "")}`);
    const rows = await this.db
      .select()
      .from(schema.quotes)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(schema.quotes.createdAt))
      .limit(o.limit ?? 50);
    return rows.map((r) => r.data as Quote);
  }

  async saveQuoteFile(f: QuoteFile): Promise<void> {
    const createdAt = f.createdAt ? new Date(f.createdAt) : new Date();
    await this.db
      .insert(schema.quoteFiles)
      .values({ quoteNumber: f.quoteNumber, kind: f.kind, fileName: f.fileName, mimeType: f.mimeType, data: f.data, createdAt })
      .onConflictDoUpdate({ target: [schema.quoteFiles.quoteNumber, schema.quoteFiles.kind], set: { fileName: f.fileName, mimeType: f.mimeType, data: f.data, createdAt } });
  }

  async getQuoteFiles(quoteNumber: string): Promise<QuoteFile[]> {
    const rows = await this.db.select().from(schema.quoteFiles).where(eq(schema.quoteFiles.quoteNumber, quoteNumber)).orderBy(schema.quoteFiles.kind);
    return rows.map((r) => ({ quoteNumber: r.quoteNumber, kind: r.kind, fileName: r.fileName, mimeType: r.mimeType, data: r.data, createdAt: r.createdAt.toISOString() }));
  }

  async getConversation(phone: string): Promise<ConversationState | null> {
    const [row] = await this.db.select().from(schema.conversations).where(eq(schema.conversations.phone, phone)).limit(1);
    return row ? (row.state as ConversationState) : null;
  }

  async setConversation(phone: string, state: ConversationState | null): Promise<void> {
    if (!state) {
      await this.db.delete(schema.conversations).where(eq(schema.conversations.phone, phone));
      return;
    }
    await this.db
      .insert(schema.conversations)
      .values({ phone, state, updatedAt: new Date() })
      .onConflictDoUpdate({ target: schema.conversations.phone, set: { state, updatedAt: new Date() } });
  }

  async markProcessed(messageId: string): Promise<boolean> {
    const res = await this.db.insert(schema.processedMessages).values({ id: messageId }).onConflictDoNothing().returning({ id: schema.processedMessages.id });
    return res.length > 0;
  }

  async getSyncMarks(): Promise<Record<string, string>> {
    const rows = await this.db.select({ fileId: schema.syncMarks.fileId, modifiedTime: schema.syncMarks.modifiedTime }).from(schema.syncMarks);
    return Object.fromEntries(rows.map((r) => [r.fileId, r.modifiedTime]));
  }

  async setSyncMark(fileId: string, modifiedTime: string, provider?: string): Promise<void> {
    try {
      await this.db
        .insert(schema.syncMarks)
        .values({ fileId, modifiedTime, provider: provider ?? null })
        .onConflictDoUpdate({ target: schema.syncMarks.fileId, set: provider ? { modifiedTime, provider } : { modifiedTime } });
    } catch (err) {
      if (!isMissingColumn(err)) throw err;
      // sync_marks.provider not migrated yet: keep the Drive sync working without it
      await this.sqlClient`insert into sync_marks (file_id, modified_time) values (${fileId}, ${modifiedTime}) on conflict (file_id) do update set modified_time = excluded.modified_time`;
    }
  }

  async close(): Promise<void> {
    await this.sqlClient.end({ timeout: 5 });
  }
}
