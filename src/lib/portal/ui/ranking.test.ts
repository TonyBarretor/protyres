import { describe, expect, it } from "vitest";
import { loadRankingForDashboard } from "../dashboard/ranking";
import { JsonPortalStore } from "../store/json-portal-store";
import { assignReturnPath, buildValidationRows, MAX_VALIDATION_ROWS, NOTE_MAX, parseValidationForm } from "./ranking";

function form(entries: Record<string, string>) {
  return { get: (name: string) => (name in entries ? entries[name] : null) };
}

describe("validar ranking: formulario", () => {
  it("solo las respondidas, respuestas válidas, nota recortada, sin repetir", () => {
    const got = parseValidationForm(
      form({
        ids: "10,11,12,13,10,abc,-1",
        nivel_10: "A",
        nota_10: "  flota grande,   paga a tiempo  ",
        nivel_11: "desconocida",
        nivel_12: "Z",
        nota_12: "sin respuesta: no se guarda",
        nota_13: "solo nota",
      }),
    );
    expect(got).toEqual([
      { companyId: 10, nivelVendedor: "A", nota: "flota grande, paga a tiempo" },
      { companyId: 11, nivelVendedor: "desconocida", nota: null },
    ]);
  });

  it("como mucho 20 empresas; la nota hasta ~500 caracteres", () => {
    const ids = Array.from({ length: 30 }, (_, i) => i + 1);
    const entries: Record<string, string> = { ids: ids.join(",") };
    for (const id of ids) entries[`nivel_${id}`] = "B";
    entries.nota_1 = "x".repeat(2000);
    const got = parseValidationForm(form(entries));
    expect(got).toHaveLength(MAX_VALIDATION_ROWS);
    expect(got[0].nota).toHaveLength(NOTE_MAX);
    expect(parseValidationForm(form({}))).toEqual([]);
  });

  it("nivel y puntaje del sistema se leen de la base, nunca del formulario; empresas inexistentes se ignoran", async () => {
    const store = JsonPortalStore.memory();
    const r = await store.upsertCompanies([
      { ruc: "20100000001", razonSocial: "UNO SAC", unidades: 20 },
      { ruc: "20100000002", razonSocial: "DOS SAC", unidades: 30 },
    ]);
    const [a, b] = [r.ids["20100000001"], r.ids["20100000002"]];
    await store.saveScores(
      [{ companyId: a, score: 81.5, nivel: "A", detalle: { v: 1, factores: [], frenos: [], nivelBase: "A" } }],
      new Date("2026-11-14T15:00:00Z"),
    );
    const answers = parseValidationForm(form({ ids: `${a},${b},999`, nivel_1: "A", [`nivel_${a}`]: "C", [`nivel_${b}`]: "B", nivel_999: "A", nivelSistema: "C", scoreSistema: "1" }));
    const rows = await buildValidationRows(answers, store, 7);
    expect(rows).toEqual([
      { userId: 7, companyId: a, nivelVendedor: "C", nota: null, nivelSistema: "A", scoreSistema: 81.5 },
      { userId: 7, companyId: b, nivelVendedor: "B", nota: null, nivelSistema: null, scoreSistema: null },
    ]);
  });
});

describe("Asignarme desde Hoy: a dónde vuelve", () => {
  it("solo /portal/hoy; cualquier otra cosa vuelve a la ficha", () => {
    expect(assignReturnPath(form({ volver: "/portal/hoy" }), 5)).toBe("/portal/hoy");
    expect(assignReturnPath(form({}), 5)).toBe("/portal/empresas/5");
    for (const v of ["https://evil.example/portal/hoy", "//evil.example", "/portal/hoy/../../x", "/portal/hoy?x=1", "/portal", "/portal/pipeline"]) {
      expect(assignReturnPath(form({ volver: v }), 5)).toBe("/portal/empresas/5");
    }
  });
});

describe("tablero: validación del ranking", () => {
  it("solo el admin; nombres de empresas y vendedores; sin respuestas = informe vacío", async () => {
    const store = JsonPortalStore.memory();
    const admin = await store.upsertUser({ nombre: "Tony Admin", whatsapp: "51900000009", rol: "admin" });
    const frank = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
    const sup = await store.upsertUser({ nombre: "Sofía Supervisora", whatsapp: "51900000003", rol: "supervisor" });
    expect(await loadRankingForDashboard(frank, store)).toBeNull();
    expect(await loadRankingForDashboard(sup, store)).toBeNull();
    const empty = await loadRankingForDashboard(admin, store);
    expect(empty?.report.respuestas).toBe(0);
    const r = await store.upsertCompanies([{ ruc: "20100000001", razonSocial: "UNO SAC", unidades: 20 }]);
    const id = r.ids["20100000001"];
    await store.addRankingValidations([{ userId: frank.id, companyId: id, nivelVendedor: "C", nota: "ya no opera", nivelSistema: "A", scoreSistema: 80 }]);
    const d = await loadRankingForDashboard(admin, store);
    expect(d?.report).toMatchObject({ respuestas: 1, comparables: 1, coincidencias: 0, pctCoincidencia: 0 });
    expect(d?.companyName[id]).toBe("UNO SAC");
    expect(d?.userName[frank.id]).toBe("Frank Rodríguez");
  });
});
