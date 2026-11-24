/**
 * Corrida L — lo de SUNAT en Match Venta, Prospectos, "mejores" y el reparto de visitas (datos inventados de
 * match/__fixtures__/world.ts, con filas de SUNAT inventadas).
 */
import { describe, expect, it } from "vitest";
import { JsonPortalStore } from "../store/json-portal-store";
import type { PortalStore, SunatRecordInput } from "../store/types";
import { matchesByCompany, matchesForProduct, matchFiltersQuery, parseMatchFilters, planCompanyFrom, proposeVisitPlan } from "../match";
import { cfg, load, NOW, world } from "../match/__fixtures__/world";
import { bestFleets } from "../scoring/best";
import { loadPortalConfig } from "../config";
import { SunatSchema } from "./config";

const SUNAT = SunatSchema.parse({});

function rec(ruc: string, ubigeo: string | null, dep: string | null, prov: string | null, dist: string | null, estado = "ACTIVO", condicion = "HABIDO"): SunatRecordInput {
  return { ruc, encontrado: true, razonSocial: null, estado, condicion, ubigeo, departamento: dep, provincia: prov, distrito: dist, direccion: dist ? `Av. Prueba 1, ${dist}` : null, piezas: null, anexos: 0, fecha: "2026-11-23" };
}

async function seedSunat(s: PortalStore) {
  await s.upsertSunat([
    // Buses: el MTC dice Ate; SUNAT, Santiago de Surco (mismo departamento: manda SUNAT)
    rec("20000000001", "150140", "LIMA", "LIMA", "SANTIAGO DE SURCO"),
    // Carga mixta: dada de baja de oficio y no habida (alerta: baja al final, no se oculta)
    rec("20000000003", "150103", "LIMA", "LIMA", "ATE", "BAJA DE OFICIO", "NO HABIDO"),
    // Minera de Arequipa con domicilio fiscal en San Isidro: el distrito de Lima no aplica a su flota de Arequipa
    rec("20000000002", "150131", "LIMA", "LIMA", "SAN ISIDRO"),
    // Flota chica (CALLAO en el MTC) con domicilio en Bellavista (Callao)
    rec("20000000007", "070102", "CALLAO", "CALLAO", "BELLAVISTA", "ACTIVO", "NO HALLADO"),
  ]);
}

describe("Match Venta con SUNAT", () => {
  it("estado o condición en alerta: al final de la lista del producto y de la vista por empresa, sin ocultarse", async () => {
    const w = await world(JsonPortalStore.memory());
    await load(w);
    const before = await matchesForProduct(w.store, w.frank, "T0433", {}, { cfg: cfg(), now: NOW });
    const names = before.empresas.map((c) => c.razonSocial);
    expect(names.indexOf("CARGA MIXTA DEMO SAC")).toBeLessThan(names.length - 1);
    await seedSunat(w.store);
    const view = await matchesForProduct(w.store, w.frank, "T0433", {}, { cfg: cfg(), now: NOW, sunat: SUNAT });
    const after = view.empresas.map((c) => c.razonSocial);
    expect(after).toHaveLength(names.length);
    expect(after[after.length - 1]).toBe("CARGA MIXTA DEMO SAC");
    const mixta = view.empresas.find((c) => c.razonSocial === "CARGA MIXTA DEMO SAC")!;
    expect(mixta.sunatAviso).toEqual({ nivel: "alerta", texto: "BAJA DE OFICIO · NO HABIDO" });
    expect(mixta.enAlerta).toBe(true);
    const buses = view.empresas.find((c) => c.razonSocial === "BUSES DEL SUR DEMO SAC")!;
    expect(buses.ubicacion).toMatchObject({ distrito: "SANTIAGO DE SURCO", fuente: "sunat", ubigeo: "150140" });
    expect(buses.direccionVisible).toEqual({ texto: "Av. Prueba 1, SANTIAGO DE SURCO", fuente: "fiscal", segun: "Según SUNAT al 23/11/2026" });
    expect(buses.sunatAviso).toBeNull();

    const byCompany = await matchesByCompany(w.store, w.frank, {}, { cfg: cfg(), sunat: SUNAT });
    expect(byCompany[byCompany.length - 1].razonSocial).toBe("CARGA MIXTA DEMO SAC");
    expect(byCompany.map((c) => c.razonSocial)).toContain("CARGA MIXTA DEMO SAC");
  });

  it("filtro por distrito (código INEI) en la dirección y en las vistas; Lima y Callao juntos", async () => {
    const w = await world(JsonPortalStore.memory());
    await load(w);
    await seedSunat(w.store);
    const f = parseMatchFilters(new URLSearchParams("dep=LIMA&dist=150140"));
    expect(f).toEqual({ departamento: "LIMA", distrito: "150140" });
    expect(new URLSearchParams(matchFiltersQuery(f)).get("dist")).toBe("150140");
    // un distrito que no son 6 dígitos no entra
    expect(parseMatchFilters(new URLSearchParams("dist=ATE"))).toEqual({});
    const surco = await matchesForProduct(w.store, w.frank, "T0433", f, { cfg: cfg(), sunat: SUNAT });
    expect(surco.empresas.map((c) => c.razonSocial)).toEqual(["BUSES DEL SUR DEMO SAC"]);
    // Ate: la de SUNAT (Carga mixta); Buses ya no (SUNAT manda sobre el Ate del MTC)
    const ate = await matchesForProduct(w.store, w.frank, "T0433", { distrito: "150103" }, { cfg: cfg(), sunat: SUNAT });
    expect(ate.empresas.map((c) => c.razonSocial)).toEqual(["CARGA MIXTA DEMO SAC"]);
    // la minera de Arequipa no sale en San Isidro (su domicilio fiscal no es donde opera)
    const si = await matchesByCompany(w.store, w.sup, { distrito: "150131" }, { cfg: cfg(), sunat: SUNAT });
    expect(si.map((c) => c.razonSocial)).toEqual([]);
  });

  it("Prospectos: searchCompanies por distrito y listDistritos por departamento", async () => {
    const w = await world(JsonPortalStore.memory());
    await seedSunat(w.store);
    const r = await w.store.searchCompanies({ distrito: "150140" });
    expect(r.rows.map((c) => c.razonSocial)).toEqual(["BUSES DEL SUR DEMO SAC"]);
    expect(r.rows[0].sunat).toMatchObject({ ubigeo: "150140", estado: "ACTIVO" });
    expect((await w.store.searchCompanies({ distrito: "070102" })).rows.map((c) => c.razonSocial)).toEqual(["FLOTA CHICA DEMO EIRL"]);
    expect((await w.store.searchCompanies({ distrito: "150131" })).total).toBe(0);
    const lima = await w.store.listDistritos({ departamento: "LIMA" });
    expect(lima.map((d) => [d.ubigeo, d.distrito, d.empresas])).toEqual([
      ["150103", "ATE", 1],
      ["070102", "BELLAVISTA", 1],
      ["150140", "SANTIAGO DE SURCO", 1],
    ]);
    expect(await w.store.listDistritos({ departamento: "AREQUIPA" })).toEqual([]);
  });

  it("reparto de visitas por el distrito real de SUNAT", async () => {
    const w = await world(JsonPortalStore.memory());
    await seedSunat(w.store);
    const companies = await Promise.all(["20000000001", "20000000003"].map((r) => w.store.getCompanyByRuc(r)));
    const sunat = new Map((await w.store.getSunatByRucs(["20000000001", "20000000003"])).map((s) => [s.ruc, s]));
    const plan = proposeVisitPlan(companies.map((c) => planCompanyFrom(c!, sunat.get(c!.ruc))), { start: NOW, perDay: 4 });
    expect(plan[0].zonas).toEqual(["LIMA / ATE", "LIMA / SANTIAGO DE SURCO"]);
  });
});

describe("mejores con SUNAT", () => {
  it("las empresas en alerta van al final (bot y portal), sin ocultarse", async () => {
    const w = await world(JsonPortalStore.memory());
    const s = w.store;
    await s.saveScores(
      [
        { companyId: w.ids["20000000003"], score: 95, nivel: "A", detalle: null },
        { companyId: w.ids["20000000001"], score: 80, nivel: "A", detalle: null },
        { companyId: w.ids["20000000007"], score: 50, nivel: "B", detalle: null },
      ] as never,
      NOW,
    );
    await seedSunat(s);
    const scoring = loadPortalConfig().scoring;
    const r = await bestFleets(s, w.frank, scoring, { limit: 10, sunat: SUNAT });
    const names = r.rows.map((x) => x.razonSocial);
    expect(names[names.length - 1]).toBe("CARGA MIXTA DEMO SAC");
    expect(names.slice(0, 2)).toEqual(["BUSES DEL SUR DEMO SAC", "FLOTA CHICA DEMO EIRL"]);
    expect(r.rows.find((x) => x.razonSocial === "CARGA MIXTA DEMO SAC")?.sunat?.estado).toBe("BAJA DE OFICIO");
  });
});
