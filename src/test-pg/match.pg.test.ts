/**
 * Corrida K — Match Venta contra Postgres real:
 *  - JSON y Postgres dan lo mismo: siembra y prioridades (con su registro), cálculo por lotes, vistas (por producto, por
 *    empresa, ficha, Hoy), apagado sin stock con aviso, cliente final de leasing, agenda y reporte de la visita.
 *  - Dos y tres vendedores que agendan a la vez la misma empresa sin dueño: solo uno se la lleva, una sola oportunidad
 *    abierta y una sola cita.
 *  - Con los datos reales (padrón + ventas de Odoo + stock del 23/11/2026, si están en la máquina): cálculo y vistas
 *    medidos (cada vista por debajo de 2 s).
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestPdf } from "../lib/ingest/pdf";
import {
  companyMatchBlock,
  markMatchVisitsReported,
  matchesByCompany,
  matchesForProduct,
  matchOverview,
  matchReportData,
  pendingMatchVisits,
  recalcMatch,
  scheduleMatchVisit,
  setCompanyDireccion,
  setPriorityAndRecalc,
  todayMatchLine,
} from "../lib/portal/match";
import { BANK, cfg, load, NOW, odooLine, source, STOCK, world } from "../lib/portal/match/__fixtures__/world";
import { noticesOf } from "../lib/portal/bot/state";
import { JsonPortalStore } from "../lib/portal/store/json-portal-store";
import { PgPortalStore } from "../lib/portal/store/pg-portal-store";
import type { Company, FleetVehicle, PortalStore } from "../lib/portal/store/types";
import { readSalesXlsx } from "../lib/portal/sales/xlsx";
import { loadSalesSettings } from "../lib/portal/sales/config";
import { commitOdooUpload, previewOdooUpload } from "../lib/portal/sales/import";
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

/** Lo comparable de una tarjeta (sin ids). */
const card = (c: { razonSocial: string; pct: number | null; tipo: string; yaCompro: boolean; excluida: string | null; llantasMedida: number; podriaLlevar: number | null; detalle: { desglose: string } }) => [c.razonSocial, c.pct, c.tipo, c.yaCompro, c.excluida, c.llantasMedida, c.podriaLlevar, c.detalle.desglose];

describe("Match Venta: JSON y Postgres dan lo mismo", () => {
  it("prioridad, cálculo, vistas, apagado sin stock, leasing, agenda y reporte", async () => {
    const { json, pg: p } = await bothTraces<PortalStore>(JsonPortalStore.memory(), pg, async (s, trace) => {
      const w = await world(s);
      await s.upsertSaleLines([odooLine(BANK, "F001-100", "12R22.5", 16, "2026-04-01")]);
      const r = await load(w);
      trace("recalc", { productos: r.productos, filas: r.filas, empresas: r.empresas, apagados: r.apagados });
      trace("productos", (await s.listMatchProducts()).map((x) => [x.code, x.aplicacion, x.prioridad]));
      const ov = await matchOverview(s, w.frank, { cfg: cfg() });
      trace("overview", { total: ov.totalLlantas, empresas: ov.empresas, productos: ov.productos.map((x) => [x.code, x.disponible, x.empresas, x.yaCompraron, x.notas]) });
      for (const code of ["T0433", "T0949", "T1527", "T0428"]) {
        const v = await matchesForProduct(s, w.frank, code, {}, { cfg: cfg(), now: NOW });
        trace(`producto.${code}`, { empresas: v.empresas.map(card), soloVentas: v.soloVentas.map(card), vacio: v.vacio, compra: v.empresas.map((c) => c.compraTexto) });
      }
      trace("producto.sup", (await matchesForProduct(s, w.sup, "T0433", { incluirExcluidas: true }, { cfg: cfg() })).empresas.map(card));
      trace("porEmpresa", (await matchesByCompany(s, w.frank, {}, { cfg: cfg() })).map((c) => [c.razonSocial, c.orden, c.matches.map((m) => m.productCode)]));
      trace("ficha", (await companyMatchBlock(s, w.frank, w.ids["20000000003"], { cfg: cfg() })).map(card));
      trace("hoy", (await todayMatchLine(s, w.frank, { cfg: cfg() }))?.text);

      // cliente final del leasing -> la minera ya compró 12R22.5
      await s.setClienteFinal({ bankRuc: BANK, documentos: ["F001-100"], company: { id: w.ids["20000000002"], ruc: "20000000002" }, userId: w.frank.id });
      await recalcMatch({ store: s, prices: source(STOCK), cfg: cfg(), leasingRucs: [BANK], now: NOW }, "cliente final");
      trace("leasing", (await matchesForProduct(s, w.frank, "T0949", {}, { cfg: cfg(), now: NOW })).empresas.map((c) => [c.razonSocial, c.pct, c.compraTexto]));

      // quitar y volver a prender con registro
      const off = await setPriorityAndRecalc(s, { code: "T0428", on: false, user: w.juan, prices: source(STOCK), now: NOW, cfg: cfg() });
      trace("quitar", off.ok && off.changed);
      const on = await setPriorityAndRecalc(s, { code: "T0428", on: true, user: w.frank, prices: source(STOCK), now: NOW, cfg: cfg() });
      trace("prender", on.ok && on.changed);
      trace("registro", (await s.matchPriorityLog("T0428")).map((e) => [e.accion, e.userId === w.frank.id ? "frank" : e.userId === w.juan.id ? "juan" : e.userId]));

      // sin stock: se apaga sola con un aviso
      const empty = STOCK.map((x) => (x.code === "T0949" ? { ...x, priceDate: "2026-11-30", stock: 0, stockByWarehouse: undefined } : x));
      const r2 = await recalcMatch({ store: s, prices: source(empty), cfg: cfg(), leasingRucs: [BANK], now: NOW }, "sin stock");
      const r3 = await recalcMatch({ store: s, prices: source(empty), cfg: cfg(), leasingRucs: [BANK], now: NOW }, "otra vez");
      trace("apagado", [r2.apagados, r3.apagados, (await s.listMatchProducts()).find((x) => x.code === "T0949")?.prioridad]);
      trace("aviso", noticesOf(await s.getPortalConversation(w.frank.whatsapp)).map((n) => [n.kind, n.text]));

      // agenda y reporte
      const companyId = w.ids["20000000001"];
      const v = await scheduleMatchVisit(s, { companyId, productCode: "T0433", user: w.frank, startsAt: new Date("2026-11-24T14:00:00Z"), now: NOW });
      trace("agenda", v.ok ? { assigned: v.assigned, created: v.createdOpportunity, duplicate: v.duplicate, motivo: v.motivo, etapa: v.opportunity.etapa, accion: v.opportunity.proximaAccion, notas: v.appointment.notas } : v);
      const dup = await scheduleMatchVisit(s, { companyId, productCode: "T0433", user: w.frank, startsAt: new Date("2026-11-24T18:00:00Z"), now: NOW });
      trace("agenda.dup", dup.ok && dup.duplicate);
      trace("agenda.juan", await scheduleMatchVisit(s, { companyId, productCode: "T0433", user: w.juan, startsAt: new Date("2026-11-24T14:00:00Z"), now: NOW }).then((x) => (x.ok ? "ok" : x.reason)));
      const pending = await pendingMatchVisits(s, companyId, w.frank.id, new Date("2026-11-24T20:00:00Z"));
      trace("pendientes", pending.map((x) => [x.productCode, x.motivo]));
      const act = await s.addActivity({ companyId, userId: w.frank.id, tipo: "visita", texto: "visita", data: matchReportData(pending), occurredAt: new Date("2026-11-24T20:00:00Z") });
      await markMatchVisitsReported(s, pending, act.id, NOW);
      trace("reportada", (await s.listMatchVisits({ companyId })).map((x) => [x.productCode, x.activityId === act.id]));
      trace("cita", (await s.listAppointments({ companyId })).map((a) => a.estado));
      trace("actividad", (await s.listActivities({ companyId })).map((a) => [a.tipo, a.data && "match" in a.data ? a.data.match : null]));
      trace("hoy.despues", (await todayMatchLine(s, w.frank, { cfg: cfg() }))?.text);
      // ubicación: provincia/distrito del padrón y dirección escrita a mano
      const dir = await setCompanyDireccion(s, w.frank, companyId, "Av. Prueba 123, Ate");
      trace("direccion", dir.ok ? [dir.company.provincia, dir.company.distrito, dir.company.direccion] : dir.error);
      trace("tarjeta.ubicacion", (await matchesForProduct(s, w.frank, "T0433", {}, { cfg: cfg() })).empresas.map((c) => [c.razonSocial, c.departamento, c.provincia, c.distrito, c.direccion, c.limaCallao]));
    });
    expect(diffTraces(json, p)).toEqual([]);
    expect(json.recalc).toMatchObject({ productos: 4 });
  });
});

describe("agendar desde Match Venta: dos o tres vendedores a la vez", () => {
  it("solo uno la toma, una sola oportunidad abierta y una sola cita", async () => {
    await truncateAll(testDbUrl());
    const w = await world(pg);
    await load(w);
    const tercero = await pg.upsertUser({ nombre: "Tercer Vendedor", whatsapp: "51900000009", rol: "vendedor" });
    const sellers = [w.frank, w.juan, tercero];
    const extra = [PgPortalStore.connect(testDbUrl()), PgPortalStore.connect(testDbUrl())];
    const stores: PortalStore[] = [pg, ...extra];
    const problems: string[] = [];
    try {
      for (let round = 0; round < 6; round++) {
        const ruc = `2099980${String(round).padStart(4, "0")}`;
        const { ids } = await pg.upsertCompanies([{ ruc, razonSocial: `CARRERA MATCH ${round} S.A.C.`, unidades: 30 }]);
        const companyId = ids[ruc];
        const res = await Promise.all(sellers.map((u, i) => scheduleMatchVisit(stores[i], { companyId, productCode: "T0433", user: u, startsAt: new Date("2026-11-25T15:00:00Z"), now: NOW })));
        const won = res.filter((r) => r.ok).length;
        const lost = res.filter((r) => !r.ok && r.reason === "otro_dueno").length;
        const open = await pg.listOpportunities({ companyId, open: true });
        const appts = await pg.listAppointments({ companyId });
        const owner = (await pg.getCompany(companyId))!.ownerUserId;
        if (won !== 1 || lost !== 2 || open.length !== 1 || appts.length !== 1 || open[0].ownerUserId !== owner) problems.push(`ronda ${round}: ${won} agendaron, ${lost} rechazados, ${open.length} oportunidades, ${appts.length} citas`);
      }
      expect(problems).toEqual([]);
    } finally {
      await Promise.all(extra.map((x) => x.close()));
    }
  });
});

// ── datos reales (fuera de git): el padrón importado, las ventas de Odoo y el stock del 23/11/2026 ──

const MAIN = "/Users/tonybarreto/Desktop/coworkSandbox/protyres/data";
const pick = (rel: string) => [path.resolve(process.cwd(), "data", rel), path.join(MAIN, rel)].find((f) => fs.existsSync(f));
const PORTAL_REAL = pick("portal-store.json");
const SALES_XLSX = pick("referencia-360tyres/Reporte_Ventas_01-2025_hasta_11-2026.xlsx");
const STOCK_PDF = pick("referencia-360tyres/STOCK_PROTYRES_23112026.pdf");

// la flota entera (150 mil vehículos) tarda minutos por el pooler: solo con MATCH_REAL=1
describe.runIf(!!PORTAL_REAL && !!SALES_XLSX && !!STOCK_PDF && process.env.MATCH_REAL === "1")("datos reales: cálculo y vistas por debajo de 2 s", () => {
  it("padrón completo + ventas + stock real", async () => {
    await truncateAll(testDbUrl());
    const raw = JSON.parse(fs.readFileSync(PORTAL_REAL!, "utf8")) as { users: { nombre: string; whatsapp: string; rol: "vendedor" }[]; companies: Company[]; fleet: FleetVehicle[] };
    const t0 = Date.now();
    for (const u of raw.users) if (u.whatsapp) await pg.upsertUser({ nombre: u.nombre, whatsapp: u.whatsapp, rol: u.rol });
    const up = await pg.upsertCompanies(raw.companies.map((c) => ({ ruc: c.ruc, razonSocial: c.razonSocial, sector: c.sector, departamento: c.departamento, provincia: c.provincia ?? null, distrito: c.distrito ?? null, unidades: c.unidades, llantasPiso: c.llantasPiso, antiguedadMedia: c.antiguedadMedia })));
    const rucOf = new Map(raw.companies.map((c) => [c.id, c.ruc]));
    const fleet = raw.fleet.flatMap(({ id: _id, ...v }) => {
      const id = up.ids[rucOf.get(v.companyId) ?? ""];
      return id ? [{ ...v, companyId: id }] : [];
    });
    for (let i = 0; i < fleet.length; i += 20_000) await pg.upsertFleet(fleet.slice(i, i + 20_000));
    const vendedor = (await pg.listUsers()).find((u) => u.rol === "vendedor") ?? (await pg.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" }));
    const xlsx = await readSalesXlsx(fs.readFileSync(SALES_XLSX!), { users: await pg.listUsers(), settings: loadSalesSettings() });
    const stats = await previewOdooUpload(pg, xlsx.odoo!);
    const sales = await commitOdooUpload({ store: pg, parsed: xlsx.odoo!, fileName: "ventas.xlsx", hash: "real", user: { id: vendedor.id, nombre: vendedor.nombre, rol: "vendedor" }, stats, log: () => undefined });
    const loadMs = Date.now() - t0;
    const stock = await ingestPdf(fs.readFileSync(STOCK_PDF!), { provider: "Protyres", sourceRef: "STOCK_PROTYRES_23112026.pdf", kind: "stock" });
    const frank = vendedor;
    const c = loadPortalConfig().match;
    const t1 = Date.now();
    const r = await recalcMatch({ store: pg, prices: source(stock.rows), cfg: c, now: NOW }, "datos reales");
    const recalcMs = Date.now() - t1;
    const times: Record<string, number> = {};
    const time = async <T>(label: string, f: () => Promise<T>): Promise<T> => {
      const t = Date.now();
      const out = await f();
      times[label] = Date.now() - t;
      return out;
    };
    const ov = await time("vista 1 (productos)", () => matchOverview(pg, frank, { cfg: c }));
    for (const prod of ov.productos) await time(`vista 2 ${prod.code}`, () => matchesForProduct(pg, frank, prod.code, {}, { cfg: c }));
    await time("ver por empresa", () => matchesByCompany(pg, frank, {}, { cfg: c }));
    await time("hoy", () => todayMatchLine(pg, frank, { cfg: c }));
    const top = (await matchesForProduct(pg, frank, "P0433", {}, { cfg: c })).empresas[0];
    await time("ficha", () => companyMatchBlock(pg, frank, top.companyId!, { cfg: c }));
    console.log(`[test:pg] datos reales: carga ${loadMs} ms (${raw.companies.length} empresas, ${fleet.length} vehículos, ${sales.inserted} líneas de ventas); recalc ${recalcMs} ms (${r.filas} filas; leer ${r.phases.leer}, calcular ${r.phases.calcular}, guardar ${r.phases.guardar}); vistas ${JSON.stringify(times)}`);
    expect(ov.totalLlantas).toBe(636);
    for (const [k, ms] of Object.entries(times)) expect(ms, k).toBeLessThan(2000);
  }, 900_000);
});
