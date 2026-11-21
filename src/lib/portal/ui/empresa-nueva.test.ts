/** Corrida J — "Agregar empresa" de Prospectos y vehículos cargados a mano de la ficha (lógica de las server actions). */
import { describe, expect, it } from "vitest";
import { JsonPortalStore } from "../store/json-portal-store";
import { addVehicleFromForm, canCreateCompany, canEditManualFleet, createCompanyFromForm, removeVehicleFromForm } from "./empresa-nueva";

const RUC_SOL = "20600000013";
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const full = (over: Record<string, string> = {}) => form({ ruc: RUC_SOL, razonSocial: "Transportes Sol SAC", sector: "carga", departamento: "LIMA", unidades: "", contactoNombre: "", contactoCargo: "", contactoTelefono: "", ...over });

async function setup() {
  const store = JsonPortalStore.memory();
  const frank = await store.upsertUser({ nombre: "Frank Prueba", whatsapp: "51900000001", rol: "vendedor" });
  const juan = await store.upsertUser({ nombre: "Juan Prueba", whatsapp: "51900000002", rol: "vendedor" });
  const tec = await store.upsertUser({ nombre: "Danyer", whatsapp: "51900000003", rol: "tecnico" });
  return { store, frank, juan, tec };
}

describe("Agregar empresa", () => {
  it("permisos: vendedor, supervisor y admin; el técnico no", () => {
    expect(canCreateCompany({ rol: "vendedor", activo: true })).toBe(true);
    expect(canCreateCompany({ rol: "admin", activo: true })).toBe(true);
    expect(canCreateCompany({ rol: "tecnico", activo: true })).toBe(false);
    expect(canCreateCompany({ rol: "vendedor", activo: false })).toBe(false);
  });

  it("crea con contacto; RUC repetido devuelve la existente; errores claros; el técnico no puede", async () => {
    const { store, frank, tec } = await setup();
    const r = await createCompanyFromForm(store, frank, full({ unidades: "12", contactoNombre: "Rosa Díaz", contactoCargo: "Jefa de flota", contactoTelefono: "987 654 321" }));
    expect(r).toMatchObject({ ok: true, created: true, company: { ruc: RUC_SOL, origen: "manual", ownerUserId: frank.id, unidades: 12 } });
    if (!r.ok) return;
    expect((await store.listContacts(r.company.id)).map((c) => [c.nombre, c.cargo, c.telefono])).toEqual([["Rosa Díaz", "Jefa de flota", "987654321"]]);
    expect(await createCompanyFromForm(store, frank, full({ razonSocial: "Otra" }))).toMatchObject({ ok: true, created: false, company: { id: r.company.id } });
    expect(await createCompanyFromForm(store, frank, full({ ruc: "20600000019" }))).toEqual({ ok: false, error: expect.stringMatching(/no es válido/) });
    expect(await createCompanyFromForm(store, frank, full({ sector: "" }))).toEqual({ ok: false, error: "Elige el sector." });
    expect(await createCompanyFromForm(store, frank, full({ unidades: "doce" }))).toEqual({ ok: false, error: "Unidades: un número entero." });
    expect(await createCompanyFromForm(store, frank, full({ contactoTelefono: "999888777" }))).toEqual({ ok: false, error: "El contacto necesita un nombre." });
    expect(await createCompanyFromForm(store, tec, full({ ruc: "20612345679" }))).toMatchObject({ ok: false, forbidden: true });
    expect(await store.countCompanies()).toBe(1);
  });
});

describe("vehículos cargados a mano en la ficha", () => {
  it("el dueño agrega y quita; otro vendedor no; en una empresa del padrón no se cargan", async () => {
    const { store, frank, juan } = await setup();
    const r = await createCompanyFromForm(store, frank, full());
    if (!r.ok) throw new Error(r.error);
    const c = r.company;
    expect(canEditManualFleet(frank, c)).toBe(true);
    expect(canEditManualFleet(juan, c)).toBe(false);
    const add = await addVehicleFromForm(store, frank, c, form({ placa: "abc123", marca: "Volvo", clase: "Tracto", ejes: "3", llantas: "10", medida: "295/80R22.5", anio: "" }));
    expect(add).toEqual({ ok: true, mensaje: "Vehículo ABC-123 agregado." });
    expect(await addVehicleFromForm(store, juan, c, form({ placa: "XYZ987" }))).toMatchObject({ ok: false });
    expect(await addVehicleFromForm(store, frank, c, form({ placa: "XYZ987", ejes: "tres" }))).toEqual({ ok: false, error: "Ejes, llantas y año van en números enteros." });
    const [v] = await store.listManualVehicles(c.id);
    expect(v).toMatchObject({ placa: "ABC-123", marca: "VOLVO", clase: "TRACTO", ejes: 3, llantas: 10, medidaProbable: "295/80R22.5" });
    expect((await store.getCompany(c.id))!.llantasPiso).toBe(10);
    // la flota por marca (padrón) no los mezcla: van en su propio bloque
    expect(await store.fleetByBrand(c.id)).toEqual([]);
    expect(await removeVehicleFromForm(store, juan, c, v.id)).toMatchObject({ ok: false });
    expect(await removeVehicleFromForm(store, frank, c, v.id)).toEqual({ ok: true, mensaje: "Vehículo quitado." });
    expect(await store.listManualVehicles(c.id)).toEqual([]);

    const { ids } = await store.upsertCompanies([{ ruc: "20602221505", razonSocial: "ZBUSS S.A.C." }]);
    await store.setOwner(ids["20602221505"], frank.id);
    const mtc = (await store.getCompany(ids["20602221505"]))!;
    expect(await addVehicleFromForm(store, frank, mtc, form({ placa: "QQQ111" }))).toEqual({ ok: false, error: "La flota de esta empresa viene del padrón del MTC." });
  });
});
