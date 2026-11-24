/**
 * Corrida K — Match Venta (lógica y datos) con el store en memoria. Datos inventados: empresas, flotas, ventas y stock
 * de prueba (nada real; __fixtures__/world.ts).
 */
import { describe, expect, it } from "vitest";
import { loadPortalConfig } from "../config";
import type { StockDeduction } from "../../store/types";
import { noticesOf } from "../bot/state";
import { JsonPortalStore } from "../store/json-portal-store";
import {
  analyzeFleets,
  companyMatchBlock,
  defaultMatchConfig,
  equivalencesFor,
  markMatchVisitsReported,
  matchesByCompany,
  matchesForProduct,
  matchFiltersQuery,
  matchOverview,
  matchProgress,
  matchReportData,
  outerDiameterMm,
  ownStockProducts,
  parseMatchFilters,
  pendingMatchVisits,
  progressText,
  proposeVisitPlan,
  purchaseText,
  recalcMatch,
  replaceEquivalencias,
  resolveProduct,
  saleLines,
  scheduleMatchVisit,
  setPriority,
  setPriorityAndRecalc,
  todayMatchLine,
  directionsLink,
  locationText,
  setCompanyDireccion,
} from "./index";
import { BANK, cfg, load, NOW, odooLine, source, STOCK, stockRow, world as makeWorld } from "./__fixtures__/world";

const world = () => makeWorld(JsonPortalStore.memory());

describe("equivalencias de medida", () => {
  it("diámetro exterior: métricas con su perfil; sin perfil, ancho en pulgadas y perfil convencional por aro", () => {
    const pc = defaultMatchConfig().perfilConvencional;
    expect(outerDiameterMm("315/80R22.5", pc)).toBeCloseTo(1075.5, 1);
    expect(outerDiameterMm("295/80R22.5", pc)).toBeCloseTo(1043.5, 1);
    expect(outerDiameterMm("12R22.5", pc)).toBeCloseTo(1089.7, 1);
    expect(outerDiameterMm("265/65R17", pc)).toBeCloseTo(776.3, 1);
  });

  it("mismo aro exacto y ±3% = migración; mismo aro fuera = revisión; aro 17 ≠ 17.5", () => {
    const c = defaultMatchConfig();
    const e265 = equivalencesFor("265/65R17", ["245/70R17", "265/70R17", "215/75R17.5", "235/75R17.5", "130/80-17"], c);
    expect(e265.migracion.map((x) => x.desde)).toEqual(["245/70R17"]);
    expect(e265.revision.map((x) => x.desde)).toEqual(["265/70R17"]);
    // 215/75R17.5 no migra a 265/65R17 (17 no es 17.5); una medida de moto no se compara
    expect(JSON.stringify(e265)).not.toContain("17.5");
    expect(JSON.stringify(e265)).not.toContain("130/80");
    const e315 = equivalencesFor("315/80R22.5", ["295/80R22.5", "12R22.5", "275/80R22.5"], c);
    expect(e315.migracion.map((x) => x.desde).sort()).toEqual(["12R22.5", "295/80R22.5"]);
    expect(e315.revision.map((x) => x.desde)).toEqual(["275/80R22.5"]);
  });

  it("el ancho no puede diferir más de 30 mm (configurable): 385/65R22.5 coincide en diámetro pero va a revisión", () => {
    // 385/65R22.5 es una llanta ancha de eje simple: coincidir en diámetro no la hace intercambiable con 295/80 o 315/80
    const c = defaultMatchConfig();
    expect(c.migracion.maxDiferenciaAnchoMm).toBe(30);
    const e295 = equivalencesFor("295/80R22.5", ["385/65R22.5", "11R22.5", "315/70R22.5"], c);
    expect(e295.migracion.map((x) => x.desde).sort()).toEqual(["11R22.5", "315/70R22.5"]);
    expect(e295.revision.find((x) => x.desde === "385/65R22.5")).toMatchObject({ diferenciaPct: 2.7, diferenciaAnchoMm: 90 });
    // 11R22.5 (279 mm) frente a 315/80R22.5: 36 mm de diferencia -> revisión; 12R22.5 (305 mm): 10 mm -> migración
    const e315 = equivalencesFor("315/80R22.5", ["385/65R22.5", "11R22.5", "12R22.5", "295/80R22.5"], c);
    expect(e315.migracion.map((x) => x.desde).sort()).toEqual(["12R22.5", "295/80R22.5"]);
    expect(e315.revision.map((x) => x.desde).sort()).toEqual(["11R22.5", "385/65R22.5"]);
    expect(equivalencesFor("12R22.5", ["385/65R22.5", "315/80R22.5"], c).migracion.map((x) => x.desde)).toEqual(["315/80R22.5"]);
    // configurable: con 100 mm vuelve a entrar por diámetro
    const wide = defaultMatchConfig({ migracion: { ...c.migracion, maxDiferenciaAnchoMm: 100 } });
    expect(equivalencesFor("295/80R22.5", ["385/65R22.5"], wide).migracion.map((x) => x.desde)).toEqual(["385/65R22.5"]);
  });

  it("pesos del porcentaje en config/portal.json: Volumen 45, Encaje 40, Historial 15 (decisión del 23/11)", async () => {
    const pesos = loadPortalConfig().match.pesos;
    expect(pesos).toMatchObject({ encaje: 40, volumen: 45, historial: 15 });
    expect(pesos.encaje + pesos.volumen + pesos.historial).toBe(100);
    // el cálculo usa esos pesos: encaje completo y volumen completo sin historial = 85
    const w = await world();
    await load(w, { cfg: cfg({ pesos }) });
    const r = (await w.store.listMatchResults({ productCodes: ["T0433"] })).find((x) => !x.yaCompro && x.detalle.encaje === 1 && x.detalle.volumen === 1 && x.detalle.historial === 0);
    expect(r?.pct).toBe(85 + (r?.detalle.puntos?.aplicacion ?? 0));
  });

  it("la tabla guardada en config/portal.json no trae 385/65R22.5 como migración en ninguna medida", () => {
    const eq = loadPortalConfig().match.equivalencias;
    for (const [medida, e] of Object.entries(eq)) {
      expect(e.migracion.map((x) => x.desde), medida).not.toContain("385/65R22.5");
      if (medida.endsWith("R22.5")) expect(e.revision.map((x) => x.desde), medida).toContain("385/65R22.5");
    }
  });

  it("la tabla se escribe en config/portal.json sin reformatear lo demás", () => {
    const text = '{\n  "a": { "b": 1 },\n  "match": {\n    "pesos": { "encaje": 50 },\n    "equivalencias": { "x": { "migracion": [] } },\n    "cortesFlota": [10, 30, 100]\n  }\n}\n';
    const out = replaceEquivalencias(text, { "12R22.5": { migracion: [{ desde: "315/80R22.5", diferenciaPct: -1.3 }], revision: [] } });
    expect(out).toContain('"a": { "b": 1 }');
    expect(out).toContain('"cortesFlota": [10, 30, 100]');
    expect(JSON.parse(out).match.equivalencias).toEqual({ "12R22.5": { migracion: [{ desde: "315/80R22.5", diferenciaPct: -1.3 }], revision: [] } });
  });
});

describe("stock propio para Match Venta", () => {
  it("disponible en Lima = San Luis + Callao − reserva − en pedidos; lo que no es neumático queda fuera", () => {
    const ded: StockDeduction[] = [{ id: 1, orderKey: "oc:x:1", label: "OC 1", rowId: "stk-T0433", origin: "Protyres|stock", warehouse: "SAN LUIS", quantity: 12, description: "", createdAt: NOW.toISOString() }];
    const p = ownStockProducts(STOCK, ded, defaultMatchConfig());
    expect(p.map((x) => x.code)).toEqual(["T0428", "T0433", "T0949", "T1527"]);
    expect(p.find((x) => x.code === "T0433")).toMatchObject({ lima: 100, reserved: 0, committed: 12, available: 88, warehouses: { "San Luis": 58, Callao: 42 } });
    expect(p.find((x) => x.code === "T0428")).toMatchObject({ lima: 28, reserved: 5, available: 23 });
    // solo los almacenes configurados forman "Lima"
    expect(ownStockProducts(STOCK, [], defaultMatchConfig({ almacenesLima: ["San Luis"] })).find((x) => x.code === "T0433")!.available).toBe(58);
  });
});

describe("recálculo sin trabajo de más (corrida K, guion contra Postgres)", () => {
  it("lee solo el stock propio (stockRows) si la fuente lo tiene, no la tabla de precios entera", async () => {
    const w = await world();
    await w.store.seedMatchProducts([{ code: "T0433", aplicacion: null, prioridad: true }], NOW);
    const src = { ...source(STOCK), allRows: async () => { throw new Error("no debía leer la tabla entera"); }, stockRows: async () => STOCK.filter((r) => r.kind === "stock") };
    const r = await recalcMatch({ store: w.store, prices: src, cfg: cfg(), leasingRucs: [BANK], now: NOW }, "prueba");
    expect(r.productos).toBe(1);
  });

  it("sin productos prioritarios activos no lee empresas ni ventas, y deja el resultado vacío", async () => {
    const w = await world();
    await load(w);
    expect((await w.store.listMatchResults({})).length).toBeGreaterThan(0);
    for (const p of await w.store.listMatchProducts()) await w.store.setMatchPriority(p.code, false, { userId: w.frank.id, accion: "quitar", at: NOW });
    const calls: string[] = [];
    const spy = new Proxy(w.store, {
      get(t, k, r) {
        const v = Reflect.get(t, k, r);
        if (k === "matchInputs" || k === "querySales") return (...a: unknown[]) => (calls.push(String(k)), (v as (...x: unknown[]) => unknown).apply(t, a));
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const r = await recalcMatch({ store: spy, prices: source(STOCK), cfg: cfg({ productos: [] }), leasingRucs: [BANK], now: NOW }, "sin prioridades");
    expect(r).toMatchObject({ productos: 0, filas: 0 });
    expect(calls).toEqual([]);
    expect(await w.store.listMatchResults({})).toEqual([]);
  });
});

describe("prioridad", () => {
  it("sobrevive a una carga nueva de stock (va por código) y se apaga sola al llegar a 0, con aviso al vendedor", async () => {
    const w = await world();
    await load(w);
    expect((await w.store.listMatchProducts()).filter((p) => p.prioridad).map((p) => p.code)).toEqual(["T0428", "T0433", "T0949", "T1527"]);
    // carga nueva: las mismas filas con otra fecha y otras cantidades (la prioridad no se toca)
    const reload = STOCK.map((r) => (r.code === "T0949" ? { ...r, priceDate: "2026-11-30", stockByWarehouse: { "San Luis": 0 }, stock: 0 } : { ...r, priceDate: "2026-11-30" }));
    const r = await recalcMatch({ store: w.store, prices: source(reload), cfg: cfg(), leasingRucs: [BANK], now: NOW }, "carga nueva");
    expect(r.apagados).toEqual(["T0949"]);
    const prods = await w.store.listMatchProducts();
    expect(prods.find((p) => p.code === "T0433")?.prioridad).toBe(true);
    expect(prods.find((p) => p.code === "T0949")).toMatchObject({ prioridad: false });
    expect(prods.find((p) => p.code === "T0949")?.sinStockAt).not.toBeNull();
    const log = await w.store.matchPriorityLog("T0949");
    expect(log[0]).toMatchObject({ accion: "sin_stock", userId: null });
    // aviso a los vendedores (avisos pendientes del bot), una sola vez aunque se recalcule de nuevo
    await recalcMatch({ store: w.store, prices: source(reload), cfg: cfg(), leasingRucs: [BANK], now: NOW }, "otra vez");
    const notices = noticesOf(await w.store.getPortalConversation(w.frank.whatsapp)).filter((n) => n.kind === "match_sin_stock");
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain("12R22.5 Fenixway Fuerte 89");
    expect(notices[0].text).toContain("llegó a 0");
    // el producto ya no sale en la vista
    expect((await matchOverview(w.store, w.frank, { cfg: cfg() })).productos.map((p) => p.code)).not.toContain("T0949");
  });

  it("una carga de stock anterior al día en que se marcó la prioridad no la apaga (la siembra no se pierde al migrar)", async () => {
    // Al migrar, el primer cálculo corre con el stock viejo que ya estaba cargado: ahí faltan o están en 0 productos de la
    // siembra del 23/11. Si eso las apagara, la siembra (que solo agrega códigos nuevos) no las vuelve a prender.
    const w = await world();
    await w.store.seedMatchProducts(["T0433", "T0949", "T1527", "T0428"].map((code) => ({ code, aplicacion: null, prioridad: true })), NOW);
    const old = STOCK.filter((r) => r.code !== "T1527").map((r) => ({ ...r, priceDate: "2026-11-10", ...(r.code === "T0949" ? { stockByWarehouse: { "San Luis": 0 }, stock: 0 } : {}) }));
    const r1 = await recalcMatch({ store: w.store, prices: source(old), cfg: cfg(), leasingRucs: [BANK], now: NOW }, "migración");
    expect(r1.apagados).toEqual([]);
    expect((await w.store.listMatchProducts()).filter((p) => p.prioridad).map((p) => p.code)).toEqual(["T0428", "T0433", "T0949", "T1527"]);
    expect(noticesOf(await w.store.getPortalConversation(w.frank.whatsapp)).filter((n) => n.kind === "match_sin_stock")).toEqual([]);
    // una carga del mismo día o posterior sí cuenta: T1527 no vino y T0949 está en 0
    const fresh = old.map((r) => ({ ...r, priceDate: "2026-11-23" }));
    const r2 = await recalcMatch({ store: w.store, prices: source(fresh), cfg: cfg(), leasingRucs: [BANK], now: NOW }, "carga nueva");
    expect(r2.apagados.sort()).toEqual(["T0949", "T1527"]);
  });

  it("activar y quitar con registro de quién; no se activa sin disponible ni en lo que no es neumático", async () => {
    const w = await world();
    const stock = ownStockProducts(STOCK, [], defaultMatchConfig());
    const off = await setPriority(w.store, { code: "t0433", on: false, user: w.frank, stock, now: NOW });
    expect(off).toMatchObject({ ok: false, reason: "no_existe" });
    const on = await setPriority(w.store, { code: "t0433", on: true, user: w.frank, stock, now: NOW });
    expect(on).toMatchObject({ ok: true, changed: true });
    expect(on.ok && on.text).toContain("es prioridad");
    expect((await w.store.matchPriorityLog("T0433"))[0]).toMatchObject({ accion: "activar", userId: w.frank.id });
    const again = await setPriority(w.store, { code: "T0433", on: true, user: w.frank, stock, now: NOW });
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(await setPriority(w.store, { code: "AR001", on: true, user: w.frank, stock, now: NOW })).toMatchObject({ ok: false, reason: "no_existe" });
    const zero = ownStockProducts([stockRow("T0001", "295/80R22.5", "X", {})], [], defaultMatchConfig());
    expect(await setPriority(w.store, { code: "T0001", on: true, user: w.frank, stock: zero, now: NOW })).toMatchObject({ ok: false, reason: "sin_stock" });
    const quit = await setPriority(w.store, { code: "T0433", on: false, user: w.juan, stock, now: NOW });
    expect(quit).toMatchObject({ ok: true, changed: true });
    expect((await w.store.matchPriorityLog("T0433"))[0]).toMatchObject({ accion: "quitar", userId: w.juan.id });
    expect(await setPriority(w.store, { code: "T0433", on: true, user: { id: 99, nombre: "Tec", rol: "tecnico" }, stock, now: NOW })).toMatchObject({ ok: false, reason: "sin_permiso" });
  });

  it("la siembra es idempotente: una prioridad quitada no vuelve al recalcular", async () => {
    const w = await world();
    const c = cfg({ productos: [{ codigo: "T0433", aplicacion: "Delantera regional", prioridad: true }] });
    await recalcMatch({ store: w.store, prices: source(STOCK), cfg: c, leasingRucs: [BANK], now: NOW }, "1");
    const r = await setPriorityAndRecalc(w.store, { code: "T0433", on: false, user: w.frank, prices: source(STOCK), now: NOW, cfg: c });
    expect(r.ok && r.changed).toBe(true);
    await recalcMatch({ store: w.store, prices: source(STOCK), cfg: c, leasingRucs: [BANK], now: NOW }, "2");
    expect((await w.store.listMatchProducts()).find((p) => p.code === "T0433")?.prioridad).toBe(false);
  });

  it("encuentra el producto por código, por medida + modelo y por voz", () => {
    const stock = ownStockProducts(STOCK, [], defaultMatchConfig());
    const one = (q: string) => {
      const r = resolveProduct(q, stock);
      return r.kind === "one" ? r.product.code : r.kind;
    };
    expect(one("P T0428")).toBe("T0428");
    expect(one("t0428")).toBe("T0428");
    expect(one("295 flama 66")).toBe("T0433");
    expect(one("295/80R22.5 flama 66")).toBe("T0433");
    expect(one("12R22.5 fuerte 89")).toBe("T0949");
    expect(one("doce r veintidós y medio fuerte ochenta y nueve")).toBe("T0949");
    expect(one("flama 77")).toBe("T0428");
    expect(one("295 flama 77")).toBe("none");
    expect(one("ridge blade")).toBe("T1527");
  });
});

describe("el cruce", () => {
  it("flota con la medida, compra real con cliente final, desglose en una línea y orden", async () => {
    const w = await world();
    const r = await load(w);
    expect(r.productos).toBe(4);
    const view = await matchesForProduct(w.store, w.frank, "T0433", {}, { cfg: cfg(), now: NOW });
    const names = view.empresas.map((c) => c.razonSocial);
    // la de Juan no aparece para Frank; Estado y banco de leasing, ocultos por defecto
    expect(names).not.toContain("TRANSPORTES DE JUAN DEMO SAC");
    expect(names).not.toContain("MUNICIPALIDAD DISTRITAL DEMO");
    expect(names).not.toContain("BANCO DEMO LEASING");
    const buses = view.empresas.find((c) => c.razonSocial === "BUSES DEL SUR DEMO SAC")!;
    // 36 de 40 unidades usan 295/80R22.5 (90%), 216 llantas, ya compró, aplicación delantera -> buses
    expect(buses.detalle.desglose).toBe("90% de su flota usa 295/80R22.5 · 216 llantas en piso · ya te compró esta medida · buses y carga en carretera");
    expect(buses.yaCompro).toBe(true);
    expect(buses.estado).toBe("Cliente");
    expect(buses.compraTexto).toContain("Ya te compró 60");
    expect(buses.compraTexto).toContain("última: junio (20)");
    expect(buses.distrito).toBe("ATE");
    expect(buses.limaCallao).toBe(true);
    expect(buses.tamanoTexto).toBe("30 a 99 unidades");
    // ordenado por porcentaje
    const pcts = view.empresas.map((c) => c.pct!);
    expect([...pcts].sort((a, b) => b - a)).toEqual(pcts);
    expect(buses.pct).toBeGreaterThan(view.empresas.find((c) => c.razonSocial === "CARGA MIXTA DEMO SAC")!.pct!);
    expect(buses.podriaLlevarTexto).toMatch(/^podría llevar ~\d+$/);
    // supervisor ve la de Juan
    const supView = await matchesForProduct(w.store, w.sup, "T0433", {}, { cfg: cfg() });
    expect(supView.empresas.map((c) => c.razonSocial)).toContain("TRANSPORTES DE JUAN DEMO SAC");
    // con el filtro, Estado y banco aparecen
    const all = await matchesForProduct(w.store, w.sup, "T0433", { incluirExcluidas: true }, { cfg: cfg() });
    expect(all.empresas.find((c) => c.razonSocial === "BANCO DEMO LEASING")?.excluida).toBe("leasing");
    expect(all.empresas.find((c) => c.razonSocial === "MUNICIPALIDAD DISTRITAL DEMO")?.excluida).toBe("estado");
  });

  it("banco de leasing: sin cliente final la compra queda en el banco; con cliente final pasa a la empresa", async () => {
    const w = await world();
    await w.store.upsertSaleLines([odooLine(BANK, "F001-100", "12R22.5", 16, "2026-04-01")]);
    await load(w, { sales: false });
    let rows = await w.store.listMatchResults({ productCodes: ["T0949"] });
    expect(rows.find((r) => r.companyId === w.ids["20000000002"])?.yaCompro).toBe(false);
    expect(rows.find((r) => r.ruc === BANK)?.excluida).toBe("leasing");
    await w.store.setClienteFinal({ bankRuc: BANK, documentos: ["F001-100"], company: { id: w.ids["20000000002"], ruc: "20000000002" }, userId: w.frank.id });
    await recalcMatch({ store: w.store, prices: source(STOCK), cfg: cfg(), leasingRucs: [BANK], now: NOW }, "cliente final");
    rows = await w.store.listMatchResults({ productCodes: ["T0949"] });
    const mina = rows.find((r) => r.companyId === w.ids["20000000002"])!;
    expect(mina.yaCompro).toBe(true);
    expect(mina.detalle.compra).toMatchObject({ cantidad: 16, precioUnitario: 240, moneda: "USD", margenPct: 20, mismoProducto: false });
    expect(purchaseText(mina.detalle.compra!, NOW)).toContain("a US$ 240.00");
    // tracción: minería sube
    expect(mina.detalle.aplicacion).toBe("minería, construcción o carga pesada");
    expect(mina.pct).toBe(100);
  });

  it("«este mismo producto» dice cuántas fueron de ese código; otro producto de la misma medida no lo dice", async () => {
    // dos códigos de 12R22.5 (T0949 y otro): la empresa compró 30 del T0949 y 200 del otro
    const w = await world();
    await w.store.upsertSaleLines([odooLine("20000000002", "F001-201", "12R22.5", 30, "2026-04-01", "T0949"), odooLine("20000000002", "F001-202", "12R22.5", 200, "2026-05-01", "T9999")]);
    await load(w, { sales: false });
    const mina = (await w.store.listMatchResults({ productCodes: ["T0949"] })).find((r) => r.companyId === w.ids["20000000002"])!;
    expect(mina.detalle.compra).toMatchObject({ cantidad: 230, mismoProducto: true, cantidadMismoProducto: 30 });
    expect(purchaseText(mina.detalle.compra!, NOW)).toMatch(/^Ya te compró 230 de esta medida \(30 de este mismo producto\)/);
    // solo de este código: sin repetir la cantidad
    expect(purchaseText({ ...mina.detalle.compra!, cantidad: 30, cantidadMismoProducto: 30 }, NOW)).toMatch(/^Ya te compró 30 \(este mismo producto\)/);
    // otro código de la medida: solo el total de la medida
    expect(purchaseText({ ...mina.detalle.compra!, mismoProducto: false, cantidadMismoProducto: 0 }, NOW)).toMatch(/^Ya te compró 230 · /);
  });

  it("una empresa con varios matches aparece una vez en la vista general y sube", async () => {
    const w = await world();
    await load(w);
    const list = await matchesByCompany(w.store, w.frank, {}, { cfg: cfg() });
    const mixta = list.filter((c) => c.razonSocial === "CARGA MIXTA DEMO SAC");
    expect(mixta).toHaveLength(1);
    expect(new Set(mixta[0].matches.map((m) => m.productCode))).toEqual(new Set(["T0433", "T0949", "T0428"]));
    expect(mixta[0].orden).toBe(Math.min(100, mixta[0].matches[0].pct! + cfg().bonusPorMatchExtra * 2));
    // ficha: "Match con tu stock"
    const block = await companyMatchBlock(w.store, w.frank, w.ids["20000000003"], { cfg: cfg() });
    expect(block.map((b) => b.productCode)).toContain("T0949");
  });

  it("medida que el padrón no permite inferir: lo dice y la lista sale de ventas reales; migración ×0,5 con etiqueta", async () => {
    const w = await world();
    await load(w);
    const cam = await matchesForProduct(w.store, w.frank, "T1527", {}, { cfg: cfg() });
    expect(cam.notas[0]).toContain("no dice qué empresas usan 265/65R17");
    expect(cam.empresas).toHaveLength(0);
    expect(cam.soloVentas.map((c) => c.razonSocial)).toEqual(["CAMIONETAS FUERA DEL PADRON DEMO"]);
    expect(cam.soloVentas[0].pct).toBeNull();
    expect(cam.vacio).toBeNull();
    // 315/80R22.5: nadie lo tiene inferido; migración desde 295/80R22.5 (−3%) y 12R22.5 (+1,3%)
    const t315 = await matchesForProduct(w.store, w.frank, "T0428", {}, { cfg: cfg() });
    expect(t315.notas[0]).toContain("no permite saber qué empresas usan 315/80R22.5");
    const buses = t315.empresas.find((c) => c.razonSocial === "BUSES DEL SUR DEMO SAC")!;
    expect(buses.tipo).toBe("migracion");
    expect(buses.migracionTexto).toBe("Migración posible desde 295/80R22.5: confirmar con el área técnica");
    expect(buses.detalle.encaje).toBeCloseTo(0.45, 3);
    // la flota 11R22.5 (Callao) migra a 295/80R22.5 (+0,3%, 16 mm), no a 12R22.5 (−4%: revisión) y, desde que la regla
    // limita el ancho a 30 mm (pedido del 23/11), tampoco a 315/80R22.5 (36 mm más ancha: revisión); antes salía T0428
    const chica = (await w.store.listMatchResults({ companyIds: [w.ids["20000000007"]] })).map((r) => r.productCode).sort();
    expect(chica).toEqual(["T0433"]);
  });

  it("filtros en la dirección y estados vacíos con explicación", async () => {
    const w = await world();
    await load(w);
    const f = parseMatchFilters(new URLSearchParams("compraron=1&lima=1&tam=1&dep=LIMA"));
    expect(f).toEqual({ yaCompraron: true, limaCallao: true, tamano: 1, departamento: "LIMA" });
    expect(parseMatchFilters(matchFiltersQuery(f) as unknown as Record<string, string>)).toBeTruthy();
    expect(new URLSearchParams(matchFiltersQuery(f)).get("compraron")).toBe("1");
    const v = await matchesForProduct(w.store, w.frank, "T0433", f, { cfg: cfg() });
    expect(v.empresas.map((c) => c.razonSocial)).toEqual(["BUSES DEL SUR DEMO SAC"]);
    const none = await matchesForProduct(w.store, w.frank, "T0433", { departamento: "PUNO" }, { cfg: cfg() });
    expect(none.vacio).toContain("Ninguna empresa cumple los filtros");
    const ov = await matchOverview(w.store, w.frank, { cfg: cfg() });
    expect(ov.totalLlantas).toBe(100 + 40 + 91 + 23);
    expect(ov.productos.map((p) => p.code)).toEqual(["T0433", "T1527", "T0949", "T0428"]);
    expect(ov.productos[0]).toMatchObject({ disponible: 100, almacenes: { "San Luis": 58, Callao: 42 }, aplicacion: "Delantera regional" });
    const line = await todayMatchLine(w.store, w.frank, { cfg: cfg() });
    expect(line?.text).toMatch(/^Tienes 254 llantas prioritarias: \d+ empresas sin contactar hacen match$/);
    const empty = JsonPortalStore.memory();
    expect((await matchOverview(empty, w.frank, { cfg: cfg() })).vacio).toContain("Aún no se calculó");
  });
});

describe("agenda de visitas", () => {
  it("asigna si no tiene dueño, crea la oportunidad una vez, deja la cita ligada al producto con su motivo", async () => {
    const w = await world();
    await load(w);
    const companyId = w.ids["20000000001"];
    const at = new Date("2026-11-24T14:00:00Z");
    const r = await scheduleMatchVisit(w.store, { companyId, productCode: "T0433", user: w.frank, startsAt: at, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.assigned).toBe(true);
    expect(r.createdOpportunity).toBe(true);
    expect(r.motivo).toBe("ofrecer 295/80R22.5 Fenixway Flama 66: ya te compró 60 en junio");
    expect(r.appointment.notas).toBe(r.motivo);
    expect(r.opportunity).toMatchObject({ etapa: "cita_agendada", proximaAccion: `Visita: ${r.motivo}` });
    expect((await w.store.getCompany(companyId))?.ownerUserId).toBe(w.frank.id);
    // otra vez el mismo día: no duplica cita ni oportunidad
    const again = await scheduleMatchVisit(w.store, { companyId, productCode: "T0433", user: w.frank, startsAt: new Date("2026-11-24T16:00:00Z"), now: NOW });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(await w.store.listOpportunities({ companyId })).toHaveLength(1);
    expect(await w.store.listAppointments({ companyId })).toHaveLength(1);
    // Juan no puede: ya es de Frank
    const juan = await scheduleMatchVisit(w.store, { companyId, productCode: "T0433", user: w.juan, startsAt: at, now: NOW });
    expect(juan).toMatchObject({ ok: false, reason: "otro_dueno", ownerUserId: w.frank.id });
    // el reporte de la visita conserva el vínculo
    const pending = await pendingMatchVisits(w.store, companyId, w.frank.id, new Date("2026-11-24T20:00:00Z"));
    expect(pending.map((v) => v.productCode)).toEqual(["T0433"]);
    expect(matchReportData(pending)).toEqual({ match: [{ visitId: pending[0].id, productCode: "T0433", motivo: r.motivo }] });
    const act = await w.store.addActivity({ companyId, userId: w.frank.id, tipo: "visita", texto: "visité", data: matchReportData(pending) });
    await markMatchVisitsReported(w.store, pending, act.id, NOW);
    expect((await w.store.listMatchVisits({ companyId }))[0]).toMatchObject({ activityId: act.id });
    expect((await w.store.getAppointment(r.appointment.id))?.estado).toBe("realizada");
    expect(await pendingMatchVisits(w.store, companyId, w.frank.id, NOW)).toEqual([]);
  });

  it("reparto por día agrupando por departamento y distrito, 4 por día, sin domingos", () => {
    const mk = (i: number, departamento: string, distrito: string | null) => ({ companyId: i, razonSocial: `E${i}`, departamento, provincia: departamento, distrito });
    const plan = proposeVisitPlan(
      [mk(1, "LIMA", "ATE"), mk(2, "AREQUIPA", null), mk(3, "LIMA", "ATE"), mk(4, "LIMA", "SURCO"), mk(5, "LIMA", "ATE"), mk(6, "LIMA", "SURCO"), mk(7, "AREQUIPA", null)],
      { start: new Date("2026-11-28T15:00:00Z"), perDay: 4 },
    );
    // sábado 28 -> domingo 29 se salta -> lunes 30
    expect(plan.map((d) => d.fecha)).toEqual(["2026-11-28", "2026-11-30", "2026-12-01"]);
    expect(plan[0].visitas.map((v) => v.companyId)).toEqual([2, 7]);
    expect(plan[1].visitas.map((v) => v.companyId)).toEqual([1, 3, 5]);
    expect(plan[2].visitas.map((v) => v.companyId)).toEqual([4, 6]);
    expect(plan.every((d) => d.visitas.length <= 4)).toBe(true);
  });
});

describe("avance y análisis", () => {
  it("disponible, cotizado (sin tocar el cotizador), pedido, restante y visitas", async () => {
    const w = await world();
    await load(w);
    await scheduleMatchVisit(w.store, { companyId: w.ids["20000000001"], productCode: "T0433", user: w.frank, startsAt: new Date("2026-11-24T14:00:00Z"), now: NOW });
    const ded: StockDeduction[] = [{ id: 1, orderKey: "oc:x:1", label: "OC 1", rowId: "stk-T0433", origin: "Protyres|stock", warehouse: "SAN LUIS", quantity: 10, description: "", createdAt: NOW.toISOString() }];
    const stock = ownStockProducts(STOCK, ded, defaultMatchConfig());
    const quote = { number: "001", date: "2026-11-23", status: "sent", items: [{ code: "T0433", size: "295/80R22.5", brand: "Fenixway", model: "FLAMA 66", quantity: 8 }, { size: "295/80R22.5", brand: "Fenixway", model: "Flama 66", quantity: 4 }, { size: "295/80R22.5", brand: "Fenixway", model: "Flama 77", quantity: 50 }] };
    const rows = await matchProgress(w.store, { stock, quotes: [quote as never] });
    const r = rows.find((x) => x.code === "T0433")!;
    expect(r).toMatchObject({ disponible: 100, cotizado: 12, pedido: 10, restante: 90, visitas: { agendadas: 1, hechas: 0, conCotizacion: 0, conPedido: 0 } });
    expect(progressText(rows)).toContain("Visitas: 1 agendadas");
  });

  it("análisis por tamaño de flota con muestras y sin conclusiones con menos de 5 clientes", async () => {
    const w = await world();
    await load(w);
    const a = analyzeFleets(await w.store.matchInputs(), saleLines(await w.store.querySales({ tipoLinea: ["neumatico"] }), [BANK]), defaultMatchConfig());
    expect(a.porTamano.map((g) => g.grupo)).toEqual(["10 a 29 unidades", "30 a 99 unidades", "100 o más unidades"]);
    const mid = a.porTamano[1];
    expect(mid).toMatchObject({ empresas: 3, clientes: 2, neumaticos: 68, concluyente: false });
    expect(a.fueraDelPadron).toMatchObject({ clientes: 1, neumaticos: 12 });
    expect(a.recomendacion).toContain("No hay suficientes clientes");
  });
});

describe("ubicación: el padrón no trae dirección", () => {
  it("Agregar dirección (dueño, sin dueño o supervisor) y Cómo llegar exacta o aproximada", async () => {
    const w = await world();
    const juanCo = w.ids["20000000004"];
    expect(await setCompanyDireccion(w.store, w.frank, juanCo, "Av. Prueba 123")).toMatchObject({ ok: false });
    const ok = await setCompanyDireccion(w.store, w.sup, juanCo, "  Av. Prueba   123 ");
    expect(ok.ok && ok.company.direccion).toBe("Av. Prueba 123");
    expect((await w.store.listActivities({ companyId: juanCo }))[0].texto).toBe("Dirección: Av. Prueba 123");
    const buses = (await w.store.getCompany(w.ids["20000000001"]))!;
    expect(locationText(buses)).toBe("Ate, Lima");
    expect(directionsLink(buses)).toEqual({ url: "https://www.google.com/maps/search/?api=1&query=BUSES%20DEL%20SUR%20DEMO%20SAC%2C%20ATE%2C%20LIMA%2C%20Per%C3%BA", aproximada: true });
    expect(directionsLink({ ...buses, direccion: "Av. Prueba 123" }).aproximada).toBe(false);
  });
});
