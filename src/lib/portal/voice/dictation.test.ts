/**
 * Cotización por voz (corrida D, punto 8): normalización de lo dictado. Transcripciones simuladas (como las devolvería
 * Deepgram con smart_format: a veces cifras, a veces palabras) -> el texto que el cotizador ya entiende.
 */
import { describe, expect, it } from "vitest";
import { parseRequestRegex } from "../../quote/request";
import { findTyreSizes } from "../../tyre/spec";
import { checkSizes, normalizeDictation, normalizeSpoken, normalizeVoiceCorrection, spokenToDigits } from "./dictation";

const sizesOf = (spoken: string) => findTyreSizes(normalizeSpoken(spoken)).map((s) => s.canonical);

describe("spokenToDigits", () => {
  it("números dictados en palabras", () => {
    expect(spokenToDigits("doscientos noventa y cinco")).toBe("295");
    expect(spokenToDigits("doscientos cincuenta y cuatro")).toBe("254");
    expect(spokenToDigits("ocho llantas")).toBe("8 llantas");
    expect(spokenToDigits("cuarenta y cinco días")).toBe("45 días");
    expect(spokenToDigits("veintidós punto cinco")).toBe("22.5");
    expect(spokenToDigits("veintidós y medio")).toBe("22.5");
    expect(spokenToDigits("una docena de llantas")).toBe("12 de llantas");
    expect(spokenToDigits("media docena")).toBe("6");
    expect(spokenToDigits("dos docenas")).toBe("24");
    expect(spokenToDigits("mil cien")).toBe("1100");
    expect(spokenToDigits("ciento veinte")).toBe("120");
  });
  it("'un'/'una' solo son número antes de llanta/unidad/docena", () => {
    expect(spokenToDigits("para una empresa de buses")).toBe("para una empresa de buses");
    expect(spokenToDigits("una llanta")).toBe("1 llanta");
  });
});

describe("medidas dictadas: al menos 12 formas", () => {
  const CASES: [string, string][] = [
    ["295/80R22.5", "295/80R22.5"],
    ["295 80 22.5", "295/80R22.5"],
    ["295 80 R 22.5", "295/80R22.5"],
    ["295/80 R22,5", "295/80R22.5"],
    ["doscientos noventa y cinco ochenta erre veintidós punto cinco", "295/80R22.5"],
    ["doscientos noventa y cinco ochenta veintidós y medio", "295/80R22.5"],
    ["295 barra 80 erre 22.5", "295/80R22.5"],
    ["doscientos noventa y cinco sobre ochenta R veintidós coma cinco", "295/80R22.5"],
    ["295 80 22 5", "295/80R22.5"],
    ["trescientos quince ochenta erre veintidós cinco", "315/80R22.5"],
    ["once erre veintidós y medio", "11R22.5"],
    ["11 22.5", "11R22.5"],
    ["11 R 22.5", "11R22.5"],
    ["doce R veintidós punto cinco", "12R22.5"],
    ["doscientos quince setenta y cinco diecisiete y medio", "215/75R17.5"],
    ["mil R veinte", "10R20"],
    ["siete cincuenta erre dieciséis", "7.5R16"],
  ];
  for (const [spoken, want] of CASES) {
    it(`«${spoken}» -> ${want}`, () => {
      expect(sizesOf(spoken)).toEqual([want]);
    });
  }
  it("son al menos 12 formas distintas", () => {
    expect(new Set(CASES.map(([s]) => s)).size).toBeGreaterThanOrEqual(12);
  });
  it("no inventa medidas con números que no lo son", () => {
    expect(sizesOf("ocho llantas a doscientos cincuenta y cuatro a cuarenta y cinco días")).toEqual([]);
    expect(sizesOf("tienen 82 ómnibus y 3 camiones")).toEqual([]);
  });
});

describe("normalizeDictation: el pedido completo", () => {
  it("el ejemplo del punto 8 -> mismo texto que el cotizador entiende", () => {
    const r = normalizeDictation("cotízame ocho Flama 77 en 295 80 22.5 a 254 para ZBUSS, a 45 días");
    expect(r.text).toBe("Flama 77 295/80R22.5 x8 precio 254\npara ZBUSS\nplazo: 45 días");
    expect(r.sizes).toEqual(["295/80R22.5"]);
    const req = parseRequestRegex(r.text);
    expect(req.lines.map((l) => [l.model, l.size?.canonical, l.quantity, l.unitPrice])).toEqual([["FLAMA 77", "295/80R22.5", 8, 254]]);
    expect(req.customerCompany ?? req.customerName).toBe("ZBUSS");
    expect(req.paymentTerm).toBe("45 días");
  });
  it("marca del catálogo cuando el diseño es de una sola marca", () => {
    const r = normalizeDictation("cotízame ocho Flama 77 en 295 80 22.5", { designs: [{ brand: "Fenixway", model: "Flama 77" }, { brand: "Fenixway", model: "Valor 99" }] });
    expect(r.text).toBe("Fenixway Flama 77 295/80R22.5 x8");
  });
  it("todo en palabras, con docena, margen, descuento y plazo", () => {
    const r = normalizeDictation("cotízame una docena de Valor 99 en doce erre veintidós y medio a trescientos diez dólares para Transportes Beta con un margen de diez por ciento y descuento de cinco por ciento, crédito a treinta días");
    expect(r.text.split("\n")).toEqual(["Valor 99 12R22.5 x12 precio 310", "para Transportes Beta", "plazo: 30 días", "margen 10%", "dscto 5%"]);
    const req = parseRequestRegex(r.text);
    expect([req.lines[0].quantity, req.lines[0].unitPrice, req.marginPct, req.discountPct, req.paymentTerm]).toEqual([12, 310, 10, 5, "30 días"]);
  });
  it("dos llantas en una nota", () => {
    const r = normalizeDictation("cotiza ocho Flama 77 en 295 80 22.5 a 254 y cuatro Valor 87 en once erre veintidós y medio a 300 para ZBUSS");
    expect(r.text.split("\n")).toEqual(["Flama 77 295/80R22.5 x8 precio 254", "Valor 87 11R22.5 x4 precio 300", "para ZBUSS"]);
  });
  it("transcripción con ruido: muletillas, mayúsculas sueltas y puntuación", () => {
    const r = normalizeDictation("Eh, cotízame este... ocho llantas eh Flama setenta y siete en doscientos noventa y cinco, ochenta erre veintidós punto cinco, a doscientos cincuenta y cuatro dólares para zbuss. Mmm, a cuarenta y cinco días, gracias.");
    expect(r.sizes).toEqual(["295/80R22.5"]);
    const req = parseRequestRegex(r.text);
    expect(req.lines.map((l) => [l.model, l.size?.canonical, l.quantity, l.unitPrice])).toEqual([["FLAMA 77", "295/80R22.5", 8, 254]]);
    expect(req.customerCompany ?? req.customerName).toMatch(/zbuss/i);
    expect(req.paymentTerm).toBe("45 días");
  });
  it("sin medida: sin sizes (quien llama pregunta)", () => {
    expect(normalizeDictation("cotízame ocho Flama 77 para ZBUSS").sizes).toEqual([]);
  });
});

describe("checkSizes: contra el catálogo, nunca elige", () => {
  const CATALOG = ["295/80R22.5", "315/80R22.5", "275/80R22.5", "11R22.5", "12R22.5", "215/75R17.5", "10R20"];
  it("existe -> nada que preguntar", () => {
    expect(checkSizes(["295/80R22.5", "11R22.5"], CATALOG)).toEqual([]);
  });
  it("no existe -> candidatas parecidas (dos: se pregunta)", () => {
    expect(checkSizes(["285/80R22.5"], CATALOG)).toEqual([{ size: "285/80R22.5", candidates: ["275/80R22.5", "295/80R22.5"] }]);
    expect(checkSizes(["295/80R22"], CATALOG)).toEqual([{ size: "295/80R22", candidates: ["295/80R22.5"] }]);
    expect(checkSizes(["445/65R22.5"], CATALOG)).toEqual([{ size: "445/65R22.5", candidates: [] }]);
  });
  it("catálogo vacío: no valida", () => {
    expect(checkSizes(["999/99R99"], [])).toEqual([]);
  });
});

describe("correcciones por voz", () => {
  it("cantidad, precio, modelo, condiciones", () => {
    expect(normalizeVoiceCorrection("No, eran doce")).toEqual({ kind: "text", text: "cantidad 12" });
    expect(normalizeVoiceCorrection("no no, son 12 llantas")).toEqual({ kind: "text", text: "cantidad 12" });
    expect(normalizeVoiceCorrection("precio 259")).toEqual({ kind: "text", text: "precio 259" });
    expect(normalizeVoiceCorrection("Precio doscientos cincuenta y nueve.")).toEqual({ kind: "text", text: "precio 259" });
    expect(normalizeVoiceCorrection("cámbialo a Valor 99")).toEqual({ kind: "text", text: "modelo Valor 99" });
    expect(normalizeVoiceCorrection("Cámbialo a Valor noventa y nueve.")).toEqual({ kind: "text", text: "modelo Valor 99" });
    expect(normalizeVoiceCorrection("margen diez")).toEqual({ kind: "text", text: "margen 10" });
    expect(normalizeVoiceCorrection("descuento de cinco por ciento")).toEqual({ kind: "text", text: "dscto 5" });
    expect(normalizeVoiceCorrection("a sesenta días")).toEqual({ kind: "text", text: "plazo: 60 días" });
  });
  it("un ok dictado es confirmación (quien llama no arma el PDF por voz)", () => {
    expect(normalizeVoiceCorrection("Ok.")).toEqual({ kind: "confirm" });
    expect(normalizeVoiceCorrection("sí, dale")).toEqual({ kind: "confirm" });
    expect(normalizeVoiceCorrection("Sí, está bien, ármalo")).toEqual({ kind: "confirm" });
    expect(normalizeVoiceCorrection("Listo")).toEqual({ kind: "confirm" });
  });
});

// ── pasada 2 con Deepgram real (2026-11-13) ──
describe("Deepgram escribe «por ciento» como «por 100»", () => {
  it("margen 12 por 100 / descuento de 5 por 100: es porcentaje y no se pega al cliente", () => {
    const a = normalizeDictation("Cotiza 20 ADR 778 en 295, 80 r 22.5, para Cruz del Sur, margen 12 por 100.");
    expect(a.customer).toBe("Cruz del Sur");
    expect(a.text).toContain("margen 12%");
    const b = normalizeDictation("Cotízame 4 Fenixway Flama 89 en 275, 80 r 22.5, a 290, para RANSA, a 30 días, con descuento de 5 por 100.");
    expect(b.customer).toBe("RANSA");
    expect(b.text).toContain("dscto 5%");
    expect(b.text).toContain("plazo: 30 días");
  });

  it("«ADR 778» dictado con espacio recibe la marca del diseño ADR778 (única)", () => {
    const d = normalizeDictation("Cotiza 20 ADR 778 en 295 80 r 22.5", { designs: [{ brand: "Aonaite", model: "ADR778" }, { brand: "Fenixway", model: "Flama 77" }] });
    expect(d.items[0]).toBe("Aonaite ADR 778 295/80R22.5 x20");
  });
});

// corrida H (guion de Frank contra Postgres, por reglas): "Cotización de cuatro Valor 87 …" dejaba "ción" en la llanta
// ("Fenixway 295/80R22.5 CION VALOR 87"): la cabecera "cotiza" se comía el inicio de "cotización"
describe("cabecera de cotización dictada", () => {
  const cat = { designs: [{ brand: "Fenixway", model: "Valor 87" }] };
  it("«Cotización de …», «Hazme la cotización de …», «Necesito una cotización para …» no dejan restos en la llanta", () => {
    for (const t of ["Cotización de cuatro Valor 87 en 295 80 22.5", "cotización: cuatro Valor 87 en 295 80 22.5", "Hazme la cotización de cuatro Valor 87 en 295 80 22.5", "Necesito una cotización de cuatro Valor 87 en 295 80 22.5", "Cotízame cuatro Valor 87 en 295 80 22.5"]) {
      expect(normalizeDictation(t, cat).text, t).toBe("Fenixway Valor 87 295/80R22.5 x4");
    }
  });
});
