/**
 * Corrida H, punto 2 — store del portal contra Postgres real: cada escritura del portal y del bot, con las mismas
 * entradas en el store JSON (en memoria) y en PgPortalStore (pool de producción, pooler en modo transacción). Lo que
 * se observa después (lecturas, listados, resultados) tiene que ser igual en los dos.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonPortalStore } from "../lib/portal/store/json-portal-store";
import { PgPortalStore } from "../lib/portal/store/pg-portal-store";
import type { FleetVehicleInput, PortalStore } from "../lib/portal/store/types";
import { recalcScores } from "../lib/portal/scoring/recalc";
import { loadPortalConfig } from "../lib/portal/config";
import { testDbUrl, truncateAll } from "./harness";
import { bothTraces, diffTraces } from "./parity";

let pg: PgPortalStore;

beforeAll(async () => {
  await truncateAll(testDbUrl());
  pg = PgPortalStore.connect(testDbUrl());
});
afterAll(async () => {
  await pg?.close();
});

const T0 = new Date("2026-11-11T15:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const day = (d: number) => new Date(T0.getTime() + d * 86_400_000);

function vehicle(companyId: number, placa: string, over: Partial<FleetVehicleInput> = {}): FleetVehicleInput {
  return {
    companyId, placa, marca: "SCANIA", clase: "REMOLCADOR", anio: 2018, ejes: 3, llantas: 10, llantasFuente: "20241231", pesoBruto: 48000, chasis: null,
    departamento: "LIMA", origen: "carga", medidaProbable: "295/80R22.5", confianza: "media", ...over,
  };
}

/** Todas las escrituras del portal en orden fijo (sin paralelismo: los ids tienen que coincidir). */
async function scenario(s: PortalStore, trace: (label: string, v: unknown) => void): Promise<void> {
  // ── usuarios ──
  const frank = await s.upsertUser({ nombre: "Frank Prueba", whatsapp: "+51 900 000 001", rol: "vendedor" });
  const juan = await s.upsertUser({ nombre: "Juan Prueba", whatsapp: "51900000002", rol: "supervisor", activo: true });
  // las inserciones primero: en Postgres un upsert que choca gasta un número de la secuencia (ids distintos, no es un error)
  trace("user.inactivo", await s.upsertUser({ nombre: "Ex Vendedor", whatsapp: "51900000003", rol: "vendedor", activo: false }));
  trace("user.update", await s.upsertUser({ nombre: "Frank P.", whatsapp: "51900000001", rol: "vendedor" }));
  trace("user.keepsActivo", await s.upsertUser({ nombre: "Ex Vendedor", whatsapp: "51900000003", rol: "vendedor" }));
  // corrida J: correo y enlaces de calendario; un upsert sin ellos los conserva, null borra el correo, uno mal escrito no se guarda
  trace("user.email", await s.upsertUser({ nombre: "Frank P.", whatsapp: "51900000001", rol: "vendedor", email: " Frank.P@Example.PE ", calendarLinks: true }));
  trace("user.keepsEmail", await s.upsertUser({ nombre: "Frank P.", whatsapp: "51900000001", rol: "vendedor" }));
  trace("user.badEmail", await s.upsertUser({ nombre: "Juan Prueba", whatsapp: "51900000002", rol: "supervisor", email: "no es correo" }));
  trace("user.clearEmail", await s.upsertUser({ nombre: "Ex Vendedor", whatsapp: "51900000003", rol: "vendedor", email: null, calendarLinks: false }));
  trace("user.byWhatsapp", await s.getUserByWhatsapp("51 900 000 002"));
  trace("user.list", await s.listUsers());

  // ── empresas ──
  const up = await s.upsertCompanies([
    { ruc: "20100000001", razonSocial: "TRANSPORTES ANDINOS DEL SUR S.A.C.", sector: "carga", departamento: "AREQUIPA", unidades: 40, llantasPiso: 400 },
    { ruc: "20100000002", razonSocial: "Turismo Señor de Ñaña S.A.", sector: "pasajeros", departamento: "LIMA", unidades: 25, llantasPiso: 160 },
    { ruc: "2010-0000-003", razonSocial: "LOGÍSTICA COSTERA E.I.R.L.", sector: "mixto", departamento: "LIMA", unidades: 12, llantasPiso: 600 },
    { ruc: "20100000004", razonSocial: "NUEVA SAC" },
  ]);
  trace("companies.upsert", up);
  const A = up.ids["20100000001"];
  const B = up.ids["20100000002"];
  const C = up.ids["20100000003"];
  trace("companies.reupsert", await s.upsertCompanies([{ ruc: "20100000001", razonSocial: "TRANSPORTES ANDINOS DEL SUR SAC", unidades: 42 }, { ruc: "20100000004", razonSocial: "NUEVA S.A.C.", departamento: "PIURA" }]));
  trace("companies.update", await s.updateCompany(A, { esCliente: true, temperatura: "caliente", creditTermsDays: 30 }));
  trace("companies.updateEmpty", (await s.updateCompany(B, {}))?.razonSocial);
  trace("companies.setOwner", await s.setOwner(A, frank.id));
  trace("companies.byRuc", await s.getCompanyByRuc("20100000001"));
  trace("companies.byRucs", (await s.getCompaniesByRucs(["20100000002", "20100000003", "20100000002", "x"])).map((c) => c.ruc).sort());
  trace("companies.count", await s.countCompanies());

  // ── flota ──
  trace("fleet.upsert", await s.upsertFleet([vehicle(A, "ABC-123"), vehicle(A, "abc 124", { marca: "volvo " }), vehicle(A, "ABC-125", { origen: "pasajeros", medidaProbable: "11R22.5" }), vehicle(B, "BUS-001", { origen: "pasajeros", clase: "OMNIBUS", marca: "MERCEDES BENZ" })]));
  trace("fleet.replace", await s.replaceFleet(A, [{ ...vehicle(A, "ABC-124"), marca: "VOLVO" }, { ...vehicle(A, "NEW-001"), anio: 2022 }, vehicle(A, "ABC-125", { origen: "pasajeros", medidaProbable: "11R22.5" })]));
  trace("fleet.move", await s.upsertFleet([vehicle(C, "BUS-001", { origen: "pasajeros", clase: "OMNIBUS", marca: "MERCEDES BENZ" })]));
  trace("fleet.prune", await s.pruneFleet([B, C], [{ placa: "bus 001", origen: "pasajeros" }]));
  trace("fleet.list", await s.listFleet(A));
  // corrida J: la placa de una línea contra el padrón (sin guion, espacios ni mayúsculas)
  trace("fleet.byPlacas", await s.findFleetByPlacas(["abc-124", "BUS 001", "new001", "ZZZ-999"]));
  trace("fleet.byBrand", await s.fleetByBrand(A));
  trace("fleet.count", await s.countFleet());
  trace("fleet.origin", await s.companyOriginCounts());
  trace("fleet.marcas", await s.listMarcas());
  trace("companies.departamentos", await s.listDepartamentos());

  // ── ventas (subida de Excel y demo) ──
  trace("sales.insert", await s.insertSales([
    { fecha: "2026-09-01", ruc: "20100000001", razonSocial: "TRANSPORTES ANDINOS", medida: "295/80R22.5", marca: "VALOR", cantidad: 24, precioUnitario: 250, vendedor: "FRANK", origen: "excel", sourceRef: "xlsx:abc" },
    { fecha: "2026-10-15", ruc: "20100000001", cantidad: 8, total: 2000, vendedor: "FRANK", origen: "excel", sourceRef: "xlsx:abc" },
    { fecha: "2025-01-15", ruc: "20100000002", cantidad: 4, origen: "excel", sourceRef: "xlsx:abc" },
    { fecha: "2026-10-01", ruc: "20100000003", cantidad: 12, origen: "demo", isDemo: true },
  ]));
  trace("sales.bySource", await s.countSalesBySource("xlsx:abc"));
  trace("sales.bySourceNone", await s.countSalesBySource("xlsx:otro"));
  trace("sales.byRuc", await s.salesByRuc("20100000001"));
  trace("sales.byRucSince", (await s.salesByRuc("20100000001", "2026-10-01")).map((x) => x.fecha));
  trace("sales.participation", await s.participation(["20100000001", "20100000002", "20100000003"], "2026-01-01"));
  trace("sales.aggregate", (await s.salesAggregate("2026-01-01", "2026-12-31")).sort((a, b) => a.fecha.localeCompare(b.fecha)));
  trace("sales.search", (await s.searchCompanies({ orderBy: "participacion", since: "2026-01-01", withMedidas: true })).rows.map((r) => [r.ruc, r.participacion, r.participacionDemo, r.medidas]));
  trace("sales.searchQ", (await s.searchCompanies({ q: "señor ñaña", since: "2026-01-01" })).rows.map((r) => r.ruc));
  trace("sales.searchFiltros", await s.searchCompanies({ departamento: ["LIMA"], minUnits: 10, marcas: ["volvo"], since: "2026-01-01" }));
  trace("sales.deleteDemo", await s.deleteDemoSales());
  trace("sales.count", await s.countSales());

  // ── acceso: enlaces y sesiones ──
  await s.saveLoginToken({ tokenHash: "h1", userId: frank.id, expiresAt: at(15) });
  await s.saveLoginToken({ tokenHash: "h-viejo", userId: frank.id, expiresAt: at(-1) });
  trace("token.consume", await s.consumeLoginToken("h1", T0));
  trace("token.consumeAgain", await s.consumeLoginToken("h1", T0));
  trace("token.expired", await s.consumeLoginToken("h-viejo", T0));
  trace("session.create", await s.createSession({ id: "sess-1", userId: frank.id, expiresAt: day(30) }));
  trace("session.get", await s.getSession("sess-1", T0));
  trace("session.getExpired", await s.getSession("sess-1", day(31)));
  await s.deleteSession("sess-1");
  trace("session.deleted", await s.getSession("sess-1", T0));
  // hotfix login 2: enlace reutilizable (nonce para reenviarlo), renovar la sesión, `cerrar portal`
  await s.saveLoginToken({ tokenHash: "h-n1", userId: frank.id, expiresAt: at(60), nonce: "n1" });
  await s.saveLoginToken({ tokenHash: "h-n2", userId: juan.id, expiresAt: at(60), nonce: "n2" });
  await s.saveLoginToken({ tokenHash: "h-sin-nonce", userId: juan.id, expiresAt: at(90) });
  trace("token.current", await s.currentLoginToken(frank.id, T0));
  trace("token.currentJuan", await s.currentLoginToken(juan.id, T0));
  trace("token.currentLater", await s.currentLoginToken(frank.id, at(61)));
  await s.extendLoginToken("h-n1", at(120));
  await s.extendLoginToken("h-n1", at(30)); // no acorta
  trace("token.extended", await s.currentLoginToken(frank.id, at(100)));
  trace("token.peek", [await s.peekLoginToken("h-n1", at(100)), await s.peekLoginToken("h-n1", at(121)), await s.peekLoginToken("nope", T0)]);
  trace("token.use", await s.useLoginTokenIntoSession("h-n1", at(1), { id: "sess-2", expiresAt: day(30) }));
  trace("token.useAgain", await s.useLoginTokenIntoSession("h-n1", at(2), { id: "sess-3", expiresAt: day(30) }));
  trace("token.useExpired", await s.useLoginTokenIntoSession("h-viejo", at(2), { id: "sess-x", expiresAt: day(30) }));
  trace("session.fromToken", [await s.getSession("sess-2", T0), await s.getSession("sess-3", T0), await s.getSession("sess-x", T0)]);
  await s.renewSession("sess-2", day(40));
  await s.renewSession("sess-2", day(35)); // no acorta
  trace("session.renewed", await s.getSession("sess-2", day(39)));
  await s.createSession({ id: "sess-juan", userId: juan.id, expiresAt: day(30) });
  trace("access.revoke", await s.revokeUserAccess(frank.id, at(5)));
  trace("access.afterRevoke", [await s.getSession("sess-2", at(6)), await s.getSession("sess-3", at(6)), await s.peekLoginToken("h-n1", at(6)), await s.currentLoginToken(frank.id, at(6))]);
  trace("access.othersKeep", [await s.getSession("sess-juan", at(6)), await s.peekLoginToken("h-n2", at(6))]);
  trace("access.revokeAgain", await s.revokeUserAccess(frank.id, at(7)));

  // ── contactos ──
  const ct = await s.addContact({ companyId: A, nombre: "Carlos Quispe", cargo: "Jefe de flota", telefono: "987654321", createdBy: frank.id });
  trace("contact.add", ct);
  trace("contact.update", await s.updateContact(ct.id, { email: "carlos@example.pe", cargo: null }));
  const ct2 = await s.addContact({ companyId: A, nombre: "Otra Persona" });
  trace("contact.delete", await s.deleteContact(ct2.id));
  trace("contact.deleteAgain", await s.deleteContact(ct2.id));
  trace("contact.list", await s.listContacts(A));

  // ── oportunidades (asignarme, etapas) ──
  const op = await s.createOpportunity({ companyId: A, ownerUserId: frank.id, createdBy: frank.id, at: at(1) });
  trace("opp.create", op);
  trace("opp.moveSame", await s.moveStage(op.id, "prospecto", frank.id, at(2)));
  trace("opp.move", await s.moveStage(op.id, "cita_agendada", frank.id, at(3)));
  trace("opp.update", await s.updateOpportunity(op.id, { proximaAccion: "Visita", proximaAccionAt: day(2), montoEstimado: 8128.5, quoteNumber: "COT-0001", cierreEsperado: "2026-12-15" }));
  trace("opp.open", await s.getOpenOpportunity(A, frank.id));
  const op2 = await s.createOpportunity({ companyId: B, etapa: "cerrado_perdido", at: at(4) });
  trace("opp.closed", op2);
  trace("opp.moveMissing", await s.moveStage(99999, "cotizacion_enviada", null, at(5)));
  trace("opp.openOrCreateExisting", await s.openOrCreateOpportunity({ companyId: A, ownerUserId: juan.id, createdBy: juan.id, at: at(6) }));
  trace("opp.openOrCreateNew", await s.openOrCreateOpportunity({ companyId: C, ownerUserId: juan.id, createdBy: juan.id, at: at(7) }));
  trace("owner.claimTaken", await s.setOwner(A, juan.id, { onlyIfOwner: null }));
  trace("owner.claimWrongPrev", await s.setOwner(B, juan.id, { onlyIfOwner: frank.id }));
  trace("owner.claimFree", await s.setOwner(B, juan.id, { onlyIfOwner: null }));
  trace("owner.release", await s.setOwner(B, null, { onlyIfOwner: juan.id }));
  trace("opp.listOpen", (await s.listOpportunities({ open: true })).map((o) => o.id));
  trace("opp.listClosed", (await s.listOpportunities({ open: false, etapas: ["cerrado_perdido"] })).map((o) => o.id));
  trace("opp.history", await s.stageHistory(op.id));
  trace("opp.historyFor", await s.stageHistoryFor([op.id, op2.id, op.id]));

  // ── actividades (reporte de visita, enlazar cotización) ──
  trace("act.add", await s.addActivity({ companyId: A, opportunityId: op.id, userId: frank.id, tipo: "visita", texto: "Visité ZBUSS", canal: "whatsapp", data: { quoteNumber: "COT-0001", items: [{ q: 8 }] }, occurredAt: at(10) }));
  await s.addActivity({ companyId: A, userId: frank.id, tipo: "nota", occurredAt: at(11) });
  await s.addActivity({ companyId: B, userId: juan.id, tipo: "llamada", texto: "Llamé", occurredAt: at(12) });
  trace("act.list", await s.listActivities({ companyId: A }));
  trace("act.listUser", (await s.listActivities({ userId: frank.id, since: at(10), until: at(11), limit: 5 })).map((a) => a.tipo));
  trace("act.listLimit", (await s.listActivities({ limit: 2 })).map((a) => a.texto));

  // ── citas y reprogramación ──
  const ap = await s.addAppointment({ companyId: A, opportunityId: op.id, userId: frank.id, startsAt: day(2), lugar: "Base de Ate", conTecnico: true });
  trace("appt.add", ap);
  trace("appt.reprogramar", await s.updateAppointment(ap.id, { startsAt: day(3), notas: "movida" }));
  trace("appt.updateEmpty", await s.updateAppointment(ap.id, {}));
  trace("appt.updateMissing", await s.updateAppointment(99999, { estado: "cancelada" }));
  await s.addAppointment({ companyId: B, userId: juan.id, startsAt: day(1), estado: "realizada" });
  trace("appt.list", await s.listAppointments({ from: day(0), to: day(5) }));
  trace("appt.listUser", (await s.listAppointments({ userId: frank.id, estado: "programada" })).map((a) => a.id));

  // ── conversación del bot del portal ──
  await s.setPortalConversation("+51 900 000 001", { pending: { kind: "report", draft: { texto: "hola", n: 1 } } });
  trace("conv.get", (await s.getPortalConversation("51900000001"))?.state);
  await s.setPortalConversation("51900000001", {});
  trace("conv.cleared", await s.getPortalConversation("51900000001"));

  // ── vocabulario y transcripciones de voz ──
  trace("vocab.add", await s.addVocabulary({ term: " Fenix ", meaning: "Fenixway", addedBy: frank.id }));
  trace("vocab.upsert", await s.addVocabulary({ term: "FENIX", meaning: "Fenixway (marca)" }));
  trace("vocab.list", await s.listVocabulary());
  await s.logVoiceTranscript({ phone: "51900000001", userId: frank.id, context: "cotizacion", transcript: "ocho fenix", understood: { sizes: ["295/80R22.5"], quantities: [8], brand: "FENIXWAY", design: null, customer: null, questions: [], fixes: [{ from: "fenix", to: "fenixway" }] }, outcome: "ok" as never, createdAt: at(20) });
  trace("voice.list", await s.listVoiceTranscripts({ phone: "51900000001" }));

  // ── OC, pedido y memoria del pedido ──
  const po = await s.addPurchaseOrder({ companyId: A, opportunityId: op.id, userId: frank.id, numero: " 4500123 ", quoteNumber: "COT-0001", fileName: "oc.pdf", mimeType: "application/pdf", data: "UERGLTE=", createdAt: at(30) });
  trace("po.add", po);
  trace("po.update", await s.updatePurchaseOrder(po.id, { status: "pedido_enviado", quoteNumber: "COT-0002" }));
  trace("po.list", await s.listPurchaseOrders({ companyId: A }));
  trace("po.get", await s.getPurchaseOrder(po.id));
  trace("profile.none", await s.getOrderProfile(A));
  trace("profile.set", (await s.setOrderProfile(A, { direccionFiscal: "Av. 1", last: { flete: "cliente", enllante: false } })).data);
  trace("profile.get", (await s.getOrderProfile(A))?.data);

  // ── crédito ──
  trace("credit.first", await s.saveCredit(A, { estado: "en_evaluacion", fuente: "manual", pdf: { name: "r.pdf", mime: "application/pdf", data: "UERG" } }, frank.id, at(40)));
  trace("credit.same", await s.saveCredit(A, { estado: "en_evaluacion", fuente: "manual" }, juan.id, at(41)));
  trace("credit.approve", await s.saveCredit(A, { estado: "aprobado", fuente: "manual", linea: 50000, moneda: "USD", plazoDias: 45, consultadoAt: at(42), consultadoPor: juan.id }, juan.id, at(43)));
  trace("credit.get", await s.getCredit(A));
  trace("credit.pdf", await s.getCreditPdf(A));
  trace("credit.dropPdf", (await s.saveCredit(A, { estado: "aprobado", fuente: "manual", linea: 50000, moneda: "USD", plazoDias: 45, consultadoAt: at(42), consultadoPor: juan.id, pdf: null }, juan.id, at(44))).entry?.cambios);
  trace("credit.pdfGone", await s.getCreditPdf(A));
  trace("credit.history", await s.creditHistory(A));

  // ── encuestas ──
  const sv = await s.createSurvey({ companyId: A, contactId: ct.id, tokenHash: "tok-a", canal: "whatsapp_vendedor", createdBy: frank.id, expiresAt: day(30), createdAt: at(50) });
  trace("survey.create", sv);
  trace("survey.dup", await s.createSurvey({ companyId: A, tokenHash: "tok-a2", canal: "email", expiresAt: day(30), createdAt: at(51) }, { onlyIfNoneSince: day(-30) }));
  trace("survey.sent", await s.markSurveySent(sv!.id, at(52), "email"));
  trace("survey.sentAgain", await s.markSurveySent(sv!.id, at(53)));
  const ans = { nps: 9, valora: ["precio", "stock"], satisfaccionEntrega: 4, mejorar: "Más stock", referencia: true };
  trace("survey.answer", await s.answerSurvey(sv!.id, ans, at(60)));
  trace("survey.answerAgain", await s.answerSurvey(sv!.id, ans, at(61)));
  trace("survey.answerMissing", await s.answerSurvey(99999, ans, at(61)));
  const sv2 = await s.createSurvey({ companyId: B, tokenHash: "tok-b", canal: "manual", expiresAt: at(70), createdAt: at(50) });
  trace("survey.answerLate", await s.answerSurvey(sv2!.id, ans, at(71)));
  trace("survey.expire", await s.expireSurvey(sv2!.id));
  trace("survey.byToken", await s.getSurveyByTokenHash("tok-a"));
  trace("survey.list", await s.listSurveys({ ownerUserId: frank.id }));
  trace("survey.listAll", (await s.listSurveys({ limit: 5 })).map((x) => [x.id, x.estado]));
  trace("survey.responses", await s.listSurveyResponses({ since: day(-1) }));

  // ── puntaje (completo y parcial), ranking y validación ──
  const cfg = loadPortalConfig().scoring;
  const full = await recalcScores(s, cfg, { now: T0, prices: null });
  trace("score.full", { empresas: full.empresas, conteo: full.conteo, cuts: full.cuts, top: full.top, full: full.full });
  trace("score.run", await s.latestScoreRun().then((r) => r && { ...r, duracionMs: typeof r.duracionMs }));
  trace("score.company", await s.getCompany(A));
  await s.updateCompany(C, { esCliente: true });
  const part = await recalcScores(s, cfg, { now: at(90), companyIds: [C], prices: null });
  trace("score.partial", { empresas: part.empresas, conteo: part.conteo, cuts: part.cuts, full: part.full });
  trace("score.companyC", await s.getCompany(C));
  trace("score.best", await s.bestCompanies({ userId: frank.id, activeSince: day(-30), limit: 2, offset: 0 }));
  trace("score.best2", await s.bestCompanies({ userId: frank.id, activeSince: day(-30), limit: 10, offset: 1 }));
  trace("score.validate", await s.addRankingValidations([
    { userId: frank.id, companyId: A, nivelVendedor: "A", nota: "buena", nivelSistema: "B", scoreSistema: 61.25, createdAt: at(100) },
    { userId: frank.id, companyId: B, nivelVendedor: "no_conozco" as never, nota: null, nivelSistema: null, scoreSistema: null, createdAt: at(100) },
  ]));
  trace("score.validations", await s.listRankingValidations({ userId: frank.id, since: at(99) }));
  trace("score.notice1", await s.markUserNotice(frank.id, "ranking"));
  trace("score.notice2", await s.markUserNotice(frank.id, "ranking"));

  // ── límites de intentos ──
  trace("rate.hits", [await s.hitRateLimit("login:ip:x", at(0)), await s.hitRateLimit("login:ip:x", at(0)), await s.hitRateLimit("login:ip:x", at(1)), await s.hitRateLimit("login:ip:y", at(0))]);
  trace("rate.prune", await s.pruneRateLimitHits(at(1)));
  trace("rate.afterPrune", await s.hitRateLimit("login:ip:x", at(0)));
}

describe("store del portal: JSON y Postgres dan lo mismo", () => {
  it("todas las escrituras y sus lecturas", async () => {
    const { json, pg: p } = await bothTraces<PortalStore>(JsonPortalStore.memory(), pg, scenario);
    expect(diffTraces(json, p)).toEqual([]);
  });
});
