import { describe, expect, it, vi } from "vitest";
import type { Contact, Opportunity } from "../store/types";
import {
  CONFIRM_LINE,
  advancesStage,
  applyCorrection,
  draftByRules,
  draftToRecords,
  formatDraftSummary,
  isConfirmation,
  isRejection,
  makeDraft,
  nextQuestion,
  type ReportDraft,
} from "./draft";
import { extractReport, type ExtractContext, type ExtractedReport, type LlmClient } from "./extract";
import type { CompanyRef } from "./match";

// miércoles 11/11/2026 15:00 en Lima
const NOW = new Date("2026-11-11T20:00:00Z");
const COMPANIES: CompanyRef[] = [
  { id: 1, razonSocial: "TRANSPORTES ZBUSS S.A.C.", ruc: "20600000001" },
  { id: 2, razonSocial: "EXPRESO ANDINO S.A.C.", ruc: "20600000002" },
  { id: 3, razonSocial: "EXPRESO ANDINO CARGO S.A.C.", ruc: "20600000003" },
];
const CTX: ExtractContext = { now: NOW, vendedor: { id: 7, nombre: "Frank" }, companies: COMPANIES, vocabulary: [{ term: "zebus", meaning: "Zbuss" }] };

const GOOD: ExtractedReport = {
  empresa: { nombre: "Zbuss", ruc: null },
  tipo: "visita",
  contacto: { nombre: "Juan Pérez", cargo: "Jefe de flota" },
  interes: { medidas: ["295/80R22.5"], posicion: "tracción", cantidades: "40 llantas al mes", notas: "Usa Michelin" },
  proximaAccion: { texto: "Enviar cotización", fecha: "2026-11-13T10:00:00-05:00" },
  etapaSugerida: "visita_realizada",
  ocurrioEn: "2026-11-11T10:00:00-05:00",
  confianza: "alta",
  faltantes: [],
};

function fakeClient(...inputs: unknown[]) {
  const create = vi.fn(async () => {
    const input = inputs.shift();
    return { content: [{ type: "tool_use" as const, id: `tu_${inputs.length}`, name: "registrar_reporte", input }] };
  });
  return { client: { messages: { create } } as unknown as LlmClient, create };
}

describe("extractReport", () => {
  it("JSON válido del modelo: valida, ajusta la empresa a la lista y pasa contexto (Lima, vendedor, empresas, etapas, vocabulario)", async () => {
    const { client, create } = fakeClient(GOOD);
    const r = await extractReport("visité a zebus hoy a las 10", CTX, { client, model: "test-model" });
    expect(r.via).toBe("llm");
    expect(r.text).toBe("visité a Zbuss hoy a las 10");
    expect(r.report.empresa).toEqual({ nombre: "TRANSPORTES ZBUSS S.A.C.", ruc: "20600000001" });
    expect(create).toHaveBeenCalledTimes(1);
    const params = (create.mock.calls[0] as unknown[])[0] as { model: string; system: string; tool_choice: unknown; tools: { name: string }[] };
    expect(params.model).toBe("test-model");
    expect(params.tool_choice).toEqual({ type: "tool", name: "registrar_reporte" });
    expect(params.system).toContain("2026-11-11T15:00:00-05:00");
    expect(params.system).toContain("Frank");
    expect(params.system).toContain("EXPRESO ANDINO S.A.C. (RUC 20600000002)");
    expect(params.system).toContain("cita_agendada");
    expect(params.system).toContain('"zebus" = Zbuss');
  });

  it("respuesta inválida -> un reintento con el error como tool_result; la segunda vale", async () => {
    const { client, create } = fakeClient({ ...GOOD, tipo: "almuerzo" }, GOOD);
    const r = await extractReport("visité a zbuss", CTX, { client });
    expect(r.via).toBe("llm");
    expect(r.report.tipo).toBe("visita");
    expect(create).toHaveBeenCalledTimes(2);
    const second = (create.mock.calls[1] as unknown[])[0] as { messages: { role: string; content: unknown }[] };
    expect(second.messages).toHaveLength(3);
    expect(JSON.stringify(second.messages[2].content)).toMatch(/tool_result.*tipo/);
  });

  it("dos respuestas inválidas -> reglas (confianza baja)", async () => {
    const { client, create } = fakeClient({ nada: 1 }, { tipo: "x" });
    const r = await extractReport("Llamé a Zbuss", CTX, { client });
    expect(create).toHaveBeenCalledTimes(2);
    expect(r.via).toBe("rules");
    expect(r.report.tipo).toBe("llamada");
    expect(r.report.confianza).toBe("baja");
  });

  it("error del API -> reglas", async () => {
    const client = { messages: { create: vi.fn(async () => Promise.reject(new Error("overloaded"))) } } as unknown as LlmClient;
    const r = await extractReport("visité a zbuss", CTX, { client });
    expect(r.via).toBe("rules");
  });

  it("sin clave -> reglas: tipo por verbo, empresa por la lista, medidas, contacto, fechas", async () => {
    const r = await extractReport(
      "Visité a Zbuss, hablé con Juan Pérez, gerente de flota. Usan 295/80R22.5 y 11R22.5 en tracción, 40 llantas al mes. Quedamos en llamarlo el viernes a las 10am",
      CTX,
      { client: null },
    );
    expect(r.via).toBe("rules");
    const rep = r.report;
    expect(rep.tipo).toBe("visita");
    expect(rep.empresa).toEqual({ nombre: "TRANSPORTES ZBUSS S.A.C.", ruc: "20600000001" });
    expect(rep.contacto).toEqual({ nombre: "Juan Pérez", cargo: "Gerente de flota" });
    expect(rep.interes.medidas).toEqual(["295/80R22.5", "11R22.5"]);
    expect(rep.interes.posicion).toBe("tracción");
    expect(rep.interes.cantidades).toBe("40 llantas al mes");
    expect(rep.proximaAccion).toEqual({ texto: "Llamar", fecha: "2026-11-13T10:00:00-05:00" });
    expect(rep.etapaSugerida).toBe("visita_realizada");
    expect(rep.confianza).toBe("baja");
    expect(rep.faltantes).toEqual([]);
  });

  it("reglas: empresa ambigua o ausente queda en faltantes; 'ayer' fija ocurrioEn", async () => {
    const r = await extractReport("ayer llamé a los de andino", CTX, { client: null });
    expect(r.report.empresa).toBeNull();
    expect(r.report.faltantes).toContain("empresa");
    expect(r.report.ocurrioEn).toBe("2026-11-10T15:00:00-05:00");
    const byRuc = await extractReport("nota: 20600000003 pide precios", CTX, { client: null });
    expect(byRuc.report.empresa?.ruc).toBe("20600000003");
    expect(byRuc.report.tipo).toBe("nota");
    expect(byRuc.report.faltantes).toContain("tipo");
  });
});

function draftOf(report: ExtractedReport, canal: "whatsapp" | "voz" = "whatsapp"): ReportDraft {
  return makeDraft(report, { companies: COMPANIES, canal, texto: "texto", messageAt: NOW, via: "llm" });
}

describe("borrador", () => {
  it("resumen con datos y la línea final exacta", () => {
    const d = draftOf(GOOD);
    expect(d.companyId).toBe(1);
    const s = formatDraftSummary(d);
    expect(s.split("\n").at(-1)).toBe("¿Está bien? Responde *sí* o corrige");
    expect(s.endsWith(CONFIRM_LINE)).toBe(true);
    expect(s).toContain("*Reporte de visita* — TRANSPORTES ZBUSS (RUC 20600000001)");
    expect(s).toContain("Juan Pérez — Jefe de flota");
    expect(s).toContain("295/80R22.5 · tracción · 40 llantas al mes");
    expect(s).toContain("Enviar cotización");
    expect(s).toContain("Visita realizada");
    const sinEmpresa = formatDraftSummary(draftOf({ ...GOOD, empresa: null, proximaAccion: { texto: "Llamar", fecha: null } }));
    expect(sinEmpresa).toContain("_(sin identificar)_");
    expect(sinEmpresa).toContain("Llamar _(sin fecha)_");
    expect(sinEmpresa.endsWith(CONFIRM_LINE)).toBe(true);
  });

  it("una pregunta a la vez: empresa (lista si es ambigua) > tipo si confianza baja > fecha de la próxima acción", async () => {
    let d = draftOf({ ...GOOD, empresa: { nombre: "Andino" }, confianza: "baja", proximaAccion: { texto: "Llamar", fecha: null } });
    expect(d.candidates.map((c) => c.id)).toEqual([2, 3]);
    let q = nextQuestion(d)!;
    expect(q.field).toBe("empresa");
    expect(q.text).toMatch(/1\. EXPRESO ANDINO \(RUC 20600000002\)\n2\. EXPRESO ANDINO CARGO/);
    d = await applyCorrection(d, "2", { ctx: CTX, extract: null });
    expect(d.companyId).toBe(3);
    q = nextQuestion(d)!;
    expect(q.field).toBe("tipo");
    d = await applyCorrection(d, "llamada", { ctx: CTX, extract: null });
    expect(d.tipo).toBe("llamada");
    q = nextQuestion(d)!;
    expect(q.field).toBe("proximaAccion.fecha");
    d = await applyCorrection(d, "viernes 10am", { ctx: CTX, extract: null });
    expect(d.proximaAccion?.fecha).toBe("2026-11-13T10:00:00-05:00");
    expect(nextQuestion(d)).toBeNull();
  });

  it("'sin fecha' / 'no sé' responden la pregunta sin cambiar nada", async () => {
    const d = draftOf({ ...GOOD, proximaAccion: { texto: "Llamar", fecha: null } });
    expect(nextQuestion(d)?.field).toBe("proximaAccion.fecha");
    const d2 = await applyCorrection(d, "sin fecha", { ctx: CTX, extract: null });
    expect(d2.proximaAccion).toEqual({ texto: "Llamar", fecha: null });
    expect(nextQuestion(d2)).toBeNull();
  });

  it("empresa sin coincidencia pide nombre o RUC; responder con RUC la fija", async () => {
    const d = draftOf({ ...GOOD, empresa: null });
    expect(nextQuestion(d)?.text).toMatch(/nombre o el RUC/);
    const d2 = await applyCorrection(d, "20600000001", { ctx: CTX, extract: null });
    expect(d2.companyId).toBe(1);
  });

  it("corrección con el modelo simulado: recibe el borrador y el texto; la empresa se re-resuelve si cambia", async () => {
    const extract = vi.fn(async (cur: ExtractedReport, text: string) => {
      expect(text).toBe("no, fue con el gerente general");
      return { ...cur, contacto: { nombre: null, cargo: "Gerente general" } };
    });
    const d = await applyCorrection(draftOf(GOOD), "no, fue con el gerente general", { ctx: CTX, extract });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(d.contacto).toEqual({ nombre: null, cargo: "Gerente general" });
    expect(d.companyId).toBe(1);

    const viaClient = fakeClient({ ...GOOD, empresa: { nombre: "Expreso Andino Cargo", ruc: null } });
    const d2 = await applyCorrection(draftOf(GOOD), "no, era expreso andino cargo", { ctx: CTX, deps: { client: viaClient.client } });
    expect(viaClient.create).toHaveBeenCalledTimes(1);
    expect(d2.companyId).toBe(3);
    expect(d2.empresa?.ruc).toBe("20600000003");
  });

  it("corrección sin modelo: cargo y fecha de la próxima acción por reglas", async () => {
    const d = await applyCorrection(draftOf(GOOD), "no, fue con el gerente", { ctx: CTX, extract: null });
    expect(d.contacto).toEqual({ nombre: null, cargo: "Gerente" });
    const d2 = await applyCorrection(draftOf(GOOD), "la llamada es el viernes a las 4", { ctx: CTX, extract: null });
    expect(d2.proximaAccion?.fecha).toBe("2026-11-13T16:00:00-05:00");
    expect(d2.proximaAccion?.texto).toBe("Enviar cotización");
  });

  it("confirmación y rechazo", () => {
    for (const t of ["sí", "si", "Sí.", "ok", "OK!", "correcto", "dale", "está bien", "Sí, está bien", "confirmo", "👍"]) expect(isConfirmation(t), t).toBe(true);
    for (const t of ["no", "si pero fue el lunes", "no, fue con el gerente", "", "sigue"]) expect(isConfirmation(t), t).toBe(false);
    for (const t of ["no", "No.", "cancelar", "Cancela"]) expect(isRejection(t), t).toBe(true);
    for (const t of ["no, fue con el gerente", "sí", "no fue visita"]) expect(isRejection(t), t).toBe(false);
  });

  it("draftByRules arma un borrador completo sin modelo", () => {
    const d = draftByRules("visité a zbuss", CTX, "voz", NOW);
    expect(d.companyId).toBe(1);
    expect(d.canal).toBe("voz");
    expect(d.via).toBe("rules");
    expect(nextQuestion(d)?.field).toBe("tipo");
  });
});

describe("draftToRecords", () => {
  const opp = (etapa: Opportunity["etapa"]): Opportunity => ({
    id: 50,
    companyId: 1,
    ownerUserId: 7,
    etapa,
    probabilidad: 0,
    montoEstimado: null,
    cierreEsperado: null,
    proximaAccion: null,
    proximaAccionAt: null,
    quoteNumber: null,
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
  });
  const contact = (nombre: string): Contact => ({ id: 1, companyId: 1, nombre, cargo: null, telefono: null, email: null, notas: null, createdBy: 7, createdAt: NOW, updatedAt: NOW });
  const later = new Date("2026-11-11T20:05:00Z");

  it("actividad con canal, data, occurredAt del reporte y createdAt ahora; avanza etapa; próxima acción; contacto nuevo", () => {
    const r = draftToRecords(draftOf(GOOD, "voz"), { userId: 7, now: later, opportunity: opp("cita_agendada"), contacts: [contact("Rosa Díaz")] });
    expect(r.activity.companyId).toBe(1);
    expect(r.activity.opportunityId).toBe(50);
    expect(r.activity.tipo).toBe("visita");
    expect(r.activity.canal).toBe("voz");
    expect(r.activity.occurredAt.toISOString()).toBe("2026-11-11T15:00:00.000Z");
    expect(r.activity.createdAt).toBe(later);
    expect(r.activity.texto).toContain("Visita con Juan Pérez — Jefe de flota");
    expect((r.activity.data as { reporte: ExtractedReport }).reporte.tipo).toBe("visita");
    expect(r.stageChange).toEqual({ opportunityId: 50, from: "cita_agendada", to: "visita_realizada" });
    expect(r.opportunityPatch).toEqual({ opportunityId: 50, patch: { proximaAccion: "Enviar cotización", proximaAccionAt: new Date("2026-11-13T15:00:00Z") } });
    expect(r.newContact).toEqual({ companyId: 1, nombre: "Juan Pérez", cargo: "Jefe de flota", createdBy: 7 });
    expect(r.newOpportunity).toBeNull();
  });

  it("nunca retrocede de etapa ni toca una cerrada; contacto existente no se duplica; sin ocurrioEn usa la hora del mensaje", () => {
    const d = draftOf({ ...GOOD, ocurrioEn: null });
    const r = draftToRecords(d, { userId: 7, now: later, opportunity: opp("negociacion"), contacts: [contact("juan perez")] });
    expect(r.stageChange).toBeNull();
    expect(r.newContact).toBeNull();
    expect(r.activity.occurredAt.toISOString()).toBe(NOW.toISOString());
    expect(r.activity.canal).toBe("whatsapp");
    expect(draftToRecords(d, { userId: 7, now: later, opportunity: opp("cerrado_ganado"), contacts: [] }).stageChange).toBeNull();
    expect(advancesStage("prospecto", "visita_realizada")).toBe(true);
    expect(advancesStage("cotizacion_enviada", "visita_realizada")).toBe(false);
    expect(advancesStage("cerrado_perdido", "negociacion")).toBe(false);
  });

  it("sin oportunidad abierta: la crea en la etapa sugerida con la próxima acción", () => {
    const r = draftToRecords(draftOf(GOOD), { userId: 7, now: later, opportunity: null, contacts: [] });
    expect(r.newOpportunity).toMatchObject({ companyId: 1, ownerUserId: 7, etapa: "visita_realizada", proximaAccion: "Enviar cotización", createdBy: 7 });
    expect(r.stageChange).toBeNull();
    expect(r.activity.opportunityId).toBeNull();
  });

  it("sin empresa identificada lanza", () => {
    expect(() => draftToRecords(draftOf({ ...GOOD, empresa: null }), { userId: 7, now: later, opportunity: null, contacts: [] })).toThrow(/empresa/);
  });
});
