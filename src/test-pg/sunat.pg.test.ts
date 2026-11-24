/**
 * Corrida L — SUNAT contra Postgres real:
 *  - JSON y Postgres dan lo mismo: importación (fixtures de empresas reales + persona natural inventada), reimportación
 *    sin duplicar, locales, RUC del portal (padrón + ventas), distritos, filtro por distrito en Prospectos y Match Venta,
 *    alerta al final de Match Venta y de "mejores".
 *  - Con los datos reales (padrón importado + los dos zip de SUNAT, si están en la máquina; SUNAT_REAL=1): importación y
 *    consultas nuevas medidas (cada una por debajo de 2 s).
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchesByCompany, matchesForProduct } from "../lib/portal/match";
import { cfg, load, NOW, world } from "../lib/portal/match/__fixtures__/world";
import { bestFleets } from "../lib/portal/scoring/best";
import { loadPortalConfig } from "../lib/portal/config";
import { SunatSchema } from "../lib/portal/sunat/config";
import { importSunat } from "../lib/portal/sunat/import";
import { JsonPortalStore } from "../lib/portal/store/json-portal-store";
import { PgPortalStore } from "../lib/portal/store/pg-portal-store";
import type { Company, MatchResultInput, PortalStore } from "../lib/portal/store/types";
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

const FIX = path.resolve(__dirname, "../lib/portal/sunat/__fixtures__");
const MAIN = path.join(FIX, "padron_reducido_ruc.txt");
const ANEXOS = path.join(FIX, "padron_reducido_local_anexo.txt");
const SUNAT = SunatSchema.parse({});

describe("SUNAT: JSON y Postgres dan lo mismo", () => {
  it("importación, reimportación, locales, RUC del portal, distritos, filtros y alerta", async () => {
    const { json, pg: p } = await bothTraces<PortalStore>(JsonPortalStore.memory(), pg, async (s, trace) => {
      const w = await world(s);
      await load(w);
      // empresas del portal que están en el fixture de SUNAT (reales) y un cliente de ventas fuera del padrón
      await s.upsertCompanies([
        { ruc: "20100193117", razonSocial: "YARA PERU S.R.L.", sector: "carga", departamento: "LIMA", unidades: 40 },
        { ruc: "20100015103", razonSocial: "TRANSPORTES 77 S.A.", sector: "carga", departamento: "LIMA", provincia: "LIMA", distrito: "LA VICTORIA", unidades: 1242 },
        { ruc: "20100036950", razonSocial: "CONSTRUCCIONES METALICAS UNION S A", sector: "carga", departamento: "LIMA", unidades: 12 },
        { ruc: "20601269440", razonSocial: "MAC2 E.I.R.L.", sector: "carga", departamento: "AREQUIPA", unidades: 15 },
      ]);
      await s.insertSales([{ fecha: "2026-10-01", ruc: "20100039207", razonSocial: "RANSA COMERCIAL S.A.C", cantidad: 4 }]);
      const r1 = await importSunat({ store: s, archivo: MAIN, anexos: ANEXOS, fecha: "2026-11-23" });
      const { ms: _ms, rssMaxMb: _r, heapMaxMb: _h, ...sum1 } = r1;
      trace("import1", sum1);
      trace("portalRucs", await s.listPortalRucs());
      trace("getSunat", await s.getSunat("20100193117"));
      trace("getSunatByRucs", (await s.getSunatByRucs(["20100015103", "20100039207", "20999999999"])).sort((a, b) => a.ruc.localeCompare(b.ruc)));
      trace("locales", (await s.listSunatLocales("20100015103")).map(({ id: _id, ...l }) => l));
      // reimportación: sin duplicar
      const r2 = await importSunat({ store: s, archivo: MAIN, anexos: ANEXOS, fecha: "2026-12-01" });
      trace("import2", [r2.inserted, r2.updated, r2.localesBorrados, r2.anexos]);
      trace("locales2", (await s.listSunatLocales("20100015103")).length);
      trace("distritosLima", await s.listDistritos({ departamento: "LIMA" }));
      trace("distritosTodos", await s.listDistritos());
      trace("search.surco", (await s.searchCompanies({ distrito: "150140" })).rows.map((c) => [c.razonSocial, c.sunat?.direccion]));
      trace("search.ventanilla", (await s.searchCompanies({ distrito: "070106", departamento: ["LIMA"] })).rows.map((c) => c.razonSocial));
      trace("search.cayma", (await s.searchCompanies({ distrito: "040103" })).rows.map((c) => c.razonSocial));
      trace("search.nada", (await s.searchCompanies({ distrito: "999999" })).total);
      // alerta: Construcciones Metálicas (BAJA DE OFICIO / NO HABIDO) al final de "mejores"
      const ids = (await s.getCompaniesByRucs(["20100036950", "20100193117", "20100015103"])).map((c) => c.id).sort((a, b) => a - b);
      await s.saveScores(ids.map((id, i) => ({ companyId: id, score: 90 - i, nivel: "A", detalle: null })) as never, NOW);
      const best = await bestFleets(s, w.frank, loadPortalConfig().scoring, { limit: 20, sunat: SUNAT });
      trace("best", best.rows.map((r) => [r.razonSocial, r.sunat?.estado ?? null]));
      // Match Venta: la empresa de la fixture con SUNAT en alerta (las del mundo de prueba no tienen SUNAT)
      await s.upsertSunat([{ ruc: "20000000003", encontrado: true, razonSocial: null, estado: "BAJA DE OFICIO", condicion: "NO HABIDO", ubigeo: "150103", departamento: "LIMA", provincia: "LIMA", distrito: "ATE", direccion: "Av. Prueba 1, Ate, Lima", piezas: null, anexos: 0, fecha: "2026-11-23" }]);
      const v = await matchesForProduct(s, w.frank, "T0433", {}, { cfg: cfg(), now: NOW, sunat: SUNAT });
      trace("match.producto", v.empresas.map((c) => [c.razonSocial, c.enAlerta, c.ubicacion.distrito]));
      trace("match.ate", (await matchesForProduct(s, w.frank, "T0433", { distrito: "150103" }, { cfg: cfg(), sunat: SUNAT })).empresas.map((c) => c.razonSocial));
      trace("match.empresa", (await matchesByCompany(s, w.frank, {}, { cfg: cfg(), sunat: SUNAT })).map((c) => c.razonSocial));
    });
    const diffs = diffTraces(json, p);
    expect(diffs).toEqual([]);
    expect((json.import1 as { encontradas: number }).encontradas).toBe(5);
    expect((json.best as [string][]).at(-1)?.[0]).toBe("CONSTRUCCIONES METALICAS UNION S A");
    expect((json["match.producto"] as [string][]).at(-1)?.[0]).toBe("CARGA MIXTA DEMO SAC");
  });
});

// ── datos reales (fuera de git): el padrón importado y los dos zip de SUNAT ──

const MAIN_DATA = "/Users/tonybarreto/Desktop/coworkSandbox/protyres/data";
const pick = (rel: string) => [path.resolve(process.cwd(), "data", rel), path.join(MAIN_DATA, rel)].find((f) => fs.existsSync(f));
const PORTAL_REAL = pick("portal-store.json");
const RUC_ZIP = pick("sunat/padron_reducido_ruc.zip");
const ANEXO_ZIP = pick("sunat/padron_reducido_local_anexo.zip");

describe.runIf(!!PORTAL_REAL && !!RUC_ZIP && !!ANEXO_ZIP && process.env.SUNAT_REAL === "1")("datos reales: importación y consultas por debajo de 2 s", () => {
  it("padrón importado + SUNAT real", async () => {
    await truncateAll(testDbUrl());
    const raw = JSON.parse(fs.readFileSync(PORTAL_REAL!, "utf8")) as { users: { nombre: string; whatsapp: string; rol: "vendedor" }[]; companies: Company[] };
    for (const u of raw.users) if (u.whatsapp) await pg.upsertUser({ nombre: u.nombre, whatsapp: u.whatsapp, rol: u.rol });
    const up = await pg.upsertCompanies(raw.companies.map((c) => ({ ruc: c.ruc, razonSocial: c.razonSocial, sector: c.sector, departamento: c.departamento, provincia: c.provincia ?? null, distrito: c.distrito ?? null, unidades: c.unidades, llantasPiso: c.llantasPiso, antiguedadMedia: c.antiguedadMedia })));
    const ids = Object.values(up.ids);
    await pg.saveScores(ids.map((id, i) => ({ companyId: id, score: 100 - (i % 100), nivel: "A", detalle: null })) as never, NOW);
    // un resultado de Match por empresa (para medir la lista con el join de SUNAT sin recalcular la flota entera)
    const rucOf = new Map(Object.entries(up.ids).map(([ruc, id]) => [id, ruc]));
    const rows: MatchResultInput[] = ids.map((id, i) => ({ productCode: "P0433", medida: "295/80R22.5", companyId: id, ruc: rucOf.get(id)!, razonSocial: "X", tipo: "directo", pct: 30 + (i % 70), llantasMedida: 10, unidadesMedida: 5, podriaLlevar: 4, yaCompro: false, excluida: null, detalle: { desglose: "" } as never }));
    await pg.saveMatchRun({ motivo: "prueba", productos: 1, empresas: ids.length, filas: rows.length, duracionMs: 0, data: {} }, rows);
    const t0 = Date.now();
    const r = await importSunat({ store: pg, archivo: RUC_ZIP!, anexos: ANEXO_ZIP! });
    const importMs = Date.now() - t0;
    const times: Record<string, number> = {};
    const all: Record<string, number[]> = {};
    // mejor de 3: el pooler de Supabase varía mucho de una llamada a otra (se imprimen las tres)
    const time = async <T>(label: string, f: () => Promise<T>): Promise<T> => {
      let out: T | undefined;
      for (let i = 0; i < 3; i++) {
        const t = Date.now();
        out = await f();
        (all[label] ??= []).push(Date.now() - t);
      }
      times[label] = Math.min(...all[label]);
      return out as T;
    };
    const frank = (await pg.listUsers())[0] ?? (await pg.upsertUser({ nombre: "Frank", whatsapp: "51900000001", rol: "vendedor" }));
    await time("searchCompanies sin filtro", () => pg.searchCompanies({ orderBy: "atractivo", withMedidas: true }));
    await time("searchCompanies distrito Ate", () => pg.searchCompanies({ distrito: "150103", departamento: ["LIMA"], orderBy: "atractivo" }));
    await time("searchCompanies distrito Cayma", () => pg.searchCompanies({ distrito: "040103" }));
    await time("listDistritos Lima", () => pg.listDistritos({ departamento: "LIMA" }));
    await time("listDistritos todos", () => pg.listDistritos());
    await time("bestCompanies con alerta", () => bestFleets(pg, frank, loadPortalConfig().scoring, { limit: 20, sunat: SUNAT }));
    await time("listMatchSummaries con SUNAT", () => pg.listMatchSummaries({ productCodes: ["P0433"] }));
    const most = (await pg.getSunatByRucs(raw.companies.map((c) => c.ruc))).sort((a, b) => b.anexos - a.anexos)[0];
    await time("getSunat", () => pg.getSunat(most.ruc));
    await time(`listSunatLocales (${most.anexos})`, () => pg.listSunatLocales(most.ruc));
    await time("listPortalRucs", () => pg.listPortalRucs());
    console.log(`[test:pg] SUNAT real: importación ${importMs} ms (${r.rucs} RUC, ${r.encontradas} encontradas, ${r.anexos} locales; lectura ${r.ms} ms, RSS máx ${r.rssMaxMb} MB); consultas (mejor de 3) ${JSON.stringify(times)}; todas ${JSON.stringify(all)}`);
    for (const [k, ms] of Object.entries(times)) expect(ms, k).toBeLessThan(2000);
    // reimportar no duplica
    const r2 = await importSunat({ store: pg, archivo: RUC_ZIP!, anexos: ANEXO_ZIP! });
    expect([r2.inserted, r2.updated]).toEqual([0, r.rucs]);
    expect(r2.anexos).toBe(r.anexos);
  }, 900_000);
});
