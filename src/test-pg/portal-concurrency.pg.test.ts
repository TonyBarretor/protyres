/**
 * Corrida H, punto 2 — store del portal en Postgres con más operaciones a la vez que conexiones en el pool (5), varias
 * instancias (como Vercel: cada una con su pool) y transacciones que fallan a la mitad.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgPortalStore } from "../lib/portal/store/pg-portal-store";
import type { FleetVehicleInput } from "../lib/portal/store/types";
import { testDbUrl, truncateAll } from "./harness";

let pg: PgPortalStore;
let pg2: PgPortalStore;
let A: number;
let B: number;
let frank: number;

const T0 = new Date("2026-11-11T15:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const day = (d: number) => new Date(T0.getTime() + d * 86_400_000);

function vehicle(companyId: number, placa: string, over: Partial<FleetVehicleInput> = {}): FleetVehicleInput {
  return {
    companyId, placa, marca: "SCANIA", clase: "REMOLCADOR", anio: 2018, ejes: 3, llantas: 10, llantasFuente: "20241231", pesoBruto: 48000, chasis: null,
    departamento: "LIMA", origen: "carga", medidaProbable: "295/80R22.5", confianza: "media", ...over,
  };
}

/** Reparte llamadas entre las dos instancias (dos pools, como dos funciones de Vercel a la vez). */
const either = (i: number) => (i % 2 ? pg2 : pg);

beforeAll(async () => {
  await truncateAll(testDbUrl());
  pg = PgPortalStore.connect(testDbUrl());
  pg2 = PgPortalStore.connect(testDbUrl());
  const r = await pg.upsertCompanies([
    { ruc: "20200000001", razonSocial: "CONCURRENCIA UNO SAC", unidades: 10 },
    { ruc: "20200000002", razonSocial: "CONCURRENCIA DOS SAC", unidades: 20 },
  ]);
  A = r.ids["20200000001"];
  B = r.ids["20200000002"];
  frank = (await pg.upsertUser({ nombre: "Frank Prueba", whatsapp: "51900000001", rol: "vendedor" })).id;
});
afterAll(async () => {
  await pg?.close();
  await pg2?.close();
});

describe("muchas operaciones a la vez", () => {
  it("40 escrituras y lecturas mezcladas (8 veces el pool) terminan todas", async () => {
    const ops = Array.from({ length: 40 }, (_, i) => {
      const s = either(i);
      switch (i % 5) {
        case 0: return s.addActivity({ companyId: A, userId: frank, tipo: "nota", texto: `n${i}`, occurredAt: at(i) });
        case 1: return s.searchCompanies({ q: "concurrencia", withMedidas: true });
        case 2: return s.createOpportunity({ companyId: B, createdBy: frank });
        case 3: return s.addContact({ companyId: A, nombre: `Contacto ${i}` });
        default: return s.listActivities({ companyId: A, limit: 5 });
      }
    });
    const t = Date.now();
    await Promise.all(ops);
    expect(Date.now() - t).toBeLessThan(60_000);
    expect((await pg.listActivities({ companyId: A })).length).toBe(8);
    expect((await pg.listContacts(A)).length).toBe(8);
  });

  it("transacciones a la vez sobre la misma oportunidad: el historial queda con una sola etapa abierta", async () => {
    const op = await pg.createOpportunity({ companyId: A, ownerUserId: frank, createdBy: frank, at: at(0) });
    const etapas = ["cita_agendada", "visita_realizada", "cotizacion_enviada", "negociacion", "cita_agendada", "visita_realizada", "cotizacion_enviada", "negociacion"] as const;
    await Promise.all(etapas.map((e, i) => either(i).moveStage(op.id, e, frank, at(i + 1))));
    const h = await pg.stageHistory(op.id);
    const open = h.filter((x) => x.leftAt === null);
    expect(open).toHaveLength(1);
    // las fechas son las del escenario, no las del commit: la etapa abierta es la actual
    expect(open[0].etapa).toBe((await pg.getOpportunity(op.id))!.etapa);
  });

  it("asignarse una empresa libre: de 6 a la vez, uno la toma; la oportunidad abierta se crea una vez", async () => {
    const { ids } = await pg.upsertCompanies([{ ruc: "20200000009", razonSocial: "LIBRE SAC" }]);
    const id = ids["20200000009"];
    const users = await Promise.all(Array.from({ length: 6 }, (_, i) => pg.upsertUser({ nombre: `V${i}`, whatsapp: `5191000000${i}`, rol: "vendedor" })));
    const claims = await Promise.all(users.map((u, i) => either(i).setOwner(id, u.id, { onlyIfOwner: null })));
    const won = claims.filter((c) => c !== null);
    expect(won).toHaveLength(1);
    expect((await pg.getCompany(id))!.ownerUserId).toBe(won[0]!.ownerUserId);
    const opps = await Promise.all(Array.from({ length: 8 }, (_, i) => either(i).openOrCreateOpportunity({ companyId: id, ownerUserId: won[0]!.ownerUserId, createdBy: won[0]!.ownerUserId })));
    expect(opps.filter((o) => o.created)).toHaveLength(1);
    expect(new Set(opps.map((o) => o.opportunity.id)).size).toBe(1);
    expect(await pg.listOpportunities({ companyId: id, open: true })).toHaveLength(1);
  });

  it("límite de intentos: 20 golpes a la vez cuentan 1..20", async () => {
    const r = await Promise.all(Array.from({ length: 20 }, (_, i) => either(i).hitRateLimit("login:ip:paralelo", at(0))));
    expect([...r].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("enlace de acceso usado 10 veces a la vez: entra una sola", async () => {
    await pg.saveLoginToken({ tokenHash: "tok-paralelo", userId: frank, expiresAt: day(1) });
    const r = await Promise.all(Array.from({ length: 10 }, (_, i) => either(i).consumeLoginToken("tok-paralelo", T0)));
    expect(r.filter((x) => x !== null)).toEqual([frank]);
  });

  it("encuesta: dos crons a la vez crean una sola; 8 respuestas a la vez, se guarda una", async () => {
    const mk = (i: number) => either(i).createSurvey({ companyId: B, tokenHash: `tok-s-${i}`, canal: "email", expiresAt: day(30), createdAt: T0 }, { onlyIfNoneSince: day(-30) });
    const created = (await Promise.all(Array.from({ length: 6 }, (_, i) => mk(i)))).filter((x) => x !== null);
    expect(created).toHaveLength(1);
    const ans = { nps: 10, valora: ["precio"], satisfaccionEntrega: 5, mejorar: null, referencia: false };
    const r = await Promise.all(Array.from({ length: 8 }, (_, i) => either(i).answerSurvey(created[0]!.id, ans, at(1))));
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(await pg.listSurveyResponses({ companyId: B })).toHaveLength(1);
  });

  it("crédito guardado a la vez desde dos pantallas: el historial encadena los estados", async () => {
    const estados = ["en_evaluacion", "aprobado", "observado", "rechazado", "en_evaluacion", "aprobado"] as const;
    await Promise.all(estados.map((e, i) => either(i).saveCredit(B, { estado: e, fuente: "manual", ...(e === "aprobado" ? { linea: 1000 + i, moneda: "USD", plazoDias: 30 } : {}), notas: `n${i}` }, frank, T0)));
    // misma hora para todos: el historial queda en el orden en que se guardaron (id)
    const h = [...(await pg.creditHistory(B))].reverse(); // del más antiguo al más nuevo
    expect(h[0].estadoAnterior).toBeNull();
    for (let i = 1; i < h.length; i++) expect(h[i].estadoAnterior).toBe(h[i - 1].estadoNuevo);
    expect(h.at(-1)!.estadoNuevo).toBe((await pg.getCredit(B))!.estado);
  });

  it("aviso de validar el ranking: una sola vez aunque lleguen 8 mensajes a la vez", async () => {
    const r = await Promise.all(Array.from({ length: 8 }, (_, i) => either(i).markUserNotice(frank, "ranking-paralelo")));
    expect(r.filter(Boolean)).toHaveLength(1);
  });

  it("vocabulario y usuarios repetidos a la vez: una fila", async () => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => either(i).addVocabulary({ term: i % 2 ? "Flamita" : "FLAMITA", meaning: `Flama ${i}` })));
    expect((await pg.listVocabulary()).filter((v) => v.term.toLowerCase() === "flamita")).toHaveLength(1);
    await Promise.all(Array.from({ length: 6 }, (_, i) => either(i).upsertUser({ nombre: `Nuevo ${i}`, whatsapp: "51900000077", rol: "vendedor" })));
    expect((await pg.listUsers()).filter((u) => u.whatsapp === "51900000077")).toHaveLength(1);
  });
});

describe("transacciones que fallan a la mitad", () => {
  it("oportunidad cuyo historial falla después de insertarla: no queda a medias y el pool sigue sano", async () => {
    const before = (await pg.listOpportunities()).length;
    await expect(pg.createOpportunity({ companyId: A, createdBy: "no-es-id" as unknown as number })).rejects.toThrow();
    expect((await pg.listOpportunities()).length).toBe(before);
    const ok = await Promise.all(Array.from({ length: 10 }, (_, i) => either(i).countCompanies()));
    expect(new Set(ok).size).toBe(1);
  });

  it("reemplazo de flota que falla después de borrar: la flota anterior sigue entera", async () => {
    await pg.replaceFleet(A, [vehicle(A, "AAA-001"), vehicle(A, "AAA-002")]);
    const bad = [vehicle(A, "AAA-001"), vehicle(A, "BBB-001", { anio: "no-es-año" as unknown as number })];
    await expect(pg.replaceFleet(A, bad.map(({ companyId: _c, ...v }) => v))).rejects.toThrow();
    expect((await pg.listFleet(A)).map((v) => v.placa)).toEqual(["AAA-001", "AAA-002"]);
  });

  it("crédito con un valor inválido: ni la fila ni el historial cambian", async () => {
    const prev = await pg.getCredit(A);
    const hist = (await pg.creditHistory(A)).length;
    await expect(pg.saveCredit(A, { estado: "aprobado", linea: "mucho" as unknown as number, moneda: "USD", plazoDias: 30 }, frank)).rejects.toThrow();
    expect(await pg.getCredit(A)).toEqual(prev);
    expect((await pg.creditHistory(A)).length).toBe(hist);
    // y la siguiente transacción en ese pool funciona
    await expect(pg.saveCredit(A, { estado: "en_evaluacion", fuente: "manual" }, frank)).resolves.toBeTruthy();
  });

  it("encuesta respondida con un dato inválido: sigue pendiente y se puede responder después", async () => {
    const s = (await pg.createSurvey({ companyId: A, tokenHash: "tok-falla", canal: "manual", expiresAt: day(30), createdAt: T0 }))!;
    await expect(pg.answerSurvey(s.id, { nps: "diez" as unknown as number, valora: [], satisfaccionEntrega: null, mejorar: null, referencia: null }, at(1))).rejects.toThrow();
    expect((await pg.getSurvey(s.id))!.estado).toBe("pendiente");
    expect((await pg.answerSurvey(s.id, { nps: 8, valora: [], satisfaccionEntrega: null, mejorar: null, referencia: null }, at(2))).ok).toBe(true);
  });
});
