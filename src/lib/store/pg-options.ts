/**
 * Opciones de la lib `postgres` para funciones sin servidor (Vercel) contra el pooler de Supabase en modo transacción
 * (puerto 6543). Las usan los dos stores (src/lib/store/pg-store.ts y src/lib/portal/store/pg-portal-store.ts).
 *
 * Corrida F, punto 1 (Prospectos colgado 300 s en Vercel), medido contra la base real:
 *  - max_pipeline: 0. Con más consultas en paralelo que conexiones en el pool, la lib encola (pipelining) la siguiente
 *    consulta en una conexión ocupada; a través del pooler en modo transacción esa segunda consulta no vuelve nunca y la
 *    función espera hasta el límite de Vercel. Con 0, cada conexión lleva una consulta a la vez y el resto espera turno.
 *  - prepare: false. El pooler en modo transacción no conserva sentencias preparadas entre transacciones.
 *  - connect_timeout: si la base no contesta en 10 s, falla (el bot sigue con el cotizador; la página muestra error).
 *  - idle_timeout / max_lifetime: la instancia suelta las conexiones ociosas y renueva las viejas.
 *
 * statement_timeout por conexión no sirve aquí: el pooler en modo transacción ignora los parámetros de arranque
 * (`connection: { statement_timeout }` y `options=-c ...` quedan en el valor del rol, 2 min; comprobado). El tope por
 * página lo pone withDeadline() (src/lib/portal/ui/deadline.ts) y el de la ruta, maxDuration (src/app/portal/layout.tsx).
 */
import postgres from "postgres";

export interface ServerlessPgOptionsInput {
  /** Conexiones por instancia. */
  max: number;
}

/** PG_CONTAR=1 (diagnóstico: simulador con SIM_TIEMPOS; pruebas): consultas enviadas por los stores de este proceso. */
export const pgQueryCount = { n: 0, last: [] as string[] };

export function serverlessPgOptions({ max }: ServerlessPgOptionsInput): postgres.Options<Record<string, postgres.PostgresType>> {
  const opts = {
    ...(process.env.PG_CONTAR
      ? {
          debug: (_c: number, query: string) => {
            pgQueryCount.n++;
            pgQueryCount.last = [...pgQueryCount.last.slice(-19), query];
          },
        }
      : {}),
    prepare: false,
    max,
    // no está en los tipos de la lib, pero sí en sus opciones (src/index.js: max_pipeline, por defecto 100)
    max_pipeline: 0,
    connect_timeout: 10,
    idle_timeout: 20,
    max_lifetime: 60 * 10,
    onnotice: () => undefined,
  };
  return opts as postgres.Options<Record<string, postgres.PostgresType>>;
}

type Client = postgres.Sql<Record<string, postgres.PostgresType>>;

/**
 * Corrida H, punto 1 (16/11 en producción: "UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1" al hacer
 * `asignarme`). Con max_pipeline: 0 la lib nunca llama al `onexecute` del BEGIN de `sql.begin` (en connection.js va
 * detrás de `sent.length < max_pipeline`, siempre falso), así que la conexión no queda reservada y, con más de una en
 * el pool, el BEGIN se rechaza y la conexión queda con la transacción abierta. Pasaba con todo `sql.begin` (portal) y
 * con las transacciones de drizzle (carga de listas de precios), que usan el mismo `begin`.
 *
 * Este `begin` reserva una conexión del pool (`sql.reserve()`, que no depende del pipelining), corre BEGIN / la función
 * / COMMIT en ella y, si algo falla, ROLLBACK; siempre la devuelve al pool. Con el pooler de Supabase en modo
 * transacción, todo lo de BEGIN a COMMIT va por la misma conexión del servidor. Sin savepoints (nadie los usa).
 */
export async function reservedBegin<T>(sql: Client, fn: (tx: postgres.TransactionSql<Record<string, postgres.PostgresType>>) => T | Promise<T>, mode = ""): Promise<T> {
  const conn = await sql.reserve();
  let open = false;
  try {
    await discardStaleTransaction(conn);
    await conn.unsafe(`begin ${mode.replace(/[^a-z ]/gi, "")}`);
    open = true;
    const tx = Object.assign(conn, {
      savepoint: () => {
        throw new Error("savepoint no está soportado (pg-options.ts reservedBegin)");
      },
      prepare: () => {
        throw new Error("prepare no está soportado (pg-options.ts reservedBegin)");
      },
    }) as unknown as postgres.TransactionSql<Record<string, postgres.PostgresType>>;
    const out = await fn(tx);
    const result = (Array.isArray(out) ? await Promise.all(out) : out) as T;
    await conn.unsafe("commit");
    open = false;
    return result;
  } catch (err) {
    if (open) await conn.unsafe("rollback").catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Hotfix login (18/11): una conexión que trae una transacción abierta de antes (un BEGIN sin COMMIT: el error del 16/11, o
 * una función cortada a mitad de una transacción) se traga todo lo que se escriba por ella: nadie más lo ve y, cuando la
 * conexión se cierra, se pierde. Con el login pasaba eso: la sesión creada no existía para la página siguiente y el enlace
 * quedaba "ya usado" en esa conexión. Antes de cada transacción se mira (dentro de una transacción, now() es la hora de su
 * inicio y no la de la sentencia); si la trae, se deshace y se registra. Lo que hubiera en ella ya estaba perdido.
 */
export async function discardStaleTransaction(conn: { unsafe(q: string): Promise<unknown> }, log: (m: string) => void = console.error): Promise<boolean> {
  const [r] = (await conn.unsafe("select (now() <> statement_timestamp()) as stale")) as { stale: boolean }[];
  if (!r?.stale) return false;
  log("[pg] la conexión traía una transacción abierta de antes (sin COMMIT): se deshace antes de seguir");
  await conn.unsafe("rollback");
  return true;
}

/** Cliente `postgres` para los stores: opciones de arriba y `begin` seguro (reservedBegin). */
export function serverlessPostgres(url: string, input: ServerlessPgOptionsInput): Client {
  const sql = postgres(url, serverlessPgOptions(input)) as Client;
  const begin = ((modeOrFn: string | ((tx: postgres.TransactionSql<Record<string, postgres.PostgresType>>) => unknown), maybeFn?: (tx: postgres.TransactionSql<Record<string, postgres.PostgresType>>) => unknown) =>
    typeof modeOrFn === "function" ? reservedBegin(sql, modeOrFn) : reservedBegin(sql, maybeFn!, modeOrFn)) as Client["begin"];
  return Object.assign(sql, { begin });
}
