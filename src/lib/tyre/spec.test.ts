import { describe, expect, it } from "vitest";
import { findTyreSizes, parseTyreSize, sameSize, sizeCore } from "./spec";
import { findBrandInText, knownBrand, normalizeBrand } from "./brands";

describe("parseTyreSize – metric", () => {
  it.each([
    ["295/80R22.5", "295/80R22.5"],
    ["295/80 R 22.5", "295/80R22.5"],
    ["295/80R22,5", "295/80R22.5"],
    ["295/80 r22.5", "295/80R22.5"],
    ["295/80-22.5", "295/80-22.5"],
    ["295/80 22.5", "295/80R22.5"],
    ["385/65R22.5 160K", "385/65R22.5"],
    ["215/75R17.5", "215/75R17.5"],
    ["205/55R16 91V", "205/55R16"],
    ["205/55ZR16", "205/55R16"],
    ["LT265/70R17", "LT265/70R17"],
    ["P215/60R16", "P215/60R16"],
    ["205/65R16C", "205/65R16C"],
    ["Llanta 295/80R22.5 152/148M Michelin", "295/80R22.5"],
  ])("%s -> %s", (input, canonical) => {
    expect(parseTyreSize(input)?.canonical).toBe(canonical);
  });

  it("extracts load and speed index", () => {
    const s = parseTyreSize("295/80R22.5 152/148M")!;
    expect(s.loadIndex).toBe("152/148");
    expect(s.speedIndex).toBe("M");
    const c = parseTyreSize("205/55R16 91V")!;
    expect(c.loadIndex).toBe("91");
    expect(c.speedIndex).toBe("V");
  });
});

describe("parseTyreSize – numeric (truck)", () => {
  it.each([
    ["11R22.5", "11R22.5", "11R22.5"],
    ["11 R 22.5", "11R22.5", "11R22.5"],
    ["11r22,5", "11R22.5", "11R22.5"],
    ["11-22.5", "11-22.5", "11-22.5"],
    ["11X22.5", "11-22.5", "11-22.5"],
    ["12R22.5", "12R22.5", "12R22.5"],
    ["10.00R20", "10R20", "10.00R20"],
    ["1000R20", "10R20", "10.00R20"],
    ["1000-20", "10-20", "10.00-20"],
    ["12.00R24", "12R24", "12.00R24"],
    ["7.50R16", "7.5R16", "7.50R16"],
    ["750R16", "7.5R16", "7.50R16"],
    ["8.25R20", "8.25R20", "8.25R20"],
    ["9.5R17.5", "9.5R17.5", "9.5R17.5"],
    ["11 22.5", "11R22.5", "11R22.5"],
  ])("%s -> %s (display %s)", (input, canonical, display) => {
    const s = parseTyreSize(input);
    expect(s?.canonical).toBe(canonical);
    expect(s?.display).toBe(display);
  });
});

describe("parseTyreSize – flotation", () => {
  it.each([
    ["31x10.50R15", "31X10.5R15"],
    ["33X12.50R20", "33X12.5R20"],
    ["31×10.5 R15", "31X10.5R15"],
  ])("%s -> %s", (input, canonical) => {
    expect(parseTyreSize(input)?.canonical).toBe(canonical);
  });
});

describe("parseTyreSize – rejects noise", () => {
  it.each(["", "Michelin", "precio 410", "20/10/2026", "S/ 1,250.00", "RUC 20123456789", "cantidad 4"])(
    "%s -> null",
    (input) => {
      expect(parseTyreSize(input)).toBeNull();
    },
  );
});

describe("findTyreSizes", () => {
  it("finds several sizes in a WhatsApp-style message, in order", () => {
    const msg =
      "Buen día, precios de hoy: Michelin X Multi Z 295/80R22.5 a $410, Bridgestone R268 11R22.5 $385 c/u y 1000R20 Westlake a 290";
    const sizes = findTyreSizes(msg).map((s) => s.canonical);
    expect(sizes).toEqual(["295/80R22.5", "11R22.5", "10R20"]);
  });

  it("does not double-count a metric size as numeric", () => {
    expect(findTyreSizes("295/80R22.5").length).toBe(1);
  });
});

describe("sameSize / sizeCore", () => {
  it("compares across notations", () => {
    expect(sameSize("11 R 22,5", "11R22.5")).toBe(true);
    expect(sameSize("1000R20", "10.00R20")).toBe(true);
    expect(sameSize("11R22.5", "12R22.5")).toBe(false);
  });
  it("strips LT/C for relaxed comparison", () => {
    expect(sizeCore("LT265/70R17")).toBe("265/70R17");
    expect(sizeCore("205/65R16C")).toBe("205/65R16");
  });
});

describe("brands", () => {
  it("normalizes known brands and aliases", () => {
    expect(normalizeBrand("MICHELIN")).toBe("Michelin");
    expect(normalizeBrand(" michellin ")).toBe("Michelin");
    expect(normalizeBrand("GT RADIAL")).toBe("Giti");
    expect(normalizeBrand("bf goodrich")).toBe("BFGoodrich");
    expect(normalizeBrand("double coin")).toBe("Double Coin");
  });
  it("title-cases unknown brands", () => {
    expect(normalizeBrand("LLANTAS DEL SUR")).toBe("Llantas Del Sur");
    expect(knownBrand("LLANTAS DEL SUR")).toBeNull();
  });
  it("finds a brand inside free text", () => {
    expect(findBrandInText("tengo bridgestone r268 11r22.5 a 385")?.brand).toBe("Bridgestone");
    expect(findBrandInText("precio de hoy 11r22.5 a 385")).toBeNull();
  });
});
