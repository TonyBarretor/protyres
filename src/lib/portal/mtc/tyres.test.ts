import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMtcBuffer } from "./parse";
import type { MtcVehicle } from "./parse";
import { applyTyres, applyTyresAll, buildTyreIndex } from "./tyres";

const FIX = path.join(__dirname, "__fixtures__");
const CUTS = ["20241231", "20231231", "20221231"];

describe("llantas by PLACA from older carga cuts", () => {
  const history = parseMtcBuffer(fs.readFileSync(path.join(FIX, "carga2224.csv"))).vehicles;
  const current = parseMtcBuffer(fs.readFileSync(path.join(FIX, "carga25.csv")), { cuts: ["20251231"] }).vehicles;
  const index = buildTyreIndex(history, CUTS);
  const fleet = new Map(applyTyresAll(current, index).map((v) => [v.placa, v]));

  it("prefers 20241231 over 20231231", () => {
    expect(fleet.get("AAA111")).toMatchObject({ llantas: 10, ejes: 3, llantasFuente: "20241231" });
  });
  it("skips ND in a newer cut and falls back to 20221231", () => {
    expect(fleet.get("AAA112")).toMatchObject({ llantas: 6, llantasFuente: "20221231" });
  });
  it("uses 20231231 when it is the only one", () => {
    expect(fleet.get("AAA113")).toMatchObject({ llantas: 10, llantasFuente: "20231231" });
    expect(fleet.get("BBB221")).toMatchObject({ llantas: 6, llantasFuente: "20231231" });
  });
  it("keeps own ejes when the historical row has none", () => {
    expect(fleet.get("BBB222")).toMatchObject({ llantas: 6, ejes: 2, llantasFuente: "20241231" });
  });
  it("ignores cuts not listed and leaves unknowns null", () => {
    expect(fleet.get("CCC332")).toMatchObject({ llantas: null, llantasFuente: null });
    expect(fleet.get("BBB223")).toMatchObject({ llantas: null, llantasFuente: null });
  });
  it("fills missing ejes from the historical row", () => {
    const v = { ...current.find((x) => x.placa === "AAA111")!, ejes: null };
    expect(applyTyres(v, index)).toMatchObject({ ejes: 3, llantas: 10 });
  });
  it("pasajeros keep their own llantas with the current cut as source", () => {
    const pas = parseMtcBuffer(fs.readFileSync(path.join(FIX, "pasajeros.csv")), { cuts: ["20251231"] }).vehicles;
    const out = applyTyresAll(pas, index);
    expect(out[0]).toMatchObject({ llantas: 8, llantasFuente: "20251231" });
  });
  it("index order does not depend on row order", () => {
    const rows: Pick<MtcVehicle, "placa" | "llantas" | "ejes" | "fechaCorte">[] = [
      { placa: "X1", llantas: 6, ejes: 2, fechaCorte: "20221231" },
      { placa: "X1", llantas: 10, ejes: 3, fechaCorte: "20241231" },
      { placa: "X1", llantas: 8, ejes: 3, fechaCorte: "20231231" },
    ];
    expect(buildTyreIndex(rows, CUTS).get("X1")).toEqual({ llantas: 10, ejes: 3, corte: "20241231" });
    expect(buildTyreIndex([...rows].reverse(), CUTS).get("X1")).toEqual({ llantas: 10, ejes: 3, corte: "20241231" });
  });
});
