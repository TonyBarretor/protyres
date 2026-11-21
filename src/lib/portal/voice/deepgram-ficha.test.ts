/**
 * Corrida I: una llanta dictada en forma de ficha. Caso real de producción (17/11): el bot respondió con tres llantas
 * ("1. Fenixway modelo valor 96 / 2. r 11R22.5 / 3. por incluido impuestos IGB 18 % 11R22.5 x4 precio 298") y era una.
 * Una coma o un punto no separan llantas; las palabras de ficha se descartan o se mapean; el IGV dicho de cualquier forma
 * es la opción del cotizador; las lonas pegadas al aro van aparte y contra el catálogo; una marca dicha como "cliente" es
 * la marca (y se pregunta el cliente). Más 30 variantes reales de Deepgram (fixtures/deepgram-ficha.json).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseRequestRegex } from "../../quote/request";
import { fichaWords, joinDesignCodes, normalizeDictation } from "./dictation";
import { TEST_CATALOG } from "./fixtures/test-catalog";
import { groupItems, splitPly } from "./items";

const PROD = "Cotizar cliente Fenixway, modelo valor 96, 11 r, 22.518 p r, por 4 unidades. Precio, 298 dólares, incluido impuestos, IGB 18 por 100.";

describe("ficha dictada: el caso de producción (17/11)", () => {
  it("es UNA llanta: 4 × Fenixway Valor 96 11R22.5 18PR a 298, con IGV, y pregunta solo el cliente", () => {
    const d = normalizeDictation(PROD, TEST_CATALOG);
    expect(d.items).toEqual(["Fenixway valor 96 11R22.5 18PR x4 precio 298"]);
    expect(d.text).toBe("Fenixway valor 96 11R22.5 18PR x4 precio 298\ncon igv");
    expect(d.doubts).toEqual([]);
    expect(d.single).toBeUndefined();
    expect(d.customer).toBe("");
    expect(d.brandAsCustomer).toBe("Fenixway");
    expect(d.currency).toBe("USD");
    expect(d.plyIssues).toEqual([]);
  });

  it("el cotizador escrito lee esa línea como la llanta dictada", () => {
    const r = parseRequestRegex(normalizeDictation(PROD, TEST_CATALOG).text);
    expect(r.lines).toHaveLength(1);
    const l = r.lines[0];
    expect([l.size?.canonical, l.brand, l.model, l.quantity, l.ply, l.unitPrice]).toEqual(["11R22.5", "Fenixway", "VALOR 96", 4, 18, 298]);
    expect(r.showPricesWithTax).toBe(true);
  });
});

describe("palabras de ficha", () => {
  it("cantidad, precio, moneda y etiquetas", () => {
    expect(fichaWords("por 4 unidades").text.trim()).toBe("x4");
    expect(fichaWords("cantidad 12").text.trim()).toBe("x12");
    expect(fichaWords("cantidad: 6 llantas").text.trim()).toBe("x6");
    expect(fichaWords("Precio, 298 dólares").text.trim()).toBe("precio 298 dólares");
    expect(fichaWords("el precio es 265").text.trim()).toBe("precio 265");
    expect(fichaWords("valor 96, 298 dólares").text.trim()).toBe("valor 96, precio 298");
    expect(fichaWords("modelo valor 96").text.replace(/^[\s,]+/, "")).toBe("valor 96");
    expect(fichaWords("precio 255 soles").currency).toBe("PEN");
    expect(fichaWords("precio 255 dólares").currency).toBe("USD");
    expect(fichaWords("precio 255").currency).toBeNull();
    // un plazo no es una cantidad
    expect(fichaWords("por 30 días").text).toBe("por 30 días");
  });

  it("IGV: incluido, con, más, sin, mal oído y con el 18 %", () => {
    const tax = (s: string) => normalizeDictation(`cotiza 4 valor 99 en 295 80 22.5 a 260, ${s}`, TEST_CATALOG);
    for (const s of ["incluido impuestos", "incluido IGV", "con IGV", "IGV incluido", "impuestos incluidos", "incluido IGB 18 por 100", "incluye el IGV", "con IPV"]) expect(tax(s).text, s).toMatch(/\ncon igv$/);
    for (const s of ["más IGV", "sin IGV", "sin impuestos", "más impuestos", "IGV aparte", "más IGB 18 %"]) expect(tax(s).text, s).toMatch(/\nsin igv$/);
    // el IGV dicho sin decir si va incluido: no entra en la llanta y se avisa
    const bare = tax("IGV 18 por ciento");
    expect(bare.items).toEqual(["Fenixway valor 99 295/80R22.5 x4 precio 260"]);
    expect(bare.text).not.toMatch(/igv/i);
    expect(bare.taxMention).toBe("IGV 18 %");
  });

  it("lonas: 18 PR, 18 p r, dieciocho lonas y pegadas al aro", () => {
    expect(splitPly("11 r, 22.518 p r")).toBe("11 r, 22.5 18PR");
    expect(splitPly("22.516 lonas")).toBe("22.5 16PR");
    expect(splitPly("18 PR, 16 p.r., 16 ply")).toBe("18PR, 16PR, 16PR");
    // no son lonas: "18 por ciento", "18 precio"
    expect(splitPly("18 por ciento, 18 precio")).toBe("18 por ciento, 18 precio");
    const d = normalizeDictation("cotiza Valor 96, 11 R 22.5, dieciocho lonas, por 4 unidades", TEST_CATALOG);
    expect(d.items).toEqual(["Fenixway Valor 96 11R22.5 18PR x4"]);
  });

  it("lonas que no existen para esa medida en el catálogo: no van en la línea y se dice cuáles hay", () => {
    const d = normalizeDictation("cotiza Valor 96, 11 R 22.5, 22 PR, por 4 unidades", TEST_CATALOG);
    expect(d.items).toEqual(["Fenixway Valor 96 11R22.5 x4"]);
    expect(d.plyIssues).toEqual([{ item: 0, ply: 22, size: "11R22.5", available: [16, 18] }]);
  });

  it("una marca del catálogo dicha como cliente es la marca; un cliente de verdad sigue siendo el cliente", () => {
    const brand = normalizeDictation("cotizar cliente Westlake, modelo CM958, 11 R 22.5, por 2 unidades", TEST_CATALOG);
    expect(brand.items).toEqual(["Westlake CM958 11R22.5 x2"]);
    expect(brand.brandAsCustomer).toBe("Westlake");
    expect(brand.customer).toBe("");
    const real = normalizeDictation("cotizar cliente Transportes Beta, modelo Valor 99, 295 80 R 22.5, por 2 unidades", TEST_CATALOG);
    expect(real.customer).toBe("Transportes Beta");
    expect(real.brandAsCustomer).toBeUndefined();
  });

  it("«cotizar para ZBUSS, …»: el cliente no queda pegado a la llanta", () => {
    const d = normalizeDictation("Cotizar para ZBUSS, modelo valor 96, 11 r 22.5, por 4 unidades, precio 298 dólares, con IGV.", TEST_CATALOG);
    expect(d.text).toBe("Fenixway valor 96 11R22.5 x4 precio 298\npara ZBUSS\ncon igv");
  });

  it("un código de diseño con las cifras dictadas una a una («TRD 0 2») es el del catálogo", () => {
    expect(joinDesignCodes("modelo TRD 0 2, medida", [{ model: "TRD02" }])).toBe("modelo TRD02, medida");
    expect(joinDesignCodes("Westlake CM 958", [{ model: "CM958" }])).toBe("Westlake CM 958");
  });
});

describe("una o varias llantas", () => {
  it("una coma o un punto no separan: otra llanta solo con otra cantidad con su producto, otra medida o una palabra de enlace", () => {
    expect(groupItems("Fenixway, valor 96, §0§ 18PR, x4. precio 298").groups).toEqual(["Fenixway valor 96 §0§ 18PR x4 precio 298"]);
    // otra cantidad con su producto
    expect(groupItems("8 valor 99 en §0§, 4 Flama 77 en §1§").groups).toEqual(["8 valor 99 en §0§", "4 Flama 77 en §1§"]);
    // otra medida distinta
    expect(groupItems("valor 99 §0§ x8, §1§ x4", undefined, { sizeOf: (k) => ["295/80R22.5", "11R22.5"][k] }).groups).toEqual(["valor 99 §0§ x8", "§1§ x4"]);
    // palabra de enlace
    expect(groupItems("valor 99 §0§ x8 y Flama 77 x4").groups).toEqual(["valor 99 §0§ x8", "Flama 77 x4"]);
    expect(groupItems("valor 99 §0§ x8 además Flama 77 x4").groups).toEqual(["valor 99 §0§ x8", "Flama 77 x4"]);
  });

  it("ante la duda, UNA llanta y por qué (dos cantidades, dos productos)", () => {
    const two = normalizeDictation("Cotizar para Transportes Gamma, Fenixway Valor 96, 11 r 22.5, por 4 unidades, precio 298, por 6 unidades.", TEST_CATALOG);
    expect(two.items).toEqual(["Fenixway Valor 96 11R22.5 x4 precio 298"]);
    expect(two.single?.why).toEqual(["dos cantidades («x6»)"]);
    const prod = normalizeDictation("Cotizar cliente ZBUSS, modelo Valor 99, Flama 77, 295 80 R 22.5, por 8 unidades.", TEST_CATALOG);
    expect(prod.items).toHaveLength(1);
    expect(prod.single?.why).toEqual(["dos productos («Flama 77»)"]);
    // la alternativa del botón "Son varias": separar por cada coma
    expect(prod.single?.alt.split("\n").filter((l) => !/^para /.test(l)).length).toBeGreaterThan(1);
  });
});

interface Caso {
  id: string;
  voice: string;
  heard: string;
  nota?: string;
  esperado: { texto: string; pregunta?: string[]; unaSola?: string[]; marcaComoCliente?: string; moneda?: string; igvSinDecir?: string; lonas?: unknown[] };
}
const { casos } = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "deepgram-ficha.json"), "utf8")) as { casos: Caso[] };

describe("transcripciones reales de Deepgram de una llanta en forma de ficha", () => {
  it("el caso de producción y 30 variantes, de varias voces", () => {
    expect(casos.filter((c) => /^f\d+$/.test(c.id))).toHaveLength(30);
    expect(new Set(casos.map((c) => c.voice.replace(/ \(Spanish \((?:Mexico|Spain)\)\)$/, ""))).size).toBeGreaterThanOrEqual(10);
  });
  for (const c of casos) {
    it(`${c.id} (${c.voice}): «${c.heard.slice(0, 70)}…»`, () => {
      const d = normalizeDictation(c.heard, TEST_CATALOG);
      expect(d.text).toBe(c.esperado.texto);
      expect(d.doubts).toEqual(c.esperado.pregunta ?? []);
      expect(d.single?.why).toEqual(c.esperado.unaSola);
      expect(d.brandAsCustomer).toEqual(c.esperado.marcaComoCliente);
      expect(d.currency ?? undefined).toEqual(c.esperado.moneda);
      expect(d.taxMention).toEqual(c.esperado.igvSinDecir);
      expect(d.plyIssues).toEqual(c.esperado.lonas ?? []);
      // una ficha sin dudas es una sola llanta, o las que se unieron con "y/además/también" u otra cantidad con su producto
      if (!c.nota && !d.doubts.length && !d.single) expect(d.items.every((l) => /\bx\d+\b/.test(l))).toBe(true);
    });
  }
});
