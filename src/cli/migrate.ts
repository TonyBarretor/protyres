/**
 * Apply the schema to Postgres without drizzle-kit (whose introspection can hang behind Supabase's transaction pooler).
 * Idempotent: every statement uses IF NOT EXISTS, so it is safe to run again after each update.
 *
 *   npm run db:migrate
 */
import "./env";
import postgres from "postgres";

const STATEMENTS = [
  `create table if not exists prices (
    id text primary key,
    provider text not null,
    kind text not null default 'provider',
    code text,
    description text not null default '',
    brand text not null default '',
    model text not null default '',
    size text not null default '',
    size_display text not null default '',
    size_raw text not null default '',
    is_tyre boolean not null default true,
    load_index text,
    speed_index text,
    ply integer,
    position text,
    tube text,
    cost numeric(12,2),
    price_includes_tax boolean not null default false,
    max_discount_pct numeric(5,2),
    currency text not null default 'USD',
    stock integer,
    price_date text not null,
    source text not null,
    source_ref text not null default '',
    notes text,
    raw text,
    updated_at timestamptz not null default now()
  )`,
  `alter table prices add column if not exists photo_url text`,
  `alter table prices add column if not exists sheet_url text`,
  `create index if not exists prices_size_idx on prices (size)`,
  `create index if not exists prices_provider_idx on prices (provider, kind)`,
  `create table if not exists quotes (
    number text primary key,
    status text not null default 'draft',
    customer_email text,
    total numeric(12,2),
    currency text,
    requested_by text,
    data jsonb not null,
    created_at timestamptz not null default now(),
    sent_at timestamptz
  )`,
  `create table if not exists conversations (
    phone text primary key,
    state jsonb not null,
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists counters (
    name text primary key,
    value integer not null default 0
  )`,
  `create table if not exists processed_messages (
    id text primary key,
    processed_at timestamptz not null default now()
  )`,
  `create table if not exists sync_marks (
    file_id text primary key,
    modified_time text not null,
    ok boolean not null default true
  )`,
  `create table if not exists photos (
    key text primary key,
    brand text not null default '',
    model text not null default '',
    url text,
    data text,
    mime_type text,
    sheet_url text,
    source text not null default 'manual',
    added_by text,
    created_at timestamptz not null default now()
  )`,
  `alter table photos add column if not exists sheet_data text`,
  `alter table photos add column if not exists origin text`,
  `alter table photos add column if not exists code text`,
  `alter table sync_marks add column if not exists provider text`,
  `create table if not exists quote_files (
    quote_number text not null,
    kind text not null,
    file_name text not null,
    mime_type text not null,
    data text not null,
    created_at timestamptz not null default now(),
    primary key (quote_number, kind)
  )`,
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL no está definida (ponla en .env)");
  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 20, onnotice: () => undefined }); // "already exists, skipping" notices are expected
  try {
    for (const stmt of STATEMENTS) {
      const head = stmt.replace(/\s+/g, " ").slice(0, 70);
      await sql.unsafe(stmt);
      console.log(`ok   ${head}…`);
    }
    const [{ photos }] = await sql`select count(*)::int as photos from prices where photo_url is not null`;
    const [{ rows }] = await sql`select count(*)::int as rows from prices`;
    const [{ files }] = await sql`select count(*)::int as files from quote_files`;
    console.log(`\nListo. Filas de precios: ${rows} (con foto: ${photos}). Archivos de cotizaciones enviadas: ${files}. Si las fotos están en 0, vuelve a ingerir la lista de Steel.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
