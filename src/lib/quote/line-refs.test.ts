/**
 * Corrida J, punto 1: la placa por línea (referencias del cliente junto a la medida, como la UB de Prosegur).
 */
import { describe, expect, it } from "vitest";
import { lineRefs, lineRefsChat, lineRefsLabel, normalizePlate, parsePlateCommand } from "./line-refs";
import { describeLine, parseRequestRegex } from "./request";

describe("placa: normalización", () => {
  it("formato peruano de 6 caracteres, mayúsculas y guion", () => {
    expect(normalizePlate("abc123")).toBe("ABC-123");
    expect(normalizePlate("ABC 123")).toBe("ABC-123");
    expect(normalizePlate("a1b-234")).toBe("A1B-234");
    expect(normalizePlate(" bvv-704 ")).toBe("BVV-704");
    for (const bad of ["AB12", "ABCD123", "123ABC", "AB-1234", "", "placa", "1AB-234"]) expect(normalizePlate(bad)).toBeUndefined();
  });
});

describe("placa: comandos", () => {
  it("poner, cambiar y quitar por ítem; a secas con un solo ítem", () => {
    expect(parsePlateCommand("placa 2 ABC-123")).toEqual({ kind: "set", line: 2, plate: "ABC-123" });
    expect(parsePlateCommand("plc 2 abc123")).toEqual({ kind: "set", line: 2, plate: "ABC-123" });
    expect(parsePlateCommand("Placa: ABC 123")).toEqual({ kind: "set", line: null, plate: "ABC-123" });
    expect(parsePlateCommand("placa ABC123")).toEqual({ kind: "set", line: null, plate: "ABC-123" });
    expect(parsePlateCommand("sin placa 2")).toEqual({ kind: "clear", line: 2 });
    expect(parsePlateCommand("sin placa")).toEqual({ kind: "clear", line: null });
    expect(parsePlateCommand("placa 2 AB12")).toEqual({ kind: "invalid", line: 2, heard: "AB12" });
    expect(parsePlateCommand("placa")).toBeNull();
    expect(parsePlateCommand("precio 2 250")).toBeNull();
  });
});

describe("placa en el pedido escrito", () => {
  it("placa ABC-123, placa ABC123 y plc ABC-123 en la línea del ítem; sin placa la línea sale igual que hoy", () => {
    const r = parseRequestRegex("295/80R22.5 Valor 99 x4 placa ABC-123\n11R22.5 Flama 77 x2 placa ABC123\n315/80R22.5 x8 plc D4E-567\n12R22.5 x2");
    expect(r.lines.map((l) => [l.size?.canonical, l.quantity, l.plate, l.model])).toEqual([
      ["295/80R22.5", 4, "ABC-123", "VALOR 99"],
      ["11R22.5", 2, "ABC-123", "FLAMA 77"],
      ["315/80R22.5", 8, "D4E-567", undefined],
      ["12R22.5", 2, undefined, undefined],
    ]);
    expect(r.unparsed).toBeUndefined();
  });

  it("la misma placa en dos líneas (8 de tracción y 2 direccionales) no se fusiona; el mismo producto con placas distintas tampoco", () => {
    const r = parseRequestRegex("295/80R22.5 x8 traccion placa ABC-123\n295/80R22.5 x2 direccional placa ABC-123\n11R22.5 x4 placa ABC-123\n11R22.5 x4 placa XYZ-789");
    expect(r.lines.map((l) => [l.size?.canonical, l.quantity, l.plate])).toEqual([
      ["295/80R22.5", 8, "ABC-123"],
      ["295/80R22.5", 2, "ABC-123"],
      ["11R22.5", 4, "ABC-123"],
      ["11R22.5", 4, "XYZ-789"],
    ]);
  });

  it("placa mal escrita: no es cantidad ni modelo; queda para preguntar", () => {
    const [l] = parseRequestRegex("295/80R22.5 Valor 99 x4 placa AB12").lines;
    expect([l.quantity, l.model, l.plate, l.badPlate]).toEqual([4, "VALOR 99", undefined, "AB12"]);
    expect(describeLine(l)).toBe("295/80R22.5 VALOR 99 placa ¿AB12? x4");
  });

  it("el Entendí lista la placa de cada línea", () => {
    const [l] = parseRequestRegex("295/80R22.5 Valor 99 x4 placa abc123").lines;
    expect(describeLine(l)).toBe("295/80R22.5 VALOR 99 placa ABC-123 x4");
  });
});

describe("referencias de línea: placa y UB con el mismo mecanismo", () => {
  it("orden placa, UB; la UB propia solo si no es la de la cotización (chat) o la efectiva (PDF)", () => {
    expect(lineRefsChat(lineRefs({ plate: "ABC-123", ub: "1830" }, "1830"))).toBe("placa ABC-123");
    expect(lineRefsChat(lineRefs({ plate: "ABC-123", ub: "1845" }, "1830"))).toBe("placa ABC-123 UB 1845");
    expect(lineRefsLabel(lineRefs({ ub: undefined }, "1830", "effective"))).toBe("UB 1830");
    expect(lineRefsLabel(lineRefs({ plate: "ABC-123" }, undefined, "effective"))).toBe("PLACA ABC-123");
    expect(lineRefsLabel(lineRefs({}, undefined, "effective"))).toBe("");
  });
});
