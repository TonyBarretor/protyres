import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonPortalStore } from "../store/json-portal-store";
import { formatImportSummary, importMtc } from "./import";
import { loadTyreRules } from "./inference";

const FIX = path.join(__dirname, "__fixtures__");
const files = ["carga2224.csv", "carga25.csv", "pasajeros.csv"].map((f) => path.join(FIX, f));
const rules = loadTyreRules(path.join(__dirname, "..", "..", "..", "..", "config", "tyre-inference.json"));
const config = (minUnits: number) => ({ minUnits, currentCut: "20251231", tyreCuts: ["20241231", "20231231", "20221231"], dir: "unused" });

describe("importMtc (fixtures)", () => {
  it("dry run computes without a store", async () => {
    const s = await importMtc({ files, config: config(3), rules, dryRun: true });
    expect(s.written).toBeNull();
    expect(s.duplicadas).toBe(1); // P1A001 repeated in pasajeros
    expect(s.empresas).toBe(3);
    expect(s.files.map((f) => f.origen)).toEqual(["carga", "carga", "pasajeros"]);
    expect(formatImportSummary(s)).toContain("simulación");
  });

  it("writes companies above the threshold and is idempotent", async () => {
    const store = JsonPortalStore.memory();
    const first = await importMtc({ files, config: config(3), rules, store, batchSize: 2 });
    expect(first.empresas).toBe(3);
    expect(first.written).toMatchObject({ companiesInserted: 3, companiesUpdated: 0, fleetUpdated: 0 });
    const companies = await store.countCompanies();
    const fleet = await store.countFleet();
    expect(companies).toBe(3);
    expect(fleet).toBe(first.vehiculos);
    expect(fleet).toBe(10); // 4 + 3 + 3 (the duplicated plate counted once)

    const andinos = await store.getCompanyByRuc("20111111111");
    expect(andinos).toMatchObject({ sector: "mixto", unidades: 4, llantasPiso: 34 });
    const vehicles = await store.listFleet(andinos!.id);
    expect(vehicles.find((v) => v.placa === "AAA111")).toMatchObject({ llantas: 10, llantasFuente: "20241231", origen: "carga" });
    expect(vehicles.find((v) => v.placa === "AAA113")).toMatchObject({ medidaProbable: "295/80R22.5", confianza: "media" });
    expect(await store.getCompanyByRuc("20555555555")).toBeNull(); // 1 unit: below the threshold

    const second = await importMtc({ files, config: config(3), rules, store });
    expect(second.written).toEqual({ companiesInserted: 0, companiesUpdated: 3, fleetInserted: 0, fleetUpdated: fleet, fleetRemoved: 0 });
    expect(await store.countCompanies()).toBe(companies);
    expect(await store.countFleet()).toBe(fleet);
  });

  it("prunes vehicles no longer in the current padrón from imported companies, keeps the other companies untouched", async () => {
    const store = JsonPortalStore.memory();
    await importMtc({ files, config: config(3), rules, store });
    const andinos = (await store.getCompanyByRuc("20111111111"))!;
    const fleetBefore = (await store.listFleet(andinos.id)).map((v) => v.placa);
    // A vehicle left over from an earlier padrón (sold or retired since).
    await store.upsertFleet([{ ...(await store.listFleet(andinos.id))[0], placa: "OLD999", origen: "carga" }]);
    expect(await store.listFleet(andinos.id)).toHaveLength(fleetBefore.length + 1);

    // With a higher threshold only ANDINOS passes: its fleet is pruned to the padrón; the others keep everything.
    const others = (await store.searchCompanies({ pageSize: 10 })).rows.filter((c) => c.id !== andinos.id);
    const othersFleet = await Promise.all(others.map((c) => store.listFleet(c.id)));
    await store.setOwner(others[0].id, 7);
    const s = await importMtc({ files, config: config(4), rules, store });
    expect(s.empresas).toBe(1);
    expect(s.written).toMatchObject({ companiesInserted: 0, companiesUpdated: 1, fleetRemoved: 1 });
    expect((await store.listFleet(andinos.id)).map((v) => v.placa)).toEqual(fleetBefore);
    expect(await store.countCompanies()).toBe(3);
    for (const [i, c] of others.entries()) expect(await store.listFleet(c.id)).toEqual(othersFleet[i]);
    expect((await store.getCompany(others[0].id))?.ownerUserId).toBe(7);

    // Idempotent: a second run removes nothing more.
    const again = await importMtc({ files, config: config(4), rules, store });
    expect(again.written?.fleetRemoved).toBe(0);
    expect(await store.countFleet()).toBe(10);
  });
});
