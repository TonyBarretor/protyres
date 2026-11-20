/**
 * ventas-odoo contra Postgres real: las mismas cargas del reporte de Odoo en el store JSON y en PgPortalStore dan lo
 * mismo (carga doble, archivo más reciente, cliente final que sobrevive a la recarga, participación solo de neumáticos,
 * historial, última venta, por asignar cliente final); y el archivo real (si está en data/, que no va a git) se carga
 * entero dos veces en un tiempo lejos del límite de la función de Vercel.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonPortalStore } from "../lib/portal/store/json-portal-store";
import { PgPortalStore } from "../lib/portal/store/pg-portal-store";
import type { PortalStore, Sale } from "../lib/portal/store/types";
import { DEFAULT_SALES_SETTINGS } from "../lib/portal/sales/config";
import { companySalesView, lastSaleReference, lastTyreSales, leasingPending } from "../lib/portal/sales/history";
import { commitOdooUpload, previewOdooUpload } from "../lib/portal/sales/import";
import { buildOdooXlsx, FX, sampleOdooLines } from "../lib/portal/sales/odoo-fixture";
import { readSalesXlsx } from "../lib/portal/sales/xlsx";
import { recalcScores } from "../lib/portal/scoring/recalc";
import { loadPortalConfig } from "../lib/portal/config";
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

/** Sin el id (en Postgres un upsert que choca gasta un número de la secuencia) ni la hora de carga. */
const strip = (rows: Sale[]) => rows.map(({ id: _i, createdAt: _c, ...s }) => ({ ...s, detalle: s.detalle && { ...s.detalle, updatedAt: s.detalle.updatedAt ? "<fecha>" : null } }));

async function load(s: PortalStore, buf: Buffer, name: string, user: { id: number; nombre: string; rol: "vendedor" }) {
  const r = await readSalesXlsx(buf, { users: await s.listUsers(), settings: DEFAULT_SALES_SETTINGS });
  const stats = await previewOdooUpload(s, r.odoo!);
  const res = await commitOdooUpload({ store: s, parsed: r.odoo!, fileName: name, hash: name, user, stats, log: () => undefined });
  return { stats, res };
}

describe("ventas-odoo: JSON y Postgres dan lo mismo", () => {
  it("cargas, cliente final, participación, historial y última venta", async () => {
    const first = await buildOdooXlsx(sampleOdooLines());
    const newer = await buildOdooXlsx([
      ...sampleOdooLines(),
      { fecha: "2026-11-02", documento: "F003-5100", ruc: FX.cliente, razon: "TRANSPORTES PRUEBA SAC", descripcion: "[P0759] 295/80R22.5 18PR FENIXWAY VALOR 89", cantidad: 4, precio: 260, costo: 200 },
    ]);
    const { json, pg: p } = await bothTraces<PortalStore>(JsonPortalStore.memory(), pg, async (s, trace) => {
      const u = await s.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
      const frank = { id: u.id, nombre: u.nombre, rol: "vendedor" as const };
      const up = await s.upsertCompanies([
        // en orden de RUC: Postgres numera el lote por RUC (los ids tienen que coincidir con el store JSON)
        { ruc: FX.banco, razonSocial: "BANCO DE CREDITO DEL PERU" },
        { ruc: FX.cliente, razonSocial: "TRANSPORTES PRUEBA SAC", unidades: 20, llantasPiso: 200 },
        { ruc: FX.clienteFinal, razonSocial: "MINERA CLIENTE FINAL SAA", unidades: 10, llantasPiso: 80 },
      ]);
      await recalcScores(s, loadPortalConfig().scoring, { now: new Date("2026-11-11T15:00:00Z"), prices: null });
      const a = await load(s, first, "a.xlsx", frank);
      trace("preview.1", { ...a.stats, topEmpresas: a.stats.topEmpresas.length });
      trace("commit.1", { inserted: a.res.inserted, updated: a.res.updated, recalc: a.res.empresasRecalculadas });
      const b = await load(s, first, "a.xlsx", frank);
      trace("commit.2", { inserted: b.res.inserted, updated: b.res.updated, nuevas: b.stats.lineasNuevas });
      trace("keys", [...(await s.existingSaleLineKeys(["FA|F003-5001|SERV.BALAN|2", "FA|F003-5001|SERV.BALAN|3", "NC|F003-90|P0759|1"]))].sort());
      trace("part.1", await s.participation([FX.cliente, FX.banco, FX.fueraPadron, FX.dni, FX.clienteFinal], "2025-01-01"));
      trace("pending.1", await leasingPending(s));
      trace("setCF", await s.setClienteFinal({ bankRuc: FX.banco, documentos: ["F003-5005"], company: { id: up.ids[FX.clienteFinal], ruc: FX.clienteFinal }, userId: frank.id }));
      trace("setCF.wrongBank", await s.setClienteFinal({ bankRuc: FX.cliente, documentos: ["F003-5005"], company: { id: up.ids[FX.clienteFinal], ruc: FX.clienteFinal }, userId: frank.id }));
      const c = await load(s, newer, "b.xlsx", frank);
      trace("commit.3", { inserted: c.res.inserted, updated: c.res.updated });
      trace("part.2", await s.participation([FX.cliente, FX.banco, FX.clienteFinal], "2025-01-01"));
      trace("agg", (await s.salesAggregate("2025-01-01", "2027-01-01")).sort((x, y) => `${x.ruc}${x.fecha}${x.vendedor}`.localeCompare(`${y.ruc}${y.fecha}${y.vendedor}`)));
      trace("byClient", (await s.salesByClient()).sort((x, y) => x.ruc.localeCompare(y.ruc)));
      trace("q.company", strip(await s.querySales({ companyRucs: [FX.clienteFinal] })));
      trace("q.medida", strip(await s.querySales({ companyRucs: [FX.cliente], medida: "295/80R22.5" })));
      trace("q.docs", strip(await s.querySales({ documentos: ["f003-05001", "F NDI-1"], includeExcluded: true })));
      trace("q.excl", (await s.querySales({ docRucs: [FX.cliente], includeExcluded: true, tipoLinea: ["neumatico"] })).map((x) => [x.detalle?.documento, x.detalle?.excluida]));
      trace("q.limit", (await s.querySales({ onlyDetailed: true, limit: 3 })).map((x) => x.detalle!.lineKey));
      trace("byRuc", strip(await s.salesByRuc(FX.clienteFinal)));
      const vb = await companySalesView(s, { ruc: FX.banco });
      const vc = await companySalesView(s, { ruc: FX.cliente });
      trace("view.banco", { leasing: [...vb.leasing.values()], netos: vb.neumaticosNetos, esLeasing: vb.esLeasing });
      trace("view.cliente", { servicios: vc.serviciosPorTipo, contrato: vc.tieneContrato, medidas: vc.medidas, netos: vc.neumaticosNetos, otros: vc.otros.length });
      trace("last", strip(await lastTyreSales(s, FX.cliente, { medida: "295/80R22.5" })));
      trace("ref", await lastSaleReference(s, FX.cliente, "295/80R22.5"));
      trace("pending.2", await leasingPending(s));
      trace("uploads", (await s.listSalesUploads()).map(({ createdAt: _c, ...x }) => x));
      trace("scoring", await s.scoringInputs({ companyIds: Object.values(up.ids), marcas: [], since12m: "2025-01-01", lostSince: new Date(0) }));
      trace("companies", (await s.getCompaniesByRucs([FX.cliente, FX.clienteFinal])).map((x) => [x.ruc, x.score, x.nivel]).sort());
    });
    if (process.env.PGTEST_DUMP) fs.writeFileSync(process.env.PGTEST_DUMP, JSON.stringify(diffTraces(json, p), null, 1));
    expect(diffTraces(json, p)).toEqual([]);
    // y lo que se espera de cada paso (no solo que coincidan)
    expect(json["commit.2"]).toEqual({ inserted: 0, updated: 17, nuevas: 0 });
    expect(json["commit.3"]).toEqual({ inserted: 1, updated: 17 });
    expect(json["part.2"]).toMatchObject({ [FX.cliente]: { cantidad: 13 }, [FX.clienteFinal]: { cantidad: 10 } });
    expect((json["part.2"] as Record<string, unknown>)[FX.banco]).toBeUndefined();
    expect(json["setCF.wrongBank"]).toBe(0);
  });
});

const REAL = path.resolve(process.cwd(), "data/referencia-360tyres/Reporte_Ventas_01-2025_hasta_11-2026.xlsx");
describe.skipIf(!fs.existsSync(REAL))("ventas-odoo: archivo real en Postgres", () => {
  it("2.920 líneas: lectura + vista previa + guardado + recálculo, dos veces, sin duplicar y lejos del límite de Vercel", async () => {
    await truncateAll(testDbUrl());
    const u = await pg.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
    const buf = fs.readFileSync(REAL);
    const times: number[] = [];
    for (let i = 0; i < 2; i++) {
      const t0 = Date.now();
      const { stats, res } = await load(pg, buf, `real-${i}.xlsx`, { id: u.id, nombre: u.nombre, rol: "vendedor" });
      times.push(Date.now() - t0);
      expect(stats.lineas).toBe(2920);
      expect(res).toMatchObject(i === 0 ? { inserted: 2920, updated: 0 } : { inserted: 0, updated: 2920 });
    }
    console.log(`[test:pg] archivo real: ${times.map((t) => `${t} ms`).join(", ")}`);
    expect((await pg.countSales()).total).toBe(2920);
    const netos = (await pg.salesByClient()).reduce((n, r) => n + r.neumaticos, 0);
    expect(netos).toBe(18430);
    // la función de Vercel corta a los 300 s; el portal fija maxDuration más bajo: muy por debajo de ambos
    for (const t of times) expect(t).toBeLessThan(60_000);
  });
});
