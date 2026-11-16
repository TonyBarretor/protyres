/**
 * Corrida F, punto 1: Prospectos se colgaba 300 s en Vercel. Causa medida contra la base real: con el pooler de Supabase
 * en modo transacción (puerto 6543), dos consultas encoladas en la misma conexión (pipelining de la lib `postgres`, que
 * lo hace cuando hay más consultas en paralelo que conexiones en el pool) no vuelven nunca. Las dos conexiones a Postgres
 * deben salir de serverlessPgOptions(): sin pipelining, sin sentencias preparadas y con tiempos de conexión acotados.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serverlessPgOptions } from "./pg-options";

describe("serverlessPgOptions", () => {
  it("no encola consultas en una conexión (max_pipeline 0) y no prepara sentencias", () => {
    const o = serverlessPgOptions({ max: 4 }) as Record<string, unknown>;
    expect(o.max_pipeline).toBe(0);
    expect(o.prepare).toBe(false);
    expect(o.max).toBe(4);
    expect(o.connect_timeout).toBeGreaterThan(0);
    expect(o.connect_timeout).toBeLessThanOrEqual(10);
    expect(o.idle_timeout).toBeGreaterThan(0);
    expect(o.max_lifetime).toBeGreaterThan(0);
  });

  // Corrida H: los clientes salen de serverlessPostgres() (estas opciones + begin seguro, reservedBegin), no de
  // postgres(url, serverlessPgOptions(...)) directo: con max_pipeline 0, el sql.begin de la lib fallaba (UNSAFE_TRANSACTION).
  it("la usan el store del portal y el del cotizador (con begin seguro)", () => {
    for (const f of ["src/lib/portal/store/pg-portal-store.ts", "src/lib/store/pg-store.ts", "src/lib/store/price-sizes.ts"]) {
      const src = fs.readFileSync(path.resolve(process.cwd(), f), "utf8");
      expect(src, f).toMatch(/serverlessPostgres\(url, \{ max: \d+ \}\)/);
      expect(src, f).not.toMatch(/\bpostgres\(url/);
    }
  });
});
