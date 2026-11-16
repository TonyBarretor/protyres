/**
 * Corrida H, puntos 5 y 6: las transcripciones reales de Deepgram (fixtures/deepgram-varios-items.json; 36 notas de 2 a 5
 * llantas, 24 de Prosegur con UB y 12 correcciones dirigidas, 10 voces) dan lo que se revisó a mano: llantas separadas,
 * UB por línea, medida heredada y, cuando algo no se pudo separar con seguridad, la pregunta (nunca una llanta mezclada
 * ni descartada). Los errores de pura transcripción tienen su `nota` y no se fuerzan.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeDictation, spokenToDigits } from "./dictation";
import { TEST_CATALOG } from "./fixtures/test-catalog";
import { parseVoiceEdit } from "./items";

interface Caso {
  id: string;
  voice: string;
  said: string;
  heard: string;
  nota?: string;
  esperado: { texto?: string; pregunta?: string[]; ubPregunta?: { item: number; heard?: string }[]; hereda?: number[]; correccion?: unknown };
}

const { casos } = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "deepgram-varios-items.json"), "utf8")) as { casos: Caso[] };

describe("transcripciones reales de Deepgram con varias llantas", () => {
  it("hay al menos 30 notas de 2 a 5 llantas, de varias voces", () => {
    const multi = casos.filter((c) => !c.id.startsWith("c"));
    expect(multi.length).toBeGreaterThanOrEqual(30);
    expect(new Set(casos.map((c) => c.voice.replace(/ \((?:MX|ES)\)$/, ""))).size).toBeGreaterThanOrEqual(10);
  });

  for (const c of casos.filter((x) => !x.id.startsWith("c"))) {
    it(`${c.id} (${c.voice}): «${c.heard.slice(0, 70)}…»`, () => {
      const d = normalizeDictation(c.heard, TEST_CATALOG);
      expect(d.text).toBe(c.esperado.texto);
      expect(d.doubts).toEqual(c.esperado.pregunta ?? []);
      expect(d.ubIssues).toEqual(c.esperado.ubPregunta ?? []);
      expect(d.inherited.map((x) => x.item + 1)).toEqual(c.esperado.hereda ?? []);
      // nunca dos medidas en una llanta sin preguntar
      for (const line of d.items) if ((line.match(/\d+\/\d+R[\d.]+|\b\d{2}R[\d.]+/g) ?? []).length > 1) expect(d.doubts.length).toBeGreaterThan(0);
    });
  }

  for (const c of casos.filter((x) => x.id.startsWith("c"))) {
    it(`corrección ${c.id} (${c.voice}): «${c.heard}»`, () => {
      expect(parseVoiceEdit(spokenToDigits(c.heard))).toEqual(c.esperado.correccion);
    });
  }

  it("Prosegur, cotización 471 (las cinco líneas): cada línea con su UB y la medida heredada", () => {
    for (const id of ["p02", "p03", "p12"]) {
      const d = normalizeDictation(casos.find((c) => c.id === id)!.heard, TEST_CATALOG);
      expect(d.profile?.branch, id).toBe("Juliaca");
      expect(d.ubs, id).toEqual(["1231", "1812", "1911", "2005", "2201"]);
      expect(d.items.map((l) => l.match(/x(\d+)/)?.[1]), id).toEqual(["4", "4", "2", "4", "4"]);
      expect(d.items.map((l) => /valor 99/i.test(l)), id).toEqual([true, false, true, false, false]);
    }
  });
});
