/**
 * Medidas dictadas con voz real (corrida F, punto 9): la zona de la medida se lee contra el catálogo (voice/sizes.ts).
 * Las dos transcripciones literales de la prueba del 14/11 y variantes con las formas que devuelve Deepgram (comprobadas
 * con audios reales de voces de macOS: "r", "R", "AR", "ER", comas entre números, dígitos sueltos, "22 y medio",
 * "22 coma 5", "barra"), para las medidas más vendidas del catálogo.
 */
import { describe, expect, it } from "vitest";
import { normalizeDictation, normalizeSpoken } from "./dictation";
import { fixCatalogTerms } from "./fuzzy";
import { isSizeOnly, resolveSpokenSizes } from "./sizes";
import { spokenToDigits } from "./dictation";

/** Las medidas más presentes del catálogo de precios (data/store.json, 14/11), en su forma canónica. */
const SIZES = [
  "295/80R22.5", "11R22.5", "315/80R22.5", "12R20", "12R22.5", "215/75R17.5", "235/75R17.5", "7.5R16", "7.5-16", "275/70R22.5",
  "275/80R22.5", "385/65R22.5", "425/65R22.5", "10R20", "11R20", "13R22.5", "265/70R19.5", "9.5R17.5", "8.25R16", "8.25R20", "195R15C",
];
const CATALOG = {
  sizes: SIZES,
  brands: ["Fenixway", "Linglong", "Triangle", "Westlake", "Double Coin", "Doublestar"],
  designs: [
    { brand: "Fenixway", model: "Valor 99" },
    { brand: "Fenixway", model: "Flama 77" },
    { brand: "Fenixway", model: "Valor 87" },
  ],
};

describe("las dos transcripciones reales del 14/11", () => {
  it("«Cotízame 8 Fenix Way valor 99 en 295 80, ER 22.5 para ZBUSS.» = 8 Fenixway Valor 99 295/80R22.5 para ZBUSS", () => {
    const d = normalizeDictation("Cotízame 8 Fenix Way valor 99 en 295 80, ER 22.5 para ZBUSS.", CATALOG);
    expect(d.sizes).toEqual(["295/80R22.5"]);
    expect(d.items).toEqual(["Fenixway valor 99 295/80R22.5 x8"]);
    expect(d.customer).toBe("ZBUSS");
    expect(d.text).not.toMatch(/\s22\.5\s*x8|precio 295/);
    // se dice lo que se corrigió (marca partida y medida)
    expect(d.fixes).toEqual(expect.arrayContaining([{ from: "Fenix Way", to: "Fenixway" }, { from: "295 80, ER 22.5", to: "295/80R22.5" }]));
  });
  it("«2 9 5 80 R 22.5.» (solo la medida) = 295/80R22.5", () => {
    expect(isSizeOnly(spokenToDigits("2 9 5 80 R 22.5."))).toBe(true);
    const r = resolveSpokenSizes("2 9 5 80 R 22.5.", SIZES);
    expect(r.resolved).toEqual([{ from: "2 9 5 80 R 22.5", to: "295/80R22.5", plain: false }]);
    expect(normalizeSpoken("2 9 5 80 R 22.5.", SIZES)).toBe("295/80R22.5");
  });
});

describe("variantes dictadas (Deepgram) para las medidas más vendidas", () => {
  // [transcripción, medida, cantidad (null = no se dijo), marca/diseño que debe quedar en la línea]
  const CASES: [string, string, number | null, string | null][] = [
    ["Cotiza 12 Double Coin en 11 r 22 y medio.", "11R22.5", 12, "Double Coin"],
    ["Cotiza 12 doble Coin en 11 R 22.5.", "11R22.5", 12, "Double Coin"],
    ["Cotiza 4 West Lake en 315 80 AR 22.5 para transportes beta.", "315/80R22.5", 4, "Westlake"],
    ["Cotiza 4 west lake 315, 80 r 22.5.", "315/80R22.5", 4, "Westlake"],
    ["Cotiza 10 Flama 77, 275, 80 r 22.5.", "275/80R22.5", 10, "Flama 77"],
    ["Cotiza 2 valor 99 en 295 barra 80 r 22 coma 5.", "295/80R22.5", 2, "valor 99"],
    ["Cotízame 6 llantas 12 R 22.5 a 250 dólares.", "12R22.5", 6, null],
    ["Cotiza 4 en 2 1 5 75 ere 17.5.", "215/75R17.5", 4, null],
    ["Cotiza 8 Fenixway en 295 por 80 erre 22.5.", "295/80R22.5", 8, "Fenixway"],
    ["Cotiza 8 en 295 slash 80 R 22.5.", "295/80R22.5", 8, null],
    ["Cotiza 8 295 80 R 22.5.", "295/80R22.5", 8, null],
    ["Cotiza 20 11 R 22.5.", "11R22.5", 20, null],
    ["Cotiza 4 235 75 ar 17.5.", "235/75R17.5", 4, null],
    ["Cotiza 6 en 12 R 20.", "12R20", 6, null],
    ["Cotiza 4 en 10 r 20.", "10R20", 4, null],
    ["Cotiza 8 Valor 87 en 2 7 5 80 22.5.", "275/80R22.5", 8, "Valor 87"],
    ["Cotiza 4 en 3 1 5 80 r 22 5.", "315/80R22.5", 4, null],
    ["Cotiza 8 Fenixway en 295 80 R22.5, para ZBUSS.", "295/80R22.5", 8, "Fenixway"],
    ["Cotiza 8 en 295 x 80 R 22.5.", "295/80R22.5", 8, null],
    ["Cotiza 8 en 295-80 R 22.5.", "295/80R22.5", 8, null],
    ["Cotiza 2 Triangle en 3 8 5 65 r 22.5.", "385/65R22.5", 2, "Triangle"],
    ["Cotiza 4 en 12.00 R 20.", "12R20", 4, null],
    ["Cotiza 10 en 425 65 ER 22.5.", "425/65R22.5", 10, null],
    ["Cotiza 6 en 265, 70, r 19.5.", "265/70R19.5", 6, null],
    ["Cotiza 8 llantas 11 22.5 a 254.", "11R22.5", 8, null],
    ["Cotízame ocho Fenixway Valor 99 en doscientos noventa y cinco ochenta erre veintidós punto cinco para Zeta Bus.", "295/80R22.5", 8, "Fenixway"],
    ["Cotiza 4 en 1 1 R 22.5.", "11R22.5", 4, null],
    ["Cotiza 6 en 1 2 erre 22.5.", "12R22.5", 6, null],
    ["Cotiza 8 en 2 9 5 80 22 y medio.", "295/80R22.5", 8, null],
    ["Cotiza 10 en 3 1 5 80 ER 22.5.", "315/80R22.5", 10, null],
    ["Cotiza 4 en 215, 75, ER 17.5.", "215/75R17.5", 4, null],
    ["Cotiza 6 Flama 77 en 275 80, AR 22.5.", "275/80R22.5", 6, "Flama 77"],
    ["Cotiza 4 en 3 8 5 65 22.5.", "385/65R22.5", 4, null],
    ["Cotiza 8 en 295 80. R 22.5.", "295/80R22.5", 8, null],
    ["Cotiza 12 en 11, R 22.5.", "11R22.5", 12, null],
    ["Cotiza 4 en 12 ER 22.5.", "12R22.5", 4, null],
    ["Cotiza 2 en 2 3 5 75 r 17.5.", "235/75R17.5", 2, null],
    // pasada con audios reales (voces Flo, Grandpa y Sandy de macOS): la cantidad pegada a la medida
    ["Cotiza 6 12 R 20 a 300 dólares.", "12R20", 6, null],
    ["Cotiza 4235 por 75 r 17.5.", "235/75R17.5", 4, null],
    ["Cotizo 20 11 R 22.5", "11R22.5", 20, null],
  ];
  it.each(CASES)("%s", (transcript, size, qty, desc) => {
    const d = normalizeDictation(transcript, CATALOG);
    expect(d.sizes).toEqual([size]);
    expect(d.items).toHaveLength(1);
    const item = d.items[0];
    if (qty === null) expect(item).not.toMatch(/\bx\d/);
    else expect(item).toMatch(new RegExp(`(?:^|\\s)x${qty}(?:\\s|$)`));
    if (desc) expect(item.toLowerCase()).toContain(desc.toLowerCase());
    // ninguna cifra de la medida queda suelta (como precio o cantidad)
    expect(item.replace(size, "")).not.toMatch(/\b(?:295|315|275|80|22\.5|17\.5)\b(?!\s*dólares)/);
    expect(d.sizeChoices).toEqual([]);
  });
});

describe("contra el catálogo", () => {
  it("varias medidas posibles: se pregunta (7 50 16 = 7.50R16 o 7.50-16), en el texto va la primera", () => {
    const d = normalizeDictation("Cotiza 4 en siete cincuenta dieciséis", CATALOG);
    expect(d.sizeChoices).toEqual([{ from: "7 50 16", options: ["7.5R16", "7.5-16"] }]);
    expect(d.sizes).toEqual(["7.5R16"]);
  });
  it("con la R dicha no hay duda", () => {
    expect(normalizeDictation("Cotiza 4 en siete cincuenta erre dieciséis", CATALOG).sizeChoices).toEqual([]);
  });
  it("ninguna del catálogo: la zona queda escrita en limpio para que se pregunte («275 80 AR 22 punto»)", () => {
    const r = resolveSpokenSizes("Cotiza 10 Flama 77 en 275 80 AR 22 punto", SIZES);
    expect(r.resolved).toEqual([]);
    expect(r.unmatched).toEqual(["275 80 R 22"]);
    expect(r.text).toBe("Cotiza 10 Flama 77 en 275 80 R 22 punto");
  });
  it("la misma medida con C en el catálogo (195 R 15 -> 195R15C)", () => {
    expect(resolveSpokenSizes("195 R 15", SIZES).resolved.map((x) => x.to)).toEqual(["195R15C"]);
  });
  it("dos medidas en una zona", () => {
    expect(resolveSpokenSizes("12 R 22.5 11 R 22.5", SIZES).resolved.map((x) => x.to)).toEqual(["12R22.5", "11R22.5"]);
  });
  it("sin catálogo: lo plausible (radial)", () => {
    expect(normalizeSpoken("2 9 5 80 R 22.5.")).toBe("295/80R22.5");
    expect(normalizeSpoken("Cotízame 8 Fenix Way valor 99 en 295 80, ER 22.5 para ZBUSS.")).toBe("Cotízame 8 Fenix Way valor 99 en 295/80R22.5 para ZBUSS");
    expect(normalizeSpoken("Cotiza 6 12 R 20 a 300 dólares.")).toBe("Cotiza 6 12R20 a 300 dólares");
    expect(normalizeSpoken("Cotiza 4 en 7 50 R 16")).toBe("Cotiza 4 en 7.5R16");
  });
  it("lo que no tiene forma de medida no se toca (precio, días, porcentajes, diseño)", () => {
    const t = "Cotiza 8 Flama 77 a 254 a 45 días, margen 10 %";
    expect(resolveSpokenSizes(t, SIZES).text).toBe(t);
  });
  it("«x8» escrito es cantidad, no separador", () => {
    expect(resolveSpokenSizes("295/80R22.5 x8", SIZES).text).toBe("295/80R22.5 x8");
  });
});

describe("solo la medida (cuando el bot la pidió)", () => {
  it.each(["2 9 5 80 R 22.5.", "la medida es 295 80 r 22.5", "11 R 22.5", "perdón, sería 315 80 AR 22.5", "295/80R22.5"])("«%s» es solo medida", (t) => {
    expect(isSizeOnly(spokenToDigits(t))).toBe(true);
  });
  it.each(["Cotiza 8 Valor 99 en 295 80 R 22.5", "visité ZBUSS", "ok"])("«%s» no", (t) => {
    expect(isSizeOnly(spokenToDigits(t))).toBe(false);
  });
});

describe("marcas partidas en dos palabras (también en minúsculas)", () => {
  it.each([
    ["8 fenix way valor 99", "8 Fenixway valor 99"],
    ["4 west lake en", "4 Westlake en"],
    ["12 doublecoin en", "12 Double Coin en"],
    ["8 Fenix Way", "8 Fenixway"],
  ])("%s", (t, out) => {
    expect(fixCatalogTerms(t, { brands: CATALOG.brands, designs: CATALOG.designs }).text).toBe(out);
  });
});
