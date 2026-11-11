import { describe, expect, it, beforeEach } from "vitest";
import { FakeWhatsAppClient } from "../../whatsapp/client";
import { noticesOf } from "../bot/state";
import { runDailyJobs, DAILY_JOBS } from "../notify/jobs";
import { JsonPortalStore } from "../store";
import { surveyCounts } from "../store/survey-shared";
import type { PortalUser, SurveyResponse } from "../store/types";
import { surveyEmailReady, type SurveyEmailInput, type SurveyEmailSender } from "./email";
import { runSurveyInvites, surveyAutoEnabled } from "./invite";
import { manualSurveyWarnings, previewManualSurvey, sendManualSurvey, PREVIEW_URL } from "./manual";
import { invitationEmail } from "./messages";
import { MAX_VALORA, parseSurveyForm, type SurveyFormLike } from "./questions";
import { selectSurveyCandidates } from "./select";
import { createSurveyLink, openSurvey, submitSurvey } from "./service";
import { loadSurveySummary, npsGroup, summarizeSurveys } from "./summary";
import { hashSurveyToken, isSurveyTokenShape, newSurveyToken } from "./tokens";

const NOW = new Date("2026-11-11T13:00:00.000Z"); // miércoles 8:00 en Lima
const CFG = { afterSaleDays: 7, windowDays: 7, cooldownMonths: 6, expiresDays: 30 };
const ENV_BASE = { PORTAL_BASE_URL: "https://portal.example.pe" };
const ENV_ON = { ...ENV_BASE, SURVEY_AUTO: "1" };
const ENV_MAIL = { ...ENV_ON, RESEND_API_KEY: "re_test", EMAIL_FROM: "Encuestas <encuestas@360tyres.pe>" };
const FRANK = "51900000001";
const WINDOW_ERR = new Error("WhatsApp API 400: (#131047) Re-engagement message");

/** FormData mínima para parseSurveyForm. */
function form(fields: Record<string, string | string[]>): SurveyFormLike {
  const get = (k: string) => {
    const v = fields[k];
    return v === undefined ? null : Array.isArray(v) ? (v[0] ?? null) : v;
  };
  const getAll = (k: string) => {
    const v = fields[k];
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
  };
  return { get, getAll };
}

const GOOD = { nps: "9", valora: ["precio", "stock"], satisfaccion: "4", mejorar: "  Más stock de 295/80  ", referencia: "si" };

let store: JsonPortalStore;
let frank: PortalUser;
const ids: Record<string, number> = {};

/** Empresas: A cliente con venta real hace 7 días; B cliente solo demo; C no cliente; D cliente venta hace 3 días; E cliente venta hace 7 días y encuestada hace 2 meses; F cliente venta hace 10 días (dentro de la tolerancia). */
async function seed(): Promise<void> {
  store = JsonPortalStore.memory();
  frank = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  const r = await store.upsertCompanies([
    { ruc: "20999999901", razonSocial: "ALFA TRANSPORTES PRUEBA S.A.C." },
    { ruc: "20999999902", razonSocial: "BETA DEMO S.A.C." },
    { ruc: "20999999903", razonSocial: "GAMMA NO CLIENTE S.A.C." },
    { ruc: "20999999904", razonSocial: "DELTA RECIENTE S.A.C." },
    { ruc: "20999999905", razonSocial: "EPSILON ENCUESTADA S.A.C." },
    { ruc: "20999999906", razonSocial: "ZETA ATRASADA S.A.C." },
  ]);
  for (const [k, ruc] of Object.entries({ A: "20999999901", B: "20999999902", C: "20999999903", D: "20999999904", E: "20999999905", F: "20999999906" })) ids[k] = r.ids[ruc];
  for (const k of ["A", "B", "D", "E", "F"]) await store.updateCompany(ids[k], { esCliente: true, ownerUserId: frank.id });
  await store.insertSales([
    { fecha: "2026-11-04", ruc: "20999999901", cantidad: 8, total: 2000 },
    { fecha: "2026-11-04", ruc: "20999999902", cantidad: 8, total: 2000, isDemo: true, origen: "demo" },
    { fecha: "2026-11-04", ruc: "20999999903", cantidad: 8, total: 2000 },
    { fecha: "2026-11-04", ruc: "20999999904", cantidad: 4, total: 900 },
    { fecha: "2026-11-08", ruc: "20999999904", cantidad: 4, total: 900 },
    { fecha: "2026-11-04", ruc: "20999999905", cantidad: 8, total: 2000 },
    { fecha: "2026-11-01", ruc: "20999999906", cantidad: 8, total: 2000 },
  ]);
  const old = newSurveyToken();
  const prev = (await store.createSurvey({ companyId: ids.E, tokenHash: old.tokenHash, canal: "email", expiresAt: new Date("2026-10-11T00:00:00Z"), createdAt: new Date("2026-09-11T13:00:00Z") }))!;
  // entregada (una pendiente sin enviar de hace más de 1 día sería huérfana y no contaría)
  await store.markSurveySent(prev.id, new Date("2026-09-11T13:05:00Z"), "email");
}

const names = (cands: { company: { razonSocial: string } }[]) => cands.map((c) => c.company.razonSocial);

describe("tokens", () => {
  it("32 bytes base64url, guarda solo el sha256", () => {
    const { token, tokenHash } = newSurveyToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isSurveyTokenShape(token)).toBe(true);
    expect(tokenHash).toBe(hashSurveyToken(token));
    expect(tokenHash).not.toContain(token);
    expect(newSurveyToken().token).not.toBe(token);
    expect(isSurveyTokenShape("abc")).toBe(false);
    expect(isSurveyTokenShape(`${token}/../x`)).toBe(false);
  });
});

describe("parseSurveyForm", () => {
  it("acepta una respuesta válida y recorta el comentario", () => {
    const r = parseSurveyForm(form(GOOD));
    expect(r).toEqual({ ok: true, answer: { nps: 9, valora: ["precio", "stock"], satisfaccionEntrega: 4, mejorar: "Más stock de 295/80", referencia: true } });
  });
  it(`rechaza más de ${MAX_VALORA} opciones, opciones desconocidas y ninguna`, () => {
    expect(parseSurveyForm(form({ ...GOOD, valora: ["precio", "stock", "credito", "posventa"] }))).toEqual({ ok: false, errors: ["valora_max"] });
    expect(parseSurveyForm(form({ ...GOOD, valora: ["precio", "hackeo"] }))).toEqual({ ok: false, errors: ["valora"] });
    expect(parseSurveyForm(form({ ...GOOD, valora: [] }))).toEqual({ ok: false, errors: ["valora"] });
    // repetidas cuentan una vez
    expect(parseSurveyForm(form({ ...GOOD, valora: ["precio", "precio", "stock", "stock"] })).ok).toBe(true);
  });
  it("valida rangos y obligatorios", () => {
    const r = parseSurveyForm(form({ nps: "11", valora: ["precio"], satisfaccion: "0", referencia: "quizas" }));
    expect(r).toEqual({ ok: false, errors: ["nps", "satisfaccion", "referencia"] });
    expect(parseSurveyForm(form({ ...GOOD, nps: "-1" })).ok).toBe(false);
    expect(parseSurveyForm(form({ ...GOOD, nps: "7.5" })).ok).toBe(false);
    const sinComentario = parseSurveyForm(form({ ...GOOD, mejorar: "   ", nps: "0", referencia: "no" }));
    expect(sinComentario.ok && sinComentario.answer).toMatchObject({ nps: 0, mejorar: null, referencia: false });
  });
});

describe("encuesta: un solo uso", () => {
  beforeEach(seed);

  it("token inválido, desconocido, una respuesta y la segunda rechazada", async () => {
    expect((await openSurvey(store, "no-es-un-token", NOW)).status).toBe("invalida");
    expect((await openSurvey(store, newSurveyToken().token, NOW)).status).toBe("invalida");
    const created = (await createSurveyLink(store, { companyId: ids.A, canal: "manual", now: NOW, expiresDays: 30, env: ENV_BASE }))!;
    expect(created.url).toBe(`https://portal.example.pe/encuesta/${created.token}`);
    expect(created.survey.tokenHash).toBe(hashSurveyToken(created.token));
    const open = await openSurvey(store, created.token, NOW);
    expect(open.status).toBe("abierta");
    expect(open.status === "abierta" && open.company?.razonSocial).toBe("ALFA TRANSPORTES PRUEBA S.A.C.");

    const bad = await submitSurvey(store, created.token, form({ ...GOOD, valora: ["precio", "stock", "credito", "posventa"] }), NOW);
    expect(bad).toEqual({ ok: false, reason: "datos", errors: ["valora_max"] });
    expect((await openSurvey(store, created.token, NOW)).status).toBe("abierta"); // un error de datos no gasta el enlace

    const first = await submitSurvey(store, created.token, form(GOOD), NOW);
    expect(first.ok).toBe(true);
    const second = await submitSurvey(store, created.token, form({ ...GOOD, nps: "0" }), NOW);
    expect(second).toEqual({ ok: false, reason: "respondida" });
    expect((await openSurvey(store, created.token, NOW)).status).toBe("respondida");
    const answers = await store.listSurveyResponses({ companyId: ids.A });
    expect(answers).toHaveLength(1);
    expect(answers[0].nps).toBe(9);
  });

  it("dos respuestas simultáneas: solo una se guarda", async () => {
    const created = (await createSurveyLink(store, { companyId: ids.A, canal: "manual", now: NOW, expiresDays: 30 }))!;
    const results = await Promise.all([submitSurvey(store, created.token, form(GOOD), NOW), submitSurvey(store, created.token, form(GOOD), NOW)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await store.listSurveyResponses({ companyId: ids.A })).toHaveLength(1);
  });

  it("vencida: no acepta respuesta y queda marcada", async () => {
    const created = (await createSurveyLink(store, { companyId: ids.A, canal: "manual", now: NOW, expiresDays: 30 }))!;
    const later = new Date(NOW.getTime() + 31 * 86_400_000);
    expect(await submitSurvey(store, created.token, form(GOOD), later)).toEqual({ ok: false, reason: "vencida" });
    expect((await store.getSurvey(created.survey.id))!.estado).toBe("vencida");
    expect((await openSurvey(store, created.token, NOW)).status).toBe("vencida");
  });

  it("persiste en el archivo JSON (estado y respuesta)", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "survey-")), "store.json");
    const s1 = new JsonPortalStore(file);
    const [c] = Object.values((await s1.upsertCompanies([{ ruc: "20999999901", razonSocial: "ALFA" }])).ids);
    const created = (await createSurveyLink(s1, { companyId: c, canal: "manual", now: NOW, expiresDays: 30 }))!;
    expect((await submitSurvey(s1, created.token, form(GOOD), NOW)).ok).toBe(true);
    await s1.flush();
    const s2 = new JsonPortalStore(file);
    expect((await openSurvey(s2, created.token, NOW)).status).toBe("respondida");
    const [resp] = await s2.listSurveyResponses();
    expect(resp.createdAt).toBeInstanceOf(Date);
    expect(resp.valora).toEqual(["precio", "stock"]);
    const again = (await createSurveyLink(s2, { companyId: c, canal: "manual", now: NOW, expiresDays: 30 }))!;
    expect(again.survey.id).toBe(created.survey.id + 1);
  });
});

describe("selección de empresas a encuestar", () => {
  beforeEach(seed);

  it("cliente con venta real hace N días; excluye demo, no clientes, venta reciente y encuestadas en 6 meses", async () => {
    const sel = await selectSurveyCandidates(store, NOW, CFG);
    expect(sel.until).toBe("2026-11-04");
    expect(sel.from).toBe("2026-10-29");
    expect(names(sel.candidates)).toEqual(["ALFA TRANSPORTES PRUEBA S.A.C.", "ZETA ATRASADA S.A.C."]);
  });

  it("una encuesta de hace más de 6 meses no excluye; una vencida sin entregar tampoco", async () => {
    const t = newSurveyToken();
    const s = (await store.createSurvey({ companyId: ids.A, tokenHash: t.tokenHash, canal: "email", expiresAt: NOW, createdAt: new Date(NOW.getTime() - 3600_000) }))!; // pendiente reciente: cuenta
    expect(names((await selectSurveyCandidates(store, NOW, CFG)).candidates)).not.toContain("ALFA TRANSPORTES PRUEBA S.A.C.");
    await store.expireSurvey(s.id); // nunca se entregó
    expect(names((await selectSurveyCandidates(store, NOW, CFG)).candidates)).toContain("ALFA TRANSPORTES PRUEBA S.A.C.");
    // E: su encuesta es de hace 2 meses; 5 meses después ya pasaron 6
    const later = new Date("2027-03-15T13:00:00Z");
    await store.insertSales([{ fecha: "2027-03-08", ruc: "20999999905", cantidad: 2, total: 400 }]);
    expect(names((await selectSurveyCandidates(store, later, CFG)).candidates)).toContain("EPSILON ENCUESTADA S.A.C.");
  });

  it("una venta demo más reciente no cambia nada y una real más reciente hace esperar", async () => {
    await store.insertSales([{ fecha: "2026-11-09", ruc: "20999999901", cantidad: 1, total: 10, isDemo: true, origen: "demo" }]);
    expect(names((await selectSurveyCandidates(store, NOW, CFG)).candidates)).toContain("ALFA TRANSPORTES PRUEBA S.A.C.");
    await store.insertSales([{ fecha: "2026-11-09", ruc: "20999999901", cantidad: 1, total: 10 }]);
    expect(names((await selectSurveyCandidates(store, NOW, CFG)).candidates)).not.toContain("ALFA TRANSPORTES PRUEBA S.A.C.");
  });
});

describe("invitación automática (cron)", () => {
  beforeEach(seed);

  it("SURVEY_AUTO apagado (o dryRun): solo informa, no crea ni envía nada", async () => {
    expect(surveyAutoEnabled({})).toBe(false);
    expect(surveyAutoEnabled({ SURVEY_AUTO: "0" })).toBe(false);
    expect(surveyAutoEnabled({ SURVEY_AUTO: "true" })).toBe(true);
    const client = new FakeWhatsAppClient();
    const mails: SurveyEmailInput[] = [];
    const sendEmail: SurveyEmailSender = async (m) => (mails.push(m), { sent: true, to: m.to });
    const before = (await store.listSurveys()).length;
    const off = await runSurveyInvites({ store, client, now: NOW, env: ENV_BASE, config: CFG, sendEmail });
    expect(off).toMatchObject({ auto: false, candidatas: 2, correos: 0, whatsappVendedor: 0 });
    expect(off.resultados.every((r) => r.status === "simulado")).toBe(true);
    const dry = await runSurveyInvites({ store, client: null, now: NOW, env: ENV_MAIL, config: CFG, dryRun: true, sendEmail });
    expect(dry).toMatchObject({ auto: true, dryRun: true, candidatas: 2 });
    expect((await store.listSurveys()).length).toBe(before);
    expect(client.sent).toHaveLength(0);
    expect(mails).toHaveLength(0);
    expect(await store.listActivities()).toHaveLength(0);
  });

  it("correo al contacto si Resend está listo; idempotente al correr dos veces", async () => {
    await store.addContact({ companyId: ids.A, nombre: "Rosa Pérez", email: "rosa@alfa.example.pe" });
    await store.addContact({ companyId: ids.F, nombre: "Sin Correo", telefono: "999" });
    const open = await store.createOpportunity({ companyId: ids.F, ownerUserId: frank.id });
    const client = new FakeWhatsAppClient();
    const mails: SurveyEmailInput[] = [];
    const sendEmail: SurveyEmailSender = async (m, env) => (mails.push(m), { sent: true, to: env.EMAIL_REDIRECT_TO || m.to });
    const r1 = await runSurveyInvites({ store, client, now: NOW, env: ENV_MAIL, config: CFG, sendEmail });
    expect(r1).toMatchObject({ auto: true, candidatas: 2, correos: 1, whatsappVendedor: 1, errores: 0 });
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("rosa@alfa.example.pe");
    expect(mails[0].text).toMatch(/https:\/\/portal\.example\.pe\/encuesta\/[A-Za-z0-9_-]{43}/);
    expect(mails[0].text).toContain("ALFA TRANSPORTES PRUEBA S.A.C.");

    const [sa] = await store.listSurveys({ companyId: ids.A });
    expect(sa).toMatchObject({ estado: "enviada", canal: "email" });
    const [sf] = await store.listSurveys({ companyId: ids.F });
    expect(sf).toMatchObject({ estado: "enviada", canal: "whatsapp_vendedor" });
    // F sin correo: tarea + próxima acción + WhatsApp al vendedor con el enlace aparte para reenviar
    expect(client.sent.map((m) => m.to)).toEqual([FRANK, FRANK]);
    expect(client.texts()[0]).toContain("*Encuesta de satisfacción* — ZETA ATRASADA S.A.C.");
    expect(client.texts()[1]).toMatch(/\/encuesta\/[A-Za-z0-9_-]{43}/);
    const tareas = (await store.listActivities({ companyId: ids.F })).filter((a) => a.tipo === "tarea");
    expect(tareas).toHaveLength(1);
    expect(tareas[0].userId).toBe(frank.id);
    expect((await store.getOpportunity(open.id))!.proximaAccion).toContain("Reenviar la encuesta");

    // segunda corrida el mismo día: nada nuevo
    const r2 = await runSurveyInvites({ store, client, now: new Date(NOW.getTime() + 3600_000), env: ENV_MAIL, config: CFG, sendEmail });
    expect(r2.candidatas).toBe(0);
    expect(mails).toHaveLength(1);
    expect(client.sent).toHaveLength(2);
    expect(await store.listSurveys({ companyId: ids.A })).toHaveLength(1);
    expect(await store.listSurveys({ companyId: ids.F })).toHaveLength(1);
  });

  it("idempotencia aunque dos corridas elijan a la vez la misma empresa", async () => {
    const client = new FakeWhatsAppClient();
    const [r1, r2] = await Promise.all([
      runSurveyInvites({ store, client, now: NOW, env: ENV_ON, config: CFG }),
      runSurveyInvites({ store, client, now: NOW, env: ENV_ON, config: CFG }),
    ]);
    expect(r1.whatsappVendedor + r2.whatsappVendedor).toBe(2);
    expect(await store.listSurveys({ companyId: ids.A })).toHaveLength(1);
    expect(await store.listSurveys({ companyId: ids.F })).toHaveLength(1);
  });

  it("sin Resend verificado usa el vendedor; no pisa su próxima acción; ventana de 24 h -> aviso pendiente", async () => {
    await store.addContact({ companyId: ids.A, nombre: "Rosa Pérez", email: "rosa@alfa.example.pe" });
    const opp = await store.createOpportunity({ companyId: ids.A, ownerUserId: frank.id, proximaAccion: "Llamar a logística" });
    const client = new FakeWhatsAppClient();
    client.onSend = () => {
      throw WINDOW_ERR;
    };
    const env = { ...ENV_ON, RESEND_API_KEY: "re_x", EMAIL_FROM: "Cotizaciones <cotizaciones@example.com>" };
    expect(surveyEmailReady(env)).toBe(false);
    const r = await runSurveyInvites({ store, client, now: NOW, env, config: CFG });
    expect(r).toMatchObject({ correos: 0, avisosPendientes: 2, errores: 0 });
    expect((await store.getOpportunity(opp.id))!.proximaAccion).toBe("Llamar a logística");
    const notices = noticesOf(await store.getPortalConversation(FRANK));
    expect(notices).toHaveLength(2);
    expect(notices[0].text).toMatch(/\/encuesta\/[A-Za-z0-9_-]{43}/);
  });

  it("envío fallido (no ventana) y sin canal: la encuesta no cuenta y se reintenta otro día", async () => {
    await store.updateCompany(ids.F, { ownerUserId: null });
    const client = new FakeWhatsAppClient();
    client.onSend = () => {
      throw new Error("WhatsApp API 500");
    };
    const r = await runSurveyInvites({ store, client, now: NOW, env: ENV_ON, config: CFG });
    expect(r).toMatchObject({ errores: 1, sinCanal: 1 });
    expect(r.resultados.find((x) => x.companyId === ids.F)!.status).toBe("sin_canal");
    const [sa] = await store.listSurveys({ companyId: ids.A });
    expect(sa.estado).toBe("vencida");
    expect(await store.listActivities({ companyId: ids.A })).toHaveLength(0);
    client.onSend = undefined;
    const again = await runSurveyInvites({ store, client, now: new Date(NOW.getTime() + 86_400_000), env: ENV_ON, config: CFG });
    expect(again.whatsappVendedor).toBe(1);
  });

  it("la entrega lanza (correo): la encuesta queda vencida sin enviar y no bloquea", async () => {
    await store.addContact({ companyId: ids.A, nombre: "Rosa Pérez", email: "rosa@alfa.example.pe" });
    await store.updateCompany(ids.F, { ownerUserId: null });
    const boom: SurveyEmailSender = async () => {
      throw new Error("Resend caído");
    };
    const r = await runSurveyInvites({ store, client: null, now: NOW, env: ENV_MAIL, config: CFG, sendEmail: boom });
    expect(r.resultados.find((x) => x.companyId === ids.A)).toMatchObject({ status: "error", detalle: "Resend caído" });
    const [sa] = await store.listSurveys({ companyId: ids.A });
    expect(sa).toMatchObject({ estado: "vencida", enviadaAt: null });
    expect(surveyCounts(sa, NOW)).toBe(false);
    // al día siguiente se reintenta
    const mails: SurveyEmailInput[] = [];
    const again = await runSurveyInvites({ store, client: null, now: new Date(NOW.getTime() + 86_400_000), env: ENV_MAIL, config: CFG, sendEmail: async (m) => (mails.push(m), { sent: true, to: m.to }) });
    expect(again.correos).toBe(1);
    expect(mails).toHaveLength(1);
  });

  it("pendiente huérfana (proceso cortado) de hace 2 días no bloquea; de hace unas horas sí", async () => {
    const orphanAt = new Date(NOW.getTime() - 2 * 86_400_000);
    const t = newSurveyToken();
    const orphan = (await store.createSurvey({ companyId: ids.A, tokenHash: t.tokenHash, canal: "email", expiresAt: new Date(NOW.getTime() + 20 * 86_400_000), createdAt: orphanAt }))!;
    expect(orphan.estado).toBe("pendiente");
    expect(surveyCounts(orphan, NOW)).toBe(false);
    expect(surveyCounts(orphan, new Date(orphanAt.getTime() + 3600_000))).toBe(true);
    expect(surveyCounts({ ...orphan, estado: "vencida" }, NOW)).toBe(false);
    expect(surveyCounts({ ...orphan, estado: "enviada", enviadaAt: orphanAt }, NOW)).toBe(true);
    expect(names((await selectSurveyCandidates(store, NOW, CFG)).candidates)).toContain("ALFA TRANSPORTES PRUEBA S.A.C.");
    const r = await runSurveyInvites({ store, client: new FakeWhatsAppClient(), now: NOW, env: ENV_ON, config: CFG });
    expect(r.resultados.find((x) => x.companyId === ids.A)!.status).toBe("whatsapp_vendedor");
    // reciente (unas horas): sí bloquea
    const t2 = newSurveyToken();
    await store.createSurvey({ companyId: ids.F, tokenHash: t2.tokenHash, canal: "email", expiresAt: new Date(NOW.getTime() + 20 * 86_400_000), createdAt: new Date(NOW.getTime() - 3600_000) });
    const s2 = await store.listSurveys({ companyId: ids.F });
    expect(s2.some((x) => surveyCounts(x, NOW))).toBe(true);
  });

  it("modo prueba (EMAIL_REDIRECT_TO): el automático solo informa, no crea ni envía ni quema la ventana", async () => {
    await store.addContact({ companyId: ids.A, nombre: "Rosa Pérez", email: "rosa@alfa.example.pe" });
    const client = new FakeWhatsAppClient();
    const mails: SurveyEmailInput[] = [];
    const logs: string[] = [];
    const before = (await store.listSurveys()).length;
    const r = await runSurveyInvites({ store, client, now: NOW, env: { ...ENV_MAIL, EMAIL_REDIRECT_TO: "pruebas@360tyres.pe" }, config: CFG, log: (m) => logs.push(m), sendEmail: async (m) => (mails.push(m), { sent: true, to: m.to }) });
    expect(r).toMatchObject({ auto: true, dryRun: false, modoPrueba: true, candidatas: 2, correos: 0, whatsappVendedor: 0 });
    expect(r.nota).toMatch(/Modo prueba \(EMAIL_REDIRECT_TO=pruebas@360tyres\.pe\)/);
    expect(r.resultados.every((x) => x.status === "simulado" && x.detalle === "modo prueba")).toBe(true);
    expect(logs.some((l) => l.includes("Modo prueba"))).toBe(true);
    expect((await store.listSurveys()).length).toBe(before);
    expect(mails).toHaveLength(0);
    expect(client.sent).toHaveLength(0);
    // sin redirect, sale de verdad
    const real = await runSurveyInvites({ store, client, now: NOW, env: ENV_MAIL, config: CFG, sendEmail: async (m) => (mails.push(m), { sent: true, to: m.to }) });
    expect(real).toMatchObject({ modoPrueba: false, correos: 1 });
    expect(real.nota).toBeUndefined();
  });

  it("solo ventas demo: no se escribe a nadie", async () => {
    const demoOnly = JsonPortalStore.memory();
    const u = await demoOnly.upsertUser({ nombre: "Frank", whatsapp: FRANK, rol: "vendedor" });
    const { ids: d } = await demoOnly.upsertCompanies([{ ruc: "20999999911", razonSocial: "SOLO DEMO S.A.C." }]);
    await demoOnly.updateCompany(d["20999999911"], { esCliente: true, ownerUserId: u.id });
    await demoOnly.addContact({ companyId: d["20999999911"], nombre: "X", email: "x@demo.example.pe" });
    await demoOnly.insertSales([
      { fecha: "2026-11-04", ruc: "20999999911", cantidad: 8, total: 100, isDemo: true, origen: "demo" },
      { fecha: "2026-11-04", ruc: "20999999911", cantidad: 8, total: 100, origen: "demo" }, // marcada solo por origen
    ]);
    const client = new FakeWhatsAppClient();
    const mails: SurveyEmailInput[] = [];
    const r = await runSurveyInvites({ store: demoOnly, client, now: NOW, env: ENV_MAIL, config: CFG, sendEmail: async (m) => (mails.push(m), { sent: true, to: m.to }) });
    expect(r.candidatas).toBe(0);
    expect(client.sent).toHaveLength(0);
    expect(mails).toHaveLength(0);
    expect(await demoOnly.listSurveys()).toHaveLength(0);
  });

  it("está en los trabajos del cron diario", async () => {
    expect(DAILY_JOBS.map((j) => j.name)).toContain("encuestas");
    const report = await runDailyJobs({ store, client: null, now: NOW, dryRun: true, env: ENV_ON, log: () => undefined }, DAILY_JOBS.filter((j) => j.name === "encuestas"));
    expect(report.encuestas).toMatchObject({ ok: true, report: { dryRun: true, candidatas: 2 } });
    expect(await store.listSurveys()).toHaveLength(1); // solo la de E del seed
  });
});

describe("envío manual desde la ficha", () => {
  beforeEach(seed);

  it("vista previa por correo o enlace, y confirmación", async () => {
    const company = (await store.getCompany(ids.C))!;
    const rosa = await store.addContact({ companyId: ids.C, nombre: "Rosa", email: "rosa@gamma.example.pe" });
    const p1 = previewManualSurvey(company, rosa, frank, 30, ENV_MAIL, NOW);
    expect(p1.mode).toBe("email");
    expect(p1.mode === "email" && p1.email.text).toContain(PREVIEW_URL);
    const p2 = previewManualSurvey(company, rosa, frank, 30, ENV_BASE, NOW);
    expect(p2).toMatchObject({ mode: "link" });
    expect(p2.mode === "link" && p2.motivo).toContain("no está configurado");

    const mails: SurveyEmailInput[] = [];
    const r1 = await sendManualSurvey(store, { company, contact: rosa, user: frank, expiresDays: 30, env: { ...ENV_MAIL, EMAIL_REDIRECT_TO: "pruebas@360tyres.pe" }, now: NOW, sendEmail: async (m, env) => (mails.push(m), { sent: true, to: env.EMAIL_REDIRECT_TO! }) });
    expect(r1).toMatchObject({ mode: "email", to: "pruebas@360tyres.pe" });
    expect(r1.survey.estado).toBe("enviada");

    const r2 = await sendManualSurvey(store, { company, contact: rosa, user: frank, expiresDays: 30, env: ENV_BASE, now: NOW });
    expect(r2.mode).toBe("link");
    if (r2.mode !== "link") return;
    expect(r2.text).toContain(r2.url);
    expect(r2.survey).toMatchObject({ canal: "manual", estado: "enviada", createdBy: frank.id });
    expect((await openSurvey(store, r2.token, NOW)).status).toBe("abierta");

    // correo que falla -> enlace para copiar con el error
    const r3 = await sendManualSurvey(store, { company, contact: rosa, user: frank, expiresDays: 30, env: ENV_MAIL, now: NOW, sendEmail: async (m) => ({ sent: false, to: m.to, error: "dominio no verificado" }) });
    expect(r3).toMatchObject({ mode: "link", error: "dominio no verificado" });
  });

  it("vista previa en modo prueba: avisa a dónde irá el correo", async () => {
    const company = (await store.getCompany(ids.A))!;
    const rosa = await store.addContact({ companyId: ids.A, nombre: "Rosa", email: "rosa@alfa.example.pe" });
    const p = previewManualSurvey(company, rosa, frank, 30, { ...ENV_MAIL, EMAIL_REDIRECT_TO: "pruebas@360tyres.pe" }, NOW);
    expect(p).toMatchObject({ mode: "email", to: "pruebas@360tyres.pe", modoPrueba: "Modo prueba: el correo irá a pruebas@360tyres.pe" });
    expect(previewManualSurvey(company, rosa, frank, 30, ENV_MAIL, NOW)).toMatchObject({ mode: "email", to: "rosa@alfa.example.pe", modoPrueba: null });
  });

  it("avisos (no bloquean): solo demo, no cliente, encuesta abierta", async () => {
    const get = async (k: string) => (await store.getCompany(ids[k]))!;
    expect(await manualSurveyWarnings(store, await get("A"), NOW)).toEqual([]);
    expect(await manualSurveyWarnings(store, await get("B"), NOW)).toEqual(["La empresa solo tiene ventas demo (de prueba)."]);
    expect(await manualSurveyWarnings(store, await get("C"), NOW)).toEqual(["La empresa no está marcada como cliente."]);
    // E: la del seed ya venció (expira 11/10) -> no está abierta
    expect(await manualSurveyWarnings(store, await get("E"), NOW)).toEqual([]);
    const sent = await sendManualSurvey(store, { company: await get("A"), contact: null, user: frank, expiresDays: 30, env: ENV_BASE, now: NOW });
    const w = await manualSurveyWarnings(store, await get("A"), NOW);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^Ya tiene una encuesta abierta \(enviada, vence el \d{2}\/\d{2}\/\d{4}\) sin responder\.$/);
    // respondida: ya no está abierta
    expect(sent.mode).toBe("link");
    expect((await submitSurvey(store, sent.mode === "link" ? sent.token : "", form(GOOD), NOW)).ok).toBe(true);
    expect(await manualSurveyWarnings(store, await get("A"), NOW)).toEqual([]);
    // y no bloquea: se puede enviar otra
    const again = await sendManualSurvey(store, { company: await get("B"), contact: null, user: frank, expiresDays: 30, env: ENV_BASE, now: NOW });
    expect(again.survey.estado).toBe("enviada");
  });

  it("manual: si el correo lanza, la encuesta queda vencida sin enviar", async () => {
    const company = (await store.getCompany(ids.A))!;
    const rosa = await store.addContact({ companyId: ids.A, nombre: "Rosa", email: "rosa@alfa.example.pe" });
    await expect(
      sendManualSurvey(store, { company, contact: rosa, user: frank, expiresDays: 30, env: ENV_MAIL, now: NOW, sendEmail: async () => Promise.reject(new Error("caído")) }),
    ).rejects.toThrow("caído");
    const [s] = await store.listSurveys({ companyId: ids.A });
    expect(s).toMatchObject({ estado: "vencida", enviadaAt: null });
  });

  it("el correo lleva la razón social, el enlace y la fecha de vencimiento", () => {
    const m = invitationEmail({ razonSocial: "ALFA <S.A.C.>", url: "https://x/encuesta/abc", expiresAt: new Date("2026-12-11T13:00:00Z"), contactName: "Rosa", sellerName: "Frank Rodríguez" });
    expect(m.text).toContain("Estimado/a Rosa");
    expect(m.text).toContain("11/12/2026");
    expect(m.html).toContain("ALFA &lt;S.A.C.&gt;");
    expect(m.html).not.toContain("<S.A.C.>");
  });
});

describe("resumen y NPS", () => {
  const resp = (nps: number, valora: string[], mejorar: string | null, day: number, companyId = 1): SurveyResponse => ({
    id: day,
    surveyId: day,
    nps,
    valora,
    satisfaccionEntrega: 4,
    mejorar,
    referencia: nps >= 9,
    createdAt: new Date(Date.UTC(2026, 10, day)),
    companyId,
    contactId: null,
    canal: "email",
  });

  it("promedio, NPS = %promotores − %detractores, lo más valorado y comentarios recientes", () => {
    expect([npsGroup(10), npsGroup(9), npsGroup(8), npsGroup(7), npsGroup(6), npsGroup(0)]).toEqual(["promotor", "promotor", "pasivo", "pasivo", "detractor", "detractor"]);
    const s = summarizeSurveys([resp(10, ["precio", "stock"], "más stock", 1), resp(9, ["precio"], null, 2), resp(7, ["soporte", "precio"], "  ", 3), resp(3, ["stock"], "demoras", 4)]);
    expect(s).toMatchObject({ respuestas: 4, promedio: 7.3, promotores: 2, pasivos: 1, detractores: 1, nps: 25, satisfaccion: 4, referencias: 2 });
    expect(s.valorado.map((v) => [v.opcion, v.veces])).toEqual([
      ["Precio", 3],
      ["Disponibilidad de stock", 2],
      ["Soporte técnico", 1],
    ]);
    expect(s.comentarios.map((c) => c.texto)).toEqual(["demoras", "más stock"]);
    expect(summarizeSurveys([])).toMatchObject({ respuestas: 0, promedio: null, nps: null });
  });

  it("tablero: el vendedor solo ve sus empresas; el supervisor todas", async () => {
    await seed();
    const pedro = await store.upsertUser({ nombre: "Pedro", whatsapp: "51900000002", rol: "vendedor" });
    await store.updateCompany(ids.C, { ownerUserId: pedro.id });
    for (const [k, nps] of [["A", 10], ["C", 2]] as const) {
      const c = (await createSurveyLink(store, { companyId: ids[k], canal: "manual", now: NOW, expiresDays: 30 }))!;
      await submitSurvey(store, c.token, form({ ...GOOD, nps: String(nps), mejorar: `comentario ${k}` }), NOW);
    }
    const mine = await loadSurveySummary(store, { ownerUserId: frank.id, now: NOW });
    expect(mine).toMatchObject({ respuestas: 1, nps: 100 });
    expect(mine.comentariosEmpresa).toEqual([expect.objectContaining({ texto: "comentario A", empresa: "ALFA TRANSPORTES PRUEBA S.A.C." })]);
    const all = await loadSurveySummary(store, { now: NOW });
    expect(all).toMatchObject({ respuestas: 2, nps: 0, promedio: 6 });
  });
});
