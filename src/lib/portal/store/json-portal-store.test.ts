import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { seedUsers } from "../users";
import { JsonPortalStore } from "./json-portal-store";
import type { FleetVehicleInput } from "./types";

const NOW = new Date("2026-11-11T15:00:00Z");

function vehicle(companyId: number, placa: string, over: Partial<FleetVehicleInput> = {}): FleetVehicleInput {
  return {
    companyId,
    placa,
    marca: "SCANIA",
    clase: "REMOLCADOR",
    anio: 2018,
    ejes: 3,
    llantas: 10,
    llantasFuente: "20241231",
    pesoBruto: 48000,
    chasis: null,
    departamento: "LIMA",
    origen: "carga",
    medidaProbable: "295/80R22.5",
    confianza: "media",
    ...over,
  };
}

async function seeded() {
  const store = JsonPortalStore.memory();
  const { ids } = await store.upsertCompanies([
    { ruc: "20100000001", razonSocial: "TRANSPORTES ANDINOS DEL SUR S.A.C.", sector: "carga", departamento: "AREQUIPA", unidades: 40, llantasPiso: 400 },
    { ruc: "20100000002", razonSocial: "Turismo Señor de Ñaña S.A.", sector: "pasajeros", departamento: "LIMA", unidades: 25, llantasPiso: 160 },
    { ruc: "20100000003", razonSocial: "LOGÍSTICA COSTERA E.I.R.L.", sector: "mixto", departamento: "LIMA", unidades: 12, llantasPiso: 600 },
  ]);
  return { store, ids };
}

describe("JsonPortalStore — empresas y flota", () => {
  it("reimportar empresas no duplica y conserva lo trabajado en el portal", async () => {
    const { store, ids } = await seeded();
    expect(await store.countCompanies()).toBe(3);
    await store.setOwner(ids["20100000001"], 7);
    await store.updateCompany(ids["20100000001"], { esCliente: true, temperatura: "caliente", creditTermsDays: 30 });

    const again = await store.upsertCompanies([{ ruc: "20100000001", razonSocial: "TRANSPORTES ANDINOS DEL SUR SAC", unidades: 42, llantasPiso: 420 }, { ruc: "20100000004", razonSocial: "NUEVA SAC", unidades: 10 }]);
    expect(again).toMatchObject({ inserted: 1, updated: 1 });
    expect(again.ids["20100000001"]).toBe(ids["20100000001"]);
    expect(await store.countCompanies()).toBe(4);
    const c = await store.getCompanyByRuc("20100000001");
    expect(c).toMatchObject({ razonSocial: "TRANSPORTES ANDINOS DEL SUR SAC", unidades: 42, llantasPiso: 420, ownerUserId: 7, esCliente: true, temperatura: "caliente", creditTermsDays: 30, departamento: "AREQUIPA", sector: "carga" });
  });

  it("upsertFleet es idempotente por (placa, origen) y mueve una placa de empresa", async () => {
    const { store, ids } = await seeded();
    const a = ids["20100000001"];
    const b = ids["20100000002"];
    expect(await store.upsertFleet([vehicle(a, "ABC-123"), vehicle(a, "abc-124"), vehicle(a, "ABC-125", { origen: "pasajeros" })])).toEqual({ inserted: 3, updated: 0 });
    expect(await store.upsertFleet([vehicle(a, "ABC-123", { anio: 2019 }), vehicle(a, "ABC-124")])).toEqual({ inserted: 0, updated: 2 });
    expect(await store.countFleet()).toBe(3);
    expect((await store.listFleet(a)).find((v) => v.placa === "ABC-123")?.anio).toBe(2019);

    await store.upsertFleet([vehicle(b, "ABC-123")]);
    expect((await store.listFleet(a)).map((v) => v.placa)).toEqual(["ABC-124", "ABC-125"]);
    expect((await store.listFleet(b)).map((v) => v.placa)).toEqual(["ABC-123"]);
    expect(await store.countFleet()).toBe(3);
  });

  it("replaceFleet deja exactamente la flota indicada", async () => {
    const { store, ids } = await seeded();
    const a = ids["20100000001"];
    await store.upsertFleet([vehicle(a, "X1"), vehicle(a, "X2"), vehicle(a, "X3")]);
    const r = await store.replaceFleet(a, [vehicle(a, "X2"), vehicle(a, "X4")]);
    expect(r).toEqual({ removed: 2, upserted: 2 });
    expect((await store.listFleet(a)).map((v) => v.placa)).toEqual(["X2", "X4"]);
  });

  it("fleetByBrand agrupa por marca y clase con años, llantas y la medida más frecuente", async () => {
    const { store, ids } = await seeded();
    const a = ids["20100000001"];
    await store.upsertFleet([
      vehicle(a, "S1", { anio: 2015 }),
      vehicle(a, "S2", { anio: 2021, llantas: null, llantasFuente: null }),
      vehicle(a, "S3", { marca: "Scania", anio: 2019, medidaProbable: "12R22.5", confianza: "baja" }),
      vehicle(a, "H1", { marca: "HINO", clase: "CAMION", ejes: 2, llantas: 6, anio: 2020, medidaProbable: "235/75R17.5", confianza: "media" }),
      vehicle(a, "H2", { marca: "HINO", clase: "CAMION", ejes: 2, llantas: 6, anio: null, medidaProbable: null, confianza: null }),
    ]);
    const groups = await store.fleetByBrand(a);
    expect(groups).toEqual([
      { marca: "SCANIA", clase: "REMOLCADOR", anioMin: 2015, anioMax: 2021, unidades: 3, llantas: 20, unidadesConLlantas: 2, medidaProbable: "295/80R22.5", confianza: "media" },
      { marca: "HINO", clase: "CAMION", anioMin: 2020, anioMax: 2020, unidades: 2, llantas: 12, unidadesConLlantas: 2, medidaProbable: "235/75R17.5", confianza: "media" },
    ]);
  });

  it("searchCompanies filtra (texto sin tildes, departamento, sector, unidades, marcas, cliente) y pagina", async () => {
    const { store, ids } = await seeded();
    await store.upsertFleet([vehicle(ids["20100000001"], "A1"), vehicle(ids["20100000002"], "B1", { marca: "Sinotruk" }), vehicle(ids["20100000003"], "C1", { marca: "HOWO" })]);
    await store.updateCompany(ids["20100000003"], { esCliente: true });

    expect((await store.searchCompanies({ q: "senor de nana", now: NOW })).rows.map((r) => r.ruc)).toEqual(["20100000002"]);
    expect((await store.searchCompanies({ q: "logistica", now: NOW })).rows.map((r) => r.ruc)).toEqual(["20100000003"]);
    expect((await store.searchCompanies({ q: "201000000", now: NOW })).total).toBe(3);
    expect((await store.searchCompanies({ departamento: ["LIMA"], now: NOW })).rows.map((r) => r.ruc)).toEqual(["20100000002", "20100000003"]);
    expect((await store.searchCompanies({ sector: ["carga", "mixto"], now: NOW })).total).toBe(2);
    expect((await store.searchCompanies({ minUnits: 20, maxUnits: 30, now: NOW })).rows.map((r) => r.ruc)).toEqual(["20100000002"]);
    expect((await store.searchCompanies({ marcas: ["sinotruk", "Howo", "SITRAK"], now: NOW })).rows.map((r) => r.ruc)).toEqual(["20100000002", "20100000003"]);
    expect((await store.searchCompanies({ esCliente: true, now: NOW })).rows.map((r) => r.ruc)).toEqual(["20100000003"]);
    expect((await store.searchCompanies({ orderBy: "llantas", now: NOW })).rows.map((r) => r.ruc)).toEqual(["20100000003", "20100000001", "20100000002"]);

    const p2 = await store.searchCompanies({ page: 2, pageSize: 2, now: NOW });
    expect(p2.total).toBe(3);
    expect(p2.rows.map((r) => r.ruc)).toEqual(["20100000003"]);
  });

  it("listMarcas y listDepartamentos cuentan", async () => {
    const { store, ids } = await seeded();
    await store.upsertFleet([vehicle(ids["20100000001"], "A1"), vehicle(ids["20100000001"], "A2"), vehicle(ids["20100000002"], "B1", { marca: "scania " }), vehicle(ids["20100000002"], "B2", { marca: "HINO" })]);
    expect(await store.listMarcas()).toEqual([
      { marca: "SCANIA", vehiculos: 3, empresas: 2 },
      { marca: "HINO", vehiculos: 1, empresas: 1 },
    ]);
    expect(await store.listDepartamentos()).toEqual([
      { departamento: "LIMA", empresas: 2 },
      { departamento: "AREQUIPA", empresas: 1 },
    ]);
  });
});

describe("JsonPortalStore — ventas y participación", () => {
  it("participación de 12 meses con flag demo y orden por participación", async () => {
    const { store } = await seeded();
    await store.insertSales([
      { fecha: "2026-10-01", ruc: "20100000002", cantidad: 12, origen: "excel" },
      { fecha: "2026-01-15", ruc: "20100000002", cantidad: 8, origen: "excel" },
      { fecha: "2025-11-10", ruc: "20100000002", cantidad: 100, origen: "excel" }, // fuera de la ventana (antes del 2025-11-11)
      { fecha: "2026-06-01", ruc: "20100000003", cantidad: 30, isDemo: true, origen: "demo" },
      { fecha: "2026-07-01", ruc: "20100000003", cantidad: 4, origen: "excel" },
    ]);
    expect(await store.participation(["20100000002", "20100000003", "20100000001"], "2025-11-11")).toEqual({
      "20100000002": { cantidad: 20, demo: false },
      "20100000003": { cantidad: 34, demo: true },
    });

    const res = await store.searchCompanies({ orderBy: "participacion", now: NOW });
    expect(res.rows.map((r) => [r.ruc, r.participacion, r.participacionDemo])).toEqual([
      ["20100000003", 34, true],
      ["20100000002", 20, false],
      ["20100000001", 0, false],
    ]);

    expect((await store.salesByRuc("20100000002", "2026-01-01")).map((s) => s.fecha)).toEqual(["2026-10-01", "2026-01-15"]);
    const before = await store.countSales();
    expect(before.demo).toBe(1);
    expect(await store.deleteDemoSales()).toBe(1);
    expect(await store.countSales()).toEqual({ total: before.total - 1, demo: 0 });
    expect(await store.participation(["20100000003"], "2025-11-11")).toEqual({ "20100000003": { cantidad: 4, demo: false } });
  });
});

describe("JsonPortalStore — usuarios, tokens y sesiones", () => {
  it("el token de login es de un solo uso y vence", async () => {
    const store = JsonPortalStore.memory();
    const u = await store.upsertUser({ nombre: "Ana", whatsapp: "+51 999 000 111", rol: "vendedor" });
    expect(u.whatsapp).toBe("51999000111");
    expect((await store.upsertUser({ nombre: "Ana P.", whatsapp: "51999000111", rol: "supervisor" })).id).toBe(u.id);
    expect(await store.listUsers()).toHaveLength(1);
    expect((await store.getUserByWhatsapp("51999000111"))?.rol).toBe("supervisor");

    await store.saveLoginToken({ tokenHash: "h1", userId: u.id, expiresAt: new Date(NOW.getTime() + 15 * 60_000) });
    expect(await store.consumeLoginToken("h1", NOW)).toBe(u.id);
    expect(await store.consumeLoginToken("h1", NOW)).toBeNull();
    expect(await store.consumeLoginToken("nope", NOW)).toBeNull();

    await store.saveLoginToken({ tokenHash: "h2", userId: u.id, expiresAt: new Date(NOW.getTime() - 1) });
    expect(await store.consumeLoginToken("h2", NOW)).toBeNull();

    await store.saveLoginToken({ tokenHash: "h3", userId: u.id, expiresAt: new Date(NOW.getTime() + 60_000) });
    const race = await Promise.all([store.consumeLoginToken("h3", NOW), store.consumeLoginToken("h3", NOW)]);
    expect(race.filter((x) => x !== null)).toEqual([u.id]);

    await store.createSession({ id: "s1", userId: u.id, expiresAt: new Date(NOW.getTime() + 30 * 86_400_000) });
    expect((await store.getSession("s1", NOW))?.userId).toBe(u.id);
    expect(await store.getSession("s1", new Date(NOW.getTime() + 31 * 86_400_000))).toBeNull();
    await store.deleteSession("s1");
    expect(await store.getSession("s1", NOW)).toBeNull();
  });
});

describe("JsonPortalStore — CRM", () => {
  it("moveStage cierra la etapa abierta del historial y abre otra", async () => {
    const { store, ids } = await seeded();
    const companyId = ids["20100000001"];
    const t0 = new Date("2026-11-01T10:00:00Z");
    const t1 = new Date("2026-11-03T12:00:00Z");
    const t2 = new Date("2026-11-05T09:30:00Z");
    const opp = await store.createOpportunity({ companyId, ownerUserId: 1, createdBy: 1, at: t0 });
    expect(opp).toMatchObject({ etapa: "prospecto", probabilidad: 10, closedAt: null });
    expect(await store.getOpenOpportunity(companyId, 1)).toMatchObject({ id: opp.id });
    expect(await store.getOpenOpportunity(companyId, 2)).toBeNull();

    expect(await store.moveStage(opp.id, "cita_agendada", 1, t1)).toMatchObject({ etapa: "cita_agendada", probabilidad: 20 });
    expect(await store.moveStage(opp.id, "cita_agendada", 1, t2)).toMatchObject({ etapa: "cita_agendada" }); // misma etapa: sin historial nuevo
    const won = await store.moveStage(opp.id, "cerrado_ganado", 2, t2);
    expect(won).toMatchObject({ etapa: "cerrado_ganado", probabilidad: 100, closedAt: t2 });

    const h = await store.stageHistory(opp.id);
    expect(h.map((x) => [x.etapa, x.enteredAt.toISOString(), x.leftAt?.toISOString() ?? null, x.changedBy])).toEqual([
      ["prospecto", t0.toISOString(), t1.toISOString(), 1],
      ["cita_agendada", t1.toISOString(), t2.toISOString(), 1],
      ["cerrado_ganado", t2.toISOString(), null, 2],
    ]);
    expect(await store.getOpenOpportunity(companyId)).toBeNull();
    expect(await store.listOpportunities({ open: false })).toHaveLength(1);

    const reopened = await store.moveStage(opp.id, "negociacion", 1, new Date("2026-11-06T00:00:00Z"));
    expect(reopened).toMatchObject({ etapa: "negociacion", probabilidad: 70, closedAt: null });
    expect(await store.moveStage(999, "negociacion", 1)).toBeNull();
  });

  it("contactos, actividades y citas", async () => {
    const { store, ids } = await seeded();
    const companyId = ids["20100000002"];
    const c = await store.addContact({ companyId, nombre: "Luis Pérez", cargo: "Jefe de flota", createdBy: 1 });
    expect((await store.updateContact(c.id, { telefono: "999888777", cargo: null }))?.cargo).toBeNull();
    expect(await store.listContacts(companyId)).toHaveLength(1);
    expect(await store.deleteContact(c.id)).toBe(true);
    expect(await store.listContacts(companyId)).toHaveLength(0);

    await store.addActivity({ companyId, userId: 1, tipo: "visita", texto: "Visita a taller", canal: "whatsapp", occurredAt: new Date("2026-11-02T10:00:00Z") });
    await store.addActivity({ companyId, userId: 2, tipo: "nota", texto: "Pidió precios", canal: "portal", data: { medida: "295/80R22.5" }, occurredAt: new Date("2026-11-04T10:00:00Z") });
    expect((await store.listActivities({ companyId })).map((a) => a.tipo)).toEqual(["nota", "visita"]);
    expect((await store.listActivities({ userId: 1 })).map((a) => a.texto)).toEqual(["Visita a taller"]);
    expect(await store.listActivities({ since: new Date("2026-11-03T00:00:00Z") })).toHaveLength(1);

    const a1 = await store.addAppointment({ companyId, userId: 1, startsAt: new Date("2026-11-12T15:00:00Z"), lugar: "Lurín", conTecnico: true });
    await store.addAppointment({ companyId, userId: 1, startsAt: new Date("2026-11-11T15:00:00Z") });
    await store.addAppointment({ companyId, userId: 2, startsAt: new Date("2026-11-11T16:00:00Z") });
    expect(a1.estado).toBe("programada");
    const mine = await store.listAppointments({ userId: 1, from: new Date("2026-11-11T00:00:00Z"), to: new Date("2026-11-13T00:00:00Z") });
    expect(mine.map((a) => a.startsAt.toISOString())).toEqual(["2026-11-11T15:00:00.000Z", "2026-11-12T15:00:00.000Z"]);
    expect((await store.updateAppointment(a1.id, { estado: "realizada" }))?.estado).toBe("realizada");
  });
});

describe("JsonPortalStore — persistencia", () => {
  it("flush escribe el archivo y se recarga con fechas e índices", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-store-"));
    const file = path.join(dir, "portal-store.json");
    try {
      const store = new JsonPortalStore(file);
      const { ids } = await store.upsertCompanies([{ ruc: "20100000009", razonSocial: "PERSISTE SAC", unidades: 11 }]);
      await store.upsertFleet([vehicle(ids["20100000009"], "P1")]);
      const opp = await store.createOpportunity({ companyId: ids["20100000009"], at: NOW });
      await store.flush();

      const again = new JsonPortalStore(file);
      expect((await again.getCompanyByRuc("20100000009"))?.createdAt).toBeInstanceOf(Date);
      expect(await again.listFleet(ids["20100000009"])).toHaveLength(1);
      expect((await again.stageHistory(opp.id))[0].enteredAt.toISOString()).toBe(NOW.toISOString());
      const second = await again.upsertCompanies([{ ruc: "20100000010", razonSocial: "OTRA SAC" }]);
      expect(second.ids["20100000010"]).toBe(ids["20100000009"] + 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("seedUsers", () => {
  it("crea solo los usuarios con número configurado y avisa por los demás", async () => {
    const store = JsonPortalStore.memory();
    const salespeople = { default: "51955344340", "51955344340": { name: "Frank Melek Rodríguez Mirano" } };
    const r = await seedUsers(store, { salespeople, env: {} });
    expect(r.users.map((u) => [u.nombre, u.rol, u.whatsapp])).toEqual([["Frank Rodríguez", "vendedor", "51955344340"]]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join("\n")).toMatch(/Juan Bustios.*PORTAL_SUPERVISOR_NUMBER/);
    expect(r.warnings.join("\n")).toMatch(/Tony Barreto.*PORTAL_ADMIN_NUMBER/);
  });

  it("sin ningún número no crea nadie; ADMIN_NUMBERS da el admin y no pisa a Frank", async () => {
    const store = JsonPortalStore.memory();
    const none = await seedUsers(store, { salespeople: {}, env: {} });
    expect(none.users).toEqual([]);
    expect(none.warnings).toHaveLength(3);
    expect(await store.listUsers()).toEqual([]);

    const salespeople = { "51955344340": { name: "Frank Melek Rodríguez Mirano" } };
    const r = await seedUsers(store, { salespeople, env: { ADMIN_NUMBERS: "18605180534,51955344340", PORTAL_SUPERVISOR_NUMBER: "51 911 222 333" } });
    expect(r.warnings).toEqual([]);
    expect(r.users.map((u) => [u.rol, u.whatsapp])).toEqual([
      ["vendedor", "51955344340"],
      ["supervisor", "51911222333"],
      ["admin", "18605180534"],
    ]);
    await seedUsers(store, { salespeople, env: { ADMIN_NUMBERS: "18605180534", PORTAL_SUPERVISOR_NUMBER: "51911222333" } });
    expect(await store.listUsers()).toHaveLength(3); // idempotente
  });
});
