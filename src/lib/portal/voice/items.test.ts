/**
 * Varias llantas en una nota de voz y UB dictada (corrida H, puntos 5 y 6): las piezas de voice/items.ts y su uso en
 * normalizeDictation, con los casos que salieron de la pasada con Deepgram real (2026-11-16).
 */
import { describe, expect, it } from "vitest";
import { normalizeDictation, spokenToDigits } from "./dictation";
import { TEST_CATALOG, TEST_DESIGNS } from "./fixtures/test-catalog";
import { groupItems, joinUbDigits, markUbs, parseVoiceEdit, unglueNumbers } from "./items";

describe("números que Deepgram pegó", () => {
  it("aro .5 con la cantidad de la llanta siguiente: «17.54 valor 89» -> «17.5 4 valor 89»", () => {
    expect(unglueNumbers("2 Flama 77 en 215, 75 r 17.54 valor 89 en 235")).toBe("2 Flama 77 en 215, 75 r 17.5 4 valor 89 en 235");
    expect(unglueNumbers("12 r 22.512 Flama 77")).toBe("12 r 22.5 12 Flama 77");
    // un aro que no es de camión, o sin palabra después, no se toca
    expect(unglueNumbers("a 22.54 dólares por 20.54")).toBe("a 22.54 dólares por 20.54");
  });
  it("diseño del catálogo con el ancho pegado: «valor 99295, 80» -> «valor 99 295, 80» (solo si el diseño existe)", () => {
    expect(unglueNumbers("8 llantas, valor 99295, 80 r 22.5", TEST_DESIGNS)).toBe("8 llantas, valor 99 295, 80 r 22.5");
    expect(unglueNumbers("4 Flama 77315, 80 r 22.5", TEST_DESIGNS)).toBe("4 Flama 77 315, 80 r 22.5");
    expect(unglueNumbers("4 Foo 77315, 80 r 22.5", TEST_DESIGNS)).toBe("4 Foo 77315, 80 r 22.5");
  });
});

describe("UB dictada", () => {
  it("«dos mil cinco» y «mil doscientos treinta y uno» en cifras", () => {
    expect(spokenToDigits("para la u be dos mil cinco")).toBe("para la u be 2005");
    expect(spokenToDigits("u be mil doscientos treinta y uno")).toBe("u be 1231");
    expect(spokenToDigits("dos mil doscientos uno")).toBe("2201");
  });
  it("formas claras siempre; las oídas de «u be» y el número suelto solo con un cliente que pide UB", () => {
    const strong = markUbs("4 valor 99 UB 1231, 4 valor 89 unidad 1812, 2 valor 99 unidad blindada 1.911", 0);
    expect(strong.ubs.map((u) => u.value)).toEqual(["1231", "1812", "1911"]);
    expect(markUbs("4 valor 99 para la v grande 1231", 0).ubs).toEqual([]);
    expect(markUbs("4 valor 99 para la v grande 1231", 1).ubs.map((u) => u.value)).toEqual(["1231"]);
    expect(markUbs("1231, 4, valor 99, un 2005", 2).ubs.map((u) => u.value)).toEqual(["2005", "1231"]);
    // un precio no es UB
    expect(markUbs("4 valor 99 a 1250 dólares", 2).ubs).toEqual([]);
  });
  it("cifras dictadas una por una se juntan; lo que no tiene 4 cifras queda inválido (se pregunta)", () => {
    expect(joinUbDigits("para la 1 2 3 1. 4, valor 89")).toBe("para la 1231. 4, valor 89");
    expect(joinUbDigits("para la 2 9 5 80 r 22.5")).toBe("para la 2 9 5 80 r 22.5");
    const u = markUbs("UB 12 31 y para la U 181", 1).ubs;
    expect(u.map((x) => [x.value, x.valid])).toEqual([
      ["1231", true],
      ["181", false],
    ]);
  });
});

describe("separar las llantas", () => {
  it("cantidad que empieza otra llanta sin separador (después de una medida o una UB)", () => {
    expect(groupItems("8 valor 99 en §0§ 12 Flama 77 en §1§").groups).toEqual(["8 valor 99 en §0§", "12 Flama 77 en §1§"]);
    expect(groupItems("4 valor 99 en §0§ ¤0¤ 4 valor 89 ¤1¤, 2 valor 99 ¤2¤").groups).toEqual(["4 valor 99 en §0§ ¤0¤", "4 valor 89 ¤1¤", "2 valor 99 ¤2¤"]);
  });
  it("lo que no es llanta por sí solo va con la que corresponde", () => {
    // la cantidad y la UB delante; la medida y el precio detrás; el número del diseño tras una coma
    expect(groupItems("¤0¤, 4, valor 99, ¤1¤, 4, valor 89").groups).toEqual(["¤0¤ 4 valor 99", "¤1¤ 4 valor 89"]);
    expect(groupItems("8, Westlake CM 958, en §0§ a 198, Westlake a z 670, en §1§ a 185").groups).toEqual(["8 Westlake CM 958 en §0§ a 198", "Westlake a z 670 en §1§ a 185"]);
    expect(groupItems("4, valor 99, §0§, más 4 Flama, 77, §1§").groups).toEqual(["4 valor 99 §0§", "4 Flama 77 §1§"]);
  });
  it("una cifra que no se sabe de quién es: duda (no se pega ni se descarta)", () => {
    const g = groupItems("4 valor 99 en §0§, 6");
    expect(g.doubts.length + g.groups.length).toBeGreaterThan(0);
    expect(normalizeDictation("cotiza cuatro Valor 99 en 295 80 22.5 y seis Flama 77 en 315 80 22.5 y doce", TEST_CATALOG).doubts.join(" ")).toMatch(/12/);
  });
});

describe("normalizeDictation con varias llantas", () => {
  it("el ejemplo del punto 5: dos llantas con cantidad, marca, diseño y medida; cliente y plazo para toda la cotización", () => {
    const d = normalizeDictation("Cotízame ocho Valor 99 en 295 80 R 22.5, y doce Flama 89 en 11 R 22.5, para Zeta Bus a 30 días.", TEST_CATALOG);
    expect(d.text).toBe("Fenixway Valor 99 295/80R22.5 x8\nFenixway Flama 89 11R22.5 x12\npara Zeta Bus\nplazo: 30 días");
    expect(d.doubts).toEqual([]);
  });
  it("precio por llanta; margen y descuento para toda la cotización", () => {
    const d = normalizeDictation("Cotiza cuatro Flama 77 en 315 80 R 22.5 a 254 dólares y seis Valor 99 en 12 R 22.5 a 280, con margen de 10 por ciento, descuento del 3 por 100", TEST_CATALOG);
    expect(d.items).toEqual(["Fenixway Flama 77 315/80R22.5 x4 precio 254", "Fenixway Valor 99 12R22.5 x6 precio 280"]);
    expect(d.text).toContain("margen 10%");
    expect(d.text).toContain("dscto 3%");
  });
  it("la línea sin medida hereda la de la anterior y se dice; la primera sin medida (otras con) es duda", () => {
    const d = normalizeDictation("cotiza cuatro Flama 77 en 315 80 22.5 y dos Valor 99", TEST_CATALOG);
    expect(d.items).toEqual(["Fenixway Flama 77 315/80R22.5 x4", "Fenixway Valor 99 315/80R22.5 x2"]);
    expect(d.inherited).toEqual([{ item: 1, size: "315/80R22.5" }]);
    expect(normalizeDictation("cotiza dos Valor 99 y cuatro Flama 77 en 315 80 22.5", TEST_CATALOG).doubts.join(" ")).toMatch(/no tiene medida/);
  });
  it("dos medidas en una llanta: duda (nunca mezcla números de dos medidas)", () => {
    const d = normalizeDictation("cotiza ocho Valor 99 en 295 80 22.5 y 11 R 22.5", TEST_CATALOG);
    expect(d.doubts.join(" ")).toMatch(/«y? ?11R22\.5» no dice cantidad ni modelo|dos medidas/);
  });
  it("«Cotícame», «Contícame» (cotízame mal oído) no quedan como parte de la llanta", () => {
    expect(normalizeDictation("Cotícame 4 Flama 77 en 215, 75 r 17.5, y 4 Flama 77 en 235, 75 r 17.5.", TEST_CATALOG).items).toEqual(["Fenixway Flama 77 215/75R17.5 x4", "Fenixway Flama 77 235/75R17.5 x4"]);
  });
  it("una medida seguida de punto («22.5. Otra, …») se lee", () => {
    expect(normalizeDictation("Cotiza 8, valor 99, 295, 80 r 22.5. Otra, 4 Flama 77, 315, 80 r 22.5. Para ZBUSS.", TEST_CATALOG).items).toEqual(["Fenixway valor 99 295/80R22.5 x8", "Fenixway Flama 77 315/80R22.5 x4"]);
  });
});

describe("cliente con contrato por voz (Prosegur)", () => {
  const P = "Cotízame para Prosegur Juliaca: cuatro Valor 99 en 215 75 R 17.5 para la UB 1231, cuatro Valor 89 para la UB 1812 y dos Valor 99 para la UB 1911";
  it("cliente y sucursal en la cabecera; cada línea con su UB; la medida heredada se dice", () => {
    const d = normalizeDictation(P, TEST_CATALOG);
    expect(d.profile).toMatchObject({ key: "prosegur", branch: "Juliaca" });
    expect(d.text).toBe(["prosegur Juliaca", "Fenixway Valor 99 215/75R17.5 x4 ub 1231", "Fenixway Valor 89 215/75R17.5 x4 ub 1812", "Fenixway Valor 99 215/75R17.5 x2 ub 1911"].join("\n"));
    expect(d.inherited.map((x) => x.item)).toEqual([1, 2]);
    expect(d.ubIssues).toEqual([]);
  });
  it("la UB dicha de cualquier forma", () => {
    for (const ub of ["u be mil doscientos treinta y uno", "unidad 1231", "UB uno dos tres uno", "UB 12 31", "unidad blindada 1231"]) {
      const d = normalizeDictation(`Cotízame para Prosegur Juliaca: cuatro Valor 99 para la ${ub}`, TEST_CATALOG);
      expect(d.ubs, ub).toEqual(["1231"]);
    }
  });
  it("UB que falta o no tiene 4 cifras: se pregunta (ubIssues)", () => {
    const d = normalizeDictation("Cotízame para Prosegur Juliaca: cuatro Valor 99 para la UB 1231, cuatro Valor 89 y dos Valor 99 para la U 181", TEST_CATALOG);
    expect(d.ubIssues).toEqual([{ item: 1 }, { item: 2, heard: "181" }]);
  });
  it("el nombre mal oído se reconoce por parecido (y la sucursal contra las conocidas); otro nombre no", () => {
    expect(normalizeDictation("Cotízame para Prosegul Juliaka 4 valor 99 para la v 1231", TEST_CATALOG).profile).toMatchObject({ key: "prosegur", branch: "Juliaca", heard: "Prosegul Juliaka" });
    expect(normalizeDictation("Cotízame para proseguir, Juliaka. 4, valor 99 para la 1 2 3 1.", TEST_CATALOG).profile?.branch).toBe("Juliaca");
    expect(normalizeDictation("Cotízame para asegurar. 2 Flama 77 para la U 3104", TEST_CATALOG).profile).toBeUndefined();
  });
  it("«… para Prosegur Juliaca» al final también es el cliente con contrato", () => {
    const d = normalizeDictation("cotiza cuatro Valor 99 UB 1231 y dos Valor 89 UB 1812 para Prosegur Juliaca", TEST_CATALOG);
    expect(d.text.split("\n")[0]).toBe("prosegur Juliaca");
    expect(d.ubs).toEqual(["1231", "1812"]);
    expect(d.customer).toBe("");
  });
});

describe("correcciones dirigidas y agregar por voz", () => {
  const e = (t: string) => parseVoiceEdit(spokenToDigits(t));
  it("cantidad, quitar y precio de una línea", () => {
    expect(e("el segundo eran diez")).toEqual({ kind: "quantity", line: 2, value: 10 });
    expect(e("El 2º eran 10.")).toEqual({ kind: "quantity", line: 2, value: 10 });
    expect(e("El 3º que sea 12.")).toEqual({ kind: "quantity", line: 3, value: 12 });
    expect(e("La 1º son 6 llantas,")).toEqual({ kind: "quantity", line: 1, value: 6 });
    expect(e("quita el tercero")).toEqual({ kind: "remove", line: 3 });
    expect(e("Elemena el 2º.")).toEqual({ kind: "remove", line: 2 });
    expect(e("el tercero quítalo")).toEqual({ kind: "remove", line: 3 });
    expect(e("al primero ponle precio doscientos cincuenta y nueve")).toEqual({ kind: "price", line: 1, value: 259 });
    expect(e("Al 2º ponle 270 dólares.")).toEqual({ kind: "price", line: 2, value: 270 });
    expect(e("precio del segundo 250")).toEqual({ kind: "price", line: 2, value: 250 });
  });
  it("agrega / añade / súmale / también", () => {
    expect(e("Agrega cuatro Flama 77 en 275 80 R 22.5")).toEqual({ kind: "add", text: "4 Flama 77 en 275 80 R 22.5" });
    expect(e("añade dos Valor 99 en 12 R 22.5 a 280")).toEqual({ kind: "add", text: "2 Valor 99 en 12 R 22.5 a 280" });
    expect(e("Súmale 6 valor 89 en 235 75 r 17.5.")).toEqual({ kind: "add", text: "6 valor 89 en 235 75 r 17.5" });
    expect(e("También 4 valor 99, 295, 80 r 22.5.")).toEqual({ kind: "add", text: "4 valor 99, 295, 80 r 22.5" });
  });
  it("lo demás no es una corrección dirigida", () => {
    expect(e("no, eran doce")).toBeNull();
    expect(e("cámbialo a Valor 99")).toBeNull();
    expect(e("Padre A 4 Flama 77 en 275 80 r 22.5")).toBeNull();
  });
});
