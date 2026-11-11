import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkExistingTables, expectedSchema, type ColumnRow } from "./migrate-guard";

const STATEMENTS = [
  `create table if not exists users (
    id serial primary key,
    nombre text not null,
    whatsapp text unique,
    rol text not null default 'vendedor',
    created_at timestamptz not null default now()
  )`,
  `create table if not exists fleet_vehicles (
    id serial primary key,
    placa text not null,
    peso_bruto numeric(10,2),
    origen text not null,
    unique (placa, origen)
  )`,
  `create index if not exists fleet_vehicles_placa_idx on fleet_vehicles (placa)`,
  `alter table users add column if not exists email text`,
];

const rows = (table: string, cols: string[]): ColumnRow[] => cols.map((c) => ({ table_name: table, column_name: c }));

describe("migrate guard", () => {
  it("reads table columns from the create statements (skips constraints, indexes and alters)", () => {
    const s = expectedSchema(STATEMENTS);
    expect([...s.keys()]).toEqual(["users", "fleet_vehicles"]);
    expect(s.get("users")).toEqual(["id", "nombre", "whatsapp", "rol", "created_at"]);
    expect(s.get("fleet_vehicles")).toEqual(["id", "placa", "peso_bruto", "origen"]);
  });

  it("table that does not exist yet: ok", () => {
    expect(checkExistingTables(expectedSchema(STATEMENTS), [])).toEqual({ ok: true, existing: [] });
  });

  it("our own table from an earlier run (even without later alter columns, with extra columns): ok", () => {
    const r = checkExistingTables(expectedSchema(STATEMENTS), [...rows("users", ["id", "nombre", "whatsapp", "rol", "created_at", "extra"]), ...rows("fleet_vehicles", ["id", "placa", "peso_bruto", "origen"])]);
    expect(r).toEqual({ ok: true, existing: ["users", "fleet_vehicles"] });
  });

  it("foreign table with the same name: aborts with a clear message", () => {
    const r = checkExistingTables(expectedSchema(STATEMENTS), rows("users", ["id", "nombre", "email", "password_hash", "created_at"]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.foreign).toEqual([{ table: "users", missing: ["whatsapp", "rol"] }]);
    expect(r.message).toContain("La tabla users ya existe en la base y no es del portal");
    expect(r.message).toContain("whatsapp, rol");
    expect(r.message).toContain("No se tocó nada");
  });

  it("the real portal statements in migrate.ts define the expected columns", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "..", "cli", "migrate.ts"), "utf8");
    const stmts = [...src.matchAll(/`(create table if not exists[\s\S]*?)`/g)].map((m) => m[1]);
    const s = expectedSchema(stmts);
    for (const t of ["companies", "fleet_vehicles", "sales", "users", "login_tokens", "portal_sessions", "contacts", "opportunities", "opportunity_stage_history", "activities", "appointments"]) {
      expect(s.has(t), t).toBe(true);
    }
    expect(s.get("users")).toEqual(expect.arrayContaining(["whatsapp", "rol", "activo"]));
    expect(s.get("sales")).toEqual(expect.arrayContaining(["is_demo", "cantidad", "ruc"]));
    expect(s.get("sales")).not.toContain("source_ref"); // added by alter: an older portal sales table is still ours
    expect(s.get("fleet_vehicles")).not.toContain("unique");
    // a pre-portal "sales" table without is_demo is rejected
    const r = checkExistingTables(s, rows("sales", ["id", "fecha", "ruc", "cantidad", "total"]));
    expect(r.ok).toBe(false);
  });
});
