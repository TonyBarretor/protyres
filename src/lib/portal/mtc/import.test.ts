import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonPortalStore } from "../store/json-portal-store";
import { formatImportSummary, importMtc } from "./import";
import { loadTyreRules } from "./inference";

const FIX = path.join(__dirname, "__fixtures__");
const files = ["carga2224.csv", "carga25.csv", "pasajeros.csv"].map((f) => path.join(FIX, f));
const rules = loadTyreRules(path.join(__dirname, "..", "..", "..", "..", "config", "tyre-inference.json"));
const config = (minUnits: number, sectorMajority = 0.9) => ({ minUnits, currentCut: "20251231", tyreCuts: ["20241231", "20231231", "20221231"], dir: "unused", sectorMajority });

describe("importMtc (fixtures)", () => {
  it("dry run computes without a store", async () => {
    const s = await importMtc({ files, config: config(3), rules, dryRun: true });
    expect(s.written).toBeNull();
    expect(s.duplicadas).toBe(1); // P1A001 repeated in pasajeros
    expect(s.empresas).toBe(3);
    expect(s.files.map((f) => f.origen)).toEqual(["carga", "carga", "pasajeros"]);
    expect(formatImportSummary(s)).toContain("simulación");
  });

  it("uses import.sectorMajority for the sector (3 carga + 1 pasajeros = 75 %)", async () => {
    const at = async (m: number) => (await importMtc({ files, config: config(3, m), rules, dryRun: true, verifyRuc: "20111111111" })).verificacion?.sector;
    expect(await at(0.9)).toBe("mixto");
    expect(await at(0.75)).toBe("carga");
    const store = JsonPortalStore.memory();
    await importMtc({ files, config: config(3, 0.75), rules, store });
    expect((await store.getCompanyByRuc("20111111111"))!.sector).toBe("carga");
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

describe("corrida J: empresas fuera del padrón", () => {
  it("importa una empresa puntual por RUC aunque tenga menos unidades que el umbral, y solo esa", async () => {
    const store = JsonPortalStore.memory();
    const s = await importMtc({ files, config: config(3), rules, store, onlyRucs: ["20555555555"] });
    expect(s.empresas).toBe(1);
    expect(s.faltantes).toEqual([]);
    expect(await store.countCompanies()).toBe(1);
    const c = (await store.getCompanyByRuc("20555555555"))!;
    expect(c.unidades).toBe(1);
    expect(await store.listFleet(c.id)).toHaveLength(1);
    expect(formatImportSummary(s)).toContain("Empresas pedidas por RUC: 20555555555");
    // un RUC que no está en el padrón vigente: no escribe nada y lo dice
    const none = await importMtc({ files, config: config(3), rules, store, onlyRucs: ["20600000013"] });
    expect(none.empresas).toBe(0);
    expect(none.faltantes).toEqual(["20600000013"]);
    expect(formatImportSummary(none)).toContain("No están en el padrón vigente: 20600000013");
    expect(await store.countCompanies()).toBe(1);
  });

  it("la reimportación no toca las empresas creadas a mano; si llega su RUC se fusiona y conserva lo cargado a mano", async () => {
    const store = JsonPortalStore.memory();
    const frank = await store.upsertUser({ nombre: "Frank Prueba", whatsapp: "51900000001", rol: "vendedor" });
    const andinos = (await store.createManualCompany({ ruc: "20111111111", razonSocial: "ANDINOS (A MANO)", sector: "carga", departamento: "LIMA", unidades: 2, createdBy: frank.id })).company;
    const sol = (await store.createManualCompany({ ruc: "20600000013", razonSocial: "TRANSPORTES SOL SAC", sector: "carga", departamento: "JUNIN", unidades: 3, createdBy: frank.id })).company;
    for (const [c, placa] of [[andinos, "MAN111"], [sol, "MAN222"]] as const) await store.addManualVehicle(c.id, { placa, marca: "VOLVO", clase: "CAMION", ejes: 2, llantas: 6, medida: "11R22.5" });
    await store.addContact({ companyId: andinos.id, nombre: "Rosa Díaz", createdBy: frank.id });
    const opp = await store.createOpportunity({ companyId: andinos.id, ownerUserId: frank.id, createdBy: frank.id });

    const s = await importMtc({ files, config: config(3), rules, store });
    expect(s.fusionadas).toEqual(["20111111111"]);
    expect(formatImportSummary(s)).toContain("Empresas creadas a mano que llegaron en el padrón (fusionadas): 20111111111");
    const merged = (await store.getCompany(andinos.id))!;
    expect(merged).toMatchObject({ origen: "mtc", razonSocial: "TRANSPORTES ANDINOS DEMO S.A.C.", unidades: 4, ownerUserId: frank.id, createdBy: frank.id });
    const placas = (await store.listFleet(andinos.id)).map((v) => `${v.placa}:${v.origen}`);
    expect(placas).toEqual(["AAA111:carga", "AAA112:carga", "AAA113:carga", "MAN111:manual", "P2B001:pasajeros"]);
    expect((await store.listContacts(andinos.id)).map((c) => c.nombre)).toEqual(["Rosa Díaz"]);
    expect((await store.getOpenOpportunity(andinos.id))?.id).toBe(opp.id);
    expect((await store.listActivities({ companyId: andinos.id })).map((a) => a.texto)).toEqual([expect.stringContaining("apareció en el padrón del MTC")]);
    // la que no está en el padrón: intacta
    expect(await store.getCompany(sol.id)).toMatchObject({ origen: "manual", razonSocial: "TRANSPORTES SOL SAC", departamento: "JUNIN", unidades: 3, ownerUserId: frank.id });
    expect((await store.listFleet(sol.id)).map((v) => v.placa)).toEqual(["MAN222"]);
    // otra vez: idempotente, ya no hay nada que fusionar ni se borra lo cargado a mano
    const again = await importMtc({ files, config: config(3), rules, store });
    expect(again.fusionadas).toEqual([]);
    expect((await store.listFleet(andinos.id)).map((v) => v.placa)).toContain("MAN111");
  });
});
