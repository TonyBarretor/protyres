/**
 * Corrida J, punto 5 — pantalla general de ventas contra Postgres real: el store JSON y PgPortalStore dan lo mismo en cada
 * filtro y combinación (líneas, resumen, vista por cliente en cada orden, opciones de los filtros), antes y después de
 * asignar un cliente final; y con el archivo real de Odoo (si está en data/, que no va a git) cada consulta de la pantalla
 * responde en menos de 2 s y el resumen coincide con el del store JSON.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SALES_SETTINGS } from "../lib/portal/sales/config";
import { commitOdooUpload, previewOdooUpload } from "../lib/portal/sales/import";
import { assignScenarioClienteFinal, LIST_FILTERS, seedSalesListScenario } from "../lib/portal/sales/list-scenario";
import { readSalesXlsx } from "../lib/portal/sales/xlsx";
import { JsonPortalStore } from "../lib/portal/store/json-portal-store";
import { PgPortalStore } from "../lib/portal/store/pg-portal-store";
import type { PortalStore, Sale, SalesClientSort, SalesListFilter } from "../lib/portal/store/types";
import { loadSalesListView } from "../lib/portal/ui/ventas-lista";
import { testDbUrl, truncateAll } from "./harness";
import { bothTraces, diffTraces } from "./parity";

let pg: PgPortalStore;

beforeAll(async () => {
  await truncateAll(testDbUrl());
  pg = PgPortalStore.connect(testDbUrl());
});
afterAll(async () => {
  await pg?.close();
});

const strip = (rows: Sale[]) => rows.map(({ id: _i, createdAt: _c, ...s }) => ({ ...s, detalle: s.detalle && { ...s.detalle, updatedAt: s.detalle.updatedAt ? "<fecha>" : null, uploadId: null } }));
const SORTS: SalesClientSort[] = ["neumaticos", "total", "margen", "ultima", "cliente"];

async function traceFilters(s: PortalStore, trace: (label: string, value: unknown) => void, tag: string, filters: Record<string, SalesListFilter>) {
  for (const [name, f] of Object.entries(filters)) {
    trace(`${tag}.${name}.lineas`, strip(await s.listSalesLines(f, { limit: 100, offset: 0 })));
    trace(`${tag}.${name}.pagina2`, (await s.listSalesLines(f, { limit: 3, offset: 3 })).map((x) => [x.fecha, x.detalle?.lineKey ?? null]));
    trace(`${tag}.${name}.resumen`, await s.salesListSummary(f));
    for (const sort of SORTS) for (const dir of ["asc", "desc"] as const) trace(`${tag}.${name}.clientes.${sort}.${dir}`, await s.salesListByClient(f, { sort, dir, limit: 3, offset: 1 }));
  }
}

describe("pantalla de ventas: JSON y Postgres dan lo mismo", () => {
  it("cada filtro y combinación, resumen, vista por cliente en cada orden y opciones", async () => {
    const { json, pg: p } = await bothTraces<PortalStore>(JsonPortalStore.memory(), pg, async (s, trace) => {
      const { ids } = await seedSalesListScenario(s);
      await traceFilters(s, trace, "antes", LIST_FILTERS);
      trace("opciones.reales", await s.salesFilterOptions(false));
      trace("opciones.demo", await s.salesFilterOptions(true));
      trace("asignar", await assignScenarioClienteFinal(s, ids));
      await traceFilters(s, trace, "despues", { todo: {}, leasing: LIST_FILTERS.leasing, minera: { q: "minera" }, "q.tildes": LIST_FILTERS["q.tildes"], medida: LIST_FILTERS.medida });
      trace("fuera.de.rango", await s.salesListByClient({}, { sort: "total", dir: "desc", limit: 5, offset: 500 }));
    });
    if (process.env.PGTEST_DUMP) fs.writeFileSync(process.env.PGTEST_DUMP, JSON.stringify(diffTraces(json, p), null, 1));
    expect(diffTraces(json, p)).toEqual([]);
    // y lo que se espera (no solo que coincidan)
    expect((json["antes.todo.resumen"] as { lineas: number }).lineas).toBe(19);
    expect((json["despues.minera.resumen"] as { lineas: number }).lineas).toBe(1);
    expect(json["fuera.de.rango"]).toMatchObject({ rows: [], total: expect.any(Number) });
    expect((json["fuera.de.rango"] as { total: number }).total).toBeGreaterThan(0);
  });
});

const REAL = path.resolve(process.cwd(), "data/referencia-360tyres/Reporte_Ventas_01-2025_hasta_11-2026.xlsx");
describe.skipIf(!fs.existsSync(REAL))("pantalla de ventas: archivo real en Postgres", () => {
  it("2.920 líneas: cada consulta de la pantalla en menos de 2 s y el mismo resumen que el store JSON", async () => {
    await truncateAll(testDbUrl());
    const json = JsonPortalStore.memory();
    const buf = fs.readFileSync(REAL);
    for (const s of [pg, json] as PortalStore[]) {
      const u = await s.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
      const r = await readSalesXlsx(buf, { users: await s.listUsers(), settings: DEFAULT_SALES_SETTINGS });
      const stats = await previewOdooUpload(s, r.odoo!);
      await commitOdooUpload({ store: s, parsed: r.odoo!, fileName: "real.xlsx", hash: "real", user: { id: u.id, nombre: u.nombre, rol: "vendedor" }, stats, log: () => undefined });
    }
    expect((await pg.countSales()).total).toBe(2920);
    const opts = await pg.salesFilterOptions(false);
    const marca = opts.marcas[0];
    const vendedor = opts.vendedores[0];
    const filters: Record<string, SalesListFilter> = {
      todo: {},
      texto: { q: "fenix" },
      "texto.2": { q: "transportes sac" },
      medida: { medida: "295/80R22.5" },
      marca: { marca },
      tipo: { tipoLinea: "servicio" },
      vendedor: { vendedor },
      rango: { desde: "2026-01-01", hasta: "2026-06-30" },
      leasing: { docRucs: DEFAULT_SALES_SETTINGS.leasingRucs, sinClienteFinal: true },
      combinado: { q: "r22.5", tipoLinea: "neumatico", desde: "2025-06-01", vendedor },
    };
    const times: string[] = [];
    const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const t0 = Date.now();
      const out = await fn();
      const ms = Date.now() - t0;
      times.push(`${label} ${ms} ms`);
      expect(ms, label).toBeLessThan(2000);
      return out;
    };
    for (const [name, f] of Object.entries(filters)) {
      const sum = await timed(`${name}.resumen`, () => pg.salesListSummary(f));
      // mismo resultado que el store JSON (los montos en numeric de Postgres y los del store JSON, al céntimo)
      expect(sum, name).toEqual(await json.salesListSummary(f));
      const last = Math.max(0, Math.floor((sum.lineas - 1) / 50) * 50);
      await timed(`${name}.pagina1`, () => pg.listSalesLines(f, { limit: 50, offset: 0 }));
      await timed(`${name}.ultima`, () => pg.listSalesLines(f, { limit: 50, offset: last }));
      for (const sort of SORTS) {
        const byClient = await timed(`${name}.clientes.${sort}`, () => pg.salesListByClient(f, { sort, dir: "desc", limit: 50, offset: 0 }));
        expect(byClient, `${name}.${sort}`).toEqual(await json.salesListByClient(f, { sort, dir: "desc", limit: 50, offset: 0 }));
      }
    }
    // la pantalla completa (todas sus consultas, como la arma la página)
    const vendedorUser = { id: 1, rol: "vendedor" as const, activo: true };
    await timed("pantalla.lineas", () => loadSalesListView(pg, vendedorUser, { q: "fenix", tipo: "neumatico", p: "3" }));
    await timed("pantalla.clientes", () => loadSalesListView(pg, vendedorUser, { vista: "clientes", orden: "margen" }));
    await timed("opciones", () => pg.salesFilterOptions(false));
    console.log(`[test:pg] pantalla de ventas (archivo real): ${times.join(", ")}`);
    const all = await pg.salesListSummary({});
    // 18.536 neumáticos netos, igual que la carga (sales-odoo.pg.test.ts): ninguna línea se pierde ni se duplica
    expect(all.neumaticos).toBe(18536);
  });
});
