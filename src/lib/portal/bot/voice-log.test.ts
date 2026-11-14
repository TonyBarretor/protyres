/**
 * Registro de transcripciones de voz (corrida F, punto 9): lo entendido de un pedido dictado y el store JSON (filtros por
 * resultado, usuario y fecha; persiste en el archivo).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonPortalStore } from "../store";
import type { VoiceUnderstood } from "../store/types";
import { normalizeDictation } from "../voice/dictation";
import { understoodOf } from "./voice-log";

const U: VoiceUnderstood = { sizes: [], quantities: [], brand: null, design: null, customer: null, questions: [], fixes: [] };

describe("understoodOf", () => {
  it("medida, cantidad, marca, diseño, cliente y correcciones del pedido dictado", () => {
    const d = normalizeDictation("Cotízame 8 Fenix Way valor 99 en 295 80, ER 22.5 para ZBUSS.", { sizes: ["295/80R22.5"], brands: ["Fenixway"], designs: [{ brand: "Fenixway", model: "Valor 99" }] });
    expect(understoodOf(d)).toEqual({
      sizes: ["295/80R22.5"],
      quantities: [8],
      brand: "Fenixway",
      design: "valor 99",
      customer: "ZBUSS",
      questions: [],
      fixes: [
        { from: "Fenix Way", to: "Fenixway" },
        { from: "295 80, ER 22.5", to: "295/80R22.5" },
      ],
      text: "Fenixway valor 99 295/80R22.5 x8\npara ZBUSS",
    });
  });
});

describe("JsonPortalStore: voice_transcripts", () => {
  it("lista la más reciente primero, filtra por resultado, usuario y fecha, y persiste", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "voice-log-")), "portal.json");
    const s = new JsonPortalStore(file);
    await s.logVoiceTranscript({ phone: "51900000001", userId: 1, context: "cotizacion", transcript: "a", understood: U, outcome: "ok", createdAt: new Date("2026-11-13T15:00:00Z") });
    await s.logVoiceTranscript({ phone: "51900000001", userId: 1, context: "medida", transcript: "b", understood: { ...U, questions: ["medida no reconocida"] }, outcome: "fallo", createdAt: new Date("2026-11-14T15:00:00Z") });
    await s.logVoiceTranscript({ phone: "51900000002", userId: 2, context: "cotizacion", transcript: "c", understood: U, outcome: "pregunta", createdAt: new Date("2026-11-14T16:00:00Z") });
    expect((await s.listVoiceTranscripts()).map((r) => r.transcript)).toEqual(["c", "b", "a"]);
    expect((await s.listVoiceTranscripts({ outcomes: ["fallo", "pregunta"] })).map((r) => r.transcript)).toEqual(["c", "b"]);
    expect((await s.listVoiceTranscripts({ userId: 1 })).map((r) => r.transcript)).toEqual(["b", "a"]);
    expect((await s.listVoiceTranscripts({ since: new Date("2026-11-14T00:00:00Z"), until: new Date("2026-11-14T15:30:00Z") })).map((r) => r.transcript)).toEqual(["b"]);
    expect((await s.listVoiceTranscripts({ limit: 1 })).map((r) => r.transcript)).toEqual(["c"]);
    await s.close();
    const again = new JsonPortalStore(file);
    const [last] = await again.listVoiceTranscripts({ limit: 1, phone: "51900000001" });
    expect(last).toMatchObject({ transcript: "b", outcome: "fallo", context: "medida", userId: 1 });
    expect(last.createdAt).toBeInstanceOf(Date);
    expect(last.understood.questions).toEqual(["medida no reconocida"]);
  });
});
