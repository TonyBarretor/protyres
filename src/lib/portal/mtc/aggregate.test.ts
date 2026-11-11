import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPortalConfig } from "../config";
import { aggregateCompanies } from "./aggregate";
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
    expect(cfg.import).toEqual({ minUnits: 10, currentCut: "20251231", tyreCuts: ["20241231", "20231231", "20221231"], dir: "data/mtc" });
  });
  it("fills defaults and keeps other keys", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "portal-")), "portal.json");
    fs.writeFileSync(file, JSON.stringify({ import: { minUnits: 5 }, otra: { x: 1 } }));
    const cfg = loadPortalConfig({ file });
    expect(cfg.import).toEqual({ minUnits: 5, currentCut: "20251231", tyreCuts: ["20241231", "20231231", "20221231"], dir: "data/mtc" });
    expect((cfg as Record<string, unknown>).otra).toEqual({ x: 1 });
    expect(loadPortalConfig({ file: file + ".missing" }).import.minUnits).toBe(10);
  });
});
