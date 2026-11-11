/**
 * Guardia de `npm run db:migrate` para las tablas del portal. Nombres como `users` o `sales` son comunes: si la base ya
 * tiene una tabla con ese nombre que NO es la nuestra, `create table if not exists` no haría nada, los `create index`
 * fallarían a medias o, peor, el portal escribiría en una tabla ajena. Antes de crear nada del portal se compara lo que
 * hay en `information_schema.columns` con las columnas de nuestros `create table`; si falta alguna, se aborta todo.
 *
 * Las columnas esperadas salen de las propias sentencias de migrate.ts (un solo lugar). Solo cuentan las del
 * `create table`: las que agrega después un `alter table ... add column if not exists` pueden faltar en una base donde el
 * portal ya se creó antes (es justo lo que ese alter viene a completar).
 *
 * Puro: sin conexión (migrate.ts hace la consulta y le pasa las filas).
 */

/** Tabla -> columnas definidas en su `create table if not exists`. */
export type ExpectedSchema = Map<string, string[]>;

export interface ColumnRow {
  table_name: string;
  column_name: string;
}

export interface ForeignTable {
  table: string;
  /** Columnas nuestras que no tiene. */
  missing: string[];
}

export type GuardResult = { ok: true; existing: string[] } | { ok: false; foreign: ForeignTable[]; message: string };

const CONSTRAINT_WORDS = new Set(["primary", "unique", "constraint", "foreign", "check", "exclude", "like"]);

/** Parte el cuerpo de un create table por comas de primer nivel (respeta numeric(12,2), unique (a, b), ...). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Tablas y columnas de los `create table if not exists` de `statements` (ignora índices y alters). */
export function expectedSchema(statements: string[]): ExpectedSchema {
  const out: ExpectedSchema = new Map();
  for (const stmt of statements) {
    const m = /^\s*create\s+table\s+if\s+not\s+exists\s+("?)(\w+)\1\s*\(([\s\S]*)\)\s*;?\s*$/i.exec(stmt);
    if (!m) continue;
    const cols: string[] = [];
    for (const part of splitTopLevel(m[3])) {
      const word = /^\s*"?(\w+)"?/.exec(part)?.[1];
      if (!word || CONSTRAINT_WORDS.has(word.toLowerCase())) continue;
      cols.push(word.toLowerCase());
    }
    out.set(m[2].toLowerCase(), cols);
  }
  return out;
}

/**
 * Compara lo esperado con las columnas que ya existen (filas de information_schema.columns del esquema public).
 * Tabla inexistente: ok (se creará). Tabla con todas nuestras columnas: ok (corrida previa). Si no: aborta.
 */
export function checkExistingTables(expected: ExpectedSchema, rows: ColumnRow[]): GuardResult {
  const present = new Map<string, Set<string>>();
  for (const r of rows) {
    const t = r.table_name.toLowerCase();
    let set = present.get(t);
    if (!set) present.set(t, (set = new Set()));
    set.add(r.column_name.toLowerCase());
  }
  const foreign: ForeignTable[] = [];
  const existing: string[] = [];
  for (const [table, cols] of expected) {
    const have = present.get(table);
    if (!have) continue;
    existing.push(table);
    const missing = cols.filter((c) => !have.has(c));
    if (missing.length) foreign.push({ table, missing });
  }
  if (!foreign.length) return { ok: true, existing };
  const detail = foreign.map((f) => `La tabla ${f.table} ya existe en la base y no es del portal: le faltan las columnas ${f.missing.join(", ")}`).join(".\n");
  return {
    ok: false,
    foreign,
    message: `${detail}.\nNo se tocó nada del portal (ni tablas ni índices). Renombra o mueve esas tablas, o usa otra base, y vuelve a correr npm run db:migrate.`,
  };
}
