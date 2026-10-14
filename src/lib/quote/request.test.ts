import { beforeAll, describe, expect, it } from "vitest";
import { describeRequest, parseDiscount, parseQuantity, parseRequestRegex, parseTaxMode } from "./request";

beforeAll(() => {
  process.env.LLM_DISABLED = "1";
});

describe("salesman one-liners", () => {
  it("full request with discount and tax mode", () => {
    const r = parseRequestRegex("Fenixway 295/80R22.5 Valor 87 x4 para Transportes ABC, juan@abc.com, dscto 10% sin igv");
    expect(r.lines.length).toBe(1);
    const l = r.lines[0];
    expect(l.brand).toBe("Fenixway");
    expect(l.size?.canonical).toBe("295/80R22.5");
    expect(l.model).toBe("VALOR 87");
    expect(l.quantity).toBe(4);
    expect(r.customerCompany).toBe("Transportes ABC");
    expect(r.customerEmail).toBe("juan@abc.com");
    expect(r.discountPct).toBe(10);
    expect(r.showPricesWithTax).toBe(false);
    expect(describeRequest(r)).toBe("Fenixway 295/80R22.5 VALOR 87 x4 · Transportes ABC · juan@abc.com · dscto 10% · sin IGV");
  });
  it("position words and leading quantity", () => {
    const r = parseRequestRegex("02 llantas delanteras 7.50-16 16PR para Jose Luis Muñoz");
    expect(r.lines[0].size?.canonical).toBe("7.5-16");
    expect(r.lines[0].quantity).toBe(2);
    expect(r.lines[0].position).toBe("DEL");
    expect(r.lines[0].ply).toBe(16);
    expect(r.customerName).toBe("Jose Luis Muñoz");
  });
  it("one size, two positions with their own quantities -> two lines (never summed)", () => {
    const cases = [
      "FENIXWAY 295/80R22.5 VALOR 18PR MIXTA X2 Y TRACCIÓN X8, ATN: SRTA. KARINA QUISPE, CON IGV",
      "Fenixway 295/80R22.5 Valor 18PR x2 mixtas y x8 de tracción para Transportes ABC, juan@abc.com",
      "FENIXWAY 295/80R22.5 VALOR 18PR MIXTA X2\nFENIXWAY 295/80R22.5 VALOR 18PR TRACCIÓN X8",
    ];
    for (const text of cases) {
      const r = parseRequestRegex(text);
      expect(r.lines.map((l) => [l.position, l.quantity, l.model])).toEqual([
        ["MIX", 2, "VALOR"],
        ["TRAC", 8, "VALOR"],
      ]);
      expect(r.lines.every((l) => l.brand === "Fenixway" && l.ply === 18 && l.size?.canonical === "295/80R22.5")).toBe(true);
    }
    expect(parseRequestRegex("295/80R22.5 2 mixtas, 8 de tracción").lines.map((l) => [l.position, l.quantity])).toEqual([
      ["MIX", 2],
      ["TRAC", 8],
    ]);
    expect(parseRequestRegex("FENIXWAY 295/80R22.5 VALOR 18PR X10").lines.map((l) => l.quantity)).toEqual([10]);
    expect(parseRequestRegex("295/80R22.5 x4 delanteras, dscto 5%").lines.map((l) => [l.position, l.quantity])).toEqual([["DEL", 4]]);
  });
  it("helpers", () => {
    expect(parseQuantity("11R22.5 x6")).toBe(6);
    expect(parseQuantity("6 unidades 11R22.5")).toBe(6);
    expect(parseQuantity("02 llantas")).toBe(2);
    expect(parseQuantity("215/75 x R17.5 PIKIN 1 Posterior")).toBe(1); // "1 posterior": a quantity before a position word
    expect(parseDiscount("dscto 15%")).toBe(15);
    expect(parseDiscount("con 12.5 % de descuento")).toBe(12.5);
    expect(parseDiscount("11R22.5 x2")).toBeUndefined();
    expect(parseTaxMode("precios con igv")).toBe(true);
    expect(parseTaxMode("mas igv")).toBe(false);
    expect(parseTaxMode("11R22.5")).toBeUndefined();
  });
});

describe("customer emails (tables pasted as text)", () => {
  it("sugar-mill RFQ with tyres, patches and quantities", () => {
    const text = `Estimado proveedor, buen día.
La presente es para invitarle a presentar su mejor propuesta económica por los siguientes materiales, puestos en nuestro almacén de Casa Grande.
Fecha máxima de presentación: 06/10
Hora: 12:00
Material Descripción UM Cantidad
5657944 LLANTA 12.5/80 X 18 - 12 PLY R4 UND 2
5102162 LLANTA 19.5L X 24-10 PLY -POST (1T5 UND 2
5583916 PARCHE PARA LLANTA RS-35 VIPAL UND 25
5583917 PARCHE PARA LLANTA VFP-6 VIPAL UND 50
5554521 LLANTA TRACCION 12R22.5 MOD G377 UND 19
5600686 LLANTA 16.9R30 GOOD YEAR SUPER TRACTION UND 2`;
    const r = parseRequestRegex(text);
    const lines = r.lines.map((l) => [l.size?.canonical ?? l.text, l.quantity, l.brand ?? "", l.model ?? "", l.position ?? "", l.ply ?? ""]);
    expect(lines).toEqual([
      ["12.5/80-18", 2, "", "R4", "", 12],
      ["19.5L-24", 2, "", "1T5", "TRAC", 10],
      ["PARCHE PARA LLANTA RS-35 VIPAL", 25, "Vipal", "", "", ""],
      ["PARCHE PARA LLANTA VFP-6 VIPAL", 50, "Vipal", "", "", ""],
      ["12R22.5", 19, "", "G377", "TRAC", ""],
      ["16.9R30", 2, "Goodyear", "SUPER TRACTION", "TRAC", ""],
    ]);
  });

  it("fleet RFQ with one row per tyre is merged", () => {
    const text = `Buen día:
Por favor para cotizar lo siguiente:
Placa unidad Medida de Llanta Planta Zonal Cant Ubicación de Llantas Marcado
BYV-762 215/75 x R17.5 PIKIN 1 Posterior 10 01 26
BYV-762 215/75 x R17.5 PIKIN 1 Posterior 10 02 26
BYV-762 215/75 x R17.5 PIKIN 1 Posterior 10 03 26
BYV-762 215/75 x R17.5 PIKIN 1 Posterior 10 04 26
MONT-13 300 x R15 ICA 1 Delantera 10 05 26
MONT-13 300 x R15 ICA 1 Delantera 10 06 26`;
    const r = parseRequestRegex(text);
    expect(r.lines.map((l) => [l.size?.canonical, l.quantity, l.position])).toEqual([
      ["215/75R17.5", 4, "TRAC"],
      ["300-15", 2, "DEL"],
    ]);
  });

  it("forwarded WhatsApp with a screenshot caption", () => {
    const r = parseRequestRegex("Frank buenas tardes me cotizas llantas 02 llantas delanteras y dos aros\n7.50-16-16 pr track king set\n11x22.5 16 TL AG888");
    expect(r.lines.map((l) => [l.size?.canonical ?? l.text, l.quantity])).toEqual([
      ["aros", 2],
      ["7.5-16", 1],
      ["11-22.5", 1],
    ]);
    expect(r.lines[1].brand).toBe("Track King");
    expect(r.lines[1].ply).toBe(16);
  });
});
