import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PortalConfigSchema } from "../config";
import { JsonPortalStore } from "../store";
import type { Opportunity, PortalStore, PortalUser, SalesAggRow } from "../store/types";
import { assignmentToFirstCall, stageAverages, weeklyActivity } from "./activity";
import { computeCompliance } from "./compliance";
import { avanceLines, formatMoney } from "./format";
import { ambiguousGoalKeys, goalForUser, loadDashboard } from "./load";
import { countBusinessDays, expectedProgress, lastWeeks, limaToday, monthOf, yearOf } from "./period";
import { computeProjection } from "./projection";
import { topByTyres, withFleet } from "./participation";
import { matchUser, namesMatch } from "./vendors";

/** Miércoles 11/11/2026 10:00 en Lima. */
const NOW = new Date("2026-11-11T15:00:00Z");

const user = (id: number, nombre: string, whatsapp: string, rol: PortalUser["rol"] = "vendedor"): PortalUser => ({ id, nombre, whatsapp, rol, activo: true, createdAt: NOW });
const FRANK = user(1, "Frank Rodríguez", "51900000001");
const JUAN = user(2, "Juan Bustios", "51900000002", "supervisor");
const OTRO = user(3, "Pedro Rodríguez", "51900000003");

const row = (fecha: string, monto: number, extra: Partial<SalesAggRow> = {}): SalesAggRow => ({ ruc: "20999000011", fecha, vendedor: "Frank", razonSocial: "TRANSPORTES DE PRUEBA S.A.C.", cantidad: 10, monto, sinMonto: 0, demo: false, filas: 1, ...extra });

const opp = (o: Partial<Opportunity>): Opportunity => ({
  id: 1,
  companyId: 1,
  ownerUserId: 1,
  etapa: "prospecto",
  probabilidad: 10,
  montoEstimado: null,
  cierreEsperado: null,
  proximaAccion: null,
  proximaAccionAt: null,
  quoteNumber: null,
  createdAt: NOW,
  updatedAt: NOW,
  closedAt: null,
  ...o,
});

describe("periodos y avance esperado (días hábiles, Lima)", () => {
  it("noviembre 2026 a una fecha fija", () => {
    expect(limaToday(NOW)).toBe("2026-11-11");
    expect(limaToday(new Date("2026-11-12T04:30:00Z"))).toBe("2026-11-11"); // 23:30 en Lima
    expect(monthOf("2026-11-11")).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(monthOf("2028-02-10").end).toBe("2028-02-29");
    const p = expectedProgress(monthOf("2026-11-11"), "2026-11-11");
    expect(p).toEqual({ elapsed: 8, total: 21, ratio: 8 / 21 });
    // sábado = lo mismo que el viernes
    expect(expectedProgress(monthOf("2026-11-14"), "2026-11-14").elapsed).toBe(10);
    expect(expectedProgress(monthOf("2026-11-13"), "2026-11-13").elapsed).toBe(10);
    // feriados de config
    expect(expectedProgress(monthOf("2026-11-11"), "2026-11-11", ["2026-11-02"]).total).toBe(20);
    const y = expectedProgress(yearOf("2026-11-11"), "2026-11-11");
    expect(y.total).toBe(261);
    expect(y.elapsed).toBe(225);
    expect(countBusinessDays("2026-11-12", "2026-11-11")).toBe(0);
  });

  it("últimas 8 semanas lunes–domingo en Lima", () => {
    const now = new Date("2026-11-11T03:00:00Z"); // martes 10/11 22:00 en Lima
    const weeks = lastWeeks(now);
    expect(weeks).toHaveLength(8);
    expect(weeks[7].start).toBe("2026-11-09");
    expect(weeks[7].end).toBe("2026-11-15");
    expect(weeks[0].start).toBe("2026-09-21");
    expect(weeks[7].from.toISOString()).toBe("2026-11-09T05:00:00.000Z");
    const acts = [
      { tipo: "visita", occurredAt: new Date("2026-11-09T04:59:00Z") }, // domingo 8, 23:59 Lima -> semana anterior
      { tipo: "visita", occurredAt: new Date("2026-11-09T05:00:00Z") }, // lunes 9, 00:00 Lima
      { tipo: "llamada", occurredAt: new Date("2026-11-10T20:00:00Z") },
      { tipo: "cotizacion", occurredAt: new Date("2026-11-10T20:00:00Z") },
      { tipo: "cotizacion_enviada", occurredAt: new Date("2026-11-10T20:00:00Z") }, // reenvío: no cuenta
      { tipo: "nota", occurredAt: new Date("2026-11-10T20:00:00Z") },
      { tipo: "visita", occurredAt: new Date("2026-09-21T04:00:00Z") }, // antes de la ventana
    ];
    const w = weeklyActivity(acts, weeks);
    expect(w[7]).toMatchObject({ visitas: 1, llamadas: 1, cotizaciones: 1 });
    expect(w[6]).toMatchObject({ start: "2026-11-02", visitas: 1 });
    expect(w.reduce((a, x) => a + x.visitas, 0)).toBe(2);
  });
});

describe("cruce del vendedor de las ventas", () => {
  it("tolerante con tildes, mayúsculas y nombres parciales; ambiguo = sin vendedor", () => {
    expect(namesMatch("Frank", "Frank Rodríguez")).toBe(true);
    expect(namesMatch("FRANK RODRIGUEZ MIRANO", "Frank Rodríguez")).toBe(true);
    expect(namesMatch("Franco", "Frank Rodríguez")).toBe(false);
    const users = [FRANK, JUAN, OTRO];
    expect(matchUser("Frank", users)?.id).toBe(1);
    expect(matchUser("  frank rodriguez ", users)?.id).toBe(1);
    expect(matchUser("Rodríguez", users)).toBeNull(); // dos Rodríguez
    expect(matchUser("51900000003", users)?.id).toBe(3);
    expect(matchUser("", users)).toBeNull();
    expect(matchUser("Patricia", users)).toBeNull();
    // varios coinciden pero uno es exacto
    expect(matchUser("Frank Rodríguez", [FRANK, user(9, "Frank Rodríguez Mirano", "519")])?.id).toBe(1);
  });

  it("meta del usuario por nombre o WhatsApp", () => {
    const goals = PortalConfigSchema.parse({ goals: { users: { frank: { monthly: 10 }, "51900000003": { monthly: 30 } } } }).goals;
    const users = [FRANK, JUAN, OTRO];
    expect(goalForUser(goals, FRANK, users)).toEqual({ monthly: 10, yearly: null });
    expect(goalForUser(goals, OTRO, users)?.monthly).toBe(30);
    expect(goalForUser(goals, JUAN, users)).toBeNull();
    expect(ambiguousGoalKeys(goals, users)).toEqual([]);
  });

  it("una clave de meta que coincide con varios usuarios no se asigna a ninguno y se reporta", () => {
    const goals = PortalConfigSchema.parse({ goals: { users: { "rodríguez": { monthly: 99 }, "51900000003": { monthly: 30 } } } }).goals;
    const users = [FRANK, JUAN, OTRO];
    // "Rodríguez" coincide con dos usuarios
    for (const u of users) expect(goalForUser(goals, u, users)?.monthly ?? null).toBe(u.id === OTRO.id ? 30 : null);
    expect(ambiguousGoalKeys(goals, users)).toEqual([{ clave: "rodríguez", usuarios: users.filter((u) => /Rodr/.test(u.nombre)).map((u) => u.nombre) }]);
    // aunque uno sea exacto, si coincide con varios no se asigna
    const g2 = PortalConfigSchema.parse({ goals: { users: { "Frank Rodríguez": { monthly: 5 } } } }).goals;
    const mirano = user(9, "Frank Rodríguez Mirano", "519");
    expect(goalForUser(g2, FRANK, [FRANK, mirano])).toBeNull();
    expect(goalForUser(g2, FRANK, [FRANK])?.monthly).toBe(5);
  });
});

describe("cumplimiento", () => {
  const rows = [row("2026-11-03", 1000), row("2026-11-10", 500, { demo: true }), row("2026-10-15", 2000), row("2025-12-20", 9999), row("2026-11-11", 0, { sinMonto: 2 })];

  it("mes y año contra la meta, avance esperado vs real", () => {
    const c = computeCompliance(rows.filter((r) => r.fecha >= "2026-01-01"), "2026-11-11", { monthly: 4200, yearly: 42000 });
    expect(c.mes.vendido).toEqual({ monto: 1500, cantidad: 30, sinMonto: 2, demo: true });
    expect(c.mes.meta).toBe(4200);
    expect(c.mes.avanceReal).toBeCloseTo(1500 / 4200);
    expect(c.mes.progress.ratio).toBeCloseTo(8 / 21);
    expect(c.mes.esperado).toBe(1600);
    expect(c.anio.vendido.monto).toBe(3500);
    expect(c.anio.esperado).toBeCloseTo((42000 * 225) / 261, 1);
    expect(c.anio.vendido.demo).toBe(true);
  });

  it("sin meta: vendido sin avance real", () => {
    const c = computeCompliance([row("2026-11-03", 100)], "2026-11-11", null);
    expect(c.mes.meta).toBeNull();
    expect(c.mes.avanceReal).toBeNull();
    expect(c.mes.esperado).toBeNull();
    expect(c.mes.vendido.demo).toBe(false);
  });
});

describe("proyección ponderada", () => {
  it("cierre en el mes por etapa; sin fecha, vencidas, sin monto y cerradas no suman", () => {
    const month = monthOf("2026-11-11");
    const vendido = { monto: 1000, cantidad: 5, sinMonto: 0, demo: true };
    const p = computeProjection(
      [
        opp({ id: 1, etapa: "cotizacion_enviada", probabilidad: 50, montoEstimado: 2000, cierreEsperado: "2026-11-20" }),
        opp({ id: 2, etapa: "negociacion", probabilidad: 70, montoEstimado: 1000, cierreEsperado: "2026-11-30" }),
        opp({ id: 3, etapa: "negociacion", probabilidad: 70, montoEstimado: 500, cierreEsperado: "2026-11-01" }),
        opp({ id: 4, etapa: "prospecto", probabilidad: 10, montoEstimado: 5000, cierreEsperado: null }),
        opp({ id: 5, etapa: "visita_realizada", probabilidad: 30, montoEstimado: null, cierreEsperado: "2026-11-15" }),
        opp({ id: 6, etapa: "negociacion", probabilidad: 70, montoEstimado: 800, cierreEsperado: "2026-10-31" }),
        opp({ id: 7, etapa: "negociacion", probabilidad: 70, montoEstimado: 800, cierreEsperado: "2026-12-01" }),
        opp({ id: 8, etapa: "cerrado_ganado", probabilidad: 100, montoEstimado: 9000, cierreEsperado: "2026-11-05", closedAt: NOW }),
        opp({ id: 9, etapa: "cerrado_perdido", probabilidad: 0, montoEstimado: 9000, cierreEsperado: "2026-11-05", closedAt: NOW }),
      ],
      month,
      vendido,
    );
    expect(p.ponderado).toBe(1000 + 700 + 350);
    expect(p.proyeccion).toBe(3050);
    expect(p.demo).toBe(true);
    expect(p.sinFecha).toBe(1);
    expect(p.sinMonto).toBe(1);
    expect(p.cierreVencido).toBe(1);
    expect(p.porEtapa.map((s) => s.etapa)).toEqual(["prospecto", "cita_agendada", "visita_realizada", "cotizacion_enviada", "negociacion"]);
    expect(p.porEtapa.find((s) => s.etapa === "negociacion")).toMatchObject({ n: 2, monto: 1500, ponderado: 1050 });
    expect(p.porEtapa.find((s) => s.etapa === "cotizacion_enviada")).toMatchObject({ n: 1, monto: 2000, ponderado: 1000 });
  });
});

describe("tiempos", () => {
  it("días promedio por etapa (estancias terminadas) y asignación → primera llamada", () => {
    const d = (s: string) => new Date(s);
    const history = [
      { id: 1, opportunityId: 1, etapa: "prospecto" as const, enteredAt: d("2026-10-01T15:00:00Z"), leftAt: d("2026-10-03T15:00:00Z"), changedBy: 1 },
      { id: 2, opportunityId: 1, etapa: "cita_agendada" as const, enteredAt: d("2026-10-03T15:00:00Z"), leftAt: null, changedBy: 1 },
      { id: 3, opportunityId: 2, etapa: "prospecto" as const, enteredAt: d("2026-10-01T15:00:00Z"), leftAt: d("2026-10-05T15:00:00Z"), changedBy: 1 },
    ];
    const avg = stageAverages(history);
    expect(avg.find((s) => s.etapa === "prospecto")).toMatchObject({ dias: 3, n: 2 });
    expect(avg.find((s) => s.etapa === "cita_agendada")).toMatchObject({ dias: null, n: 0 });
    const opps = [opp({ id: 1, companyId: 10, createdAt: d("2026-10-01T15:00:00Z") }), opp({ id: 2, companyId: 20, createdAt: d("2026-10-01T15:00:00Z") })];
    const act = (companyId: number, tipo: string, at: string) => ({ id: 0, companyId, opportunityId: null, userId: 1, tipo, texto: "", canal: null, data: null, occurredAt: d(at), createdAt: d(at) });
    const r = assignmentToFirstCall(opps, history, [act(10, "llamada", "2026-10-02T03:00:00Z"), act(20, "visita", "2026-10-02T15:00:00Z")], NOW);
    expect(r).toEqual({ dias: 0.5, n: 1 });
  });
});

describe("participación top 10", () => {
  it("ordena por neumáticos, corta en 10 y pone las llantas en piso", () => {
    const rows: SalesAggRow[] = [];
    for (let i = 0; i < 12; i++) rows.push(row("2026-06-01", 0, { ruc: `2099900${String(i).padStart(4, "0")}`, cantidad: (i + 1) * 10, demo: i === 11 }));
    rows.push(row("2025-11-10", 0, { ruc: "20999000000", cantidad: 1000 })); // fuera de la ventana
    const top = topByTyres(rows, { start: "2025-11-11", end: "2026-11-11" });
    expect(top).toHaveLength(10);
    expect(top[0]).toMatchObject({ ruc: "20999000011", cantidad: 120, demo: true });
    expect(top[9].cantidad).toBe(30);
    const full = withFleet(top.slice(0, 2), [{ id: 7, ruc: "20999000011", razonSocial: "EMPRESA ONCE S.A.", llantasPiso: 240 } as never]);
    expect(full[0]).toMatchObject({ companyId: 7, razonSocial: "EMPRESA ONCE S.A.", llantasPiso: 240, ratio: 0.5 });
    expect(full[1]).toMatchObject({ companyId: null, llantasPiso: null, ratio: null });
  });
});

// ── Con el store JSON ──

const config = PortalConfigSchema.parse({
  goals: { _ejemplo: true, currency: "USD", company: { monthly: 10000, yearly: 120000 }, users: { Frank: { monthly: 4000, yearly: 48000 } } },
});

async function seeded(): Promise<{ store: PortalStore; frank: PortalUser; juan: PortalUser }> {
  const store = JsonPortalStore.memory();
  const frank = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
  const juan = await store.upsertUser({ nombre: "Juan Bustios", whatsapp: "51900000002", rol: "supervisor" });
  const { ids } = await store.upsertCompanies([
    { ruc: "20999000011", razonSocial: "TRANSPORTES ANDES DE PRUEBA S.A.C.", unidades: 12, llantasPiso: 72 },
    { ruc: "20999000022", razonSocial: "EXPRESO DE PRUEBA S.A.", unidades: 40, llantasPiso: 400 },
  ]);
  await store.insertSales([
    { fecha: "2026-11-03", ruc: "20999000011", cantidad: 10, total: 1500, vendedor: "FRANK", origen: "demo", isDemo: true },
    { fecha: "2026-11-05", ruc: "20999000022", cantidad: 4, precioUnitario: 250, vendedor: "Frank Rodriguez" },
    { fecha: "2026-11-06", ruc: "20999000022", cantidad: 2, vendedor: "frank" }, // sin monto
    { fecha: "2026-11-07", ruc: "20999000022", cantidad: 8, total: 2000, vendedor: "Patricia" }, // sin vendedor identificado
    { fecha: "2026-03-01", ruc: "20999000011", cantidad: 6, total: 600, vendedor: "Frank" },
  ]);
  const o = await store.createOpportunity({ companyId: ids["20999000022"], ownerUserId: frank.id, montoEstimado: 3000, cierreEsperado: "2026-11-25", at: new Date("2026-10-01T15:00:00Z") });
  await store.moveStage(o.id, "negociacion", frank.id, new Date("2026-10-10T15:00:00Z"));
  await store.addActivity({ companyId: ids["20999000022"], opportunityId: o.id, userId: frank.id, tipo: "llamada", occurredAt: new Date("2026-11-10T16:00:00Z") });
  return { store, frank, juan };
}

describe("store: agregado de ventas", () => {
  it("agrupa por RUC, fecha y vendedor; monto = total o precio × cantidad", async () => {
    const { store } = await seeded();
    const rows = await store.salesAggregate("2026-11-01", "2026-11-30");
    expect(rows).toHaveLength(4);
    const r = rows.find((x) => x.fecha === "2026-11-05")!;
    expect(r).toMatchObject({ monto: 1000, cantidad: 4, sinMonto: 0, demo: false, vendedor: "Frank Rodriguez" });
    expect(rows.find((x) => x.fecha === "2026-11-06")).toMatchObject({ monto: 0, sinMonto: 1 });
    expect(await store.stageHistoryFor([])).toEqual([]);
  });
});

describe("loadDashboard y avance", () => {
  it("vendedor: sus ventas (cruce tolerante), su meta, su proyección y DEMO", async () => {
    const { store, frank } = await seeded();
    const d = await loadDashboard(store, { scope: { kind: "usuario", userId: frank.id }, now: NOW, config });
    expect(d.figures.compliance.mes.vendido).toEqual({ monto: 2500, cantidad: 16, sinMonto: 1, demo: true });
    expect(d.figures.compliance.anio.vendido.monto).toBe(3100);
    expect(d.figures.goal).toEqual({ monthly: 4000, yearly: 48000 });
    expect(d.figures.projection.ponderado).toBe(2100);
    expect(d.figures.projection.proyeccion).toBe(4600);
    expect(d.weeks[7].llamadas).toBe(1);
    expect(d.stageAvg.find((s) => s.etapa === "prospecto")?.dias).toBe(9);
    expect(d.participacion[0]).toMatchObject({ ruc: "20999000011", cantidad: 16, llantasPiso: 72, demo: true });
    expect(avanceLines(d)).toEqual([
      "💰 *Vendido (noviembre):* US$ 2,500 (63 % de la meta) · DEMO",
      "🎯 *Meta (noviembre):* US$ 4,000 (meta de ejemplo)",
      "📈 *Proyección (noviembre):* US$ 4,600 · DEMO",
    ]);
  });

  it("equipo: total con ventas sin vendedor, meta de la empresa y una fila por vendedor", async () => {
    const { store } = await seeded();
    const d = await loadDashboard(store, { scope: { kind: "equipo" }, now: NOW, config });
    expect(d.figures.compliance.mes.vendido.monto).toBe(4500);
    expect(d.sinVendedor?.monto).toBe(2000);
    expect(d.figures.goal?.monthly).toBe(10000);
    expect(d.vendedores.map((v) => v.user.nombre)).toEqual(["Frank Rodríguez"]);
    expect(d.participacion.map((p) => p.ruc)).toEqual(["20999000011", "20999000022"]);
    const lines = avanceLines(d);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("del equipo");
    expect(lines[1]).toBe("🎯 *Meta del equipo (noviembre):* US$ 10,000 (meta de ejemplo)");
  });

  it("equipo: una meta con clave ambigua no se asigna y se reporta", async () => {
    const { store, frank } = await seeded();
    await store.upsertUser({ nombre: "Frank Torres", whatsapp: "51900000077", rol: "vendedor" });
    const amb = PortalConfigSchema.parse({ goals: { company: { monthly: 500 }, users: { frank: { monthly: 4000 } } } });
    const d = await loadDashboard(store, { scope: { kind: "equipo" }, now: NOW, config: amb, details: false });
    expect(d.metasAmbiguas).toEqual([{ clave: "frank", usuarios: expect.arrayContaining(["Frank Rodríguez", "Frank Torres"]) }]);
    expect(d.vendedores.every((v) => v.figures.goal === null)).toBe(true);
    const mine = await loadDashboard(store, { scope: { kind: "usuario", userId: frank.id }, now: NOW, config: amb, details: false });
    expect(mine.figures.goal).toBeNull();
    expect(mine.metasAmbiguas).toEqual([]);
  });

  it("sin ventas demo no hay DEMO; sin meta lo dice; sin _ejemplo no hay '(meta de ejemplo)'", async () => {
    const store = JsonPortalStore.memory();
    const u = await store.upsertUser({ nombre: "Ana Vendedora", whatsapp: "51900000009", rol: "vendedor" });
    await store.insertSales([{ fecha: "2026-11-02", ruc: "20999000011", cantidad: 1, total: 100, vendedor: "Ana" }]);
    const real = PortalConfigSchema.parse({ goals: { company: { monthly: 500 } } });
    const d = await loadDashboard(store, { scope: { kind: "usuario", userId: u.id }, now: NOW, config: real, details: false });
    const lines = avanceLines(d);
    expect(lines.join("\n")).not.toContain("DEMO");
    expect(lines[1]).toBe("🎯 *Meta (noviembre):* sin meta definida");
    const team = avanceLines(await loadDashboard(store, { scope: { kind: "equipo" }, now: NOW, config: real, details: false }));
    expect(team[1]).toBe("🎯 *Meta del equipo (noviembre):* US$ 500");
    expect(formatMoney(1234567.4)).toBe("US$ 1,234,567");
  });
});

describe("comando avance", () => {
  beforeAll(() => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "avance-")), "portal.json");
    fs.writeFileSync(file, JSON.stringify({ goals: { _ejemplo: true, company: { monthly: 10000 }, users: { "51900000001": { monthly: 4000 } } } }));
    process.env.PORTAL_CONFIG = file;
  });

  it("responde tres líneas: vendedor lo suyo, supervisor el equipo", async () => {
    await import("../bot/commands/avance");
    const { getPortalCommand } = await import("../bot/registry");
    const { store, frank, juan } = await seeded();
    const replies: string[] = [];
    const ctx = (u: PortalUser) => ({ store, user: u, from: u.whatsapp!, now: NOW, env: {}, reply: async (b: string) => void replies.push(b), log: () => {} }) as never;
    const cmd = getPortalCommand("avance")!;
    await cmd(ctx(frank), "");
    await cmd(ctx(juan), "");
    expect(replies[0].split("\n")).toEqual([
      "💰 *Vendido (noviembre):* US$ 2,500 (63 % de la meta) · DEMO",
      "🎯 *Meta (noviembre):* US$ 4,000 (meta de ejemplo)",
      "📈 *Proyección (noviembre):* US$ 4,600 · DEMO",
    ]);
    expect(replies[1].split("\n")).toHaveLength(3);
    expect(replies[1]).toContain("*Vendido del equipo (noviembre):* US$ 4,500");
    expect(replies[1]).toContain("US$ 10,000 (meta de ejemplo)");
  });
});
