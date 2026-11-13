import { describe, expect, it } from "vitest";
import { JsonPortalStore } from "../store/json-portal-store";
import type { FleetOrigen, FleetVehicleInput } from "../store/types";
import { aggregateCompanies } from "./aggregate";
import { formatRecalcSummary, recalcSectors } from "./recalc-sector";

function fleet(companyId: number, prefix: string, carga: number, pasajeros: number): FleetVehicleInput[] {
  const v = (i: number, origen: FleetOrigen): FleetVehicleInput => ({
    companyId,
    placa: `${prefix}${origen === "carga" ? "C" : "P"}${String(i).padStart(3, "0")}`,
    marca: "MARCA DEMO",
    clase: origen === "carga" ? "REMOLCADOR" : "OMNIBUS",
    anio: 2018,
    ejes: 2,
    llantas: null,
    llantasFuente: null,
    pesoBruto: null,
    chasis: null,
    departamento: "LIMA",
    origen,
    medidaProbable: null,
    confianza: null,
  });
  return [...Array.from({ length: carga }, (_, i) => v(i, "carga")), ...Array.from({ length: pasajeros }, (_, i) => v(i, "pasajeros"))];
}

async function seeded() {
  const store = JsonPortalStore.memory();
  const { ids } = await store.upsertCompanies([
    { ruc: "20900000001", razonSocial: "BUSES DEMO S.A.C.", sector: "mixto", unidades: 85 }, // 3 carga + 82 pasajeros
    { ruc: "20900000002", razonSocial: "MITAD Y MITAD DEMO S.A.C.", sector: "mixto", unidades: 20 }, // 10 + 10
    { ruc: "20900000003", razonSocial: "CARGA DEMO E.I.R.L.", sector: "mixto", unidades: 20 }, // 19 + 1
    { ruc: "20900000004", razonSocial: "YA BIEN DEMO S.A.", sector: "carga", unidades: 12 }, // 12 + 0
    { ruc: "20900000005", razonSocial: "SIN FLOTA DEMO S.A.", sector: "mixto", unidades: 0 },
    { ruc: "20900000006", razonSocial: "SIN SECTOR DEMO S.A.", sector: null, unidades: 10 }, // 0 + 10
  ]);
  await store.upsertFleet([
    ...fleet(ids["20900000001"], "AA", 3, 82),
    ...fleet(ids["20900000002"], "BB", 10, 10),
    ...fleet(ids["20900000003"], "CC", 19, 1),
    ...fleet(ids["20900000004"], "DD", 12, 0),
    ...fleet(ids["20900000006"], "FF", 0, 10),
  ]);
  return { store, ids };
}

describe("companyOriginCounts (JSON)", () => {
  it("cuenta la flota por origen, incluye empresas sin flota y ordena por id", async () => {
    const { store, ids } = await seeded();
    const rows = await store.companyOriginCounts();
    expect(rows.map((r) => r.companyId)).toEqual(Object.values(ids).sort((a, b) => a - b));
    expect(rows.find((r) => r.ruc === "20900000001")).toMatchObject({ razonSocial: "BUSES DEMO S.A.C.", sector: "mixto", carga: 3, pasajeros: 82 });
    expect(rows.find((r) => r.ruc === "20900000005")).toMatchObject({ carga: 0, pasajeros: 0 });
  });
});

describe("recalcSectors", () => {
  it("dry-run: informa los cambios sin escribir", async () => {
    const { store, ids } = await seeded();
    const s = await recalcSectors({ store, majority: 0.9, dryRun: true });
    expect(s).toMatchObject({ dryRun: true, empresas: 6, sinFlota: 1 });
    expect(s.transiciones).toEqual({ "mixto → pasajeros": 1, "mixto → carga": 1, "sin sector → pasajeros": 1 });
    expect(s.cambios.map((c) => c.ruc).sort()).toEqual(["20900000001", "20900000003", "20900000006"]);
    expect((await store.getCompany(ids["20900000001"]))!.sector).toBe("mixto");
    expect(formatRecalcSummary(s)).toContain("Cambiarían: 3");
  });

  it("escribe solo las que cambian, y una segunda pasada no cambia nada", async () => {
    const { store, ids } = await seeded();
    const before = await store.getCompany(ids["20900000004"]);
    const s = await recalcSectors({ store, majority: 0.9 });
    expect(s.cambios).toHaveLength(3);
    const sector = async (ruc: string) => (await store.getCompany(ids[ruc]))!.sector;
    expect(await sector("20900000001")).toBe("pasajeros");
    expect(await sector("20900000002")).toBe("mixto");
    expect(await sector("20900000003")).toBe("carga");
    expect(await sector("20900000004")).toBe("carga");
    expect(await sector("20900000005")).toBe("mixto"); // sin flota: no se toca
    expect(await sector("20900000006")).toBe("pasajeros");
    expect((await store.getCompany(ids["20900000004"]))!.updatedAt).toEqual(before!.updatedAt); // sin cambio, sin escritura
    expect(formatRecalcSummary(s)).toContain("Cambiaron: 3");
    expect((await recalcSectors({ store, majority: 0.9 })).cambios).toHaveLength(0);
  });

  it("otro umbral: vuelve a mixto lo que ya no alcanza la mayoría", async () => {
    const { store, ids } = await seeded();
    await recalcSectors({ store, majority: 0.9 });
    const s = await recalcSectors({ store, majority: 0.99 });
    expect(s.transiciones).toEqual({ "pasajeros → mixto": 1, "carga → mixto": 1 });
    expect((await store.getCompany(ids["20900000001"]))!.sector).toBe("mixto");
  });

  it("da lo mismo que el import (misma regla)", async () => {
    const { store } = await seeded();
    await recalcSectors({ store, majority: 0.9 });
    for (const r of await store.companyOriginCounts()) {
      if (!r.carga && !r.pasajeros) continue;
      const rows = [
        ...Array.from({ length: r.carga }, () => ({ origen: "carga" as const })),
        ...Array.from({ length: r.pasajeros }, () => ({ origen: "pasajeros" as const })),
      ].map((x) => ({ ...x, ruc: r.ruc, razonSocial: r.razonSocial, departamento: null, llantas: null, anio: null, fechaCorte: "20251231" }));
      expect(aggregateCompanies(rows, { sectorMajority: 0.9 })[0].sector).toBe(r.sector);
    }
  });
});
