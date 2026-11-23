/** Corrida K: provincia y distrito principales desde el padrón de pasajeros, sin tocar la flota (fixtures inventados). */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonPortalStore } from "../store/json-portal-store";
import { importUbicaciones } from "./ubicacion";

const fx = (f: string) => path.join(__dirname, "__fixtures__", f);

describe("importUbicaciones", () => {
  it("el par más frecuente dentro del departamento principal de la empresa; las de solo carga quedan sin ubicación", async () => {
    const store = JsonPortalStore.memory();
    await store.upsertCompanies([
      { ruc: "20333333333", razonSocial: "PASAJEROS DEMO", departamento: "HUANUCO", unidades: 3 },
      { ruc: "20111111111", razonSocial: "MIXTA DEMO", departamento: "LIMA", unidades: 4 },
      { ruc: "20222222222", razonSocial: "CARGA DEMO", departamento: "JUNIN", unidades: 3 },
    ]);
    const r = await importUbicaciones({ files: [fx("carga25.csv"), fx("pasajeros.csv")], currentCut: "20251231", store });
    expect(r).toMatchObject({ conUbicacion: 2, actualizadas: 2 });
    expect(await store.getCompanyByRuc("20333333333")).toMatchObject({ provincia: "HUANUCO", distrito: "AMARILIS" });
    expect(await store.getCompanyByRuc("20111111111")).toMatchObject({ provincia: "LIMA", distrito: "LIMA" });
    expect(await store.getCompanyByRuc("20222222222")).toMatchObject({ provincia: null, distrito: null, direccion: null });
    // idempotente
    expect((await importUbicaciones({ files: [fx("pasajeros.csv")], currentCut: "20251231", store })).actualizadas).toBe(0);
  });
});
