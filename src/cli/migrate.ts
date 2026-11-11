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
  `alter table prices add column if not exists stock_by_warehouse jsonb`,
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
  `create table if not exists contract_prices (
    customer text not null,
    item_id text not null,
    brand text,
    model text,
    size text,
    ply integer,
    application text,
    price numeric(12,2),
    currency text default 'USD',
    aliases text,
    updated_by text,
    updated_at timestamptz default now(),
    primary key (customer, item_id)
  )`,
  `create table if not exists messages (
    id serial primary key,
    phone text not null,
    direction text not null,
    kind text not null default 'text',
    body text not null default '',
    file_name text,
    quote_number text,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists messages_phone_created_idx on messages (phone, created_at)`,
  // ── Portal comercial (fase A): empresas del padrón MTC, flota, ventas, usuarios/sesiones y CRM ──
  `create table if not exists companies (
    id serial primary key,
    ruc text not null unique,
    razon_social text not null default '',
    sector text,
    departamento text,
    unidades integer not null default 0,
    llantas_piso integer not null default 0,
    antiguedad_media numeric(6,2),
    es_cliente boolean not null default false,
    owner_user_id integer,
    temperatura text,
    score numeric(8,2),
    credit_terms_days integer,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create index if not exists companies_departamento_idx on companies (departamento)`,
  `create index if not exists companies_owner_idx on companies (owner_user_id)`,
  `create index if not exists companies_unidades_idx on companies (unidades desc)`,
  `create table if not exists fleet_vehicles (
    id serial primary key,
    company_id integer not null,
    placa text not null,
    marca text,
    clase text,
    anio integer,
    ejes integer,
    llantas integer,
    llantas_fuente text,
    peso_bruto numeric(10,2),
    chasis text,
    departamento text,
    origen text not null,
    medida_probable text,
    confianza text,
    unique (placa, origen)
  )`,
  `create index if not exists fleet_vehicles_company_idx on fleet_vehicles (company_id)`,
  `create index if not exists fleet_vehicles_marca_idx on fleet_vehicles (marca)`,
  `create table if not exists sales (
    id serial primary key,
    fecha date not null,
    ruc text not null,
    razon_social text,
    medida text,
    marca text,
    diseno text,
    cantidad numeric(12,2) not null default 0,
    precio_unitario numeric(12,2),
    total numeric(14,2),
    vendedor text,
    origen text,
    is_demo boolean not null default false,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists sales_ruc_idx on sales (ruc)`,
  `create index if not exists sales_fecha_idx on sales (fecha)`,
  `create table if not exists users (
    id serial primary key,
    nombre text not null,
    whatsapp text unique,
    rol text not null default 'vendedor',
    activo boolean not null default true,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists login_tokens (
    token_hash text primary key,
    user_id integer not null,
    expires_at timestamptz not null,
    used_at timestamptz,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists portal_sessions (
    id text primary key,
    user_id integer not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists portal_sessions_user_idx on portal_sessions (user_id)`,
  `create table if not exists contacts (
    id serial primary key,
    company_id integer not null,
    nombre text not null,
    cargo text,
    telefono text,
    email text,
    notas text,
    created_by integer,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create index if not exists contacts_company_idx on contacts (company_id)`,
  `create table if not exists opportunities (
    id serial primary key,
    company_id integer not null,
    owner_user_id integer,
    etapa text not null default 'prospecto',
    probabilidad integer not null default 10,
    monto_estimado numeric(14,2),
    cierre_esperado date,
    proxima_accion text,
    proxima_accion_at timestamptz,
    quote_number text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    closed_at timestamptz
  )`,
  `create index if not exists opportunities_company_idx on opportunities (company_id)`,
  `create index if not exists opportunities_owner_idx on opportunities (owner_user_id, etapa)`,
  `create table if not exists opportunity_stage_history (
    id serial primary key,
    opportunity_id integer not null,
    etapa text not null,
    entered_at timestamptz not null default now(),
    left_at timestamptz,
    changed_by integer
  )`,
  `create index if not exists opportunity_stage_history_opp_idx on opportunity_stage_history (opportunity_id, entered_at)`,
  `create table if not exists activities (
    id serial primary key,
    company_id integer not null,
    opportunity_id integer,
    user_id integer,
    tipo text not null,
    texto text not null default '',
    canal text,
    data jsonb,
    occurred_at timestamptz not null default now(),
    created_at timestamptz not null default now()
  )`,
  `create index if not exists activities_company_idx on activities (company_id, occurred_at)`,
  `create index if not exists activities_user_idx on activities (user_id, occurred_at)`,
  `create table if not exists appointments (
    id serial primary key,
    company_id integer not null,
    opportunity_id integer,
    user_id integer,
    starts_at timestamptz not null,
    lugar text,
    con_tecnico boolean not null default false,
    notas text,
    estado text not null default 'programada',
    created_at timestamptz not null default now()
  )`,
  `create index if not exists appointments_user_idx on appointments (user_id, starts_at)`,
  `create index if not exists appointments_company_idx on appointments (company_id)`,
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
    const [{ contracts }] = await sql`select count(*)::int as contracts from contract_prices`;
    const [{ msgs }] = await sql`select count(*)::int as msgs from messages`;
    console.log(`\nListo. Filas de precios: ${rows} (con foto: ${photos}). Archivos de cotizaciones enviadas: ${files}. Precios de contrato cambiados desde WhatsApp: ${contracts}. Mensajes registrados: ${msgs}. Si las fotos están en 0, vuelve a ingerir la lista de Steel.`);
    const portalTables = ["companies", "fleet_vehicles", "sales", "users", "contacts", "opportunities", "activities", "appointments"];
    const portalCounts: string[] = [];
    for (const t of portalTables) {
      const [{ n }] = await sql.unsafe(`select count(*)::int as n from ${t}`);
      portalCounts.push(`${t}: ${n}`);
    }
    console.log(`Portal — ${portalCounts.join(", ")}.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
