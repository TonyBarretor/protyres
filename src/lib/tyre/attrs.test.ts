import { describe, expect, it } from "vitest";
import { extractLoadIndex, extractPly, extractPosition, extractTube } from "./attrs";
import { findTyreSizes, parseTyreSize, sizeLoose } from "./spec";

describe("real-world sizes (client files)", () => {
  it.each([
    // own list / Odoo stock
    ["215/75R17.5 18PR FENIXWAY VALOR 99 MIX", "215/75R17.5"],
    ["7.50R16LT 122/118L AONAITE 896", "7.5R16LT"],
    ["12R22.5 18pr 152/149 J", "12R22.5"],
    ["265/65R17 121/118Q", "265/65R17"],
    ["185R14C RA18 RADIAL", "185R14C"],
    ["195R14C 8PR 106/104Q AP VANCONTACT", "195R14C"],
    ["ARO 6.00X17.5 FIERRO", "6-17.5"],
    ["CAMARA 1200-20 TR78A", "12-20"],
    // Steel
    ["NEUMATICO 10 R22.5 14PR 141/139M HAL536 HIFLY", "10R22.5"],
    ["NEUMATICO 1000 R20 18PR 149/146D HF321 SET SUNFULL", "10R20"],
    // JCH
    ["NTCO: 25X10-12 10PR F978A WORCRAFT TL (ATV CUATRIMOTO)", "25X10-12"],
    ["NTCO: 130/70 12 6PR F-338B R", "130/70R12"],
    ["NTCO: 155/70 R12 73T L770 LING LONG", "155/70R12"],
    ["NTCO: 155 R12C 8PR 88/86N DS805", "155R12C"],
    ["NTCO: 145 R12 GP VAN 01 ENASAVE", "145R12"],
    ["NTCO: 4.50 12 8PR CR831 DEL WESTLAKE TCF", "4.5-12"],
    ["NTCO: 7.00 16 14PR H-RIB DEL ZOWIN TCF T.D.13MM PESO 22.5KG", "7-16"],
    ["NTCO: LT5.00 R12 10PR 88/86P DS809", "5R12"],
    ["NTCO: LT265/65 R17 10PR 120/117Q SL366 M/T OWL WESTLAKE TL LETRAS BLANCAS PESO 22.50 KG", "LT265/65R17"],
    ["NTCO: 12.00 R20 22PR TTM-D22 TRACCION ON/OFF TRIANGLE TCF T.D.22.5MM BANDA 250MM PESO 97.1KG", "12R20"],
    ["NTCO: 385/65 R22.5 20PR (160L) CPT65 MIXTA COMPASAL TL", "385/65R22.5"],
    ["NTCO: P205/70 R15 SC890 WS SUMITOMO T", "P205/70R15"],
    // customer requests (emails / WhatsApp)
    ["LLANTA 12.5/80 X 18 - 12 PLY R4", "12.5/80-18"],
    ["LLANTA 19.5L X 24-10 PLY -POST", "19.5L-24"],
    ["LLANTA TRACCION 12R22.5 MOD G377", "12R22.5"],
    ["LLANTA 16.9R30 GOOD YEAR SUPER TRACTION", "16.9R30"],
    ["215/75 x R17.5", "215/75R17.5"],
    ["300 x R15", "300-15"],
    ["7.50-16-16 pr track king set", "7.5-16"],
    ["11x22.5 16 TL AG888", "11-22.5"],
    ["18.4-34 14PR", "18.4-34"],
    ["28x9-15 14PR forklift", "28X9-15"],
    ["6.50-10 10PR", "6.5-10"],
    ["10-16.5 10PR skid", "10-16.5"],
  ])("%s -> %s", (input, canonical) => {
    expect(parseTyreSize(input)?.canonical).toBe(canonical);
  });

  it("still ignores non-sizes in those descriptions", () => {
    expect(findTyreSizes("SIKAFLEX 221 BLANCO x 600ml").length).toBe(0);
    expect(findTyreSizes("SIKAGARDVR-840 Pt 1L").length).toBe(0);
    expect(findTyreSizes("T.D.22.5MM BANDA 250MM PESO 97.1KG").length).toBe(0);
    expect(findTyreSizes("PARCHE PARA LLANTA RS-35 VIPAL").length).toBe(0);
    expect(findTyreSizes("precio 250 15 unidades").length).toBe(0);
    expect(findTyreSizes("ARO 14 TOYOTA 4H FIERRO").length).toBe(0);
  });

  it("display forms", () => {
    expect(parseTyreSize("16.9R30")?.display).toBe("16.9R30");
    expect(parseTyreSize("7.00 16")?.display).toBe("7.00-16");
    expect(parseTyreSize("1000 R20")?.display).toBe("10.00R20");
    expect(parseTyreSize("300 x R15")?.display).toBe("300-15");
  });

  it("loose matching ignores construction", () => {
    expect(sizeLoose("11R22.5")).toBe(sizeLoose("11-22.5"));
    expect(sizeLoose("LT265/65R17")).toBe(sizeLoose("265/65R17"));
    expect(sizeLoose("11R22.5")).not.toBe(sizeLoose("12R22.5"));
  });
});

describe("attributes", () => {
  it("ply", () => {
    expect(extractPly("215/75R17.5 18PR")).toBe(18);
    expect(extractPly("12.5/80 X 18 - 12 PLY R4")).toBe(12);
    expect(extractPly("7.50-16-16 pr track king")).toBe(16);
    expect(extractPly("295/80R22.5 152/148M")).toBeUndefined();
  });
  it("load index", () => {
    expect(extractLoadIndex("10 R22.5 14PR 141/139M HAL536")).toEqual({ loadIndex: "141/139", speedIndex: "M" });
    expect(extractLoadIndex("12R22.5 18pr 152/149 J")).toEqual({ loadIndex: "152/149", speedIndex: "J" });
    expect(extractLoadIndex("225/70R17 108S TR292 TL")).toEqual({ loadIndex: "108", speedIndex: "S" });
    expect(extractLoadIndex("385/65 R22.5 20PR (160L) CPT65")).toEqual({ loadIndex: "160", speedIndex: "L" });
    expect(extractLoadIndex("295/80R22.5 18PR FENIXWAY VALOR 87")).toBeUndefined();
    expect(extractLoadIndex("7.00 16 14PR H-RIB DEL ZOWIN TCF T.D.13MM")).toBeUndefined();
  });
  it("position", () => {
    expect(extractPosition("NTCO: 7.00 16 14PR H-RIB DEL ZOWIN TCF")).toBe("DEL");
    expect(extractPosition("02 llantas delanteras")).toBe("DEL");
    expect(extractPosition("LLANTA TRACCION 12R22.5 MOD G377")).toBe("TRAC");
    expect(extractPosition("215/75 x R17.5 PIKIN 1 Posterior")).toBe("TRAC");
    expect(extractPosition("295/80R22.5 18PR VALOR 99 MIX")).toBe("MIX");
    expect(extractPosition("Mixta All Position")).toBe("MIX");
    expect(extractPosition("Tracc Off the Road")).toBe("OTR");
    expect(extractPosition("265/65R17 121/118Q")).toBeUndefined();
  });
  it("tube", () => {
    expect(extractTube("11x22.5 16 TL AG888")).toBe("TL");
    expect(extractTube("7.50-16-16 pr track king set")).toBe("TT");
    expect(extractTube("7.00 16 14PR H-RIB DEL ZOWIN TCF")).toBe("TT");
  });
});

describe("forklift notations", () => {
  it.each([
    ["NTCO: 300 15 18PR LF401 NEUMATICA LING LONG TCF", "300-15"],
    ["NTCO: 250 15 20PR FL-08 NEUMATICA MITAS TCF", "250-15"],
    ["NTCO: 3.00 15 (315/70 15)/8.00R FLS692 SOLIDA", "300-15"],
    ["NTCO: 2.50 15 16PR NHS CL619 NEUMATICA WESTLAKE TCF", "250-15"],
    ["NTCO: 12.5 L15 8PR MIM-104 IMPLEMENT MRL TL", "12.5L-15"],
    ["NTCO: 2.50 17 6PR F-600 RUNSTONE TL", "2.5-17"],
  ])("%s -> %s", (input, canonical) => {
    expect(parseTyreSize(input)?.canonical).toBe(canonical);
  });
});

describe("bias truck notations (JCH)", () => {
  it.each([
    ["NTCO: 11 24.5 16PR HIGHWAY MRF T", "11-24.5"],
    ["NTCO: 10.00 20 16PR CR942 DEL WESTLAKE TCF", "10-20"],
    ["11x22.5 16 TL AG888", "11-22.5"],
  ])("%s -> %s", (input, canonical) => {
    expect(parseTyreSize(input)?.canonical).toBe(canonical);
  });
  it("does not read '11 24' in prose as a size", () => {
    expect(findTyreSizes("quedan 11 24 unidades").length).toBe(0);
  });
});
