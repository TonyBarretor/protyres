import { describe, expect, it } from "vitest";
import { JsonPortalStore } from "../store/json-portal-store";
import type { FleetVehicleInput, RankingValidation, ScoreDetail, ScoreInput } from "../store/types";
import { bestFleets, groupForToday } from "./best";
import { defaultScoringConfig } from "./config";
import { explainLine, explainWhy } from "./explain";
import { recalcScores } from "./recalc";
import { applyBrakes, brakesOf, catalogSizesFromRows, levelCuts, levelFor, scoreCompany, type CatalogSizes } from "./score";
import { compareValidations, pickValidationSample, seededRng } from "./validation";

const cfg = defaultScoringConfig();
const NOW = new Date("2026-11-14T15:00:00Z");

const CAT: CatalogSizes = {
  stock: new Set(["295/80R22.5"]),
  propio: new Set(["295/80R22.5", "12R22.5"]),
  proveedor: new Set(["11R22.5", "385/65R22.5"]),
};

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    companyId: 1,
    ruc: "20100000001",
    unidades: 82,
    llantasPiso: 586,
    sector: "pasajeros",
    departamento: "LIMA",
    antiguedadMedia: 6,
    esClienteMarcado: false,
    medidas: { "295/80R22.5": 79 },
    marcasPreferidas: {},
    vendidos12m: 0,
    ventasReales: false,
    ventasDemo: false,
    credito: null,
    perdidaAt: null,
    ...over,
  };
}

const factor = (d: { factores: ScoreDetail["factores"] }, id: string) => d.factores.find((f) => f.id === id)!;

describe("factores del puntaje", () => {
  it("potencial: escala logarítmica (una flota 10 veces mayor no vale 10 veces más); sin llantas = 0 y sin dato", () => {
    const small = factor(scoreCompany(input({ llantasPiso: 100 }), cfg, CAT).detalle, "potencial");
    const big = factor(scoreCompany(input({ llantasPiso: 1000 }), cfg, CAT).detalle, "potencial");
    expect(big.valor).toBeGreaterThan(small.valor);
    expect(big.valor / small.valor).toBeLessThan(2);
    expect(factor(scoreCompany(input({ llantasPiso: 50_000 }), cfg, CAT).detalle, "potencial").valor).toBe(1);
    const none = factor(scoreCompany(input({ llantasPiso: 0 }), cfg, CAT).detalle, "potencial");
    expect(none).toMatchObject({ valor: 0, puntos: 0, sinDato: true });
  });

  it("encaje: parte de las unidades con medida en el catálogo; con stock vale más; sin medida = 0 y sin dato", () => {
    const stock = factor(scoreCompany(input({ unidades: 10, medidas: { "295/80R22.5": 10 } }), cfg, CAT).detalle, "encaje");
    const lista = factor(scoreCompany(input({ unidades: 10, medidas: { "12R22.5": 10 } }), cfg, CAT).detalle, "encaje");
    const prov = factor(scoreCompany(input({ unidades: 10, medidas: { "11R22.5": 10 } }), cfg, CAT).detalle, "encaje");
    const fuera = factor(scoreCompany(input({ unidades: 10, medidas: { "7.5R16": 10 } }), cfg, CAT).detalle, "encaje");
    expect(stock.valor).toBe(1);
    expect(lista.valor).toBe(cfg.encaje.enCatalogo);
    expect(prov.valor).toBe(cfg.encaje.soloProveedor);
    expect(fuera.valor).toBe(0);
    expect(fuera.sinDato).toBe(false);
    // la mitad de la flota sin medida inferida cuenta como no encajada
    expect(factor(scoreCompany(input({ unidades: 20, medidas: { "295/80R22.5": 10 } }), cfg, CAT).detalle, "encaje").valor).toBe(0.5);
    expect(factor(scoreCompany(input({ medidas: {} }), cfg, CAT).detalle, "encaje")).toMatchObject({ valor: 0, sinDato: true });
  });

  it("espacio: 1 si no es cliente; si lo es, 1 − vendidos 12 meses / consumo anual (mitad de las llantas en piso)", () => {
    expect(factor(scoreCompany(input(), cfg, CAT).detalle, "espacio").valor).toBe(1);
    // 400 llantas -> consume 200 al año; le vendimos 50 -> 0.75
    expect(factor(scoreCompany(input({ llantasPiso: 400, ventasReales: true, vendidos12m: 50 }), cfg, CAT).detalle, "espacio").valor).toBe(0.75);
    expect(factor(scoreCompany(input({ llantasPiso: 400, ventasReales: true, vendidos12m: 900 }), cfg, CAT).detalle, "espacio").valor).toBe(0);
    // marcada como cliente sin ventas cargadas: todo su consumo por ganar
    expect(factor(scoreCompany(input({ esClienteMarcado: true }), cfg, CAT).detalle, "espacio").valor).toBe(1);
    // cliente sin llantas en piso: sin dato
    expect(factor(scoreCompany(input({ llantasPiso: 0, ventasReales: true, vendidos12m: 10 }), cfg, CAT).detalle, "espacio")).toMatchObject({ valor: 0, sinDato: true });
  });

  it("ventas demo: no cuentan para decidir si es cliente ni para el espacio por ganar", () => {
    const soloDemo = scoreCompany(input({ ventasDemo: true, vendidos12m: 0 }), cfg, CAT).detalle;
    expect(factor(soloDemo, "espacio")).toMatchObject({ valor: 1, dato: { cliente: false, soloDemo: true } });
    expect(explainLine({ ...soloDemo, nivelBase: "A" })).toContain("aún no es cliente");
  });

  it("familiaridad: parte de las unidades de las marcas preferidas (CNHTC = Sinotruk, SHAANQI = Shacman)", () => {
    const f = factor(scoreCompany(input({ unidades: 10, marcasPreferidas: { SCANIA: 3, CNHTC: 2, VOLVO: 5 } }), cfg, CAT).detalle, "familiaridad");
    expect(f.valor).toBe(0.5);
    expect(f.dato.marcas).toBe("Scania, Sinotruk");
    expect(factor(scoreCompany(input({ marcasPreferidas: {} }), cfg, CAT).detalle, "familiaridad")).toMatchObject({ valor: 0, sinDato: false });
  });

  it("cercanía: Lima y Callao 1, tabla configurable, otros con su valor; sin departamento = 0 y sin dato", () => {
    expect(factor(scoreCompany(input({ departamento: "CALLAO" }), cfg, CAT).detalle, "cercania").valor).toBe(1);
    expect(factor(scoreCompany(input({ departamento: "AREQUIPA" }), cfg, CAT).detalle, "cercania").valor).toBe(0.5);
    expect(factor(scoreCompany(input({ departamento: "PUNO" }), cfg, CAT).detalle, "cercania").valor).toBe(cfg.cercania.otros);
    expect(factor(scoreCompany(input({ departamento: null }), cfg, CAT).detalle, "cercania")).toMatchObject({ valor: 0, sinDato: true });
  });

  it("antigüedad: acotada entre la mejor y la peor; sin dato = 0", () => {
    expect(factor(scoreCompany(input({ antiguedadMedia: 2 }), cfg, CAT).detalle, "antiguedad").valor).toBe(1);
    expect(factor(scoreCompany(input({ antiguedadMedia: 12.5 }), cfg, CAT).detalle, "antiguedad").valor).toBe(0.5);
    expect(factor(scoreCompany(input({ antiguedadMedia: 40 }), cfg, CAT).detalle, "antiguedad").valor).toBe(0);
    expect(factor(scoreCompany(input({ antiguedadMedia: null }), cfg, CAT).detalle, "antiguedad")).toMatchObject({ valor: 0, sinDato: true });
  });

  it("puntaje = suma de los aportes, 0–100", () => {
    const r = scoreCompany(input({ llantasPiso: 50_000, medidas: { "295/80R22.5": 82 }, marcasPreferidas: { SCANIA: 82 }, antiguedadMedia: 1 }), cfg, CAT);
    expect(r.score).toBe(100);
    const sum = r.detalle.factores.reduce((a, f) => a + f.puntos, 0);
    expect(Math.abs(sum - r.score)).toBeLessThan(0.1);
    expect(scoreCompany(input({ llantasPiso: 0, medidas: {}, departamento: null, antiguedadMedia: null, ventasReales: true }), cfg, CAT).score).toBe(0);
  });
});

describe("catálogo de medidas", () => {
  it("stock propio desde minStock; lista propia; proveedores", () => {
    const c = catalogSizesFromRows(
      [
        { size: "295/80R22.5", kind: "stock", stock: 66, isTyre: true },
        { size: "275/80R22.5", kind: "stock", stock: 2, isTyre: true },
        { size: "12R22.5", kind: "own", stock: null, isTyre: true },
        { size: "11R22.5", kind: "provider", stock: 400, isTyre: true },
        { size: "", kind: "stock", stock: 10, isTyre: false },
      ],
      4,
    );
    expect([...c.stock]).toEqual(["295/80R22.5"]);
    expect([...c.propio].sort()).toEqual(["12R22.5", "275/80R22.5", "295/80R22.5"]);
    expect([...c.proveedor]).toEqual(["11R22.5"]);
  });
});

describe("niveles y frenos", () => {
  it("cortes por percentil: 10% A, 30% B, resto C; un empate en el corte queda arriba", () => {
    const scores = Array.from({ length: 100 }, (_, i) => 100 - i); // 100..1
    const cuts = levelCuts(scores, cfg);
    expect(cuts).toEqual({ cutA: 91, cutB: 61 });
    const lv = scores.map((s) => levelFor(s, cuts));
    expect(lv.filter((l) => l === "A")).toHaveLength(10);
    expect(lv.filter((l) => l === "B")).toHaveLength(30);
    expect(lv.filter((l) => l === "C")).toHaveLength(60);
    expect(levelFor(91, levelCuts([...scores, 91], cfg))).toBe("A");
  });

  it("cortes configurables", () => {
    const c2 = { ...cfg, niveles: { a: 0.2, b: 0.5 } };
    const cuts = levelCuts(
      Array.from({ length: 10 }, (_, i) => i + 1),
      c2,
    );
    expect(cuts).toEqual({ cutA: 9, cutB: 4 });
  });

  it("crédito observado o rechazado: C como máximo; perdida en 90 días: baja un nivel; los dos: C", () => {
    expect(applyBrakes("A", brakesOf({ credito: "observado", perdidaAt: null }, cfg, NOW))).toBe("C");
    expect(applyBrakes("A", brakesOf({ credito: "rechazado", perdidaAt: null }, cfg, NOW))).toBe("C");
    expect(applyBrakes("A", brakesOf({ credito: "aprobado", perdidaAt: null }, cfg, NOW))).toBe("A");
    const lost = new Date(NOW.getTime() - 30 * 86_400_000);
    expect(applyBrakes("A", brakesOf({ credito: null, perdidaAt: lost }, cfg, NOW))).toBe("B");
    expect(applyBrakes("B", brakesOf({ credito: null, perdidaAt: lost }, cfg, NOW))).toBe("C");
    expect(applyBrakes("C", brakesOf({ credito: null, perdidaAt: lost }, cfg, NOW))).toBe("C");
    const old = new Date(NOW.getTime() - 120 * 86_400_000);
    expect(brakesOf({ credito: null, perdidaAt: old }, cfg, NOW)).toEqual([]);
    // los frenos no restan puntos
    const a = scoreCompany(input(), cfg, CAT, NOW);
    const b = scoreCompany(input({ credito: "observado", perdidaAt: lost }), cfg, CAT, NOW);
    expect(b.score).toBe(a.score);
    expect(b.frenos.map((f) => f.id)).toEqual(["credito", "perdida"]);
  });
});

describe("explicación para el vendedor", () => {
  const TECH = /score|puntaje|puntos|peso|factor|potencial|encaje|familiaridad|cercania|nivelBase|sinDato|llantasPiso|_|\{|\}|undefined|null|NaN/i;

  it("la línea de ejemplo: buses, llantas, medida en stock, Lima, aún no es cliente", () => {
    const r = scoreCompany(input(), cfg, CAT);
    const line = explainLine({ ...r.detalle, frenos: r.frenos, nivelBase: "A" });
    expect(line).toBe("82 buses · 586 llantas · 96% en 295/80R22.5, que tienes en stock · Lima · aún no es cliente");
  });

  it("dos o tres factores que más aportan, lo que falta y los frenos; sin términos técnicos", () => {
    const cases: Partial<ScoreInput>[] = [
      {},
      { llantasPiso: 0 },
      { medidas: {} },
      { departamento: null, antiguedadMedia: null },
      { ventasReales: true, vendidos12m: 100, sector: "carga" },
      { credito: "observado", perdidaAt: new Date(NOW.getTime() - 5 * 86_400_000) },
      { marcasPreferidas: { SCANIA: 80 }, llantasPiso: 20, medidas: { "7.5R16": 3 } },
      { unidades: 1, llantasPiso: 6, sector: null },
    ];
    for (const c of cases) {
      const r = scoreCompany(input(c), cfg, CAT, NOW);
      const line = explainLine({ ...r.detalle, frenos: r.frenos, nivelBase: "B" });
      expect(line, JSON.stringify(c)).not.toMatch(TECH);
      expect(line.length).toBeGreaterThan(5);
      const why = explainWhy({ ...r.detalle, frenos: r.frenos, nivelBase: "B" });
      expect(why.factores).toHaveLength(6);
      for (const w of why.factores) expect(`${w.titulo} ${w.texto}`).not.toMatch(TECH);
      for (const f of why.frenos) expect(f).not.toMatch(TECH);
    }
  });

  it("lo que falta se dice", () => {
    const r = scoreCompany(input({ llantasPiso: 0, medidas: {}, departamento: null }), cfg, CAT);
    const line = explainLine({ ...r.detalle, nivelBase: "C" });
    expect(line).toContain("sin dato de llantas");
    expect(line).toContain("sin medida inferida");
    expect(line).toContain("sin departamento");
  });

  it("frenos en la línea y en el bloque", () => {
    const r = scoreCompany(input({ credito: "observado", perdidaAt: new Date(NOW.getTime() - 10 * 86_400_000) }), cfg, CAT, NOW);
    const d = { ...r.detalle, frenos: r.frenos, nivelBase: "A" as const };
    expect(explainLine(d)).toMatch(/crédito observado · oportunidad perdida hace 10 días$/);
    expect(explainWhy(d).frenos).toEqual(["Crédito observado: el nivel queda en C como máximo.", "Oportunidad perdida hace 10 días: baja un nivel."]);
  });

  it("cliente: cuánto le compra de lo que consume", () => {
    const r = scoreCompany(input({ llantasPiso: 400, ventasReales: true, vendidos12m: 50, medidas: {}, departamento: null }), cfg, CAT);
    expect(explainLine({ ...r.detalle, nivelBase: "C" })).toContain("te compra ~25% de lo que consume");
  });
});

// ── contra el store (JSON; mismo comportamiento que Postgres) ──

function vehicles(companyId: number, n: number, over: Partial<FleetVehicleInput> = {}): FleetVehicleInput[] {
  return Array.from({ length: n }, (_, i) => ({
    companyId,
    placa: `P${companyId}-${i}`,
    marca: "VOLVO",
    clase: "BUS",
    anio: 2020,
    ejes: 2,
    llantas: 6,
    llantasFuente: null,
    pesoBruto: null,
    chasis: null,
    departamento: "LIMA",
    origen: "pasajeros",
    medidaProbable: "295/80R22.5",
    confianza: "alta",
    ...over,
  }));
}

async function seedStore() {
  const store = JsonPortalStore.memory();
  const { ids } = await store.upsertCompanies(
    Array.from({ length: 30 }, (_, i) => ({
      ruc: `2060000${String(i).padStart(4, "0")}`,
      razonSocial: `TRANSPORTES ${String.fromCharCode(65 + (i % 26))}${i} S.A.C.`,
      sector: "pasajeros" as const,
      departamento: i % 3 === 0 ? "LIMA" : "PUNO",
      unidades: 10 + i * 3,
      llantasPiso: (10 + i * 3) * 6,
      antiguedadMedia: 4 + (i % 10),
    })),
  );
  const list = Object.values(ids).sort((a, b) => a - b);
  for (const id of list) await store.upsertFleet(vehicles(id, 5, { marca: id % 2 ? "SCANIA" : "VOLVO" }));
  const frank = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
  const otro = await store.upsertUser({ nombre: "Otro Vendedor", whatsapp: "51900000002", rol: "vendedor" });
  return { store, ids: list, frank, otro };
}

describe("recálculo contra el store", () => {
  it("guarda puntaje, nivel y detalle; registra el cálculo; idempotente", async () => {
    const { store, ids } = await seedStore();
    const r1 = await recalcScores(store, cfg, { catalog: CAT, now: NOW });
    expect(r1.empresas).toBe(30);
    expect(r1.conteo).toEqual({ A: 3, B: 9, C: 18 });
    const c = await store.getCompany(r1.top[0].companyId);
    expect(c?.score).toBe(r1.top[0].score);
    expect(c?.nivel).toBe("A");
    expect(c?.scoreDetalle?.factores).toHaveLength(6);
    expect((await store.latestScoreRun())?.conteo).toEqual({ A: 3, B: 9, C: 18 });
    const before = await Promise.all(ids.map((id) => store.getCompany(id)));
    const r2 = await recalcScores(store, cfg, { catalog: CAT, now: NOW });
    const after = await Promise.all(ids.map((id) => store.getCompany(id)));
    expect(r2.conteo).toEqual(r1.conteo);
    expect(after.map((x) => [x?.score, x?.nivel])).toEqual(before.map((x) => [x?.score, x?.nivel]));
  });

  it("ventas demo no hacen cliente; una venta real sí (y baja el espacio por ganar)", async () => {
    const { store, ids } = await seedStore();
    const c = (await store.getCompany(ids[29]))!;
    await store.insertSales([{ fecha: "2026-10-01", ruc: c.ruc, cantidad: 40, isDemo: true, origen: "demo" }]);
    await recalcScores(store, cfg, { catalog: CAT, now: NOW });
    const demo = (await store.getCompany(c.id))!;
    expect(factor(demo.scoreDetalle!, "espacio")).toMatchObject({ valor: 1, dato: { cliente: false, soloDemo: true } });
    await store.insertSales([{ fecha: "2026-10-02", ruc: c.ruc, cantidad: 40 }]);
    await recalcScores(store, cfg, { catalog: CAT, now: NOW });
    const real = (await store.getCompany(c.id))!;
    // 97 unidades × 6 = 582 llantas -> consumo 291; 40 reales (las 40 demo no cuentan) -> 1 − 40/291
    expect(factor(real.scoreDetalle!, "espacio").valor).toBeCloseTo(1 - 40 / 291, 3);
  });

  it("recálculo de una empresa: usa los cortes del último cálculo completo (cambio de crédito)", async () => {
    const { store } = await seedStore();
    const full = await recalcScores(store, cfg, { catalog: CAT, now: NOW });
    const best = full.top[0].companyId;
    await store.saveCredit(best, { estado: "observado" }, null, NOW);
    const one = await recalcScores(store, cfg, { catalog: CAT, now: NOW, companyIds: [best] });
    expect(one).toMatchObject({ empresas: 1, full: false, conteo: { A: 0, B: 0, C: 1 } });
    const c = (await store.getCompany(best))!;
    expect(c.nivel).toBe("C");
    expect(c.scoreDetalle?.nivelBase).toBe("A");
    expect(explainLine(c.scoreDetalle)).toContain("crédito observado");
    // no registró un cálculo completo nuevo
    expect((await store.latestScoreRun())?.conteo).toEqual(full.conteo);
  });

  it("Prospectos: orden por atractivo (sin puntaje al final) y filtro por nivel", async () => {
    const { store, ids } = await seedStore();
    const extra = await store.upsertCompanies([{ ruc: "20999999999", razonSocial: "SIN PUNTAJE SAC", unidades: 999, llantasPiso: 9999 }]);
    await recalcScores(store, cfg, { catalog: CAT, now: NOW, companyIds: undefined });
    await store.updateCompany(extra.ids["20999999999"], {}); // existe, pero se creó... ya calculada
    const all = await store.searchCompanies({ orderBy: "atractivo", pageSize: 100 });
    const scores = all.rows.map((r) => r.score ?? -1);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    const a = await store.searchCompanies({ orderBy: "atractivo", nivel: ["A"], pageSize: 100 });
    expect(a.rows.every((r) => r.nivel === "A")).toBe(true);
    expect(a.total).toBe(3);
    // una empresa nueva (sin puntaje) va al final
    await store.upsertCompanies([{ ruc: "20888888888", razonSocial: "NUEVA SAC", unidades: 5000, llantasPiso: 30000 }]);
    const again = await store.searchCompanies({ orderBy: "atractivo", pageSize: 100 });
    expect(again.rows.at(-1)?.razonSocial).toBe("NUEVA SAC");
    expect(ids.length).toBe(30);
  });
});

describe("tus mejores flotas", () => {
  it("sin dueño y propias sin actividad en 30 días; nunca las de otro vendedor", async () => {
    const { store, ids, frank, otro } = await seedStore();
    await recalcScores(store, cfg, { catalog: CAT, now: NOW });
    const ranked = (await store.searchCompanies({ orderBy: "atractivo", pageSize: 100 })).rows.map((r) => r.id);
    const [top1, top2, top3, top4] = ranked;
    await store.setOwner(top1, otro.id); // de otro vendedor: no aparece
    await store.setOwner(top2, frank.id); // de Frank, sin actividad: aparece (propia)
    await store.setOwner(top3, frank.id); // de Frank con actividad reciente: no aparece
    await store.addActivity({ companyId: top3, userId: frank.id, tipo: "llamada", texto: "llamé", occurredAt: new Date(NOW.getTime() - 3 * 86_400_000) });
    await store.setOwner(top4, frank.id); // de Frank, actividad vieja: aparece
    await store.addActivity({ companyId: top4, userId: frank.id, tipo: "llamada", texto: "llamé", occurredAt: new Date(NOW.getTime() - 45 * 86_400_000) });

    const mine = await bestFleets(store, frank, cfg, { now: NOW, limit: 20 });
    const got = mine.rows.map((r) => r.id);
    expect(got).not.toContain(top1);
    expect(got).not.toContain(top3);
    expect(got.slice(0, 2)).toEqual([top2, top4]);
    expect(mine.rows.find((r) => r.id === top2)?.propia).toBe(true);
    expect(mine.total).toBe(30 - 2);
    const g = groupForToday(mine.rows);
    expect(g.propias.map((r) => r.id)).toEqual([top2, top4]);
    expect(g.sinDueno.every((r) => r.ownerUserId === null)).toBe(true);

    // la del otro vendedor tampoco aparece para Frank, y las de Frank no aparecen para el otro
    const theirs = await bestFleets(store, otro, cfg, { now: NOW, limit: 50 });
    expect(theirs.rows.map((r) => r.id)).toContain(top1);
    for (const id of [top2, top3, top4]) expect(theirs.rows.map((r) => r.id)).not.toContain(id);
    // paginación del bot: las siguientes 5 no repiten
    const p1 = await bestFleets(store, frank, cfg, { now: NOW, limit: 5 });
    const p2 = await bestFleets(store, frank, cfg, { now: NOW, limit: 5, offset: 5 });
    expect(new Set([...p1.rows, ...p2.rows].map((r) => r.id)).size).toBe(10);
    expect(ids.length).toBe(30);
  });
});

describe("validación del ranking", () => {
  it("compara: coincidencia sin contar «No la conozco», las que más difieren primero, notas", () => {
    const at = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
    const v = (id: number, companyId: number, vendedor: RankingValidation["nivelVendedor"], sistema: RankingValidation["nivelSistema"], nota: string | null = null, d = 1): RankingValidation => ({
      id,
      userId: 1,
      companyId,
      nivelVendedor: vendedor,
      nivelSistema: sistema,
      scoreSistema: 50,
      nota,
      createdAt: at(d),
    });
    const r = compareValidations([
      v(1, 10, "A", "A"),
      v(2, 11, "B", "B"),
      v(3, 12, "C", "A", "ya no opera"),
      v(4, 13, "B", "C"),
      v(5, 14, "desconocida", "B", "no la ubico"),
      v(6, 15, "A", "B", null, 5),
      v(7, 15, "B", "B", null, 1), // la misma empresa otra vez: cuenta la más reciente
    ]);
    expect(r).toMatchObject({ respuestas: 6, comparables: 5, desconocidas: 1, coincidencias: 3, pctCoincidencia: 60, sistemaMasAlto: 1, sistemaMasBajo: 1 });
    expect(r.diferencias[0]).toMatchObject({ companyId: 12, vendedor: "C", sistema: "A", distancia: 2 });
    expect(r.matriz.C.A).toBe(1);
    expect(r.notas.map((n) => n.nota).sort()).toEqual(["no la ubico", "ya no opera"]);
    expect(compareValidations([]).pctCoincidencia).toBeNull();
  });

  it("muestra: 20, mezcla de niveles, primero las suyas, sin repetir ni las ya validadas", async () => {
    const { store, ids, frank } = await seedStore();
    // más empresas para que haya de qué elegir en cada nivel
    const more = await store.upsertCompanies(Array.from({ length: 70 }, (_, i) => ({ ruc: `2070000${String(i).padStart(4, "0")}`, razonSocial: `EMPRESA ${i}`, unidades: 10 + i, llantasPiso: (10 + i) * 6, departamento: "LIMA" })));
    expect(Object.keys(more.ids)).toHaveLength(70);
    await recalcScores(store, cfg, { catalog: CAT, now: NOW });
    const cs = await store.searchCompanies({ nivel: ["C"], orderBy: "atractivo", pageSize: 2 });
    for (const c of cs.rows) await store.setOwner(c.id, frank.id);
    const sample = await pickValidationSample(store, frank, cfg, { now: NOW, rng: seededRng(7) });
    expect(sample).toHaveLength(20);
    expect(new Set(sample.map((c) => c.id)).size).toBe(20);
    const by = (n: string) => sample.filter((c) => c.nivel === n).length;
    expect([by("A"), by("B"), by("C")]).toEqual([7, 7, 6]);
    for (const c of cs.rows) expect(sample.map((s) => s.id)).toContain(c.id);
    await store.addRankingValidations(sample.slice(0, 5).map((c) => ({ userId: frank.id, companyId: c.id, nivelVendedor: "B" as const, nota: null, nivelSistema: c.nivel ?? null, scoreSistema: c.score })));
    const next = await pickValidationSample(store, frank, cfg, { now: NOW, rng: seededRng(8) });
    for (const c of sample.slice(0, 5)) expect(next.map((s) => s.id)).not.toContain(c.id);
    expect(ids.length).toBe(30);
  });
});
