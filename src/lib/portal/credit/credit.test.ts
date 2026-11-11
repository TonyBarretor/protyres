import { describe, expect, it } from "vitest";
import { JsonPortalStore } from "../store";
import type { CompanyCredit, CreditEstado, PortalUser, UserRole } from "../store/types";
import { describeCreditChanges } from "./format";
import { EquifaxCreditProvider, getCreditBureauProvider, MANUAL_MESSAGE, ManualCreditProvider } from "./provider";
import { CREDIT_ESTADOS, canTransition, creditEstadoLabel, nextEstados, validateCredit } from "./states";
import { defaultUpdateTerms, parseCreditForm, planCreditUpdate, readCreditPdf, type CreditForm } from "./update";
import { creditWarning, creditWarningLine } from "./warning";

const ALL: CreditEstado[] = ["sin_evaluar", "en_evaluacion", "aprobado", "observado", "rechazado"];
const RUC = "20999000011";
const RAZON = "TRANSPORTES ANDES DEL PERU S.A.C.";

const user = (id: number, rol: UserRole, activo = true): PortalUser => ({ id, nombre: `u${id}`, whatsapp: null, rol, activo, createdAt: new Date() });
const form = (f: Partial<CreditForm> & { estado: CreditEstado }): CreditForm => ({
  calificacion: null,
  linea: null,
  moneda: null,
  plazoDias: null,
  fuente: null,
  consultadoAt: null,
  notas: null,
  quitarPdf: false,
  actualizarPlazo: false,
  ...f,
});
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n%fake\n");

async function seeded() {
  const store = JsonPortalStore.memory();
  const r = await store.upsertCompanies([{ ruc: RUC, razonSocial: RAZON, unidades: 12 }]);
  return { store, id: r.ids[RUC] };
}

describe("crédito: transiciones", () => {
  it("máquina de estados documentada", () => {
    const valid: Record<CreditEstado, CreditEstado[]> = {
      sin_evaluar: ["en_evaluacion", "aprobado", "observado", "rechazado"],
      en_evaluacion: ["aprobado", "observado", "rechazado"],
      aprobado: ["en_evaluacion", "observado", "rechazado"],
      observado: ["en_evaluacion", "aprobado", "rechazado"],
      rechazado: ["en_evaluacion"],
    };
    for (const from of ALL) {
      for (const to of ALL) expect(canTransition(from, to), `${from} -> ${to}`).toBe(from === to || valid[from].includes(to));
      expect(nextEstados(from)).toEqual([from, ...valid[from]]);
    }
  });

  it("inválidas: nada vuelve a sin evaluar; rechazado no pasa directo a aprobado", () => {
    for (const from of ALL.filter((e) => e !== "sin_evaluar")) expect(canTransition(from, "sin_evaluar")).toBe(false);
    expect(canTransition("rechazado", "aprobado")).toBe(false);
    expect(canTransition("rechazado", "observado")).toBe(false);
    expect(canTransition("en_evaluacion", "sin_evaluar")).toBe(false);
  });

  it("etiquetas", () => {
    expect(CREDIT_ESTADOS.map((s) => s.label)).toEqual(["sin evaluar", "en evaluación", "aprobado", "observado", "rechazado"]);
    expect(creditEstadoLabel(null)).toBe("sin evaluar");
  });

  it("validación por estado: aprobado exige línea y plazo; observado/rechazado exigen nota", () => {
    expect(validateCredit({ estado: "aprobado" })).toHaveLength(2);
    expect(validateCredit({ estado: "aprobado", linea: 50000 })).toEqual(["Para aprobar, indica el plazo aprobado (días)."]);
    expect(validateCredit({ estado: "aprobado", linea: 50000, plazoDias: 0 })).toEqual([]);
    expect(validateCredit({ estado: "aprobado", linea: 0, plazoDias: 30 })).toEqual(["Para aprobar, indica la línea aprobada."]);
    expect(validateCredit({ estado: "observado" })).toHaveLength(1);
    expect(validateCredit({ estado: "rechazado", notas: "   " })).toHaveLength(1);
    expect(validateCredit({ estado: "rechazado", notas: "deuda vencida" })).toEqual([]);
    expect(validateCredit({ estado: "en_evaluacion" })).toEqual([]);
    expect(validateCredit({ estado: "en_evaluacion", plazoDias: 400 })).toEqual(["El plazo debe ser de 0 a 365 días."]);
    expect(validateCredit({ estado: "en_evaluacion", linea: Number.NaN })).toEqual(["La línea debe ser un monto positivo."]);
    expect(validateCredit({ estado: "en_evaluacion", moneda: "EUR" })).toEqual(["Moneda no válida (USD o PEN)."]);
  });
});

describe("crédito: formulario y server action (lógica pura)", () => {
  const company = { id: 7, ownerUserId: 1, creditTermsDays: null };
  const now = new Date("2026-11-11T15:00:00Z");

  it("parseCreditForm: montos con comas, días, fecha de Lima, notas con saltos de línea", () => {
    const r = parseCreditForm(fd({ estado: "aprobado", linea: "50,000.50", moneda: "usd", plazoDias: "45 días", consultadoAt: "2026-11-10", notas: "línea 1\r\nlínea 2", actualizarPlazo: "on" }));
    expect(r).toMatchObject({ ok: true, data: { estado: "aprobado", linea: 50000.5, moneda: "USD", plazoDias: 45, notas: "línea 1\nlínea 2", actualizarPlazo: true, quitarPdf: false } });
    if (r.ok) expect(r.data.consultadoAt?.toISOString()).toBe("2026-11-10T17:00:00.000Z");
    expect(parseCreditForm(fd({ estado: "x" }))).toEqual({ ok: false, error: "Estado de crédito no válido." });
    expect(parseCreditForm(fd({ estado: "aprobado", consultadoAt: "2026-02-30" }))).toEqual({ ok: false, error: "Fecha de consulta no válida." });
    const bad = parseCreditForm(fd({ estado: "aprobado", plazoDias: "treinta" }));
    expect(bad.ok && Number.isNaN(bad.data.plazoDias)).toBe(true);
  });

  it("permisos: vendedor dueño, supervisor y admin sí; otro vendedor, técnico, inactivo o sin sesión no", () => {
    const f = form({ estado: "en_evaluacion" });
    for (const u of [user(1, "vendedor"), user(9, "supervisor"), user(10, "admin")]) expect(planCreditUpdate({ user: u, company, prev: null, form: f, now }).ok).toBe(true);
    for (const u of [user(2, "vendedor"), user(3, "tecnico"), user(9, "supervisor", false), null]) {
      expect(planCreditUpdate({ user: u, company, prev: null, form: f, now })).toEqual({ ok: false, error: "Solo el dueño de la empresa (o supervisor) puede editar el crédito." });
    }
    // empresa sin dueño: solo supervisor/admin
    expect(planCreditUpdate({ user: user(1, "vendedor"), company: { ...company, ownerUserId: null }, prev: null, form: f, now }).ok).toBe(false);
  });

  it("transición inválida y validación del destino", () => {
    const prev = { estado: "rechazado" } as CompanyCredit;
    expect(planCreditUpdate({ user: user(9, "supervisor"), company, prev, form: form({ estado: "aprobado", linea: 1, plazoDias: 30 }), now })).toEqual({
      ok: false,
      error: 'No se puede pasar de "rechazado" a "aprobado".',
    });
    const r = planCreditUpdate({ user: user(9, "supervisor"), company, prev: null, form: form({ estado: "aprobado" }), now });
    expect(r.ok).toBe(false);
  });

  it("aprobar con plazo: actualiza el plazo habitual solo con el checkbox y si cambia; moneda por defecto USD", () => {
    const f = form({ estado: "aprobado", linea: 50000, plazoDias: 45, actualizarPlazo: true });
    const r = planCreditUpdate({ user: user(1, "vendedor"), company, prev: null, form: f, now });
    expect(r).toMatchObject({ ok: true, termsDays: 45, input: { estado: "aprobado", linea: 50000, moneda: "USD", plazoDias: 45, pdf: undefined } });
    expect(planCreditUpdate({ user: user(1, "vendedor"), company, prev: null, form: { ...f, actualizarPlazo: false }, now })).toMatchObject({ ok: true, termsDays: null });
    expect(planCreditUpdate({ user: user(1, "vendedor"), company: { ...company, creditTermsDays: 45 }, prev: null, form: f, now })).toMatchObject({ ok: true, termsDays: null });
    expect(planCreditUpdate({ user: user(1, "vendedor"), company, prev: null, form: { ...f, estado: "en_evaluacion" }, now })).toMatchObject({ ok: true, termsDays: null });
    expect(defaultUpdateTerms({ creditTermsDays: null })).toBe(true);
    expect(defaultUpdateTerms({ creditTermsDays: 30 })).toBe(false);
  });

  it("quién consultó: el que sube el PDF (fecha = hoy en Lima) o cambia la fecha; si no, se conserva", () => {
    const pdf = { name: "infocorp.pdf", mime: "application/pdf", data: "eA==" };
    const r = planCreditUpdate({ user: user(1, "vendedor"), company, prev: null, form: form({ estado: "en_evaluacion" }), pdf, now });
    expect(r).toMatchObject({ ok: true, input: { consultadoPor: 1, pdf } });
    if (r.ok) expect(r.input.consultadoAt?.toISOString()).toBe("2026-11-11T17:00:00.000Z");
    const prev = { estado: "en_evaluacion", consultadoAt: new Date("2026-11-10T20:31:00Z"), consultadoPor: 9, pdfName: "a.pdf" } as CompanyCredit;
    // mismo día en el formulario: se conserva el instante y quién consultó
    const same = planCreditUpdate({ user: user(1, "vendedor"), company, prev, form: form({ estado: "en_evaluacion", consultadoAt: new Date("2026-11-10T17:00:00Z") }), now });
    expect(same).toMatchObject({ ok: true, input: { consultadoAt: prev.consultadoAt, consultadoPor: 9 } });
    const other = planCreditUpdate({ user: user(1, "vendedor"), company, prev, form: form({ estado: "en_evaluacion", consultadoAt: new Date("2026-11-11T17:00:00Z"), quitarPdf: true }), now });
    expect(other).toMatchObject({ ok: true, input: { consultadoPor: 1, pdf: null } });
  });

  it("readCreditPdf: solo PDF de hasta 4 MB", () => {
    expect(readCreditPdf({ name: "r.pdf", type: "application/pdf", size: PDF_BYTES.length }, PDF_BYTES)).toMatchObject({ ok: true, data: { name: "r.pdf", mime: "application/pdf" } });
    expect(readCreditPdf({ name: "r.pdf", type: "application/pdf", size: 3 }, new Uint8Array([1, 2, 3]))).toEqual({ ok: false, error: "El adjunto debe ser un PDF." });
    expect(readCreditPdf({ name: "r.pdf", type: "application/pdf", size: 4_000_001 }, PDF_BYTES)).toEqual({ ok: false, error: "El PDF pesa más de 4 MB." });
  });
});

describe("crédito: store e historial", () => {
  it("guardar escribe la fila y el historial; sin cambios no escribe; PDF solo con getCreditPdf", async () => {
    const { store, id } = await seeded();
    expect(await store.getCredit(id)).toBeNull();
    const t1 = new Date("2026-11-10T15:00:00Z");
    const a = await store.saveCredit(id, { estado: "en_evaluacion", fuente: "manual", pdf: { name: "r.pdf", mime: "application/pdf", data: "UERG" } }, 1, t1);
    expect(a.credit).toMatchObject({ companyId: id, estado: "en_evaluacion", pdfName: "r.pdf", updatedBy: 1 });
    expect(a.credit).not.toHaveProperty("pdfData");
    expect(a.entry).toMatchObject({ estadoAnterior: null, estadoNuevo: "en_evaluacion", userId: 1, cambios: { estado: ["sin_evaluar", "en_evaluacion"], fuente: [null, "manual"], pdf: [null, "r.pdf"] } });
    expect(await store.getCreditPdf(id)).toEqual({ name: "r.pdf", mime: "application/pdf", data: "UERG" });

    // mismo contenido, PDF sin tocar -> sin historial
    const same = await store.saveCredit(id, { estado: "en_evaluacion", fuente: "manual" }, 2);
    expect(same.entry).toBeNull();

    const t2 = new Date("2026-11-11T15:00:00Z");
    const b = await store.saveCredit(id, { estado: "aprobado", fuente: "manual", linea: 50000, moneda: "USD", plazoDias: 45 }, 2, t2);
    expect(b.entry).toMatchObject({ estadoAnterior: "en_evaluacion", estadoNuevo: "aprobado", cambios: { estado: ["en_evaluacion", "aprobado"], linea: [null, 50000], moneda: [null, "USD"], plazoDias: [null, 45] } });
    expect(await store.getCreditPdf(id)).not.toBeNull(); // se conserva

    await store.saveCredit(id, { estado: "aprobado", fuente: "manual", linea: 50000, moneda: "USD", plazoDias: 45, pdf: null }, 2, new Date("2026-11-11T16:00:00Z"));
    expect(await store.getCreditPdf(id)).toBeNull();
    expect((await store.getCredit(id))?.pdfName).toBeNull();

    const hist = await store.creditHistory(id);
    expect(hist.map((h) => h.estadoNuevo)).toEqual(["aprobado", "aprobado", "en_evaluacion"]); // más reciente primero
    expect(hist[0].cambios).toEqual({ pdf: ["r.pdf", null] });
    expect(describeCreditChanges(hist[1].cambios)).toEqual(["estado: en evaluación → aprobado", "línea: — → 50000", "moneda: — → USD", "plazo: — → 45 días"]);
    expect(await store.creditHistory(id + 1)).toEqual([]);
  });

  it("persiste en el archivo JSON (fila, PDF e historial; ids del historial siguen)", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credit-"));
    const file = path.join(dir, "store.json");
    const s1 = new JsonPortalStore(file);
    const id = (await s1.upsertCompanies([{ ruc: RUC, razonSocial: RAZON }])).ids[RUC];
    await s1.saveCredit(id, { estado: "rechazado", notas: "deuda", consultadoAt: new Date("2026-11-10T17:00:00Z"), pdf: { name: "r.pdf", mime: "application/pdf", data: "UERG" } }, 1);
    await s1.flush();
    const s2 = new JsonPortalStore(file);
    expect(await s2.getCredit(id)).toMatchObject({ estado: "rechazado", notas: "deuda", consultadoAt: new Date("2026-11-10T17:00:00Z") });
    expect((await s2.getCredit(id))?.consultadoAt).toBeInstanceOf(Date);
    expect(await s2.getCreditPdf(id)).toMatchObject({ data: "UERG" });
    const { entry } = await s2.saveCredit(id, { estado: "en_evaluacion", notas: "deuda" }, 1);
    expect(entry?.id).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("crédito: proveedor de buró", () => {
  it("manual devuelve lo guardado y pide adjuntar el PDF", async () => {
    const { store, id } = await seeded();
    const p = new ManualCreditProvider(store);
    expect(p.name).toBe("manual");
    expect(await p.consultar(RUC)).toMatchObject({ provider: "manual", ruc: RUC, estado: "sin_evaluar", tienePdf: false, mensaje: MANUAL_MESSAGE });
    await store.saveCredit(id, { estado: "aprobado", linea: 20000, moneda: "PEN", plazoDias: 30, calificacion: "Normal", pdf: { name: "r.pdf", mime: "application/pdf", data: "UERG" } }, 1);
    expect(await p.consultar(`RUC ${RUC}`)).toMatchObject({ estado: "aprobado", linea: 20000, moneda: "PEN", plazoDias: 30, calificacion: "Normal", tienePdf: true });
    expect(await p.consultar("20111111111")).toMatchObject({ estado: null, mensaje: `RUC 20111111111 no está en el portal; ${MANUAL_MESSAGE}` });
  });

  it("equifax es un esqueleto: 'no configurado' sin llamadas de red", async () => {
    const { store } = await seeded();
    await expect(new EquifaxCreditProvider().consultar(RUC)).rejects.toThrow("Equifax/Infocorp no configurado");
    expect(getCreditBureauProvider(store, "equifax")).toBeInstanceOf(EquifaxCreditProvider);
    expect(getCreditBureauProvider(store, "manual")).toBeInstanceOf(ManualCreditProvider);
    expect(() => getCreditBureauProvider(store, "sentinel")).toThrow(/desconocido/);
  });
});

describe("crédito: aviso al cotizar", () => {
  it("sin fila o sin evaluar -> ⚠️; rechazado -> ⛔; el resto sin aviso", async () => {
    const c = { razonSocial: RAZON };
    expect(creditWarningLine(c, null)).toBe("⚠️ Crédito de *TRANSPORTES ANDES DEL PERU*: sin evaluar. Antes de dar plazo, evalúalo en la ficha del portal.");
    expect(creditWarningLine(c, { estado: "sin_evaluar" })).toBe(creditWarningLine(c, null));
    expect(creditWarningLine(c, { estado: "rechazado" })).toMatch(/^⛔ Crédito RECHAZADO para \*TRANSPORTES ANDES DEL PERU\*/);
    for (const estado of ["en_evaluacion", "aprobado", "observado"] as const) expect(creditWarningLine(c, { estado })).toBeNull();
    const { store, id } = await seeded();
    expect(await creditWarning(store, { id, razonSocial: RAZON })).toMatch(/^⚠️/);
  });
});
