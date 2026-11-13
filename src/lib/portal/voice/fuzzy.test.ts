import { describe, expect, it } from "vitest";
import { fixCatalogTerms, matchSpokenName, phoneticKey, spokenForms } from "./fuzzy";

const CANDS = [
  { id: 1, name: "ZBUSS S.A.C." },
  { id: 2, name: "TRANSPORTES ZETA BUS EXPRESS S.A.C." },
  { id: 3, name: "EMPRESA DE TRANSPORTES EXPRESO ANDINO S.A." },
  { id: 4, name: "TRANSPORTES ANDES DEL PERU S.A.C." },
  { id: 5, name: "ATC LOGISTICA S.A.C." },
];

describe("clave fonética (español)", () => {
  it("iguala lo que suena igual", () => {
    expect(phoneticKey("Zeta Bus")).toBe(phoneticKey("seta buss"));
    expect(phoneticKey("Vía")).toBe(phoneticKey("bía"));
    expect(phoneticKey("Fenixway")).toBe(phoneticKey("fenicsuay"));
    expect(phoneticKey("Hércules")).toBe(phoneticKey("ercules"));
  });

  it("las siglas impronunciables se dicen letra por letra", () => {
    expect(spokenForms("ZBUSS")).toContain(phoneticKey("zeta bus"));
    expect(spokenForms("ATC")).toContain(phoneticKey("a te ce"));
  });
});

describe("empresa dictada contra empresas conocidas", () => {
  it("«Septa BUSS» -> ZBUSS (candidato claro)", () => {
    const r = matchSpokenName("Septa BUSS", [CANDS[0], CANDS[3], CANDS[4]]);
    expect(r.kind).toBe("clear");
    expect(r.best?.id).toBe(1);
  });

  it("nombre exacto o con la forma social", () => {
    expect(matchSpokenName("Transportes Andes del Perú", CANDS)).toMatchObject({ kind: "clear", best: { id: 4 } });
    expect(matchSpokenName("atece logística", CANDS)).toMatchObject({ kind: "clear", best: { id: 5 } });
  });

  it("dos parecidas: duda (candidatas para preguntar)", () => {
    const r = matchSpokenName("zeta bus", CANDS);
    expect(r.kind).toBe("doubt");
    expect(r.candidates.map((c) => c.id).sort()).toEqual([1, 2]);
  });

  it("nada parecido: none", () => {
    expect(matchSpokenName("Transportes Gamma", CANDS).kind).toBe("none");
    expect(matchSpokenName("Pérez", CANDS).kind).toBe("none");
  });
});

describe("marcas y diseños del catálogo por parecido", () => {
  const catalog = { brands: ["Fenixway", "Michelin", "Bridgestone", "Goodyear"], designs: [{ brand: "Fenixway", model: "Flama 77" }, { brand: "Fenixway", model: "Valor 99" }, { brand: "Michelin", model: "X Multi Z" }] };

  it("«Fénix Suite» -> Fenixway; «Bridgeston» -> Bridgestone; «Gudyear» -> Goodyear", () => {
    expect(fixCatalogTerms("quieren probar Fénix Suite en direccional", catalog).text).toBe("quieren probar Fenixway en direccional");
    expect(fixCatalogTerms("ocho Bridgeston 11R22.5", catalog).text).toBe("ocho Bridgestone 11R22.5");
    expect(fixCatalogTerms("unas Gudyear", catalog).text).toBe("unas Goodyear");
    expect(fixCatalogTerms("ocho Flamas 77 y dos Balor 99", catalog).text).toBe("ocho Flama 77 y dos Valor 99");
  });

  it("no toca palabras comunes ni lo que ya está bien", () => {
    for (const s of ["Visité la empresa, hablé con el gerente", "quedamos en volver a llamar el lunes", "Fenixway Flama 77", "michelin x multi z", "tienen ochenta buses y probar fresas"]) {
      expect(fixCatalogTerms(s, catalog).text).toBe(s);
    }
  });

  it("dice qué cambió", () => {
    expect(fixCatalogTerms("quieren Fénix Suite", catalog).changes).toEqual([{ from: "Fénix Suite", to: "Fenixway" }]);
  });
});

describe("empresa dictada: lo dicho entero", () => {
  it("«Andes del Perú» no empata con otra que solo empieza igual", () => {
    const c = [{ id: 1, name: "TRANSPORTES ANDES DEL PERU S.A.C." }, { id: 2, name: "EMPRESA ANDES SUR E.I.R.L." }];
    expect(matchSpokenName("Andes del Perú", c)).toMatchObject({ kind: "clear", best: { id: 1 } });
    expect(matchSpokenName("Andes", c).kind).toBe("doubt");
  });
});

describe("marcas por parecido: sin falsos positivos (pasada 2 con Deepgram real)", () => {
  // el catálogo real tiene 231 marcas, varias con nombre de palabra o de persona (Antares, Compasal, Atlas, Titan…)
  const many = { brands: ["Linglong", "Dunlop", "Triangle", "Compasal", "Fenixway", ...Array.from({ length: 50 }, (_, i) => `Marca${i}x`), "Antares", "Atlas", "Titan"], designs: [] };

  it("«la señora Ana Torres, la jefa de compras» no se toca", () => {
    const s = "hablé con la señora Ana Torres, la jefa de compras. Quieren probar Linglong en tracción.";
    expect(fixCatalogTerms(s, many).text).toBe(s);
  });

  it("las marcas raras (fuera de las más presentes) no se usan para corregir", () => {
    expect(fixCatalogTerms("visité a Titam", many).text).toBe("visité a Titam");
  });

  it("las marcas principales sí: «Lingslong» -> Linglong, «Compasol» -> Compasal", () => {
    expect(fixCatalogTerms("quieren Lingslong y Compasol", many).text).toBe("quieren Linglong y Compasal");
  });
});

describe("empresa dictada: claves cortas (guion de voz, pasada 3)", () => {
  it("«Transportes Beta» no se parece a ZETA GAS ANDINO («beta» / «seta»)", () => {
    expect(matchSpokenName("Transportes Beta", [{ id: 1, name: "ZETA GAS ANDINO S.A." }, { id: 2, name: "ZBUSS S.A.C." }]).kind).toBe("none");
  });
  it("pero una clave corta igual sí: «Ransa» -> RANSA COMERCIAL", () => {
    expect(matchSpokenName("Ransa", [{ id: 1, name: "RANSA COMERCIAL S.A.C" }])).toMatchObject({ kind: "clear", best: { id: 1 } });
  });
});
