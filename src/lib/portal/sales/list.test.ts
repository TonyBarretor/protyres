/**
 * Corrida J, punto 5 — pantalla general de ventas en el store JSON: cada filtro y sus combinaciones, resumen que coincide
 * con la suma de las filas, nota de crédito que resta, demo aparte, vista por cliente ordenable y paginada, y la lectura de
 * la URL. La paridad con Postgres está en src/test-pg/sales-list.pg.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { JsonPortalStore } from "../store/json-portal-store";
import { saleUnits } from "../store/shared";
import type { PortalStore, Sale, SalesListFilter } from "../store/types";
import { loadSalesListView, parseSalesListParams, salesListFilter, salesListHref } from "../ui/ventas-lista";
import { assignScenarioClienteFinal, LIST_FILTERS, seedSalesListScenario } from "./list-scenario";
import { FX } from "./odoo-fixture";

let store: PortalStore;
let ids: Record<string, number>;

beforeEach(async () => {
  store = JsonPortalStore.memory();
  ({ ids } = await seedSalesListScenario(store));
});

async function allLines(f: SalesListFilter): Promise<Sale[]> {
  const out: Sale[] = [];
  for (let offset = 0; ; offset += 4) {
    const page = await store.listSalesLines(f, { limit: 4, offset });
    out.push(...page);
    if (page.length < 4) return out;
  }
}

const docs = (rows: Sale[]) => rows.map((s) => s.detalle?.documento ?? "(demo)");
const round2 = (n: number) => Math.round(n * 100) / 100;

describe("pantalla de ventas: filtros", () => {
  it("cada filtro solo y combinados devuelve exactamente las líneas que cumplen todo", async () => {
    const all = await allLines({});
    // sin las anuladas (F003-5007) ni la demo
    expect(all).toHaveLength(19);
    expect(docs(all)).not.toContain("F003-5007");
    expect(all.every((s) => !s.isDemo)).toBe(true);
    // lo más reciente primero
    expect(all.map((s) => s.fecha)).toEqual([...all.map((s) => s.fecha)].sort().reverse());

    expect(new Set(docs(await allLines(LIST_FILTERS["q.ruc"])))).toEqual(new Set(["F003-5003", "F003-5201", "F003-95"]));
    expect(new Set(docs(await allLines(LIST_FILTERS["q.factura"])))).toEqual(new Set(["F003-5001"]));
    expect(new Set(docs(await allLines(LIST_FILTERS["q.factura2"])))).toEqual(new Set(["F003-5001"]));
    expect(await allLines(LIST_FILTERS["q.tildes"])).toEqual(await allLines(LIST_FILTERS["q.razon"]));
    expect((await allLines(LIST_FILTERS["q.razon"])).every((s) => s.ruc === FX.cliente)).toBe(true);
    expect((await allLines(LIST_FILTERS["q.producto"])).every((s) => /VALOR 89/.test(s.detalle!.descripcion))).toBe(true);
    expect(docs(await allLines(LIST_FILTERS["q.codigo"])).sort()).toEqual(["B BOL-00000007", "F003-5200"]);
    expect(await allLines(LIST_FILTERS["q.comodin"])).toHaveLength(19);
    expect(await allLines(LIST_FILTERS["q.nada"])).toEqual([]);

    expect((await allLines(LIST_FILTERS.medida)).every((s) => s.medida === "295/80R22.5")).toBe(true);
    expect((await allLines(LIST_FILTERS.marca)).every((s) => s.marca?.toUpperCase() === "FENIXWAY")).toBe(true);
    expect((await allLines(LIST_FILTERS["tipo.servicio"])).map((s) => s.detalle!.tipoLinea)).toEqual(expect.arrayContaining(["servicio"]));
    for (const t of ["servicio", "otro", "neumatico"] as const) {
      const rows = await allLines({ tipoLinea: t });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((s) => s.detalle!.tipoLinea === t)).toBe(true);
    }
    expect(docs(await allLines(LIST_FILTERS.vendedor)).sort()).toEqual(["B BOL-00000007", "F003-5200"]);
    expect((await allLines(LIST_FILTERS.desde)).every((s) => s.fecha >= "2026-10-01")).toBe(true);
    expect((await allLines(LIST_FILTERS.hasta)).every((s) => s.fecha <= "2026-09-30")).toBe(true);
    expect((await allLines(LIST_FILTERS.rango)).every((s) => s.fecha >= "2026-10-01" && s.fecha <= "2026-10-31")).toBe(true);
    expect(docs(await allLines(LIST_FILTERS.leasing))).toEqual(["F003-5005"]);

    // combinaciones: cada fila cumple cada filtro, y son las mismas que la intersección de los filtros por separado
    for (const name of ["combo.q+tipo+rango", "combo.medida+vendedor", "combo.marca+desde"]) {
      const f = LIST_FILTERS[name];
      const got = (await allLines(f)).map((s) => s.id);
      const parts = Object.entries(f).map(([k, v]) => ({ [k]: v }) as SalesListFilter);
      let expected = new Set((await allLines({})).map((s) => s.id));
      for (const p of parts) {
        const ids = new Set((await allLines(p)).map((s) => s.id));
        expected = new Set([...expected].filter((id) => ids.has(id)));
      }
      expect(got.length, name).toBeGreaterThan(0);
      expect(new Set(got), name).toEqual(expected);
    }
  });

  it("el cliente final se busca por su nombre y sale del filtro de leasing al asignarlo", async () => {
    expect(await allLines({ q: "minera" })).toEqual([]);
    await assignScenarioClienteFinal(store, ids);
    expect(docs(await allLines({ q: "minera" }))).toEqual(["F003-5005"]);
    expect(docs(await allLines({ q: FX.clienteFinal }))).toEqual(["F003-5005"]);
    expect(await allLines(LIST_FILTERS.leasing)).toEqual([]);
  });

  it("las ventas demo van aparte: nunca se mezclan con las reales", async () => {
    const demo = await allLines(LIST_FILTERS.demo);
    expect(demo).toHaveLength(1);
    expect(demo[0].isDemo).toBe(true);
    expect((await store.salesListSummary({})).lineas).toBe(19);
    expect((await store.salesListSummary({ demo: true })).neumaticos).toBe(50);
    expect((await store.salesListSummary({ demo: true })).totalPen).toBe(5000);
    expect(await allLines(LIST_FILTERS["combo.demo+marca"])).toHaveLength(1);
    expect(await store.salesFilterOptions(true)).toEqual({ marcas: ["DEMO MARCA"], vendedores: ["Frank Rodríguez"] });
    expect((await store.salesFilterOptions(false)).marcas).not.toContain("DEMO MARCA");
  });
});

describe("pantalla de ventas: resumen", () => {
  it("coincide con la suma de las filas en cada filtro", async () => {
    await assignScenarioClienteFinal(store, ids);
    for (const [name, f] of Object.entries(LIST_FILTERS)) {
      const rows = await allLines(f);
      const s = await store.salesListSummary(f);
      expect(s.lineas, name).toBe(rows.length);
      expect(s.neumaticos, name).toBe(rows.reduce((n, r) => n + saleUnits(r), 0));
      expect(s.totalPen, name).toBe(round2(rows.reduce((n, r) => n + (r.total ?? (r.precioUnitario ?? 0) * r.cantidad), 0)));
      expect(s.totalUsd, name).toBe(round2(rows.reduce((n, r) => n + (r.detalle?.totalUsd ?? 0), 0)));
      expect(s.clientes, name).toBe(new Set(rows.map((r) => r.detalle?.clienteFinalRuc ?? r.ruc)).size);
      expect(s.notasCredito, name).toBe(rows.filter((r) => r.detalle?.tipoDoc === "nota_credito").length);
      const m = rows.filter((r) => r.detalle && (r.detalle.margenPct !== null || r.detalle.tipoDoc === "nota_credito"));
      const venta = m.reduce((n, r) => n + (r.total ?? 0), 0);
      const costo = m.reduce((n, r) => n + (r.detalle!.costoTotal ?? 0), 0);
      expect(s.margenPct, name).toBe(venta > 0 ? round2(((venta - costo) / venta) * 100) : null);
    }
  });

  it("la nota de crédito resta neumáticos, soles, dólares y costo, y se cuenta aparte", async () => {
    const factura = await store.salesListSummary({ q: "F003-5201" });
    expect(factura).toMatchObject({ lineas: 1, neumaticos: 2, totalPen: 1750, totalUsd: 500, margenPct: 20, notasCredito: 0 });
    const conNota = await store.salesListSummary({ q: FX.fueraPadron, desde: "2026-11-01" });
    // F003-5201 y su nota F003-95: todo vuelve a cero
    expect(conNota).toMatchObject({ lineas: 2, neumaticos: 0, totalPen: 0, totalUsd: 0, margenPct: null, notasCredito: 1, notasCreditoPen: -1750 });
    const nota = (await allLines({ q: "F003-95" }))[0];
    expect(nota.cantidad).toBe(-2);
    // en todo el periodo, la nota resta del total de la empresa
    const empresa = await store.salesListSummary({ q: FX.fueraPadron });
    const sinNota = await store.salesListSummary({ q: FX.fueraPadron, hasta: "2026-11-04" });
    expect(empresa.neumaticos).toBe(sinNota.neumaticos - 2);
    expect(empresa.totalPen).toBe(round2(sinNota.totalPen - 1750));
  });
});

describe("pantalla de ventas: por cliente", () => {
  it("una fila por RUC que cuenta (cliente final incluido), con totales que suman el resumen", async () => {
    await assignScenarioClienteFinal(store, ids);
    const { rows, total } = await store.salesListByClient({}, { sort: "neumaticos", dir: "desc", limit: 50, offset: 0 });
    const s = await store.salesListSummary({});
    expect(total).toBe(s.clientes);
    expect(rows).toHaveLength(total);
    expect(rows.reduce((n, r) => n + r.neumaticos, 0)).toBe(s.neumaticos);
    expect(round2(rows.reduce((n, r) => n + r.totalPen, 0))).toBe(s.totalPen);
    expect(rows.reduce((n, r) => n + r.lineas, 0)).toBe(s.lineas);
    const minera = rows.find((r) => r.ruc === FX.clienteFinal)!;
    expect(minera).toMatchObject({ companyId: ids[FX.clienteFinal], razonSocial: "MINERA CLIENTE FINAL SAA", neumaticos: 10, ultimaFecha: "2026-10-04" });
    // el banco ya no cuenta esa factura
    expect(rows.find((r) => r.ruc === FX.banco)).toBeUndefined();
    const fuera = rows.find((r) => r.ruc === FX.fueraPadron)!;
    expect(fuera).toMatchObject({ companyId: null, razonSocial: "EMPRESA FUERA DEL PADRON EIRL", ultimaFecha: "2026-11-05" });
    // de más a menos neumáticos
    expect(rows.map((r) => r.neumaticos)).toEqual([...rows.map((r) => r.neumaticos)].sort((a, b) => b - a));
  });

  it("se ordena por cada columna en los dos sentidos y pagina", async () => {
    const get = async (sort: "neumaticos" | "total" | "margen" | "ultima" | "cliente", dir: "asc" | "desc") =>
      (await store.salesListByClient({}, { sort, dir, limit: 50, offset: 0 })).rows;
    const asc = await get("total", "asc");
    expect(asc.map((r) => r.totalPen)).toEqual([...asc.map((r) => r.totalPen)].sort((a, b) => a - b));
    const ult = await get("ultima", "desc");
    expect(ult.map((r) => r.ultimaFecha)).toEqual([...ult.map((r) => r.ultimaFecha)].sort().reverse());
    const names = (await get("cliente", "asc")).map((r) => r.razonSocial ?? r.ruc);
    expect(names).toEqual([...names].sort());
    for (const dir of ["asc", "desc"] as const) {
      const m = (await get("margen", dir)).map((r) => r.margenPct);
      const withM = m.filter((x): x is number => x !== null);
      expect(withM).toEqual([...withM].sort((a, b) => (dir === "asc" ? a - b : b - a)));
      // sin margen, al final
      expect(m.slice(withM.length).every((x) => x === null)).toBe(true);
    }
    const p1 = await store.salesListByClient({}, { sort: "cliente", dir: "asc", limit: 2, offset: 0 });
    const p2 = await store.salesListByClient({}, { sort: "cliente", dir: "asc", limit: 2, offset: 2 });
    expect(p1.total).toBe(p2.total);
    expect([...p1.rows, ...p2.rows].map((r) => r.ruc)).toEqual((await get("cliente", "asc")).slice(0, 4).map((r) => r.ruc));
  });
});

describe("pantalla de ventas: dirección y permisos", () => {
  it("los filtros quedan en la URL y se leen de vuelta", () => {
    const p = parseSalesListParams({ q: " fenix ", medida: "295/80 R 22.5", marca: "Fenixway", tipo: "neumatico", vendedor: "Frank Rodriguez", desde: "2026-10-31", hasta: "2026-10-01", leasing: "1", vista: "clientes", orden: "margen", dir: "asc", p: "3" });
    // fechas al revés: se ordenan
    expect(p).toMatchObject({ q: "fenix", desde: "2026-10-01", hasta: "2026-10-31", leasing: true, vista: "clientes", orden: "margen", dir: "asc", page: 3 });
    const href = salesListHref(p);
    const back = parseSalesListParams(Object.fromEntries(new URL(href, "http://x").searchParams));
    expect(back).toEqual(p);
    const { filter } = salesListFilter(p, [FX.banco]);
    expect(filter).toEqual({ demo: false, q: "fenix", medida: "295/80R22.5", marca: "Fenixway", tipoLinea: "neumatico", vendedor: "Frank Rodriguez", desde: "2026-10-01", hasta: "2026-10-31", docRucs: [FX.banco], sinClienteFinal: true });
    // valores inválidos: se ignoran
    expect(parseSalesListParams({ tipo: "x", desde: "2026-02-30", p: "-4", orden: "drop", dir: "up" })).toMatchObject({ tipo: "", desde: "", page: 1, orden: "neumaticos", dir: "desc" });
    expect(salesListFilter(parseSalesListParams({ medida: "llanta grande" })).medidaNoReconocida).toBe("llanta grande");
    expect(salesListHref(parseSalesListParams({}))).toBe("/portal/ventas/lista");
  });

  it("vendedor, supervisor y admin ven la pantalla; el técnico y un usuario inactivo no", async () => {
    for (const rol of ["vendedor", "supervisor", "admin"] as const) expect(await loadSalesListView(store, { id: 1, rol, activo: true }, {})).not.toBeNull();
    expect(await loadSalesListView(store, { id: 1, rol: "tecnico", activo: true }, {})).toBeNull();
    expect(await loadSalesListView(store, { id: 1, rol: "vendedor", activo: false }, {})).toBeNull();
    expect(await loadSalesListView(store, null, {})).toBeNull();
  });

  it("la vista: filas con cliente y cliente final enlazados, nota de crédito marcada, aviso de demo", async () => {
    await assignScenarioClienteFinal(store, ids);
    const v = (await loadSalesListView(store, { id: 1, rol: "vendedor", activo: true }, { q: "F003" }, [FX.banco]))!;
    expect(v.total).toBe(v.summary.lineas);
    expect(v.demoCount).toBe(1);
    const leasing = v.lineas.find((r) => r.documento === "F003-5005")!;
    expect(leasing.cliente).toEqual({ ruc: FX.banco, nombre: "BANCO DE CREDITO DEL PERU", companyId: ids[FX.banco] });
    expect(leasing.clienteFinal).toEqual({ ruc: FX.clienteFinal, nombre: "MINERA CLIENTE FINAL SAA", companyId: ids[FX.clienteFinal] });
    const nota = v.lineas.find((r) => r.documento === "F003-95")!;
    expect(nota).toMatchObject({ notaCredito: true, cantidad: -2, revierte: "F003-5201" });
    expect(v.lineas.find((r) => r.documento === "F003-5003")!.cliente.companyId).toBeNull();
    const demo = (await loadSalesListView(store, { id: 1, rol: "vendedor", activo: true }, { demo: "1" }))!;
    expect(demo.lineas.map((r) => r.demo)).toEqual([true]);
    const clientes = (await loadSalesListView(store, { id: 1, rol: "admin", activo: true }, { vista: "clientes", orden: "cliente", dir: "asc" }))!;
    expect(clientes.lineas).toEqual([]);
    expect(clientes.total).toBe(clientes.summary.clientes);
    expect(clientes.clientes[0].href).toBe(`/portal/ventas/lista?q=${clientes.clientes[0].cliente.ruc}`);
  });
});
