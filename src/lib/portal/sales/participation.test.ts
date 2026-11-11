import { describe, expect, it } from "vitest";
import { computeParticipation, formatParticipation, participationFor, participationTotals, participationWindow } from "./participation";

const now = new Date("2026-11-11T15:00:00Z");
const sales = [
  { ruc: "20100148162", fecha: "2026-11-11", cantidad: 4, isDemo: false },
  { ruc: "20100148162", fecha: "2025-11-11", cantidad: 6, isDemo: false }, // first day of the window
  { ruc: "20100148162", fecha: "2025-11-10", cantidad: 100, isDemo: false }, // outside
  { ruc: "20100148162", fecha: "2026-11-12", cantidad: 100, isDemo: false }, // future
  { ruc: "20555901179", fecha: "2026-05-01", cantidad: 12, isDemo: true },
  { ruc: "20555901179", fecha: "2026-06-01", cantidad: 8, isDemo: false },
];

describe("participation", () => {
  it("window = last 12 months, inclusive", () => {
    expect(participationWindow(now)).toEqual({ since: "2025-11-11", until: "2026-11-11" });
  });
  it("sums tyres per RUC inside the window and flags demo", () => {
    expect(computeParticipation(sales, { now })).toEqual({
      "20100148162": { cantidad: 10, demo: false },
      "20555901179": { cantidad: 20, demo: true },
    });
  });
  it("can exclude demo rows and change the window", () => {
    expect(computeParticipation(sales, { now, includeDemo: false })["20555901179"]).toEqual({ cantidad: 8, demo: false });
    expect(computeParticipation(sales, { now, since: "2025-01-01" })["20100148162"].cantidad).toBe(110);
  });
  it("helpers", () => {
    expect(participationFor("20999999999", sales, { now })).toEqual({ cantidad: 0, demo: false });
    expect(participationTotals(computeParticipation(sales, { now }))).toEqual({ cantidad: 30, empresas: 2, demo: true });
    expect(formatParticipation({ cantidad: 20, demo: true })).toBe("20 neumáticos (DEMO)");
    expect(formatParticipation({ cantidad: 1, demo: false })).toBe("1 neumático");
  });
});
