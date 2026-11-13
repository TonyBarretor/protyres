import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PriceRow } from "../../ingest/types";
import { JsonPortalStore } from "../store/json-portal-store";
import { expectedSchema } from "../store/migrate-guard";
import { TranscriptionError, VoiceNotConfigured, buildListenUrl, transcribe } from "./deepgram";
import { voiceCatalogFromRows } from "./catalog";
import { FIXED_KEYTERMS, KEYTERM_TOKEN_BUDGET, MAX_KEYTERMS, applyVocabulary, buildKeyterms, estimateTokens, parseLearnCommand } from "./vocabulary";

const OGG = "audio/ogg; codecs=opus";
const okBody = { metadata: { duration: 7.25 }, results: { channels: [{ alternatives: [{ transcript: " Visité a Zbuss hoy. ", confidence: 0.93 }] }] } };

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("deepgram.transcribe", () => {
  it("manda nova-3, español, keyterm repetido, el header y el mime; lee la respuesta", async () => {
    const f = fakeFetch(200, okBody);
    const r = await transcribe(Buffer.from("OggS..."), OGG, { apiKey: "dg-key", keyterms: ["Flama 77", "Fenixway", "flama 77", " "], fetchImpl: f.impl });
    expect(r).toEqual({ text: "Visité a Zbuss hoy.", confidence: 0.93, durationSec: 7.25 });
    expect(f.calls).toHaveLength(1);
    const u = new URL(f.calls[0].url);
    expect(u.origin + u.pathname).toBe("https://api.deepgram.com/v1/listen");
    expect(u.searchParams.get("model")).toBe("nova-3");
    expect(u.searchParams.get("language")).toBe("es");
    expect(u.searchParams.get("smart_format")).toBe("true");
    expect(u.searchParams.get("punctuate")).toBe("true");
    expect(u.searchParams.getAll("keyterm")).toEqual(["Flama 77", "Fenixway"]);
    expect(u.searchParams.has("keywords")).toBe(false);
    const h = f.calls[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Token dg-key");
    expect(h["Content-Type"]).toBe(OGG);
    expect(f.calls[0].init.method).toBe("POST");
  });

  it("error HTTP -> TranscriptionError con estado y detalle", async () => {
    const f = fakeFetch(401, { err_code: "INVALID_AUTH", err_msg: "Invalid credentials." });
    const p = transcribe(Buffer.from("x"), OGG, { apiKey: "mala", fetchImpl: f.impl });
    await expect(p).rejects.toBeInstanceOf(TranscriptionError);
    await expect(transcribe(Buffer.from("x"), OGG, { apiKey: "mala", fetchImpl: f.impl })).rejects.toThrow(/401: Invalid credentials/);
  });

  it("respuesta sin transcripción o red caída -> TranscriptionError", async () => {
    await expect(transcribe(Buffer.from("x"), OGG, { apiKey: "k", fetchImpl: fakeFetch(200, { results: {} }).impl })).rejects.toThrow(/sin transcripción/);
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(transcribe(Buffer.from("x"), OGG, { apiKey: "k", fetchImpl: down })).rejects.toThrow(/no respondió: ECONNRESET/);
  });

  it("sin clave -> VoiceNotConfigured sin llamar a la red", async () => {
    const f = fakeFetch(200, okBody);
    await expect(transcribe(Buffer.from("x"), OGG, { apiKey: "", fetchImpl: f.impl })).rejects.toBeInstanceOf(VoiceNotConfigured);
    await expect(transcribe(Buffer.from("x"), OGG, { apiKey: undefined, fetchImpl: f.impl })).rejects.toBeInstanceOf(VoiceNotConfigured);
    expect(f.calls).toHaveLength(0);
  });

  it("frases con espacios van codificadas en la URL", () => {
    expect(buildListenUrl(["Double Coin"])).toContain("keyterm=Double+Coin");
  });
});

describe("vocabulario", () => {
  it("buildKeyterms: fijos primero, aprendidos, clientes sin S.A.C., marcas y medidas, sin repetidos y dentro del límite", () => {
    const k = buildKeyterms({ companies: ["TRANSPORTES ZBUSS S.A.C.", "Flama 77"], learned: [{ term: "fenix guei", meaning: "Fenixway" }, { term: "pepe", meaning: "Pepe Llantas" }] });
    expect(k.slice(0, 4)).toEqual(FIXED_KEYTERMS);
    expect(k).toContain("Pepe Llantas");
    expect(k).toContain("TRANSPORTES ZBUSS");
    expect(k).toContain("Michelin");
    expect(k.filter((x) => x.toLowerCase() === "fenixway")).toHaveLength(1);
    expect(k.length).toBeLessThanOrEqual(MAX_KEYTERMS);
    expect(k.reduce((a, t) => a + estimateTokens(t), 0)).toBeLessThanOrEqual(KEYTERM_TOKEN_BUDGET);
  });

  it("buildKeyterms recorta con muchas empresas", () => {
    const many = Array.from({ length: 300 }, (_, i) => `EMPRESA DE TRANSPORTES NUMERO ${i} S.A.C.`);
    const k = buildKeyterms({ companies: many });
    expect(k.length).toBeLessThanOrEqual(MAX_KEYTERMS);
    expect(k.reduce((a, t) => a + estimateTokens(t), 0)).toBeLessThanOrEqual(KEYTERM_TOKEN_BUDGET);
    expect(k.slice(0, 4)).toEqual(FIXED_KEYTERMS);
  });

  it("buildKeyterms con el catálogo (punto 8): diseños y medidas del catálogo entran aunque haya muchas empresas, dentro del límite", () => {
    const rows: Pick<PriceRow, "brand" | "model" | "size" | "isTyre" | "kind">[] = [
      { brand: "Fenixway", model: "Flama 77", size: "295/80R22.5", isTyre: true, kind: "own" },
      { brand: "Fenixway", model: "Valor 99", size: "11R22.5", isTyre: true, kind: "own" },
      { brand: "Fenixway", model: "VALOR 99", size: "12R22.5", isTyre: true, kind: "provider" },
      { brand: "Aonaite", model: "ADR523", size: "445/65R22.5", isTyre: true, kind: "provider" },
      { brand: "Vipal", model: "Parche RS-35", size: "", isTyre: false, kind: "provider" },
    ];
    const catalog = voiceCatalogFromRows(rows);
    expect(catalog.designs.map((d) => d.model)).toEqual(["Valor 99", "Flama 77", "ADR523"]); // propio primero; luego por filas
    expect(catalog.sizes).toContain("445/65R22.5");
    expect(catalog.brands).toEqual(["Fenixway", "Aonaite"]);
    const many = Array.from({ length: 300 }, (_, i) => `EMPRESA DE TRANSPORTES NUMERO ${i} S.A.C.`);
    const k = buildKeyterms({ companies: many, catalog });
    expect(k.slice(0, 4)).toEqual(FIXED_KEYTERMS);
    for (const t of ["Valor 99", "ADR523", "Aonaite", "445/65R22.5"]) expect(k).toContain(t);
    expect(k.filter((x) => x.toLowerCase() === "valor 99")).toHaveLength(1);
    expect(k.length).toBeLessThanOrEqual(MAX_KEYTERMS);
    expect(k.reduce((a, t) => a + estimateTokens(t), 0)).toBeLessThanOrEqual(KEYTERM_TOKEN_BUDGET);
  });

  it("buildKeyterms con un catálogo grande respeta el tope de tokens", () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ brand: `Marca${i % 200}`, model: `Diseño largo número ${i}`, size: `${200 + (i % 250)}/80R22.5`, isTyre: true, kind: "provider" as const }));
    const k = buildKeyterms({ companies: ["TRANSPORTES ZBUSS S.A.C."], catalog: voiceCatalogFromRows(rows) });
    expect(k.length).toBeLessThanOrEqual(MAX_KEYTERMS);
    expect(k.reduce((a, t) => a + estimateTokens(t), 0)).toBeLessThanOrEqual(KEYTERM_TOKEN_BUDGET);
    expect(k).toContain("TRANSPORTES ZBUSS");
  });

  it("applyVocabulary reemplaza sin distinguir mayúsculas ni tildes, palabra completa, el más largo primero", () => {
    expect(applyVocabulary("Le ofrecí la Flama setenta y siete en 11R22.5")).toBe("Le ofrecí la Flama 77 en 11R22.5");
    expect(applyVocabulary("quiere fénix way", [])).toBe("quiere Fenixway");
    const vocab = [
      { term: "pepe", meaning: "Pepe Llantas" },
      { term: "pepe grande", meaning: "Pepe Grande SAC" },
    ];
    expect(applyVocabulary("hablé con PEPE grande y con pepe", vocab)).toBe("hablé con Pepe Grande SAC y con Pepe Llantas");
    expect(applyVocabulary("pepelucho no cambia", vocab)).toBe("pepelucho no cambia");
  });

  it("parseLearnCommand", () => {
    expect(parseLearnCommand("aprende flama setenta y siete = Flama 77")).toEqual({ term: "flama setenta y siete", meaning: "Flama 77" });
    expect(parseLearnCommand("Aprende \"zebus\" = ZBUSS")).toEqual({ term: "zebus", meaning: "ZBUSS" });
    expect(parseLearnCommand("aprende")).toBeNull();
    expect(parseLearnCommand("visité a zbuss")).toBeNull();
  });

  it("store JSON: añade, reemplaza sin duplicar (mayúsculas) y persiste", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-vocab-"));
    const file = path.join(dir, "store.json");
    const s = new JsonPortalStore(file);
    expect(await s.listVocabulary()).toEqual([]);
    const a = await s.addVocabulary({ term: "flama setenta y siete", meaning: "Flama 77", addedBy: 1 });
    expect(a.id).toBe(1);
    await s.addVocabulary({ term: "zebus", meaning: "ZBUSS" });
    const again = await s.addVocabulary({ term: "Flama Setenta y Siete", meaning: "FLAMA 77", addedBy: 2 });
    expect(again.id).toBe(1);
    await expect(s.addVocabulary({ term: " ", meaning: "x" })).rejects.toThrow();
    await s.flush();
    const loaded = await new JsonPortalStore(file).listVocabulary();
    expect(loaded.map((v) => [v.term, v.meaning, v.addedBy])).toEqual([
      ["flama setenta y siete", "FLAMA 77", 2],
      ["zebus", "ZBUSS", null],
    ]);
    expect(loaded[0].createdAt).toBeInstanceOf(Date);
    const s2 = new JsonPortalStore(file);
    expect((await s2.addVocabulary({ term: "nuevo", meaning: "Nuevo" })).id).toBe(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("la migración declara vocabulary y la guardia lee sus columnas", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "src/cli/migrate.ts"), "utf8");
    const stmt = /`(create table if not exists vocabulary[\s\S]*?)`/.exec(src)?.[1];
    expect(stmt).toBeTruthy();
    expect(expectedSchema([stmt!]).get("vocabulary")).toEqual(["id", "term", "meaning", "added_by", "created_at"]);
    expect(src).toMatch(/create unique index if not exists vocabulary_term_lower_idx on vocabulary \(lower\(term\)\)/);
  });
});
