/**
 * Postgres store (Supabase) via Drizzle. Create the tables with `npm run db:push`.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { serverlessPostgres } from "./pg-options";
import * as schema from "../../db/schema";
import type { PriceRow, PriceSource } from "../ingest/types";
import { normalizePlate } from "../quote/line-refs";
import type { Quote } from "../quote/types";
import type { QuoteShadowEntry, QuoteShadowRow } from "../quote/shadow";
import { foldKey, photoKey, stockOriginKey, type BlockedInbound, type ConversationState, type ListQuotesOptions, type LoggedMessage, type MessageLogEntry, type PriceStore, type ProductPhoto, type ProviderSummary, type QuoteFile, type ReplaceScope, type StoredContractItem, type StockDeduction, type StockDeductionInput, type Supplier, type UsageEntry, type UsageSummaryRow } from "./types";

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
    stockByWarehouse: r.stockByWarehouse && Object.keys(r.stockByWarehouse).length ? r.stockByWarehouse : undefined,
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

/** Postgres "undefined table" (a table added by `npm run db:migrate` that has not been created yet). */
const isMissingTable = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return (e?.code ?? e?.cause?.code) === "42P01";
};

function parseAliases(json: string | null): string[] | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : undefined;
  } catch {
    return undefined;
  }
}

export class PgStore implements PriceStore {
  private constructor(
    private db: Db,
    private sqlClient: ReturnType<typeof postgres>,
    private ormClient: ReturnType<typeof postgres>,
  ) {}

  static async connect(url: string): Promise<PgStore> {
    // pooler de Supabase: sin sentencias preparadas ni pipelining, begin seguro (pg-options.ts).
    // Dos clientes (corrida H): drizzle cambia los serializadores de fechas y JSON del cliente que envuelve (los deja
    // pasar tal cual porque él los convierte antes); en las consultas sueltas (uso de audio y de modelo, bloqueados,
    // sombra) un Date o un objeto llegaba crudo y fallaba: "Received an instance of Date". Las consultas sueltas van por
    // su propio cliente, con los serializadores normales.
    const ormClient = serverlessPostgres(url, { max: 2 });
    const rawClient = serverlessPostgres(url, { max: 5 });
    const db = drizzle(ormClient, { schema });
    return new PgStore(db, rawClient, ormClient);
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
          stockByWarehouse: r.stockByWarehouse ?? null,
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
              stockByWarehouse: sql`excluded.stock_by_warehouse`,
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
    await this.recordStockLoads(rows);
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

  getPhoto(brand: string, model: string): Promise<ProductPhoto | null> {
    return this.getPhotoByKey(photoKey(brand, model));
  }

  async getPhotoByKey(key: string): Promise<ProductPhoto | null> {
    const [row] = await this.db.select().from(schema.photos).where(eq(schema.photos.key, key)).limit(1);
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

  async findLastQuoteForCustomer(opts: { email?: string; company?: string; unit?: string }): Promise<Quote | null> {
    const conds = [];
    if (opts.email) conds.push(sql`lower(${schema.quotes.customerEmail}) = ${opts.email.toLowerCase()}`);
    if (opts.company) conds.push(sql`${FOLD(sql`(${schema.quotes.data}->'customer'->>'company')`)} = ${foldKey(opts.company)}`); // "Movil Bus S.A.C." = "MOVIL BUS SAC"
    if (conds.length === 0) return null;
    let where = conds.length === 1 ? conds[0] : sql`(${conds[0]}) or (${conds[1]})`;
    if (opts.unit) where = sql`(${where}) and ${FOLD(sql`(${schema.quotes.data}->>'unit')`)} = ${foldKey(opts.unit)}`;
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
    const global = (db: Pick<Db, "insert">) =>
      db
        .insert(schema.counters)
        .values({ name: "quote", value: s })
        .onConflictDoUpdate({ target: schema.counters.name, set: { value: bump } })
        .returning({ value: schema.counters.value });
    if (!key || key === "quote") {
      const [row] = await global(this.db);
      return row.value;
    }
    // Corrida H (test:pg, quote-store.pg.test.ts): las primeras cotizaciones de un vendedor que llegan a la vez desde
    // instancias distintas repetían número. Una llamada no encontraba su contador, otra lo creaba y una tercera lo
    // avanzaba al mismo valor que la primera tomaba del global. Ahora todo el paso va en una transacción con un bloqueo
    // por vendedor (se suelta en el commit): las llamadas del mismo vendedor van una tras otra; las de otros, no esperan.
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`counters:${key}`}))`);
      // the salesman's own counter, once it exists
      const [own] = await tx.update(schema.counters).set({ value: bump }).where(eq(schema.counters.name, key)).returning({ value: schema.counters.value });
      if (own) return own.value;
      const [row] = await global(tx);
      // first quote of this salesman: his counter starts from the global value just taken
      await tx
        .insert(schema.counters)
        .values({ name: key, value: row.value })
        .onConflictDoUpdate({ target: schema.counters.name, set: { value: sql`greatest(${schema.counters.value}, ${row.value})` } });
      return row.value;
    });
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
    // corrida J: ítems con esa placa (índice quotes_items_gin_idx sobre data->'items')
    if (o.plate) conds.push(sql`(${schema.quotes.data}->'items') @> ${JSON.stringify([{ plate: normalizePlate(o.plate) ?? o.plate.trim().toUpperCase() }])}::jsonb`);
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

  async getContractItems(customer: string): Promise<StoredContractItem[]> {
    try {
      const rows = await this.db.select().from(schema.contractPrices).where(eq(schema.contractPrices.customer, customer)).orderBy(schema.contractPrices.itemId);
      return rows.map((r) => ({
        id: r.itemId,
        brand: r.brand ?? undefined,
        model: r.model ?? undefined,
        size: r.size ?? undefined,
        ply: r.ply ?? undefined,
        application: r.application ?? undefined,
        price: r.price === null ? undefined : Number(r.price),
        currency: r.currency ?? undefined,
        aliases: parseAliases(r.aliases),
        updatedBy: r.updatedBy ?? undefined,
        updatedAt: r.updatedAt?.toISOString(),
      }));
    } catch (err) {
      if (isMissingTable(err)) return []; // contract_prices not migrated yet: the config's contract applies
      throw err;
    }
  }

  async setContractItem(customer: string, item: StoredContractItem): Promise<void> {
    const values = {
      customer,
      itemId: item.id.trim().toLowerCase(),
      brand: item.brand ?? null,
      model: item.model ?? null,
      size: item.size ?? null,
      ply: item.ply ?? null,
      application: item.application ?? null,
      price: item.price === undefined ? null : item.price.toFixed(2),
      currency: item.currency ?? null, // empty like the other fields: the config's currency applies
      aliases: item.aliases ? JSON.stringify(item.aliases) : null,
      updatedBy: item.updatedBy ?? null,
      updatedAt: new Date(),
    };
    try {
      await this.db
        .insert(schema.contractPrices)
        .values(values)
        .onConflictDoUpdate({ target: [schema.contractPrices.customer, schema.contractPrices.itemId], set: { ...values } });
    } catch (err) {
      if (isMissingTable(err)) throw new Error("falta la tabla contract_prices: corre npm run db:migrate");
      throw err;
    }
  }

  async deleteContractItem(customer: string, itemId: string): Promise<boolean> {
    try {
      const del = await this.db
        .delete(schema.contractPrices)
        .where(and(eq(schema.contractPrices.customer, customer), eq(schema.contractPrices.itemId, itemId.trim().toLowerCase())))
        .returning({ itemId: schema.contractPrices.itemId });
      return del.length > 0;
    } catch (err) {
      if (isMissingTable(err)) return false;
      throw err;
    }
  }

  async logMessage(entry: MessageLogEntry): Promise<void> {
    const values = { phone: entry.phone.replace(/\D/g, ""), direction: entry.direction, kind: entry.kind, body: entry.body, fileName: entry.fileName ?? null, quoteNumber: entry.quoteNumber ?? null };
    if (entry.routeRule) {
      // route_rule (corrida D) no está en el esquema de Drizzle: así select/insert de siempre no dependen de la migración.
      // Sin la columna todavía (migración pendiente), la fila se guarda igual sin ella (la regla también va en body).
      try {
        await this.db.execute(sql`insert into messages (phone, direction, kind, body, file_name, quote_number, route_rule) values (${values.phone}, ${values.direction}, ${values.kind}, ${values.body}, ${values.fileName}, ${values.quoteNumber}, ${entry.routeRule})`);
        return;
      } catch (err) {
        if (!isMissingColumn(err)) throw err;
      }
    }
    await this.db.insert(schema.messages).values(values);
  }

  async listMessages(phone: string, limit = 30): Promise<LoggedMessage[]> {
    try {
      const rows = await this.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.phone, phone.replace(/\D/g, ""))) // stored as digits: uses the (phone, created_at) index
        .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
        .limit(limit);
      return rows.reverse().map((r) => ({ id: r.id, phone: r.phone, direction: r.direction as "in" | "out", kind: r.kind, body: r.body, fileName: r.fileName ?? undefined, quoteNumber: r.quoteNumber ?? undefined, createdAt: r.createdAt.toISOString() }));
    } catch (err) {
      if (isMissingTable(err)) return []; // messages not migrated yet
      throw err;
    }
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

  // ── corrida E: uso medido y mensajes descartados (tablas llm_usage, audio_usage, blocked_inbound; SQL directo, fuera
  // del esquema de Drizzle). Sin migrar todavía: se registra en la consola y el bot sigue (sin topes hasta migrar).

  async recordUsage(entry: UsageEntry): Promise<void> {
    const phone = entry.phone.replace(/\D/g, "") || entry.phone;
    const at = entry.at ?? new Date();
    try {
      if (entry.audioSeconds !== undefined) {
        await this.sqlClient`insert into audio_usage (phone, purpose, model, seconds, cost_usd, created_at) values (${phone}, ${entry.purpose}, ${entry.model}, ${entry.audioSeconds}, ${entry.costUsd}, ${at})`;
      } else {
        await this.sqlClient`insert into llm_usage (phone, purpose, model, input_tokens, output_tokens, cost_usd, created_at) values (${phone}, ${entry.purpose}, ${entry.model}, ${entry.inputTokens ?? 0}, ${entry.outputTokens ?? 0}, ${entry.costUsd}, ${at})`;
      }
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      console.warn("[store] llm_usage / audio_usage no existen: corre npm run db:migrate (el uso no se registra ni se aplican topes)");
    }
  }

  async usageSummary(since: Date): Promise<UsageSummaryRow[]> {
    try {
      const llm = await this.sqlClient<{ phone: string; purpose: string; calls: number; input: number; output: number; cost: number }[]>`
        select phone, purpose, count(*)::int as calls, coalesce(sum(input_tokens), 0)::bigint::float8 as input,
               coalesce(sum(output_tokens), 0)::bigint::float8 as output, coalesce(sum(cost_usd), 0)::float8 as cost
        from llm_usage where created_at >= ${since} group by phone, purpose`;
      const audio = await this.sqlClient<{ phone: string; purpose: string; calls: number; seconds: number; cost: number }[]>`
        select phone, purpose, count(*)::int as calls, coalesce(sum(seconds), 0)::float8 as seconds, coalesce(sum(cost_usd), 0)::float8 as cost
        from audio_usage where created_at >= ${since} group by phone, purpose`;
      const out = new Map<string, UsageSummaryRow>();
      const row = (phone: string, purpose: string) => {
        const key = `${phone}|${purpose}`;
        let r = out.get(key);
        if (!r) out.set(key, (r = { phone, purpose, llmCalls: 0, inputTokens: 0, outputTokens: 0, audioCalls: 0, audioSeconds: 0, costUsd: 0 }));
        return r;
      };
      for (const l of llm) {
        const r = row(l.phone, l.purpose);
        r.llmCalls += Number(l.calls);
        r.inputTokens += Number(l.input);
        r.outputTokens += Number(l.output);
        r.costUsd += Number(l.cost);
      }
      for (const a of audio) {
        const r = row(a.phone, a.purpose);
        r.audioCalls += Number(a.calls);
        r.audioSeconds += Number(a.seconds);
        r.costUsd += Number(a.cost);
      }
      return [...out.values()];
    } catch (err) {
      if (isMissingTable(err)) return [];
      throw err;
    }
  }

  async logBlocked(entry: BlockedInbound): Promise<void> {
    try {
      await this.sqlClient`insert into blocked_inbound (phone, kind, reason, created_at) values (${entry.phone.replace(/\D/g, "")}, ${entry.kind}, ${entry.reason}, ${entry.at ?? new Date()})`;
    } catch (err) {
      if (!isMissingTable(err)) throw err;
    }
  }

  async blockedSummary(since: Date): Promise<{ reason: string; phones: number; messages: number }[]> {
    try {
      const rows = await this.sqlClient<{ reason: string; phones: number; messages: number }[]>`
        select reason, count(distinct phone)::int as phones, count(*)::int as messages from blocked_inbound where created_at >= ${since} group by reason`;
      return rows.map((r) => ({ reason: r.reason, phones: Number(r.phones), messages: Number(r.messages) }));
    } catch (err) {
      if (isMissingTable(err)) return [];
      throw err;
    }
  }

  // QUOTE_LLM_MODE=shadow (corrida E): tabla quote_shadow (SQL directo). Sin migrar: aviso en consola y el bot sigue.

  async logQuoteShadow(entry: QuoteShadowEntry): Promise<void> {
    const phone = entry.phone.replace(/\D/g, "") || entry.phone;
    try {
      await this.sqlClient`insert into quote_shadow (phone, request_text, rules, model, diffs, rejected, model_error, created_at)
        values (${phone}, ${entry.text}, ${this.sqlClient.json(entry.rules as unknown as postgres.JSONValue)}, ${entry.model ? this.sqlClient.json(entry.model as unknown as postgres.JSONValue) : null},
                ${this.sqlClient.json(entry.diffs as unknown as postgres.JSONValue)}, ${this.sqlClient.json(entry.rejected as unknown as postgres.JSONValue)}, ${entry.modelError ?? null}, ${entry.at ?? new Date()})`;
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      console.warn("[store] quote_shadow no existe: corre npm run db:migrate (las comparaciones del modo sombra no se registran)");
    }
  }

  async listQuoteShadow(opts: { since?: Date; limit?: number } = {}): Promise<QuoteShadowRow[]> {
    try {
      const rows = await this.sqlClient<{ id: number; phone: string; request_text: string; rules: unknown; model: unknown; diffs: unknown; rejected: unknown; model_error: string | null; created_at: Date }[]>`
        select id, phone, request_text, rules, model, diffs, rejected, model_error, created_at from quote_shadow
        where created_at >= ${opts.since ?? new Date(0)} order by created_at desc, id desc limit ${opts.limit ?? 1000}`;
      return rows.map((r) => ({
        id: Number(r.id),
        phone: r.phone,
        text: r.request_text,
        rules: r.rules as QuoteShadowRow["rules"],
        model: (r.model ?? null) as QuoteShadowRow["model"],
        diffs: (r.diffs ?? []) as QuoteShadowRow["diffs"],
        rejected: (r.rejected ?? []) as string[],
        ...(r.model_error ? { modelError: r.model_error } : {}),
        at: new Date(r.created_at),
      }));
    } catch (err) {
      if (isMissingTable(err)) return [];
      throw err;
    }
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

  // ---------- corrida H: proveedores y contador de stock (tablas suppliers, stock_loads, stock_deductions) ----------

  /** Hora de la carga de cada origen de las filas (una lista nueva reinicia el contador de stock de ese origen). */
  private async recordStockLoads(rows: PriceRow[]): Promise<void> {
    const origins = [...new Set(rows.map((r) => stockOriginKey(r.provider, r.kind)))];
    if (!origins.length) return;
    try {
      const at = new Date();
      for (const o of origins) await this.sqlClient`insert into stock_loads (origin, loaded_at) values (${o}, ${at}) on conflict (origin) do update set loaded_at = excluded.loaded_at`;
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      console.warn("[store] stock_loads no existe: corre npm run db:migrate (el contador de stock no se reinicia con la carga)");
    }
  }

  async listSuppliers(): Promise<Supplier[]> {
    try {
      const rows = await this.sqlClient<{ key: string; name: string; contact: string | null; phone: string | null; email: string | null; brands: unknown; provider: string | null; last_payment: string | null; last_delivery: string | null; updated_at: Date }[]>`
        select key, name, contact, phone, email, brands, provider, last_payment, last_delivery, updated_at from suppliers order by name`;
      return rows.map((r) => ({
        key: r.key,
        name: r.name,
        contact: r.contact ?? undefined,
        phone: r.phone ?? undefined,
        email: r.email ?? undefined,
        brands: Array.isArray(r.brands) ? r.brands.map(String) : [],
        provider: r.provider ?? undefined,
        lastPayment: r.last_payment ?? undefined,
        lastDelivery: r.last_delivery ?? undefined,
        updatedAt: new Date(r.updated_at).toISOString(),
      }));
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      return [];
    }
  }

  async upsertSuppliers(list: Supplier[]): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;
    await this.sqlClient.begin(async (tx) => {
      for (const x of list) {
        const [r] = await tx<{ inserted: boolean }[]>`
          insert into suppliers (key, name, contact, phone, email, brands, provider, last_payment, last_delivery, updated_at)
          values (${x.key}, ${x.name}, ${x.contact ?? null}, ${x.phone ?? null}, ${x.email ?? null}, ${tx.json(x.brands)}, ${x.provider ?? null}, ${x.lastPayment ?? null}, ${x.lastDelivery ?? null}, now())
          on conflict (key) do update set name = excluded.name, contact = excluded.contact, phone = excluded.phone, email = excluded.email,
            brands = excluded.brands, provider = excluded.provider, last_payment = coalesce(suppliers.last_payment, excluded.last_payment),
            last_delivery = coalesce(suppliers.last_delivery, excluded.last_delivery), updated_at = now()
          returning (xmax = 0) as inserted`;
        if (r?.inserted) inserted++;
        else updated++;
      }
    });
    return { inserted, updated };
  }

  async setSupplierTerms(key: string, terms: { payment?: string; delivery?: string }): Promise<void> {
    if (terms.payment === undefined && terms.delivery === undefined) return;
    const setPayment = terms.payment !== undefined;
    const setDelivery = terms.delivery !== undefined;
    await this.sqlClient`
      update suppliers set
        last_payment = case when ${setPayment} then ${terms.payment ?? null}::text else last_payment end,
        last_delivery = case when ${setDelivery} then ${terms.delivery ?? null}::text else last_delivery end,
        updated_at = now()
      where key = ${key}`;
  }

  async setStockDeductions(orderKey: string, label: string, entries: StockDeductionInput[], at: Date = new Date()): Promise<void> {
    await this.sqlClient.begin(async (tx) => {
      // el mismo pedido nunca descuenta dos veces: un candado por pedido (dos "rehacer" a la vez van uno tras otro) y lo
      // anterior de ese pedido se devuelve
      await tx`select pg_advisory_xact_lock(hashtext(${"stock:" + orderKey}))`;
      await tx`update stock_deductions set released_at = ${at} where order_key = ${orderKey} and released_at is null`;
      for (const e of entries) {
        if (!(e.quantity > 0)) continue;
        await tx`
          insert into stock_deductions (order_key, label, row_id, origin, warehouse, quantity, description, load_at, created_at)
          values (${orderKey}, ${label}, ${e.rowId}, ${e.origin}, ${e.warehouse}, ${Math.round(e.quantity)}, ${e.description},
                  (select loaded_at from stock_loads where origin = ${e.origin}), ${at})`;
      }
    });
  }

  async releaseStockDeductions(orderKey: string, at: Date = new Date()): Promise<number> {
    const rows = await this.sqlClient`update stock_deductions set released_at = ${at} where order_key = ${orderKey} and released_at is null returning id`;
    return rows.length;
  }

  async listStockDeductions(): Promise<StockDeduction[]> {
    try {
      const rows = await this.sqlClient<{ id: number; order_key: string; label: string | null; row_id: string; origin: string; warehouse: string; quantity: number; description: string; created_at: Date }[]>`
        select d.id, d.order_key, d.label, d.row_id, d.origin, d.warehouse, d.quantity, d.description, d.created_at
        from stock_deductions d left join stock_loads l on l.origin = d.origin
        where d.released_at is null and d.load_at is not distinct from l.loaded_at
        order by d.id`;
      return rows.map((r) => ({
        id: r.id,
        orderKey: r.order_key,
        label: r.label ?? "",
        rowId: r.row_id,
        origin: r.origin,
        warehouse: r.warehouse,
        quantity: r.quantity,
        description: r.description,
        createdAt: new Date(r.created_at).toISOString(),
      }));
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      return [];
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.sqlClient.end({ timeout: 5 }), this.ormClient.end({ timeout: 5 })]);
  }
}
