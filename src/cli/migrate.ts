/**
 * Apply the schema to Postgres without drizzle-kit (whose introspection can hang behind Supabase's transaction pooler).
 * Idempotent: every statement uses IF NOT EXISTS, so it is safe to run again after each update.
 *
 *   npm run db:migrate
 */
import "./env";
import postgres from "postgres";
import { checkExistingTables, expectedSchema, type ColumnRow } from "../lib/portal/store/migrate-guard";

export const STATEMENTS = [
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
  `alter table sales add column if not exists source_ref text`,
  `create index if not exists sales_source_ref_idx on sales (source_ref)`,
  // fase B: paso pendiente del portal en la conversación de WhatsApp (separado de `conversations` del cotizador)
  `create table if not exists portal_conversations (
    phone text primary key,
    state jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
  )`,
  // Vocabulario aprendido por el bot (`aprende X = Y`): términos clave de Deepgram y reemplazos en la transcripción.
  `create table if not exists vocabulary (
    id serial primary key,
    term text not null,
    meaning text not null,
    added_by integer,
    created_at timestamptz not null default now()
  )`,
  `create unique index if not exists vocabulary_term_lower_idx on vocabulary (lower(term))`,
  // Órdenes de compra recibidas por el bot (`oc`): el PDF/imagen en base64 como quote_files; status recibida -> pedido_generado.
  `create table if not exists purchase_orders (
    id serial primary key,
    company_id integer not null,
    opportunity_id integer,
    user_id integer,
    numero text,
    quote_number text,
    file_name text,
    mime_type text,
    data text,
    status text not null default 'recibida',
    created_at timestamptz not null default now()
  )`,
  `create index if not exists purchase_orders_company_idx on purchase_orders (company_id, created_at)`,
  // Memoria del pedido por cliente: direcciones, contacto, agencia y últimas respuestas a las preguntas del pedido.
  `create table if not exists company_order_profile (
    company_id integer primary key,
    data jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
  )`,
  // Crédito (C4): evaluación por empresa (sin fila = sin_evaluar), con el PDF del reporte en base64, y su historial.
  `create table if not exists company_credit (
    company_id integer primary key,
    estado text not null default 'sin_evaluar',
    calificacion text,
    linea numeric(14,2),
    moneda text,
    plazo_dias integer,
    fuente text,
    consultado_at timestamptz,
    consultado_por integer,
    pdf_name text,
    pdf_mime text,
    pdf_data text,
    notas text,
    updated_at timestamptz not null default now(),
    updated_by integer
  )`,
  `create table if not exists company_credit_history (
    id serial primary key,
    company_id integer not null,
    estado_anterior text,
    estado_nuevo text not null,
    cambios jsonb not null default '{}'::jsonb,
    user_id integer,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists company_credit_history_company_idx on company_credit_history (company_id, created_at)`,
  // Encuesta de satisfacción (C3): solo el sha256 del token del enlace; una respuesta por encuesta (survey_id único).
  `create table if not exists surveys (
    id serial primary key,
    company_id integer not null,
    contact_id integer,
    token_hash text not null unique,
    estado text not null default 'pendiente',
    canal text not null,
    created_by integer,
    enviada_at timestamptz,
    respondida_at timestamptz,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists surveys_company_idx on surveys (company_id, created_at)`,
  `create table if not exists survey_answers (
    id serial primary key,
    survey_id integer not null unique,
    nps integer not null,
    valora jsonb not null default '[]'::jsonb,
    satisfaccion_entrega integer,
    mejorar text,
    referencia boolean,
    created_at timestamptz not null default now()
  )`,
  // Corrida D (punto 7): qué regla del enrutador del portal decidió cada mensaje (filas kind 'route'), para revisar el piloto.
  `alter table messages add column if not exists route_rule text`,
  // Corrida E (protección): uso medido del modelo y de la voz (topes diarios, npm run llm:usage, tablero) y registro
  // mínimo de mensajes que la puerta del bot no procesó (número no registrado, ráfaga): número, tipo y motivo, sin cuerpo.
  `create table if not exists llm_usage (
    id serial primary key,
    phone text not null,
    purpose text not null,
    model text not null,
    input_tokens integer not null default 0,
    output_tokens integer not null default 0,
    cost_usd numeric(12,6) not null default 0,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists llm_usage_created_idx on llm_usage (created_at, phone)`,
  `create table if not exists audio_usage (
    id serial primary key,
    phone text not null,
    purpose text not null default 'voz',
    model text not null,
    seconds numeric(10,2) not null default 0,
    cost_usd numeric(12,6) not null default 0,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists audio_usage_created_idx on audio_usage (created_at, phone)`,
  `create table if not exists blocked_inbound (
    id serial primary key,
    phone text not null,
    kind text not null,
    reason text not null,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists blocked_inbound_created_idx on blocked_inbound (created_at)`,
  // Corrida E, punto 5: límite de intentos de las entradas públicas (login, encuesta, cron). `bucket` = ámbito + HMAC de la
  // IP o del token (nunca en claro); una fila por ventana fija. El cron borra las ventanas de hace más de 2 días.
  `create table if not exists rate_limit_hits (
    bucket text not null,
    window_start timestamptz not null,
    hits integer not null default 0,
    updated_at timestamptz not null default now(),
    primary key (bucket, window_start)
  )`,
  `create index if not exists rate_limit_hits_window_idx on rate_limit_hits (window_start)`,
  // Corrida E (punto 4): QUOTE_LLM_MODE=shadow, comparación reglas vs modelo de cada pedido (npm run quote:shadow-report).
  // request_text es dato de cliente: solo en la base.
  `create table if not exists quote_shadow (
    id serial primary key,
    phone text not null,
    request_text text not null,
    rules jsonb not null,
    model jsonb,
    diffs jsonb not null default '[]'::jsonb,
    rejected jsonb not null default '[]'::jsonb,
    model_error text,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists quote_shadow_created_idx on quote_shadow (created_at)`,
  // Corrida F, punto 9: cada transcripción de voz con lo que el bot entendió (medida, cantidad, marca, diseño, cliente,
  // preguntas). Para revisar los fallos del piloto con `npm run voice:review -- --db`; dato de cliente, solo consola.
  `create table if not exists voice_transcripts (
    id serial primary key,
    phone text not null,
    user_id integer,
    context text not null,
    transcript text not null,
    understood jsonb not null default '{}'::jsonb,
    outcome text not null,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists voice_transcripts_created_idx on voice_transcripts (created_at)`,
  // Corrida F, puntos 1 y 2 (Prospectos): búsqueda tolerante por razón social. razon_norm = minúsculas, sin tildes, sin
  // espacios ni signos (misma regla que companyNameKey() en src/lib/portal/store/shared.ts): "Z-BUSS S.A.C." -> "zbusssac".
  // Columna generada: se llena sola al importar; añadirla reescribe companies (~5 mil filas, instantáneo).
  `alter table companies add column if not exists razon_norm text generated always as (regexp_replace(translate(lower(razon_social), 'áàäâãéèëêíìïîóòöôõúùüûñç', 'aaaaaeeeeiiiiooooouuuunc'), '[^a-z0-9]+', '', 'g')) stored`,
  // pg_trgm viene en Supabase (pg_available_extensions); en el esquema extensions, como recomienda Supabase.
  `create extension if not exists pg_trgm with schema extensions`,
  `create index if not exists companies_razon_norm_trgm_idx on companies using gin (razon_norm extensions.gin_trgm_ops)`,
  // Filtro y lista de marcas de vehículo (upper(trim(marca)), igual que la consulta) y medidas probables por empresa en la
  // lista. Sin "concurrently": fleet_vehicles solo la escribe el import del MTC y el índice se crea en ~1 s sin bloquear lecturas.
  `create index if not exists fleet_vehicles_marca_norm_idx on fleet_vehicles ((upper(trim(marca))), company_id)`,
  `create index if not exists fleet_vehicles_company_medida_idx on fleet_vehicles (company_id, medida_probable)`,
  // Corrida G: puntaje de atractivo (companies.score ya existía, sin uso). nivel A/B/C, score_detalle = aporte de cada
  // factor y frenos (src/lib/portal/scoring/score.ts), score_at = último cálculo. Los llena `npm run portal:recalc-score`.
  `alter table companies add column if not exists nivel text`,
  `alter table companies add column if not exists score_detalle jsonb`,
  `alter table companies add column if not exists score_at timestamptz`,
  `create index if not exists companies_score_idx on companies (score desc nulls last, id)`,
  `create index if not exists companies_nivel_score_idx on companies (nivel, score desc)`,
  // Cada recálculo completo: cortes de nivel (los usa el recálculo de una sola empresa), conteo por nivel y duración.
  `create table if not exists score_runs (
    id serial primary key,
    run_at timestamptz not null default now(),
    empresas integer not null,
    cut_a numeric(8,2),
    cut_b numeric(8,2),
    conteo jsonb not null default '{}'::jsonb,
    duracion_ms integer
  )`,
  // Validación del ranking con el vendedor (/portal/validar-ranking): su nivel frente al del sistema en ese momento.
  `create table if not exists ranking_validations (
    id serial primary key,
    user_id integer not null,
    company_id integer not null,
    nivel_vendedor text not null,
    nota text,
    nivel_sistema text,
    score_sistema numeric(8,2),
    created_at timestamptz not null default now()
  )`,
  `create index if not exists ranking_validations_user_idx on ranking_validations (user_id, created_at)`,
  // Avisos del bot que se dan una sola vez por usuario (p. ej. "puedes validar el ranking").
  `create table if not exists user_notices (
    user_id integer not null,
    aviso text not null,
    created_at timestamptz not null default now(),
    primary key (user_id, aviso)
  )`,
  // Corrida H, punto 3b: proveedores de la lista de contactos (npm run portal:import-suppliers). `key` = nombre plegado;
  // `provider` = proveedor del cotizador que le corresponde ("JCH"); last_* = últimas condiciones de pago y entrega del pedido.
  `create table if not exists suppliers (
    key text primary key,
    name text not null,
    contact text,
    phone text,
    email text,
    brands jsonb not null default '[]'::jsonb,
    provider text,
    last_payment text,
    last_delivery text,
    updated_at timestamptz not null default now()
  )`,
  // Corrida H, punto 4: contador de stock. Cada carga de una lista (proveedor|tipo) deja su hora; un descuento cuenta solo
  // mientras su load_at sea la hora de la última carga de su origen y no esté liberado (pedido anulado o rehecho).
  `create table if not exists stock_loads (
    origin text primary key,
    loaded_at timestamptz not null default now()
  )`,
  `create table if not exists stock_deductions (
    id serial primary key,
    order_key text not null,
    label text,
    row_id text not null,
    origin text not null,
    warehouse text not null default '',
    quantity integer not null,
    description text not null default '',
    load_at timestamptz,
    created_at timestamptz not null default now(),
    released_at timestamptz
  )`,
  `create index if not exists stock_deductions_order_idx on stock_deductions (order_key)`,
  `create index if not exists stock_deductions_active_idx on stock_deductions (row_id) where released_at is null`,
  // Hotfix login 2: enlace de entrada reutilizable 24 h. `nonce` deja volver a armar el MISMO enlace (el token es
  // HMAC(PORTAL_SESSION_SECRET, nonce): sin el secreto, la base sola no da el enlace) para que `portal` lo reenvíe en vez
  // de crear otro; los enlaces viejos (sin nonce) siguen valiendo hasta su vencimiento. Índice para buscar el vigente.
  `alter table login_tokens add column if not exists nonce text`,
  `create index if not exists login_tokens_user_idx on login_tokens (user_id, expires_at)`,
  // ventas-odoo: reporte de ventas de Odoo con detalle por línea. Las ventas del formato simple y las demo quedan con los
  // valores por defecto (sin line_key, cuenta_unidades = true, excluida = false): cuentan igual que antes. Una nota de
  // crédito se guarda con cantidad y montos negativos. El cliente final (leasing) se asigna a mano y ninguna carga lo borra.
  `alter table sales add column if not exists line_key text`,
  `create unique index if not exists sales_line_key_idx on sales (line_key) where line_key is not null`,
  `alter table sales add column if not exists tipo_doc text`,
  `alter table sales add column if not exists documento text`,
  `alter table sales add column if not exists vencimiento date`,
  `alter table sales add column if not exists moneda text`,
  `alter table sales add column if not exists tipo_cambio numeric(10,4)`,
  `alter table sales add column if not exists estado_sunat text`,
  `alter table sales add column if not exists status text`,
  `alter table sales add column if not exists oc_odoo text`,
  `alter table sales add column if not exists oc_proveedor text`,
  `alter table sales add column if not exists guia text`,
  `alter table sales add column if not exists cond_venta text`,
  `alter table sales add column if not exists descripcion text`,
  `alter table sales add column if not exists codigo_producto text`,
  `alter table sales add column if not exists tipo_linea text`,
  `alter table sales add column if not exists tipo_servicio text`,
  `alter table sales add column if not exists doc_cliente text`,
  `alter table sales add column if not exists vendedor_user_id integer`,
  `alter table sales add column if not exists total_sin_serv numeric(16,4)`,
  `alter table sales add column if not exists precio_unitario_usd numeric(16,4)`,
  `alter table sales add column if not exists total_usd numeric(16,4)`,
  `alter table sales add column if not exists costo_unitario numeric(16,4)`,
  `alter table sales add column if not exists costo_total numeric(16,4)`,
  `alter table sales add column if not exists costo_unitario_usd numeric(16,4)`,
  `alter table sales add column if not exists costo_total_usd numeric(16,4)`,
  `alter table sales add column if not exists factura_proveedor text`,
  `alter table sales add column if not exists proveedor text`,
  `alter table sales add column if not exists moneda_proveedor text`,
  `alter table sales add column if not exists tipo_cambio_proveedor numeric(10,4)`,
  `alter table sales add column if not exists margen text`,
  `alter table sales add column if not exists margen_pct numeric(10,2)`,
  `alter table sales add column if not exists cuenta_unidades boolean not null default true`,
  `alter table sales add column if not exists excluida boolean not null default false`,
  `alter table sales add column if not exists advertencia text`,
  `alter table sales add column if not exists upload_id integer`,
  `alter table sales add column if not exists cliente_final_company_id integer`,
  `alter table sales add column if not exists cliente_final_ruc text`,
  `alter table sales add column if not exists cliente_final_at timestamptz`,
  `alter table sales add column if not exists cliente_final_by integer`,
  `alter table sales add column if not exists updated_at timestamptz`,
  `create index if not exists sales_cliente_final_ruc_idx on sales (cliente_final_ruc) where cliente_final_ruc is not null`,
  `create index if not exists sales_documento_idx on sales (documento)`,
  `create table if not exists sales_uploads (
    id serial primary key,
    file_name text not null,
    hash text not null,
    formato text not null,
    user_id integer,
    user_name text,
    user_rol text,
    inserted integer not null default 0,
    updated integer not null default 0,
    stats jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  )`,
  // ventas-odoo (ajustes): motivo de exclusión (venta anulada) y montos en soles calculados con el T.C. de la línea
  `alter table sales add column if not exists motivo_exclusion text`,
  `alter table sales add column if not exists monto_calculado boolean not null default false`,
  `alter table sales add column if not exists total_original numeric(14,2)`,
  `alter table sales add column if not exists precio_unitario_original numeric(12,2)`,
  // corrida J, punto 4: correo del usuario (invitación de calendario de las citas) y enlaces a calendarios en la nube
  `alter table users add column if not exists email text`,
  `alter table users add column if not exists calendar_links boolean not null default false`,
  // corrida J (placa por línea): la placa de cada ítem va en quotes.data (jsonb); estos índices sirven para consultar qué se
  // le cotizó a un vehículo (listQuotes({ plate })) y para contrastar la placa con la flota del padrón (findFleetByPlacas)
  `create index if not exists quotes_items_gin_idx on quotes using gin ((data->'items') jsonb_path_ops)`,
  `create index if not exists fleet_vehicles_placa_key_idx on fleet_vehicles ((upper(replace(replace(placa, '-', ''), ' ', ''))))`,
  // Corrida J: empresas fuera del padrón. origen 'manual' = creada a mano (pasa a 'mtc' si su RUC llega en el padrón) y
  // quién la creó. Los vehículos cargados a mano van en fleet_vehicles con origen 'manual' (sin cambio de esquema).
  `alter table companies add column if not exists origen text not null default 'mtc'`,
  `alter table companies add column if not exists created_by integer`,
  // Corrida K: Match Venta. Provincia y distrito principales (padrón de pasajeros) y dirección escrita a mano.
  `alter table companies add column if not exists provincia text`,
  `alter table companies add column if not exists distrito text`,
  `alter table companies add column if not exists direccion text`,
  // Producto del stock propio por código de Odoo: prioridad (sobrevive a una carga nueva) y aplicación; registro de cambios.
  `create table if not exists match_products (
    code text primary key,
    aplicacion text,
    prioridad boolean not null default false,
    prioridad_at timestamptz,
    prioridad_by integer,
    sin_stock_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists match_priority_log (
    id serial primary key,
    code text not null,
    accion text not null,
    user_id integer,
    detalle text,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists match_priority_log_code_idx on match_priority_log (code, created_at)`,
  // Cálculo por lotes (al cargar stock, ventas o padrón y al cambiar una prioridad): las vistas leen lo guardado.
  `create table if not exists match_runs (
    id serial primary key,
    run_at timestamptz not null default now(),
    motivo text,
    productos integer not null default 0,
    empresas integer not null default 0,
    filas integer not null default 0,
    duracion_ms integer,
    data jsonb
  )`,
  `create table if not exists match_results (
    id serial primary key,
    run_id integer not null,
    product_code text not null,
    medida text not null,
    company_id integer,
    ruc text not null,
    razon_social text,
    tipo text not null,
    pct integer,
    llantas_medida integer not null default 0,
    unidades_medida integer not null default 0,
    podria_llevar integer,
    ya_compro boolean not null default false,
    excluida text,
    detalle jsonb not null
  )`,
  `create index if not exists match_results_product_idx on match_results (product_code, pct desc)`,
  `create index if not exists match_results_company_idx on match_results (company_id)`,
  // Visita agendada desde Match Venta: ligada a la cita y al producto que la originó (y a la actividad con que se reportó).
  `create table if not exists match_visits (
    id serial primary key,
    appointment_id integer not null unique,
    company_id integer not null,
    user_id integer,
    product_code text not null,
    motivo text,
    activity_id integer,
    reported_at timestamptz,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists match_visits_company_idx on match_visits (company_id)`,
  // Corrida L: padrón reducido del RUC de SUNAT (`npm run portal:import-sunat`): una fila por RUC del portal (empresas y
  // clientes de ventas) con estado, condición, ubigeo, piezas y dirección armada; locales anexos aparte. No toca companies:
  // la dirección de operación escrita a mano (companies.direccion) nunca se pisa.
  `create table if not exists sunat_padron (
    ruc text primary key,
    encontrado boolean not null default true,
    razon_social text,
    estado text,
    condicion text,
    ubigeo text,
    departamento text,
    provincia text,
    distrito text,
    direccion text,
    piezas jsonb,
    anexos integer not null default 0,
    fecha date not null,
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists sunat_locales (
    id serial primary key,
    ruc text not null,
    ubigeo text,
    departamento text,
    provincia text,
    distrito text,
    direccion text,
    piezas jsonb not null,
    fecha date not null
  )`,
  `create index if not exists sunat_locales_ruc_idx on sunat_locales (ruc)`,
];

/** Desde aquí empiezan las sentencias del portal: antes de ejecutarlas se pasa la guardia (migrate-guard.ts). */
const PORTAL_FROM = STATEMENTS.findIndex((s) => /^create table if not exists companies\b/.test(s));
if (PORTAL_FROM < 0) throw new Error("migrate: no se encontró el inicio de las tablas del portal (create table companies)");

/** Aplica todas las sentencias (con la guardia del portal) a una conexión. La usan main() y las pruebas de Postgres. */
export async function applyMigrations(sql: postgres.Sql, log: (m: string) => void = console.log): Promise<void> {
  const run = async (stmt: string) => {
    const head = stmt.replace(/\s+/g, " ").slice(0, 70);
    await sql.unsafe(stmt);
    log(`ok   ${head}…`);
  };
  for (const stmt of STATEMENTS.slice(0, PORTAL_FROM)) await run(stmt);

  // Guardia: si una tabla del portal ya existe y no tiene nuestras columnas, es de otra cosa: no se toca nada del portal.
  const expected = expectedSchema(STATEMENTS.slice(PORTAL_FROM));
  const cols = await sql<ColumnRow[]>`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public' and table_name in ${sql([...expected.keys()])}`;
  const guard = checkExistingTables(expected, [...cols]);
  if (!guard.ok) throw new Error(guard.message);
  if (guard.existing.length) log(`Portal: tablas ya creadas en una corrida anterior: ${guard.existing.join(", ")}`);

  for (const stmt of STATEMENTS.slice(PORTAL_FROM)) await run(stmt);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL no está definida (ponla en .env)");
  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 20, onnotice: () => undefined }); // "already exists, skipping" notices are expected
  try {
    await applyMigrations(sql);
    const [{ photos }] = await sql`select count(*)::int as photos from prices where photo_url is not null`;
    const [{ rows }] = await sql`select count(*)::int as rows from prices`;
    const [{ files }] = await sql`select count(*)::int as files from quote_files`;
    const [{ contracts }] = await sql`select count(*)::int as contracts from contract_prices`;
    // con la fecha del último: un 0 recién creada la tabla (o sin tráfico desde entonces) no es lo mismo que un registro roto
    const [{ msgs, lastMsg }] = await sql`select count(*)::int as msgs, max(created_at) as "lastMsg" from messages`;
    const lastMsgText = lastMsg ? ` (último: ${new Date(lastMsg as string).toLocaleString("es-PE", { timeZone: "America/Lima" })})` : " (aún ninguno: se llena con el primer mensaje que llegue al webhook)";
    console.log(`\nListo. Filas de precios: ${rows} (con foto: ${photos}). Archivos de cotizaciones enviadas: ${files}. Precios de contrato cambiados desde WhatsApp: ${contracts}. Mensajes registrados: ${msgs}${lastMsgText}. Si las fotos están en 0, vuelve a ingerir la lista de Steel.`);
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

// solo al ejecutarlo (npm run db:migrate), no al importarlo desde las pruebas
if (/migrate\.ts$/.test(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
