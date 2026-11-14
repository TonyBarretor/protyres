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
import type postgres from "postgres";

export interface ServerlessPgOptionsInput {
  /** Conexiones por instancia. */
  max: number;
}

export function serverlessPgOptions({ max }: ServerlessPgOptionsInput): postgres.Options<Record<string, postgres.PostgresType>> {
  const opts = {
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
