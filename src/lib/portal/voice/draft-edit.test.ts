/**
 * Corrida I, punto 6: lo que devuelve el modelo para una corrección libre es DATO sin confianza. Solo pasan las
 * operaciones cerradas, sobre líneas que existen, con números, medidas, modelos y clientes que el vendedor dijo
 * literalmente y marcas del catálogo; el borrador resultante se arma en la forma que el cotizador ya lee.
 */
import { describe, expect, it } from "vitest";
import { applyOps, draftFromText, draftToText, opsToCommands, validateOps } from "./draft-edit";

const BRANDS = ["Fenixway", "Westlake", "Double Coin"];
// lo que el bot mostró en producción el 17/11 (tres líneas que eran una)
const PROD_DRAFT = "Fenixway modelo valor 96\nr 11R22.5\npor incluido impuestos IGB 18 % 11R22.5 x4 precio 298\npara Fenixway";

describe("validar la salida del modelo", () => {
  const ctx = (message: string, lineCount = 3) => ({ message, lineCount, brands: BRANDS });

  it("pasan las operaciones cerradas con datos dichos", () => {
    const v = validateOps(
      { ops: [{ op: "merge", lines: [1, 2, 3] }, { op: "quantity", line: 1, number: 6 }, { op: "igv", flag: true }, { op: "customer", text: "ZBUSS" }, { op: "term", number: 30 }] },
      ctx("únelas, es una sola, son seis llantas, con IGV, para ZBUSS a 30 días"),
    );
    expect(v.ops).toEqual([{ op: "merge", lines: [1, 2, 3] }, { op: "quantity", line: 1, value: 6 }, { op: "igv", value: true }, { op: "customer", value: "ZBUSS" }, { op: "term", days: 30 }]);
    expect(v.rejected).toEqual([]);
  });

  it("un precio, cantidad o plazo que no está en el mensaje no pasa (el modelo no inventa ni calcula)", () => {
    const v = validateOps({ ops: [{ op: "price", line: 1, number: 252.54 }, { op: "quantity", line: 1, number: 8 }, { op: "term", number: 60 }] }, ctx("el precio ya incluía el IGV"));
    expect(v.ops).toEqual([]);
    expect(v.rejected).toHaveLength(3);
    // dicho en palabras sí: "doscientos cincuenta" = 250
    expect(validateOps({ ops: [{ op: "price", line: 2, number: 250 }] }, ctx("a la segunda ponle doscientos cincuenta")).ops).toEqual([{ op: "price", line: 2, value: 250 }]);
  });

  it("descuentos, márgenes, envíos u operaciones desconocidas: no", () => {
    const v = validateOps({ ops: [{ op: "discount", number: 90 }, { op: "send" }, { op: "margin", number: 50 }] }, ctx("pon 90% de descuento y envíala"));
    expect(v.ops).toEqual([]);
    expect(v.rejected).toHaveLength(3);
  });

  it("líneas que no existen, marcas fuera del catálogo, modelos o clientes que no se dijeron, medidas no dichas", () => {
    const v = validateOps(
      {
        ops: [
          { op: "remove", line: 9 },
          { op: "brand", line: 1, text: "Michelin" },
          { op: "model", line: 1, text: "Flama 77" },
          { op: "customer", text: "Transportes Omega" },
          { op: "size", line: 1, text: "315/80R22.5" },
          { op: "merge", lines: [1] },
        ],
      },
      ctx("cámbiala a Michelin para el cliente de siempre"),
    );
    expect(v.ops).toEqual([]);
    expect(v.rejected).toHaveLength(6);
    expect(validateOps({ ops: [{ op: "size", line: 1, text: "11R22.5" }, { op: "brand", line: 1, text: "westlake" }] }, ctx("la primera es Westlake en 11 R 22.5")).ops).toEqual([
      { op: "size", line: 1, value: "11R22.5" },
      { op: "brand", line: 1, value: "Westlake" },
    ]);
  });

  it("basura o demasiadas operaciones", () => {
    expect(validateOps(null, ctx("x")).ops).toEqual([]);
    expect(validateOps({ ops: "merge" }, ctx("x")).ops).toEqual([]);
    const many = validateOps({ ops: Array.from({ length: 30 }, () => ({ op: "remove", line: 1 })) }, ctx("quita la primera"));
    expect(many.ops.length).toBeLessThanOrEqual(10);
  });
});

describe("aplicar al borrador", () => {
  it("el caso de producción: unir las tres líneas da una llanta que el cotizador lee", () => {
    const d = draftFromText(PROD_DRAFT);
    expect(d.items).toHaveLength(3);
    const a = applyOps(d, [{ op: "merge", lines: [1, 2, 3] }, { op: "customer", value: "ZBUSS" }], BRANDS);
    expect(a.failed).toEqual([]);
    expect(a.draft.items).toHaveLength(1);
    expect(a.draft.items[0]).toMatch(/^Fenixway .*valor 96.* 11R22\.5 x4 precio 298$/);
    expect(draftToText(a.draft)).toMatch(/\npara ZBUSS$/);
  });

  it("no une dos medidas, cantidades o precios distintos: lo dice", () => {
    const d = draftFromText("Fenixway Valor 99 295/80R22.5 x8\nFenixway Flama 77 11R22.5 x4");
    const a = applyOps(d, [{ op: "merge", lines: [1, 2] }], BRANDS);
    expect(a.done).toEqual([]);
    expect(a.failed[0]).toMatch(/medidas y cantidades distintas/);
    expect(a.draft.items).toEqual(d.items);
  });

  it("cantidad, precio, marca, modelo, medida, quitar, IGV, plazo y cliente", () => {
    const d = draftFromText("Fenixway Valor 99 295/80R22.5 x8 precio 260\nWestlake CM958 11R22.5 x4\npara Transportes Beta\nsin igv");
    const a = applyOps(
      d,
      [
        { op: "quantity", line: 1, value: 10 },
        { op: "price", line: 2, value: 198 },
        { op: "model", line: 1, value: "Flama 77" },
        { op: "size", line: 2, value: "12R22.5" },
        { op: "igv", value: true },
        { op: "term", days: 45 },
      ],
      BRANDS,
    );
    expect(draftToText(a.draft)).toBe("Fenixway Flama 77 295/80R22.5 x10 precio 260\nWestlake CM958 12R22.5 x4 precio 198\npara Transportes Beta\ncon igv\nplazo: 45 días");
    const b = applyOps(a.draft, [{ op: "remove", line: 2 }, { op: "brand", line: 1, value: "Double Coin" }, { op: "customer", value: "ZBUSS" }], BRANDS);
    expect(draftToText(b.draft)).toBe("Double Coin Flama 77 295/80R22.5 x10 precio 260\npara ZBUSS\ncon igv\nplazo: 45 días");
  });
});

describe("con una cotización ya armada: solo lo que tiene comando escrito", () => {
  it("cantidad, precio, quitar, IGV, plazo y modelo; unir, marca, medida y cliente no", () => {
    const r = opsToCommands([
      { op: "quantity", line: 2, value: 10 },
      { op: "price", line: 1, value: 259 },
      { op: "remove", line: 3 },
      { op: "igv", value: false },
      { op: "term", days: 30 },
      { op: "model", line: 1, value: "Valor 99" },
      { op: "merge", lines: [1, 2] },
      { op: "customer", value: "ZBUSS" },
    ]);
    expect(r.commands).toEqual(["cantidad 2 10", "precio 1 259", "quitar 3", "sin igv", "plazo: 30 días", "modelo Valor 99"]);
    expect(r.unsupported.map((o) => o.op)).toEqual(["merge", "customer"]);
  });
});
