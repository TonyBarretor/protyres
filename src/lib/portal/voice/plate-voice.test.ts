/**
 * Corrida J, punto 1.8: la placa por voz ("para la placa a be ce uno dos tres"). Se muestra siempre lo entendido; si no
 * tiene forma de placa, se pide escribirla; una llanta que no la repite no hereda la de la anterior; convive con el
 * dictado en forma de ficha y las correcciones libres de la corrida I; Prosegur no lleva placa. Transcripciones inventadas.
 */
import { describe, expect, it } from "vitest";
import { dictationNotes } from "../bot/voice-quote";
import { applyOps, draftFromText, draftToText } from "./draft-edit";
import { normalizeDictation, normalizeVoiceCorrection, plateCorrection, spokenToDigits } from "./dictation";
import { TEST_CATALOG } from "./fixtures/test-catalog";
import { extractSpokenPlates, readSpokenPlate } from "./items";

const SETTINGS = { currency: "USD", taxPct: 18, taxLabel: "IGV" };

describe("leer la placa dictada", () => {
  it("letras por su nombre, letras sueltas, cifras una a una o juntas, con guion", () => {
    const read = (s: string) => readSpokenPlate(spokenToDigits(s)).chars;
    expect(read("a be ce uno dos tres")).toBe("ABC123");
    expect(read("ABC-123")).toBe("ABC123");
    expect(read("abc ciento veintitrés")).toBe("ABC123");
    expect(read("a uno be dos tres cuatro")).toBe("A1B234");
    expect(read("doble ve a be cuatro cinco seis")).toBe("WAB456");
    expect(read("be ve ve siete cero cuatro")).toBe("BVV704");
    // para en lo que no encaja: el precio que sigue no es parte de la placa
    expect(readSpokenPlate("a be ce 1 2 3 a 254")).toMatchObject({ chars: "ABC123" });
    expect(readSpokenPlate("be ce 1 2 3 a 254").chars).toBe("BC123");
  });

  it("aparta cada placa con lo dicho, válida o no", () => {
    const r = extractSpokenPlates("4 valor 99 para la placa a be ce 1 2 3, y 2 flama 77 con placa be ce 1 2");
    expect(r.plates.map((p) => [p.value, p.valid, p.from])).toEqual([
      ["ABC-123", true, "para la placa a be ce 1 2 3"],
      ["BC12", false, "con placa be ce 1 2"],
    ]);
    expect(r.text).not.toMatch(/placa/);
  });
});

describe("cotización dictada con placa", () => {
  it("la placa va con su llanta; la siguiente no la hereda; «para la placa» nunca es el cliente", () => {
    const d = normalizeDictation("Cotízame cuatro Valor 99 en 295 80 22.5 para la placa a be ce uno dos tres, y dos Flama 77 en 11 R 22.5, para Transportes Sur", TEST_CATALOG);
    expect(d.items).toEqual(["Fenixway Valor 99 295/80R22.5 x4 placa ABC-123", "Fenixway Flama 77 11R22.5 x2"]);
    expect(d.customer).toBe("Transportes Sur");
    expect(d.plates).toEqual([{ item: 0, plate: "ABC-123", heard: "ABC-123", from: "para la placa a be ce 1 2 3" }]);
    expect(d.doubts).toEqual([]);
  });

  it("dos llantas del mismo vehículo, cada una dice su placa (8 de tracción y 2 direccionales)", () => {
    const d = normalizeDictation("Cotízame ocho Valor 89 en 295 80 22.5 placa a be ce uno dos tres, y dos Valor 99 en 295 80 22.5 placa a be ce uno dos tres, para Transportes Sur", TEST_CATALOG);
    expect(d.items).toEqual(["Fenixway Valor 89 295/80R22.5 x8 placa ABC-123", "Fenixway Valor 99 295/80R22.5 x2 placa ABC-123"]);
  });

  it("placa mal oída: no va en la línea, se muestra lo entendido y se pide escribirla", () => {
    const d = normalizeDictation("Cotízame cuatro Valor 99 en 295 80 22.5 para la placa be ce uno dos, para Transportes Sur", TEST_CATALOG);
    expect(d.items).toEqual(["Fenixway Valor 99 295/80R22.5 x4"]);
    expect(d.plates).toEqual([{ item: 0, plate: undefined, heard: "BC12", from: "para la placa be ce 1 2" }]);
    expect(dictationNotes(d, SETTINGS)).toContain("🚗 Línea 1: entendí «BC12» como placa, pero no tiene la forma de una placa (*ABC-123*): escríbela, *placa 1 ABC-123*.");
  });

  it("la placa entendida se muestra siempre", () => {
    const d = normalizeDictation("Cotízame cuatro Valor 99 en 295 80 22.5 para la placa a be ce uno dos tres, para Transportes Sur", TEST_CATALOG);
    expect(dictationNotes(d, SETTINGS)).toEqual(["🚗 Línea 1: placa *ABC-123* (entendí «para la placa a be ce 1 2 3»). Si no es, escríbela: *placa 1 ABC-123*."]);
  });

  it("en forma de ficha (corrida I): la placa es un dato más de la misma llanta", () => {
    const d = normalizeDictation("Cotízame. Fenixway, modelo Valor 96, 11 R 22.5, 18 PR, por 4 unidades, para la placa a be ce uno dos tres. Precio, 298 dólares. Para Transportes Sur.", TEST_CATALOG);
    expect(d.items).toEqual(["Fenixway Valor 96 11R22.5 18PR x4 precio 298 placa ABC-123"]);
    expect(d.single).toBeUndefined();
  });

  it("Prosegur no lleva placa: lo dicho no se entiende y se pregunta; la UB sigue igual", () => {
    const d = normalizeDictation("Prosegur Juliaca: cuatro Valor 99 UB 1231 placa a be ce uno dos tres", TEST_CATALOG);
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toContain("ub 1231");
    expect(d.items[0]).not.toContain("placa");
    expect(d.plates).toEqual([]);
    expect(d.doubts).toContain("no entendí «placa a be ce 1 2 3»: en Prosegur cada llanta lleva UB, no placa");
  });
});

describe("correcciones por voz con la cotización a la vista", () => {
  it("poner, cambiar y quitar la placa de una línea", () => {
    expect(normalizeVoiceCorrection("la placa del segundo es a be ce uno dos tres")).toEqual({ kind: "text", text: "placa 2 ABC-123" });
    expect(normalizeVoiceCorrection("placa a be ce uno dos tres")).toEqual({ kind: "text", text: "placa ABC-123" });
    expect(normalizeVoiceCorrection("ponle placa al primero be ve ve siete cero cuatro")).toEqual({ kind: "text", text: "placa 1 BVV-704" });
    expect(normalizeVoiceCorrection("sin placa el segundo")).toEqual({ kind: "text", text: "sin placa 2" });
    // lo que no tiene forma de placa va tal cual: el cotizador pide escribirla
    expect(plateCorrection("placa del 2 es be ce 1 2")).toBe("placa 2 BC12");
    // lo demás sigue igual
    expect(normalizeVoiceCorrection("eran doce")).toEqual({ kind: "text", text: "cantidad 12" });
  });
});

describe("borrador por voz (corrida I) con placa", () => {
  it("las operaciones sobre el borrador conservan la placa de cada línea; unir dos con placas distintas no se hace", () => {
    const draft = draftFromText("Fenixway Valor 99 295/80R22.5 x4 placa ABC-123\nFenixway Valor 99 295/80R22.5 x2 placa XYZ-789\npara Transportes Sur");
    const a = applyOps(draft, [{ op: "quantity", line: 1, value: 6 }], ["Fenixway"]);
    expect(draftToText(a.draft)).toBe("Fenixway Valor 99 295/80R22.5 x6 placa ABC-123\nFenixway Valor 99 295/80R22.5 x2 placa XYZ-789\npara Transportes Sur");
    const b = applyOps(draft, [{ op: "merge", lines: [1, 2] }], ["Fenixway"]);
    expect(b.failed.join(" ")).toContain("placas");
  });
});
