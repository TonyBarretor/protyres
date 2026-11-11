import { describe, expect, it } from "vitest";
import { JsonPortalStore } from "../store/json-portal-store";
import { computeParticipation } from "./participation";
import { DEMO_CATALOG, generateDemoSales, pickDemoCompanies, seedDemoSales, type DemoCompany } from "./demo";

const now = new Date("2026-11-11T12:00:00Z");
const companies: DemoCompany[] = [
  { ruc: "20111111111", razonSocial: "BUSES DEMO S.A.C.", unidades: 80, llantasPiso: 640, medidas: ["295/80R22.5"] },
  { ruc: "20222222222", razonSocial: "CARGA DEMO S.A.", unidades: 40, llantasPiso: 400, medidas: ["11R22.5", "385/65R22.5"] },
  { ruc: "20333333333", razonSocial: "SIN MEDIDA DEMO", unidades: 12, llantasPiso: 0, medidas: [] },
];

describe("generateDemoSales", () => {
  it("is deterministic and depends on the seed", () => {
    const a = generateDemoSales(companies, { now, seed: 1 });
    expect(generateDemoSales(companies, { now, seed: 1 })).toEqual(a);
    expect(generateDemoSales(companies, { now, seed: 2 })).not.toEqual(a);
  });
  it("all rows are demo, by Frank, inside the last 12 months, with catalog sizes/brands", () => {
    const rows = generateDemoSales(companies, { now });
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const r of rows) {
      expect(r).toMatchObject({ isDemo: true, origen: "demo", vendedor: "Frank" });
      expect(r.fecha >= "2025-11-11" && r.fecha <= "2026-11-11").toBe(true);
      expect(r.cantidad).toBeGreaterThan(0);
      expect(DEMO_CATALOG[r.medida!].some((i) => i.marca === r.marca && i.diseno === r.diseno)).toBe(true);
      expect(r.total).toBeCloseTo(r.precioUnitario! * r.cantidad, 2);
    }
    expect(new Set(rows.map((r) => r.ruc))).toEqual(new Set(companies.map((c) => c.ruc)));
    const bus = rows.filter((r) => r.ruc === "20111111111");
    expect(bus.every((r) => r.medida === "295/80R22.5")).toBe(true);
    // Every generated row counts in the 12-month participation and is flagged demo.
    const part = computeParticipation(rows, { now });
    expect(part["20111111111"]).toEqual({ cantidad: bus.reduce((s, r) => s + r.cantidad, 0), demo: true });
  });
});

describe("seedDemoSales", () => {
  it("finds targets by name, fills with big companies, and re-seeding does not duplicate", async () => {
    const store = JsonPortalStore.memory();
    const names = ["ANCRO S.R.L.", "MOVIL BUS S.A.C", "FRANCROS DEMO S.A.C.", ...Array.from({ length: 12 }, (_, i) => `EMPRESA ${i} DEMO S.A.`)];
    await store.upsertCompanies(names.map((razonSocial, i) => ({ ruc: String(20500000000 + i), razonSocial, unidades: 100 + i, llantasPiso: 600 })));
    await store.insertSales([{ fecha: "2026-10-01", ruc: "20500000000", cantidad: 4, origen: "excel" }]);

    const pick = await pickDemoCompanies(store, { count: 10 });
    expect(pick.found.map((f) => f.target)).toEqual(["ANCRO", "MOVIL BUS"]);
    expect(pick.found[0].razonSocial).toBe("ANCRO S.R.L."); // not FRANCROS (whole word)
    expect(pick.missing).toEqual(["INNOVA AMBIENTAL", "TURISMO JAKSA", "PROSEGUR"]);
    expect(pick.companies).toHaveLength(10);

    const first = await seedDemoSales(store, { now, count: 10 });
    const second = await seedDemoSales(store, { now, count: 10 });
    expect(second.deleted).toBe(first.inserted);
    expect(second.inserted).toBe(first.inserted);
    const all = await store.salesByRuc("20500000000");
    expect(all.filter((s) => !s.isDemo)).toHaveLength(1);
    expect(await store.deleteDemoSales()).toBe(first.inserted);
    expect(await store.salesByRuc("20500000000")).toHaveLength(1); // the real sale stays
  });
});
