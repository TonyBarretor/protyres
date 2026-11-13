import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPortalConfig } from "../config";
import { aggregateCompanies, classifySector } from "./aggregate";
import { parseMtcBuffer } from "./parse";
import { applyTyresAll, buildTyreIndex } from "./tyres";

const FIX = path.join(__dirname, "__fixtures__");
const read = (name: string, cuts?: string[]) => parseMtcBuffer(fs.readFileSync(path.join(FIX, name)), { cuts }).vehicles;

describe("aggregateCompanies", () => {
  const index = buildTyreIndex(read("carga2224.csv"), ["20241231", "20231231", "20221231"]);
  const fleet = applyTyresAll([...read("carga25.csv", ["20251231"]), ...read("pasajeros.csv", ["20251231"])], index);
  const all = aggregateCompanies(fleet);
  const byRuc = new Map(all.map((c) => [c.ruc, c]));

  it("aggregates a mixed company", () => {
    expect(byRuc.get("20111111111")).toEqual({
      ruc: "20111111111",
      razonSocial: "TRANSPORTES ANDINOS DEMO S.A.C.",
      sector: "mixto",
      departamento: "LIMA",
      unidades: 4,
      unidadesCarga: 3,
      unidadesPasajeros: 1,
      llantasEnPiso: 34,
      unidadesConLlantas: 4,
      antiguedadMedia: 8.5,
    });
  });
  it("carga company with an unknown llantas and modal department", () => {
    expect(byRuc.get("20222222222")).toMatchObject({ sector: "carga", departamento: "JUNIN", unidades: 3, llantasEnPiso: 12, unidadesConLlantas: 2, antiguedadMedia: 9 });
  });
  it("pasajeros company", () => {
    expect(byRuc.get("20333333333")).toMatchObject({ sector: "pasajeros", departamento: "HUANUCO", unidades: 3, llantasEnPiso: 18 });
  });
  it("sorted by units and filtered by minUnits", () => {
    expect(all[0].ruc).toBe("20111111111");
    expect(all).toHaveLength(5);
    expect(aggregateCompanies(fleet, { minUnits: 3 }).map((c) => c.ruc)).toEqual(["20111111111", "20222222222", "20333333333"]);
  });
});

describe("loadPortalConfig", () => {
  it("reads config/portal.json", () => {
    const cfg = loadPortalConfig({ file: path.join(__dirname, "..", "..", "..", "..", "config", "portal.json") });
    expect(cfg.import).toEqual({ minUnits: 10, currentCut: "20251231", tyreCuts: ["20241231", "20231231", "20221231"], dir: "data/mtc", sectorMajority: 0.9 });
  });
  it("fills defaults and keeps other keys", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "portal-")), "portal.json");
    fs.writeFileSync(file, JSON.stringify({ import: { minUnits: 5 }, otra: { x: 1 } }));
    const cfg = loadPortalConfig({ file });
    expect(cfg.import).toEqual({ minUnits: 5, currentCut: "20251231", tyreCuts: ["20241231", "20231231", "20221231"], dir: "data/mtc", sectorMajority: 0.9 });
    expect((cfg as Record<string, unknown>).otra).toEqual({ x: 1 });
    expect(loadPortalConfig({ file: file + ".missing" }).import.minUnits).toBe(10);
  });
  it("sectorMajority must be above 0.5 and at most 1", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-"));
    for (const bad of [0.5, 0.3, 1.2]) {
      const file = path.join(dir, `bad-${bad}.json`);
      fs.writeFileSync(file, JSON.stringify({ import: { sectorMajority: bad } }));
      expect(() => loadPortalConfig({ file })).toThrow(/inválido/);
    }
    const ok = path.join(dir, "ok.json");
    fs.writeFileSync(ok, JSON.stringify({ import: { sectorMajority: 0.8 } }));
    expect(loadPortalConfig({ file: ok }).import.sectorMajority).toBe(0.8);
  });
});

/** Flota sintética: `carga` vehículos de carga y `pasajeros` de pasajeros para un RUC inventado. */
function synthetic(ruc: string, carga: number, pasajeros: number) {
  const base = { ruc, razonSocial: "EMPRESA DE PRUEBA S.A.C.", departamento: "LIMA", llantas: null, anio: null, fechaCorte: "20251231" };
  return [
    ...Array.from({ length: carga }, () => ({ ...base, origen: "carga" as const })),
    ...Array.from({ length: pasajeros }, () => ({ ...base, origen: "pasajeros" as const })),
  ];
}

describe("sector por mayoría", () => {
  const sectorOf = (carga: number, pasajeros: number, opts: { sectorMajority?: number } = {}) => aggregateCompanies(synthetic("20999999991", carga, pasajeros), opts)[0].sector;

  it("82 ómnibus + 3 de carga (caso ZBUSS) → pasajeros", () => {
    expect(sectorOf(3, 82)).toBe("pasajeros");
  });
  it("mayoría de carga → carga", () => {
    expect(sectorOf(95, 5)).toBe("carga");
  });
  it("50/50 → mixto", () => {
    expect(sectorOf(50, 50)).toBe("mixto");
  });
  it("borde exacto del 90 % → ese sector; justo debajo → mixto", () => {
    expect(sectorOf(1, 9)).toBe("pasajeros");
    expect(sectorOf(10, 90)).toBe("pasajeros");
    expect(sectorOf(90, 10)).toBe("carga");
    expect(sectorOf(11, 89)).toBe("mixto");
  });
  it("un solo origen → ese sector", () => {
    expect(sectorOf(0, 12)).toBe("pasajeros");
    expect(sectorOf(12, 0)).toBe("carga");
  });
  it("umbral configurado distinto", () => {
    expect(sectorOf(20, 80, { sectorMajority: 0.8 })).toBe("pasajeros");
    expect(sectorOf(21, 79, { sectorMajority: 0.8 })).toBe("mixto");
    expect(sectorOf(3, 82, { sectorMajority: 0.99 })).toBe("mixto");
    expect(sectorOf(0, 82, { sectorMajority: 1 })).toBe("pasajeros");
    expect(sectorOf(1, 82, { sectorMajority: 1 })).toBe("mixto");
  });
  it("classifySector: sin unidades → null", () => {
    expect(classifySector(0, 0)).toBeNull();
    expect(classifySector(3, 82)).toBe("pasajeros");
    expect(classifySector(3, 82, 0.99)).toBe("mixto");
  });
});
