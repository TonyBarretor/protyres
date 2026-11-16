/**
 * Corrida H, punto 2 — base de Postgres para las pruebas de integración (`npm run test:pg`).
 *
 * Nunca toca los datos reales: con PGTEST_URL usa esa base (un Postgres local); si no, crea en el mismo servidor de
 * DATABASE_URL una base aparte `protyres_pgtest_<pid>_<azar>`, le aplica todas las migraciones (src/cli/migrate.ts) y
 * la elimina al terminar. Las pruebas se conectan con la misma URL que producción salvo el nombre de la base: mismo
 * intermediario de conexiones (pooler de Supabase en modo transacción, puerto 6543), mismas opciones y tamaño de pool
 * (src/lib/store/pg-options.ts).
 */
import postgres from "postgres";
import { applyMigrations } from "../cli/migrate";

export const TEST_DB_PREFIX = "protyres_pgtest_";

export interface TestDatabase {
  url: string;
  name: string;
  /** Elimina la base (solo si la creó esta corrida). */
  drop(): Promise<void>;
}

function adminClient(url: string) {
  return postgres(url, { prepare: false, max: 1, connect_timeout: 20, onnotice: () => undefined });
}

export async function createTestDatabase(log: (m: string) => void = () => undefined): Promise<TestDatabase> {
  const local = process.env.PGTEST_URL;
  if (local) {
    const sql = adminClient(local);
    try {
      await applyMigrations(sql, () => undefined);
    } finally {
      await sql.end({ timeout: 5 });
    }
    return { url: local, name: new URL(local).pathname.slice(1), drop: async () => undefined };
  }
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("test:pg necesita PGTEST_URL (Postgres local) o DATABASE_URL (crea una base aparte en ese servidor)");
  const name = `${TEST_DB_PREFIX}${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = adminClient(base);
  try {
    // bases de corridas anteriores que se cortaron a la mitad (más de 2 h)
    const old = await admin<{ datname: string }[]>`
      select datname from pg_database d where datname like ${TEST_DB_PREFIX + "%"}
        and not exists (select 1 from pg_stat_activity a where a.datname = d.datname and a.backend_start > now() - interval '2 hours')`;
    for (const o of old) if (o.datname.startsWith(TEST_DB_PREFIX)) await admin.unsafe(`drop database if exists "${o.datname}" with (force)`).catch(() => undefined);
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(base);
  u.pathname = `/${name}`;
  const url = u.toString();
  log(`test:pg: base temporal ${name}`);
  const sql = adminClient(url);
  try {
    // en Supabase las extensiones (pg_trgm) viven en el esquema "extensions", que una base nueva no trae
    await sql.unsafe("create schema if not exists extensions");
    await applyMigrations(sql, () => undefined);
  } finally {
    await sql.end({ timeout: 5 });
  }
  return {
    url,
    name,
    async drop() {
      if (!name.startsWith(TEST_DB_PREFIX)) return;
      const a = adminClient(base);
      try {
        await a.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await a.end({ timeout: 5 });
      }
    },
  };
}

/** URL de la base de pruebas (la pone el globalSetup en PGTEST_DB_URL). */
export function testDbUrl(): string {
  const url = process.env.PGTEST_DB_URL;
  if (!url) throw new Error("PGTEST_DB_URL no está definida: corre estas pruebas con npm run test:pg");
  return url;
}

/** Vacía las tablas (entre archivos de prueba), sin tocar el esquema. Solo en la base de pruebas. */
export async function truncateAll(url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  if (!process.env.PGTEST_URL && !name.startsWith(TEST_DB_PREFIX)) throw new Error(`truncateAll: ${name} no es una base de pruebas`);
  const sql = adminClient(url);
  try {
    const tables = await sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`;
    if (tables.length) await sql.unsafe(`truncate ${tables.map((t) => `"${t.tablename}"`).join(", ")} restart identity cascade`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
