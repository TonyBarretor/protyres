/**
 * Corrida J — empresas fuera del padrón: RUC, texto libre, alta (duplicado, oportunidad, contacto, puntaje), vehículos
 * cargados a mano y reimportación del padrón que no toca las manuales (o las fusiona si llega su RUC).
 */
import { describe, expect, it } from "vitest";
import { JsonPortalStore } from "../store/json-portal-store";
import type { FleetVehicleInput } from "../store/types";
import { addVehicle, createCompany, findRuc, matchDepartamento, matchSector, normalizePlaca, parseCompanyText, removeVehicle, rucProblem, type NewCompanyData } from "./manual";

/** RUC válidos (dígito verificador) e inventados. */
const RUC_SOL = "20600000013";
const RUC_LUNA = "20612345679";

const data = (over: Partial<NewCompanyData> = {}): NewCompanyData => ({ ruc: RUC_SOL, razonSocial: "Transportes Sol SAC", sector: "carga", departamento: "Lima", unidades: null, contacto: null, ...over });

async function setup() {
  const store = JsonPortalStore.memory();
  const frank = await store.upsertUser({ nombre: "Frank Prueba", whatsapp: "51900000001", rol: "vendedor" });
  return { store, frank };
}

describe("RUC", () => {
  it("valida 11 dígitos, el prefijo y el dígito verificador", () => {
    expect(rucProblem("20602221505")).toBeNull(); // ZBUSS, real
    expect(rucProblem(RUC_SOL)).toBeNull();
    expect(rucProblem("2060222150")).toMatch(/10 dígitos/);
    expect(rucProblem("30602221505")).toMatch(/no empieza/);
    expect(rucProblem("20602221506")).toMatch(/no es válido/);
    expect(rucProblem("abc")).toMatch(/no es un RUC/);
  });

  it("encuentra el RUC aunque venga separado", () => {
    expect(findRuc("ruc 20 600 000 013 transportes")?.ruc).toBe(RUC_SOL);
    expect(findRuc("20.600.000.013")?.ruc).toBe(RUC_SOL);
    expect(findRuc("tel 987654321")).toBeNull();
  });
});

describe("texto libre", () => {
  it("saca RUC, sector, departamento, unidades y contacto; lo demás es la razón social", () => {
    const p = parseCompanyText(`${RUC_SOL} Transportes Sol SAC, carga, Junín, 15 unidades, contacto Juan Pérez, jefe de flota, 987 654 321`);
    expect(p).toEqual({ ruc: RUC_SOL, razonSocial: "TRANSPORTES SOL SAC", sector: "carga", departamento: "JUNIN", unidades: 15, contacto: { nombre: "Juan Pérez", cargo: "jefe de flota", telefono: "987654321" } });
  });

  it("dictado: «RUC veinte…» ya en cifras con espacios, sector por sus palabras y departamento compuesto", () => {
    const p = parseCompanyText("RUC 20 612 345 679, Expreso Luna, son buses, en La Libertad");
    expect(p).toMatchObject({ ruc: RUC_LUNA, razonSocial: "EXPRESO LUNA", sector: "pasajeros", departamento: "LA LIBERTAD" });
  });

  it("solo la razón social", () => {
    expect(parseCompanyText("Transportes Sol")).toEqual({ razonSocial: "TRANSPORTES SOL" });
    expect(parseCompanyText("")).toEqual({});
  });

  it("departamento y sector sueltos", () => {
    expect(matchDepartamento("cuzco")).toBe("CUSCO");
    expect(matchDepartamento("departamento de Áncash")).toBe("ANCASH");
    expect(matchDepartamento("Lima Metropolitana")).toBeNull();
    expect(matchSector("los dos, carga y pasajeros")).toBe("mixto");
    expect(matchSector("ómnibus")).toBe("pasajeros");
    expect(matchSector("volquetes")).toBe("carga");
    expect(matchSector("no sé")).toBeNull();
  });
});

describe("alta", () => {
  it("crea la empresa a mano, asignada a quien la crea, con oportunidad en Prospecto, contacto y actividad", async () => {
    const { store, frank } = await setup();
    const r = await createCompany(store, frank, data({ unidades: 12, contacto: { nombre: "Juan Pérez", cargo: "jefe de flota", telefono: "987654321" } }), { canal: "whatsapp" });
    expect(r.ok && r.created).toBe(true);
    if (!r.ok) return;
    expect(r.company).toMatchObject({ ruc: RUC_SOL, razonSocial: "TRANSPORTES SOL SAC", sector: "carga", departamento: "LIMA", unidades: 12, ownerUserId: frank.id, origen: "manual", createdBy: frank.id });
    const opps = await store.listOpportunities({ companyId: r.company.id });
    expect(opps.map((o) => [o.etapa, o.ownerUserId])).toEqual([["prospecto", frank.id]]);
    expect((await store.listContacts(r.company.id)).map((c) => c.nombre)).toEqual(["Juan Pérez"]);
    const acts = await store.listActivities({ companyId: r.company.id });
    expect(acts[0].texto).toMatch(/creó la empresa \(no está en el padrón del MTC\)/);
    expect(acts[0].data).toMatchObject({ evento: "asignacion", creada: true });
    // puntaje: los datos que faltan valen 0 y lo dice (llantas en piso)
    expect(r.company.score).not.toBeNull();
    expect(r.company.scoreDetalle?.factores.find((f) => f.id === "potencial")).toMatchObject({ valor: 0, sinDato: true });
  });

  it("RUC duplicado: devuelve la que ya existe sin tocarla", async () => {
    const { store, frank } = await setup();
    const { ids } = await store.upsertCompanies([{ ruc: RUC_SOL, razonSocial: "TRANSPORTES SOL S.A.C.", unidades: 30 }]);
    const r = await createCompany(store, frank, data({ razonSocial: "Otra cosa" }), { canal: "whatsapp" });
    expect(r).toMatchObject({ ok: true, created: false, company: { id: ids[RUC_SOL], razonSocial: "TRANSPORTES SOL S.A.C.", ownerUserId: null, origen: "mtc" } });
    expect(await store.listOpportunities({ companyId: ids[RUC_SOL] })).toEqual([]);
  });

  it("RUC inválido o datos que faltan: no crea nada", async () => {
    const { store, frank } = await setup();
    expect(await createCompany(store, frank, data({ ruc: "20600000014" }), { canal: "portal" })).toEqual({ ok: false, error: expect.stringMatching(/no es válido/) });
    expect(await createCompany(store, frank, data({ departamento: "Narnia" }), { canal: "portal" })).toEqual({ ok: false, error: expect.stringMatching(/departamento/) });
    expect(await createCompany(store, frank, data({ sector: null }), { canal: "portal" })).toEqual({ ok: false, error: expect.stringMatching(/sector/) });
    expect(await store.countCompanies()).toBe(0);
  });
});

describe("vehículos cargados a mano", () => {
  it("placa normalizada; unidades y llantas de la empresa manual; misma placa corrige; otra empresa no la roba; se puede quitar", async () => {
    const { store, frank } = await setup();
    const r = await createCompany(store, frank, data({ unidades: 1 }), { canal: "portal" });
    if (!r.ok) throw new Error(r.error);
    const a = await addVehicle(store, frank, r.company, { placa: "abc 123", marca: "Volvo", clase: "Tracto", ejes: 3, llantas: 10, medida: "295/80 R22.5" });
    expect(a).toMatchObject({ ok: true, updated: false, vehicle: { placa: "ABC-123", marca: "VOLVO", clase: "TRACTO", ejes: 3, llantas: 10, medidaProbable: "295/80R22.5", confianza: "alta", origen: "manual" } });
    await addVehicle(store, frank, r.company, { placa: "XYZ-987", llantas: 6 });
    let c = (await store.getCompany(r.company.id))!;
    expect([c.unidades, c.llantasPiso]).toEqual([2, 16]);
    expect(await addVehicle(store, frank, c, { placa: "ABC-123", marca: "Volvo", clase: "Tracto", ejes: 3, llantas: 12, medida: "295/80R22.5" })).toMatchObject({ ok: true, updated: true });
    expect((await store.getCompany(c.id))!.llantasPiso).toBe(18);
    // la medida cargada cuenta para el puntaje (encaje tiene dato)
    expect((await store.getCompany(c.id))!.scoreDetalle?.factores.find((f) => f.id === "encaje")?.sinDato).toBe(false);

    const other = await createCompany(store, frank, data({ ruc: RUC_LUNA, razonSocial: "Expreso Luna" }), { canal: "portal" });
    if (!other.ok) throw new Error(other.error);
    expect(await addVehicle(store, frank, other.company, { placa: "ABC123" })).toEqual({ ok: false, error: "La placa ABC-123 ya está cargada a mano en TRANSPORTES SOL SAC." });
    expect(await addVehicle(store, frank, other.company, { placa: "??" })).toMatchObject({ ok: false, error: expect.stringMatching(/Placa no válida/) });
    expect(await addVehicle(store, frank, other.company, { placa: "BBB-111", medida: "llanta grande" })).toMatchObject({ ok: false, error: expect.stringMatching(/medida/) });

    c = (await store.getCompany(c.id))!;
    const xyz = (await store.listFleet(c.id)).find((v) => v.placa === "XYZ-987")!;
    expect(await removeVehicle(store, frank, c, xyz.id)).toBe(true);
    expect((await store.listFleet(c.id)).map((v) => v.placa)).toEqual(["ABC-123"]);
    expect((await store.getCompany(c.id))!.llantasPiso).toBe(12);
  });

  it("placas peruanas", () => {
    expect(normalizePlaca("a1b234")).toBe("A1B-234");
    expect(normalizePlaca("ABC-123")).toBe("ABC-123");
    expect(normalizePlaca("ABCDEF")).toBeNull();
  });
});

describe("reimportación del padrón", () => {
  const mtcVehicle = (companyId: number, placa: string): FleetVehicleInput => ({ companyId, placa, marca: "SCANIA", clase: "TRACTO", anio: 2019, ejes: 3, llantas: 10, llantasFuente: "20241231", pesoBruto: 30000, chasis: null, departamento: "LIMA", origen: "carga", medidaProbable: "295/80R22.5", confianza: "media" });

  it("no toca las empresas manuales que no están en el padrón; si llega su RUC, se fusiona conservando lo cargado a mano", async () => {
    const { store, frank } = await setup();
    const sol = await createCompany(store, frank, data({ contacto: { nombre: "Juan Pérez", cargo: null, telefono: null } }), { canal: "whatsapp" });
    const luna = await createCompany(store, frank, data({ ruc: RUC_LUNA, razonSocial: "Expreso Luna", sector: "pasajeros" }), { canal: "whatsapp" });
    if (!sol.ok || !luna.ok) throw new Error("alta");
    await addVehicle(store, frank, sol.company, { placa: "MAN-001", llantas: 10 });
    await addVehicle(store, frank, luna.company, { placa: "MAN-002", llantas: 6 });

    // el padrón trae a SOL (sin departamento) y otra empresa; LUNA no está
    const up = await store.upsertCompanies([
      { ruc: RUC_SOL, razonSocial: "TRANSPORTES SOL S.A.C.", sector: "carga", departamento: null, unidades: 14, llantasPiso: 140, antiguedadMedia: 6 },
      { ruc: "20602221505", razonSocial: "ZBUSS S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 85 },
    ]);
    expect(up.merged).toEqual([RUC_SOL]);
    await store.upsertFleet([mtcVehicle(sol.company.id, "MTC-001"), mtcVehicle(sol.company.id, "MTC-002")]);
    expect(await store.pruneFleet([sol.company.id], [{ placa: "MTC-001", origen: "carga" }])).toBe(1); // MTC-002 sí, MAN-001 no

    const merged = (await store.getCompany(sol.company.id))!;
    expect(merged).toMatchObject({ origen: "mtc", razonSocial: "TRANSPORTES SOL S.A.C.", departamento: "LIMA", unidades: 14, llantasPiso: 140, ownerUserId: frank.id, createdBy: frank.id });
    expect((await store.listFleet(sol.company.id)).map((v) => `${v.placa}:${v.origen}`)).toEqual(["MAN-001:manual", "MTC-001:carga"]);
    expect((await store.listContacts(sol.company.id)).map((c) => c.nombre)).toEqual(["Juan Pérez"]);
    expect(await store.getOpenOpportunity(sol.company.id)).not.toBeNull();

    const untouched = (await store.getCompany(luna.company.id))!;
    expect(untouched).toMatchObject({ origen: "manual", razonSocial: "EXPRESO LUNA", sector: "pasajeros", ownerUserId: frank.id });
    expect((await store.listFleet(luna.company.id)).map((v) => v.placa)).toEqual(["MAN-002"]);
    // los vehículos a mano no cuentan para el sector (dato del padrón)
    expect((await store.companyOriginCounts()).find((c) => c.companyId === luna.company.id)).toMatchObject({ carga: 0, pasajeros: 0 });
  });
});
