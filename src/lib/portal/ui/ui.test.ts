import { describe, expect, it } from "vitest";
import type { Appointment, FleetGroup, Opportunity, PortalUser } from "../store/types";
import { filtersQuery, hasActiveFilters, isShortcutActive, ORDERS, pageCount, parseProspectFilters, toCompanySearch, BRAND_SHORTCUTS } from "./filters";
import { groupByBrand, yearRange } from "./fleet";
import { parseContactForm } from "./labels";
import { DEFAULT_SALES_SETTINGS } from "../sales/config";
import { canAssignSelf, canEditOpportunity, canReassign, canSeeRankingReport, canUploadSales, canValidateRanking } from "./permissions";
import { groupPipeline, pipelineTotals } from "./pipeline";
import { limaDateKey, limaStartOfDay, parseLimaLocal, toLimaLocalInput } from "./time";
import { selectToday } from "./today";

const user = (id: number, rol: PortalUser["rol"], activo = true) => ({ id, rol, activo });

function opp(p: Partial<Opportunity> & { id: number }): Opportunity {
  const t = new Date("2026-11-01T12:00:00Z");
  return {
    companyId: 1,
    ownerUserId: 1,
    etapa: "prospecto",
    probabilidad: 10,
    montoEstimado: null,
    cierreEsperado: null,
    proximaAccion: null,
    proximaAccionAt: null,
    quoteNumber: null,
    createdAt: t,
    updatedAt: t,
    closedAt: null,
    ...p,
  };
}

function appt(p: Partial<Appointment> & { id: number; startsAt: Date }): Appointment {
  return { companyId: 1, opportunityId: null, userId: 1, lugar: null, conTecnico: false, notas: null, estado: "programada", createdAt: new Date(0), ...p };
}

describe("filtros de prospectos", () => {
  it("lee searchParams, ignora valores inválidos y arma CompanySearch", () => {
    const f = parseProspectFilters({ q: " zbuss ", dep: "LIMA", sector: "pasajeros", flota: "50-99", marca: ["scania", "Hino, howo", "SCANIA"], tipo: "prospecto", orden: "llantas", p: "3" });
    expect(f).toEqual({ q: "zbuss", departamento: "LIMA", sector: "pasajeros", flota: "50-99", marcas: ["SCANIA", "HINO", "HOWO"], nivel: [], tipo: "prospecto", orden: "llantas", page: 3 });
    expect(toCompanySearch(f)).toEqual({ q: "zbuss", departamento: ["LIMA"], sector: ["pasajeros"], minUnits: 50, maxUnits: 99, marcas: ["SCANIA", "HINO", "HOWO"], esCliente: false, orderBy: "llantas", page: 3, pageSize: 50 });
    const bad = parseProspectFilters({ sector: "aereo", flota: "1-2", tipo: "x", orden: "nombre", p: "-1" });
    // corrida G: el orden por defecto pasa de "unidades" a "atractivo" (lo pide la especificación, punto 4)
    expect(bad).toMatchObject({ sector: null, flota: null, tipo: null, orden: "atractivo", page: 1, marcas: [] });
    expect(toCompanySearch(parseProspectFilters({ flota: "300+" }))).toMatchObject({ minUnits: 300 });
    expect(toCompanySearch(parseProspectFilters({ flota: "300+" })).maxUnits).toBeUndefined();
  });

  it("los enlaces conservan filtros y cambiar un filtro vuelve a la página 1", () => {
    const f = parseProspectFilters({ q: "bus", marca: "SCANIA", p: "4", orden: "participacion" });
    expect(filtersQuery(f, { page: 5 })).toBe("?q=bus&marca=SCANIA&orden=participacion&p=5");
    const sino = BRAND_SHORTCUTS.find((s) => s.label.startsWith("Sinotruk"))!;
    const q = filtersQuery(f, { marcas: sino.marcas });
    expect(q).toBe("?q=bus&marca=SINOTRUK&marca=HOWO&marca=SITRAK&marca=CNHTC&orden=participacion");
    expect(isShortcutActive(parseProspectFilters({ marca: ["HOWO", "cnhtc", "SITRAK", "SINOTRUK"] }), sino.marcas)).toBe(true);
    expect(isShortcutActive(parseProspectFilters({ marca: ["HOWO", "SITRAK", "SINOTRUK"] }), sino.marcas)).toBe(false);
    const shacman = BRAND_SHORTCUTS.find((s) => s.label === "Shacman")!;
    expect(shacman.marcas).toEqual(["SHACMAN", "SHAANQI"]);
    expect(isShortcutActive(parseProspectFilters({ marca: "Shaanqi, Shacman" }), shacman.marcas)).toBe(true);
    expect(isShortcutActive(f, sino.marcas)).toBe(false);
    expect(filtersQuery(parseProspectFilters({}))).toBe("");
    expect(pageCount(0)).toBe(1);
    expect(pageCount(101)).toBe(3);
  });
});

describe("Prospectos por atractivo (corrida G)", () => {
  it("orden por defecto: atractivo; los demás órdenes se mantienen", () => {
    expect(ORDERS.map((o) => o.id)).toEqual(["atractivo", "unidades", "llantas", "participacion"]);
    expect(ORDERS[0].label).toBe("Atractivo");
    expect(parseProspectFilters({}).orden).toBe("atractivo");
    expect(toCompanySearch(parseProspectFilters({})).orderBy).toBe("atractivo");
    expect(filtersQuery(parseProspectFilters({}))).toBe("");
    expect(filtersQuery(parseProspectFilters({ orden: "unidades" }))).toBe("?orden=unidades");
    expect(parseProspectFilters({ orden: "unidades" }).orden).toBe("unidades");
  });

  it("filtro por nivel: repetible o con comas, sin repetir, ignora lo inválido; los enlaces lo conservan", () => {
    const f = parseProspectFilters({ nivel: ["c", "A,b", "A", "Z", ""] });
    expect(f.nivel).toEqual(["A", "B", "C"]);
    expect(toCompanySearch(f).nivel).toEqual(["A", "B", "C"]);
    expect(toCompanySearch(parseProspectFilters({})).nivel).toBeUndefined();
    expect(parseProspectFilters({ nivel: "x" }).nivel).toEqual([]);
    const b = parseProspectFilters({ q: "bus", nivel: "B" });
    expect(filtersQuery(b, { page: 2 })).toBe("?q=bus&nivel=B&p=2");
    expect(filtersQuery(f)).toBe("?nivel=A&nivel=B&nivel=C");
    expect(hasActiveFilters(parseProspectFilters({ nivel: "A" }))).toBe(true);
    expect(hasActiveFilters(parseProspectFilters({ orden: "llantas" }))).toBe(false);
  });
});

describe("hora de Lima", () => {
  it("el día cambia a las 05:00 UTC", () => {
    expect(limaDateKey(new Date("2026-11-12T04:59:00Z"))).toBe("2026-11-11");
    expect(limaDateKey(new Date("2026-11-12T05:00:00Z"))).toBe("2026-11-12");
    expect(limaStartOfDay(new Date("2026-11-12T03:00:00Z")).toISOString()).toBe("2026-11-11T05:00:00.000Z");
  });

  it("datetime-local se interpreta en Lima", () => {
    const d = parseLimaLocal("2026-11-11T09:30")!;
    expect(d.toISOString()).toBe("2026-11-11T14:30:00.000Z");
    expect(toLimaLocalInput(d)).toBe("2026-11-11T09:30");
    expect(parseLimaLocal("2026-02-30T10:00")).toBeNull();
    expect(parseLimaLocal("mañana")).toBeNull();
  });
});

describe("Hoy", () => {
  const now = new Date("2026-11-11T15:00:00Z"); // 10:00 en Lima
  it("acciones vencidas y de hoy; ignora futuras, sin fecha y cerradas", () => {
    const opps = [
      opp({ id: 1, proximaAccionAt: new Date("2026-11-12T04:00:00Z") }), // hoy 23:00 Lima
      opp({ id: 2, proximaAccionAt: new Date("2026-11-12T06:00:00Z") }), // mañana
      opp({ id: 3, proximaAccionAt: new Date("2026-11-09T15:00:00Z") }), // vencida
      opp({ id: 4 }),
      opp({ id: 5, proximaAccionAt: new Date("2026-11-10T15:00:00Z"), closedAt: new Date() }),
    ];
    const r = selectToday(opps, [], now);
    expect(r.acciones.map((a) => [a.opportunity.id, a.vencida])).toEqual([
      [3, true],
      [1, false],
    ]);
  });

  it("próximas de mañana a hoy+7 y sin fecha (con texto, abiertas)", () => {
    const opps = [
      opp({ id: 1, proximaAccionAt: new Date("2026-11-12T04:00:00Z") }), // hoy: va en acciones
      opp({ id: 2, proximaAccionAt: new Date("2026-11-12T06:00:00Z") }), // mañana
      opp({ id: 3, proximaAccionAt: new Date("2026-11-19T04:30:00Z") }), // 18/11 23:30 Lima (día 7): dentro
      opp({ id: 4, proximaAccionAt: new Date("2026-11-19T05:00:00Z") }), // 19/11 00:00 Lima (día 8): fuera
      opp({ id: 5, proximaAccionAt: new Date("2026-11-13T15:00:00Z"), closedAt: new Date() }), // cerrada
      opp({ id: 6, proximaAccion: "Llamar al jefe de flota", updatedAt: new Date("2026-11-05T00:00:00Z") }),
      opp({ id: 7, proximaAccion: "Enviar ficha técnica", updatedAt: new Date("2026-11-08T00:00:00Z") }),
      opp({ id: 8, proximaAccion: "   " }), // sin texto
      opp({ id: 9, proximaAccion: "Visitar", closedAt: new Date() }), // cerrada
    ];
    const r = selectToday(opps, [], now);
    expect(r.acciones.map((a) => a.opportunity.id)).toEqual([1]);
    expect(r.proximas.map((o) => o.id)).toEqual([2, 3]);
    expect(r.sinFecha.map((o) => o.id)).toEqual([7, 6]);
  });

  it("citas de hoy a hoy+7 agrupadas por día de Lima, sin canceladas", () => {
    const appts = [
      appt({ id: 1, startsAt: new Date("2026-11-11T20:00:00Z") }),
      appt({ id: 2, startsAt: new Date("2026-11-12T03:00:00Z") }), // 11/11 22:00 Lima
      appt({ id: 3, startsAt: new Date("2026-11-18T22:00:00Z") }), // día 7
      appt({ id: 4, startsAt: new Date("2026-11-19T06:00:00Z") }), // día 8: fuera
      appt({ id: 5, startsAt: new Date("2026-11-11T06:00:00Z") }), // hoy 01:00 Lima: dentro (ya pasó pero es hoy)
      appt({ id: 6, startsAt: new Date("2026-11-13T15:00:00Z"), estado: "cancelada" }),
      appt({ id: 7, startsAt: new Date("2026-11-11T04:00:00Z") }), // ayer en Lima
    ];
    const r = selectToday([], appts, now);
    expect(r.citas.map((d) => [d.day, d.esHoy, d.citas.map((c) => c.id)])).toEqual([
      ["2026-11-11", true, [5, 1, 2]],
      ["2026-11-18", false, [3]],
    ]);
  });
});

describe("pipeline", () => {
  it("agrupa por etapa en orden, suma montos y oculta cerradas viejas", () => {
    const now = new Date("2026-11-11T12:00:00Z");
    const cols = groupPipeline(
      [
        opp({ id: 1, etapa: "negociacion", montoEstimado: 1000, ownerUserId: 1 }),
        opp({ id: 2, etapa: "negociacion", montoEstimado: 500, ownerUserId: 2, proximaAccionAt: new Date("2026-11-12T00:00:00Z") }),
        opp({ id: 3, etapa: "cerrado_ganado", closedAt: new Date("2026-10-30T00:00:00Z") }),
        opp({ id: 4, etapa: "cerrado_perdido", closedAt: new Date("2026-01-01T00:00:00Z") }),
      ],
      { now },
    );
    expect(cols.map((c) => c.id)).toEqual(["prospecto", "cita_agendada", "visita_realizada", "cotizacion_enviada", "negociacion", "cerrado_ganado", "cerrado_perdido"]);
    const neg = cols.find((c) => c.id === "negociacion")!;
    expect(neg.items.map((o) => o.id)).toEqual([2, 1]);
    expect(neg.monto).toBe(1500);
    expect(neg.ponderado).toBe(1050);
    expect(cols.find((c) => c.id === "cerrado_ganado")!.items).toHaveLength(1);
    expect(cols.find((c) => c.id === "cerrado_perdido")!.items).toHaveLength(0);
    expect(pipelineTotals(cols)).toEqual({ abiertas: 2, monto: 1500, ponderado: 1050 });
    expect(groupPipeline([opp({ id: 1, ownerUserId: 1 }), opp({ id: 2, ownerUserId: 2 })], { ownerId: 2 })[0].items.map((o) => o.id)).toEqual([2]);
  });
});

describe("permisos de acciones", () => {
  it("asignarse: vendedor solo sin dueño; supervisor/admin siempre; técnico nunca", () => {
    expect(canAssignSelf(user(1, "vendedor"), { ownerUserId: null })).toBe(true);
    expect(canAssignSelf(user(1, "vendedor"), { ownerUserId: 1 })).toBe(true);
    expect(canAssignSelf(user(1, "vendedor"), { ownerUserId: 2 })).toBe(false);
    expect(canAssignSelf(user(1, "vendedor", false), { ownerUserId: null })).toBe(false);
    expect(canAssignSelf(user(3, "supervisor"), { ownerUserId: 2 })).toBe(true);
    expect(canAssignSelf(user(4, "tecnico"), { ownerUserId: null })).toBe(false);
    expect(canReassign(user(1, "vendedor"))).toBe(false);
    expect(canReassign(user(5, "admin"))).toBe(true);
  });

  it("oportunidades y ventas", () => {
    expect(canEditOpportunity(user(1, "vendedor"), { ownerUserId: 1 })).toBe(true);
    expect(canEditOpportunity(user(1, "vendedor"), { ownerUserId: 2 })).toBe(false);
    expect(canEditOpportunity(user(1, "vendedor"), { ownerUserId: 2 }, { ownerUserId: 1 })).toBe(true);
    expect(canEditOpportunity(user(3, "supervisor"), { ownerUserId: 2 })).toBe(true);
    // ventas-odoo, punto 14 (cambio pedido): por defecto también el vendedor sube ventas; los roles son configurables
    expect(canUploadSales(user(1, "vendedor"))).toBe(true);
    expect(canUploadSales(user(3, "supervisor"))).toBe(true);
    expect(canUploadSales(user(4, "tecnico"))).toBe(false);
    expect(canUploadSales(user(1, "vendedor", false))).toBe(false);
    expect(canUploadSales(user(1, "vendedor"), { ...DEFAULT_SALES_SETTINGS, uploadRoles: ["admin", "supervisor"] })).toBe(false);
  });

  it("validar el ranking: vendedor, supervisor y admin activos; técnico no. El informe en el tablero: solo admin", () => {
    expect(canValidateRanking(user(1, "vendedor"))).toBe(true);
    expect(canValidateRanking(user(3, "supervisor"))).toBe(true);
    expect(canValidateRanking(user(5, "admin"))).toBe(true);
    expect(canValidateRanking(user(4, "tecnico"))).toBe(false);
    expect(canValidateRanking(user(1, "vendedor", false))).toBe(false);
    expect(canValidateRanking(null)).toBe(false);
    expect(canSeeRankingReport(user(5, "admin"))).toBe(true);
    expect(canSeeRankingReport(user(5, "admin", false))).toBe(false);
    expect(canSeeRankingReport(user(3, "supervisor"))).toBe(false);
    expect(canSeeRankingReport(user(1, "vendedor"))).toBe(false);
  });
});

describe("flota por marca", () => {
  const g = (marca: string | null, clase: string, unidades: number, anioMin: number | null, anioMax: number | null, llantas = 0): FleetGroup => ({
    marca,
    clase,
    unidades,
    anioMin,
    anioMax,
    llantas,
    unidadesConLlantas: llantas ? unidades : 0,
    medidaProbable: null,
    confianza: null,
  });
  it("junta clases por marca con subtotales, más unidades primero", () => {
    const b = groupByBrand([g("VOLVO", "REMOLCADOR", 5, 2010, 2015, 50), g("SCANIA", "OMNIBUS", 8, 2018, 2020, 64), g("VOLVO", "CAMION", 4, 2008, 2012, 24), g(null, "SEMIRREMOLQUE", 1, null, null)]);
    expect(b.map((x) => [x.marca, x.unidades, x.llantas, x.anioMin, x.anioMax, x.clases.length])).toEqual([
      ["VOLVO", 9, 74, 2008, 2015, 2],
      ["SCANIA", 8, 64, 2018, 2020, 1],
      ["Sin marca", 1, 0, null, null, 1],
    ]);
    expect(yearRange(2008, 2015)).toBe("2008–2015");
    expect(yearRange(2015, 2015)).toBe("2015");
    expect(yearRange(null, null)).toBe("—");
  });
});

describe("formulario de contacto", () => {
  const form = (o: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(o)) fd.set(k, v);
    return fd;
  };
  it("valida nombre, teléfono y email", () => {
    expect(parseContactForm(form({ nombre: "  Ana   Pérez ", telefono: "+51 999 888 777", email: "Ana@Empresa.PE", cargo: "" }))).toEqual({
      ok: true,
      data: { nombre: "Ana Pérez", cargo: null, telefono: "+51999888777", email: "ana@empresa.pe", notas: null },
    });
    expect(parseContactForm(form({ nombre: "" }))).toMatchObject({ ok: false });
    expect(parseContactForm(form({ nombre: "Ana", telefono: "12" }))).toMatchObject({ ok: false, error: "Teléfono inválido." });
    expect(parseContactForm(form({ nombre: "Ana", email: "no-es-email" }))).toMatchObject({ ok: false, error: "Email inválido." });
  });
});
