/**
 * Tope de tiempo para cargar una pantalla del portal (corrida F, punto 1). Si la base no contesta a tiempo, la página
 * falla con un mensaje claro (src/app/portal/error.tsx) en vez de quedarse cargando hasta el límite de Vercel.
 *
 * El pooler de Supabase ignora statement_timeout por conexión (ver src/lib/store/pg-options.ts), así que el tope va aquí;
 * la consulta que quedó en curso la corta la base con el statement_timeout del rol.
 */

/** Tope por pantalla (ms). Cada pantalla responde en < 2 s contra la base real; 15 s ya es una falla. */
export const PAGE_DEADLINE_MS = 15_000;

export class PortalTimeoutError extends Error {
  constructor(
    readonly what: string,
    readonly ms: number,
  ) {
    super(`${what}: la base de datos no respondió en ${Math.round(ms / 1000)} s`);
    this.name = "PortalTimeoutError";
  }
}

export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PortalTimeoutError(what, ms)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
