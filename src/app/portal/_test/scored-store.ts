/**
 * Fixture de las pruebas de pantalla de la corrida G: store JSON en memoria con 30 empresas inventadas, su flota y el
 * puntaje ya calculado (recalcScores con un catálogo fijo). Solo lo importan pruebas.
 */
import { defaultScoringConfig } from "@/lib/portal/scoring/config";
import { recalcScores } from "@/lib/portal/scoring/recalc";
import type { CatalogSizes } from "@/lib/portal/scoring/score";
import { JsonPortalStore } from "@/lib/portal/store/json-portal-store";
import type { FleetVehicleInput } from "@/lib/portal/store/types";

export const NOW = new Date("2026-11-14T15:00:00Z");

export const CATALOG: CatalogSizes = {
  stock: new Set(["295/80R22.5"]),
  propio: new Set(["295/80R22.5", "12R22.5"]),
  proveedor: new Set(["11R22.5"]),
};

function vehicles(companyId: number, n: number, marca: string): FleetVehicleInput[] {
  return Array.from({ length: n }, (_, i) => ({
    companyId,
    placa: `P${companyId}-${i}`,
    marca,
    clase: "BUS",
    anio: 2020,
    ejes: 2,
    llantas: 6,
    llantasFuente: null,
    pesoBruto: null,
    chasis: null,
    departamento: "LIMA",
    origen: "pasajeros",
    medidaProbable: "295/80R22.5",
    confianza: "alta",
  }));
}

export async function scoredStore() {
  const store = JsonPortalStore.memory();
  const { ids } = await store.upsertCompanies(
    Array.from({ length: 30 }, (_, i) => ({
      ruc: `2060000${String(i).padStart(4, "0")}`,
      razonSocial: `TRANSPORTES PRUEBA ${i} S.A.C.`,
      sector: "pasajeros" as const,
      departamento: i % 3 === 0 ? "LIMA" : "PUNO",
      unidades: 10 + i * 3,
      llantasPiso: (10 + i * 3) * 6,
      antiguedadMedia: 4 + (i % 10),
    })),
  );
  const list = Object.values(ids).sort((a, b) => a - b);
  for (const id of list) await store.upsertFleet(vehicles(id, 5, id % 2 ? "SCANIA" : "VOLVO"));
  await recalcScores(store, defaultScoringConfig(), { catalog: CATALOG, now: NOW });
  const ranked = (await store.searchCompanies({ orderBy: "atractivo", pageSize: 100 })).rows;
  return { store, ids: list, ranked };
}
