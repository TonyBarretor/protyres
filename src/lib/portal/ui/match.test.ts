/**
 * Corrida K — pantalla Match Venta: parámetros, chips, acciones de la tarjeta, texto para cotizar, Llamar/WhatsApp,
 * fecha de la visita, reparto y "Asignármela". Datos inventados (match/__fixtures__/world.ts).
 */
import { describe, expect, it } from "vitest";
import { load, NOW, world as makeWorld } from "../match/__fixtures__/world";
import { JsonPortalStore } from "../store/json-portal-store";
import {
  assignFromMatch,
  canUseMatch,
  cardActions,
  filterChips,
  MATCH_MAX_SHOWN,
  matchHref,
  parseMatchParams,
  parsePlanConfirm,
  parsePlanPicks,
  phoneLinks,
  planDayChoices,
  progressLine,
  quoteText,
  safeMatchBack,
  titleCase,
  splitNotes,
  visitStart,
} from "./match";

const vendedor = { id: 1, rol: "vendedor" as const, activo: true };
const sup = { id: 9, rol: "supervisor" as const, activo: true };
const tecnico = { id: 5, rol: "tecnico" as const, activo: true };

describe("parámetros y filtros en la dirección", () => {
  it("lee producto, vista, filtros, tandas y búsqueda; descarta lo inválido", () => {
    const p = parseMatchParams({ p: " p0433 ", compraron: "1", dep: "arequipa", n: "35", tam: "2" });
    expect(p).toMatchObject({ code: "P0433", vista: "productos", n: 40, filters: { yaCompraron: true, departamento: "AREQUIPA", tamano: 2 } });
    expect(parseMatchParams({ dep: "NARNIA", n: "999999999", p: "<script>" })).toMatchObject({ code: null, n: MATCH_MAX_SHOWN, filters: {} });
    expect(parseMatchParams({ vista: "empresas" }).vista).toBe("empresas");
    expect(parseMatchParams({ buscar: "  flama  66 " })).toMatchObject({ buscar: "flama 66", agregar: true });
  });

  it("la dirección guarda los filtros y cambiar un filtro vuelve a la primera tanda", () => {
    const p = parseMatchParams({ p: "P0433", sindueno: "1", n: "60" });
    expect(matchHref(p)).toBe("/portal/match?p=P0433&sindueno=1&n=60");
    expect(matchHref(p, { n: 80 }, "#tanda-60")).toBe("/portal/match?p=P0433&sindueno=1&n=80#tanda-60");
    const chips = filterChips(p, [10, 30, 100]);
    expect(chips.map((c) => c.label)).toEqual(["Ya me compraron", "Flota con la medida", "Sin dueño", "Mías", "Lima y Callao", "10 a 29 unid.", "30 a 99 unid.", "100 o más unid.", "Incluir Estado y leasing"]);
    expect(chips.find((c) => c.id === "sinDueno")).toMatchObject({ active: true, href: "/portal/match?p=P0433" });
    // "Mías" apaga "Sin dueño"; "Lima y Callao" quita el departamento
    expect(chips.find((c) => c.id === "mias")!.href).toBe("/portal/match?p=P0433&mias=1");
    const dep = filterChips(parseMatchParams({ p: "P0433", dep: "CUSCO" }), [10, 30, 100]);
    expect(dep.find((c) => c.id === "limaCallao")!.href).toBe("/portal/match?p=P0433&lima=1");
    expect(dep.find((c) => c.id === "tam1")!.href).toBe("/portal/match?p=P0433&dep=CUSCO&tam=1");
    // la vista general por producto no lleva filtros
    expect(matchHref(p, { code: null })).toBe("/portal/match");
    expect(matchHref(parseMatchParams({}), { vista: "empresas" })).toBe("/portal/match?vista=empresas");
  });

  it("solo vuelve a rutas del portal permitidas", () => {
    expect(safeMatchBack("/portal/match?p=P0433#e-3")).toBe("/portal/match?p=P0433#e-3");
    expect(safeMatchBack("//evil.example.com")).toBe("/portal/match");
    expect(safeMatchBack("https://evil.example.com")).toBe("/portal/match");
    expect(safeMatchBack("/portal/hoy")).toBe("/portal/hoy");
  });
});

describe("tarjeta de empresa", () => {
  it("máximo tres acciones visibles y el resto en «más»; Asignármela solo sin dueño", () => {
    expect(cardActions({ companyId: 3, ownerUserId: null }, vendedor)).toEqual({ visibles: ["asignar", "agendar", "cotizar"], mas: ["llegar", "ficha"] });
    expect(cardActions({ companyId: 3, ownerUserId: 1 }, vendedor)).toEqual({ visibles: ["agendar", "cotizar", "llegar"], mas: ["ficha"] });
    // de otro vendedor (lo ve el supervisor): agenda, no se la asigna desde aquí
    expect(cardActions({ companyId: 3, ownerUserId: 2 }, sup).visibles).toEqual(["agendar", "cotizar", "llegar"]);
    expect(cardActions({ companyId: 3, ownerUserId: 2 }, vendedor).visibles).toEqual(["cotizar", "llegar", "ficha"]);
    // fuera del padrón (solo ventas): sin ficha ni agenda
    expect(cardActions({ companyId: null, ownerUserId: null }, vendedor)).toEqual({ visibles: ["cotizar", "llegar", "ventas"], mas: [] });
    expect(canUseMatch(tecnico)).toBe(false);
    expect(cardActions({ companyId: 3, ownerUserId: null }, tecnico).visibles).toEqual(["cotizar", "llegar", "ficha"]);
  });

  it("texto para cotizar con el bot: producto, medida, cantidad (con tope en el disponible), cliente y RUC", () => {
    const prod = { nombre: "Fenixway Flama 66", medida: "295/80R22.5", disponible: 100 };
    expect(quoteText(prod, { razonSocial: "BUSES DEL SUR DEMO SAC", ruc: "20000000001", podriaLlevar: 24 })).toBe("Fenixway Flama 66 295/80R22.5 x24 para BUSES DEL SUR DEMO SAC RUC 20000000001");
    expect(quoteText({ ...prod, disponible: 10 }, { razonSocial: "X", ruc: "1", podriaLlevar: 300 })).toContain(" x10 para ");
    expect(quoteText(prod, { razonSocial: "X", ruc: "1", podriaLlevar: null })).toContain(" x4 para ");
  });

  it("Llamar y WhatsApp: celular con o sin 51; fijo solo Llamar", () => {
    expect(phoneLinks("987 654 321")).toEqual({ tel: "tel:+51987654321", wa: "https://wa.me/51987654321" });
    expect(phoneLinks("+51 987654321")).toEqual({ tel: "tel:+51987654321", wa: "https://wa.me/51987654321" });
    expect(phoneLinks("01 4567890")).toEqual({ tel: "tel:014567890", wa: null });
    expect(phoneLinks("123")).toBeNull();
    expect(phoneLinks(null)).toBeNull();
  });
});

describe("agendar visita", () => {
  // NOW = 2026-11-23 10:00 en Lima (lunes)
  it("hoy, mañana u otra fecha; sin hora las 9:00 (hoy pasadas las 9: la próxima hora en punto)", () => {
    const iso = (r: ReturnType<typeof visitStart>) => (r.ok ? r.startsAt.toISOString() : r.error);
    expect(iso(visitStart({ dia: "manana" }, NOW))).toBe("2026-11-24T14:00:00.000Z");
    expect(iso(visitStart({ dia: "hoy" }, NOW))).toBe("2026-11-23T16:00:00.000Z");
    expect(iso(visitStart({ dia: "hoy", hora: "15:30" }, NOW))).toBe("2026-11-23T20:30:00.000Z");
    expect(iso(visitStart({ dia: "otra", fecha: "2026-12-02", hora: "08:15" }, NOW))).toBe("2026-12-02T13:15:00.000Z");
    expect(iso(visitStart({ dia: "hoy", hora: "08:00" }, NOW))).toBe("Esa hora ya pasó: elige otra.");
    expect(iso(visitStart({ dia: "otra", fecha: "2026-11-01" }, NOW))).toBe("Esa fecha ya pasó.");
    expect(iso(visitStart({ dia: "otra", fecha: "" }, NOW))).toBe("Elige la fecha de la visita.");
    expect(iso(visitStart({ dia: "ayer" }, NOW))).toMatch(/Elige el día/);
  });

  it("selección para planificar: sin repetir empresa y con formato válido; días para mover cada visita", () => {
    expect(parsePlanPicks(["3:P0433", "3:P0949", "x:1", "4:p0949", "5:<b>"])).toEqual([
      { companyId: 3, code: "P0433" },
      { companyId: 4, code: "P0949" },
    ]);
    const days = planDayChoices(NOW, ["2026-11-25"], 5);
    expect(days.map((d) => d.key)).toEqual(["2026-11-23", "2026-11-24", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-30"]);
    expect(days[0].label).toMatch(/^Hoy/);
    // zonas del reparto como título (el padrón las trae en mayúsculas)
    expect(titleCase("LIMA / SAN JUAN DE LURIGANCHO")).toBe("Lima / San Juan De Lurigancho");
    expect(titleCase("AREQUIPA")).toBe("Arequipa");
    const fd = new FormData();
    fd.append("v", "3:P0433");
    fd.append("v", "4:P0949");
    fd.set("d3", "2026-11-24");
    fd.set("h3", "10:00");
    fd.set("d4", "2026-11-26");
    expect(parsePlanConfirm(fd)).toEqual([
      { companyId: 3, code: "P0433", fecha: "2026-11-24", hora: "10:00" },
      { companyId: 4, code: "P0949", fecha: "2026-11-26", hora: "" },
    ]);
  });
});

describe("Asignármela desde Match Venta", () => {
  it("solo sin dueño, atómico entre dos vendedores, con oportunidad y actividad", async () => {
    const w = await makeWorld(JsonPortalStore.memory());
    await load(w);
    const id = w.ids["20000000001"];
    const frank = { ...w.frank, activo: true };
    const juan = { ...w.juan, activo: true };
    const [a, b] = await Promise.all([assignFromMatch(w.store, frank, id, NOW), assignFromMatch(w.store, juan, id, NOW)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const winner = a.ok ? w.frank : w.juan;
    expect((await w.store.getCompany(id))!.ownerUserId).toBe(winner.id);
    expect((await w.store.listOpportunities({ open: true })).filter((o) => o.companyId === id)).toHaveLength(1);
    const again = await assignFromMatch(w.store, a.ok ? frank : juan, id, NOW);
    expect(again).toMatchObject({ ok: true, already: true });
    const other = await assignFromMatch(w.store, a.ok ? juan : frank, id, NOW);
    expect(other.ok).toBe(false);
    expect((await assignFromMatch(w.store, { ...w.frank, rol: "tecnico", activo: true }, w.ids["20000000002"], NOW)).ok).toBe(false);
  });
});

describe("avance y notas", () => {
  it("una línea de avance y las notas técnicas aparte", () => {
    expect(progressLine({ cotizado: 1, pedido: 0, visitas: { agendadas: 0, hechas: 0, conCotizacion: 0, conPedido: 0 } })).toBe("1 cotizada · 0 en pedidos · sin visitas todavía");
    expect(progressLine({ cotizado: 12, pedido: 4, visitas: { agendadas: 3, hechas: 1, conCotizacion: 1, conPedido: 0 } })).toBe("12 cotizadas · 4 en pedidos · 3 visitas (1 hecha, 1 con cotización, 0 con pedido)");
    const n = splitNotes(["El padrón del MTC no dice…", "Requieren revisión técnica (mismo aro…): 245/65R17."]);
    expect(n).toEqual({ aviso: ["El padrón del MTC no dice…"], tecnicas: ["Requieren revisión técnica (mismo aro…): 245/65R17."] });
  });
});
