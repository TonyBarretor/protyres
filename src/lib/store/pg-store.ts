/**
 * Postgres store (Supabase) via Drizzle. Create the tables with `npm run db:push`.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../db/schema";
import type { PriceRow, PriceSource } from "../ingest/types";
import type { Quote } from "../quote/types";
import { photoKey, type ConversationState, type PriceStore, type ProductPhoto, type ProviderSummary, type ReplaceScope } from "./types";

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

const FOLD = (col: unknown) => sql`regexp_replace(lower(${col}), '[^a-z0-9]', '', 'g')`;

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
      source: row.source as ProductPhoto["source"],
      addedBy: row.addedBy ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async setPhoto(p: ProductPhoto): Promise<void> {
    const values = { key: p.key, brand: p.brand, model: p.model, url: p.url ?? null, data: p.data ?? null, mimeType: p.mimeType ?? null, sheetUrl: p.sheetUrl ?? null, source: p.source, addedBy: p.addedBy ?? null, createdAt: new Date(p.createdAt) };
    await this.db
      .insert(schema.photos)
      .values(values)
      .onConflictDoUpdate({ target: schema.photos.key, set: { ...values, createdAt: new Date() } });
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

  async nextQuoteCounter(start = 1): Promise<number> {
    const [row] = await this.db
      .insert(schema.counters)
      .values({ name: "quote", value: Math.max(1, start) })
      .onConflictDoUpdate({ target: schema.counters.name, set: { value: sql`greatest(${schema.counters.value}, ${Math.max(1, start) - 1}) + 1` } })
      .returning({ value: schema.counters.value });
    return row.value;
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

  async listQuotes(limit = 50): Promise<Quote[]> {
    const rows = await this.db.select().from(schema.quotes).orderBy(desc(schema.quotes.createdAt)).limit(limit);
    return rows.map((r) => r.data as Quote);
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
    const rows = await this.db.select().from(schema.syncMarks);
    return Object.fromEntries(rows.map((r) => [r.fileId, r.modifiedTime]));
  }

  async setSyncMark(fileId: string, modifiedTime: string): Promise<void> {
    await this.db
      .insert(schema.syncMarks)
      .values({ fileId, modifiedTime })
      .onConflictDoUpdate({ target: schema.syncMarks.fileId, set: { modifiedTime } });
  }

  async close(): Promise<void> {
    await this.sqlClient.end({ timeout: 5 });
  }
}
