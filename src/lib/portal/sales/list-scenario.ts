/**
 * Corrida J, punto 5 — escenario de la pantalla general de ventas para las pruebas (store JSON en vitest y la paridad
 * JSON / Postgres en src/test-pg): carga el reporte de prueba de odoo-fixture, unas líneas más (otra marca, otro vendedor,
 * una nota de crédito que revierte toda una factura), una venta demo y un cliente final de leasing. Solo datos inventados.
 */
import type { PortalStore, SalesListFilter } from "../store/types";
import { FX, sampleOdooLines, type OdooFixtureLine } from "./odoo-fixture";
import { seedOdoo } from "./odoo-seed";

export const LIST_EXTRA_LINES: OdooFixtureLine[] = [
  { fecha: "2026-11-03", documento: "F003-5200", ruc: FX.cliente, razon: "TRANSPORTES PRUEBA SAC", descripcion: "[P1420] 195/55ZR16 87W KUMHO ECSTA HS52 TL KOREA", cantidad: 4, precio: 60, costo: 45, margen: "25.00%", vendedor: "DANYER SAAVERDRA" },
  { fecha: "2026-11-04", documento: "F003-5201", ruc: FX.fueraPadron, razon: "EMPRESA FUERA DEL PADRON EIRL", descripcion: "[P0759] 295/80R22.5 18PR FENIXWAY VALOR 89", cantidad: 2, precio: 250, costo: 200, margen: "20.00%", vendedor: "Frank Rodriguez" },
  // revierte toda la F003-5201 (cantidad, venta y costo; el lector les pone el signo negativo)
  { fecha: "2026-11-05", tipoDoc: "Nota Crédito", documento: "F003-95", ocProveedor: "Reversión de: F003-5201, DEVOLUCION", ruc: FX.fueraPadron, razon: "EMPRESA FUERA DEL PADRON EIRL", descripcion: "[P0759] 295/80R22.5 18PR FENIXWAY VALOR 89", cantidad: 2, precio: 250, costo: 200, margen: "0.00%", vendedor: "Frank Rodriguez" },
];

/** Carga todo en el store (con las empresas del padrón). Devuelve los ids de las empresas. */
export async function seedSalesListScenario(store: PortalStore): Promise<{ ids: Record<string, number> }> {
  const u = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
  // en orden de RUC: Postgres numera el lote por RUC (los ids tienen que coincidir con el store JSON)
  const up = await store.upsertCompanies([
    { ruc: FX.banco, razonSocial: "BANCO DE CREDITO DEL PERU" },
    { ruc: FX.cliente, razonSocial: "TRANSPORTES PRUEBA SAC", unidades: 20, llantasPiso: 200 },
    { ruc: FX.clienteFinal, razonSocial: "MINERA CLIENTE FINAL SAA", unidades: 10, llantasPiso: 80 },
  ]);
  await seedOdoo(store, [...sampleOdooLines(), ...LIST_EXTRA_LINES], { id: u.id, nombre: u.nombre, rol: "vendedor" });
  await store.insertSales([{ fecha: "2026-09-01", ruc: FX.cliente, razonSocial: "TRANSPORTES PRUEBA SAC", cantidad: 50, precioUnitario: 100, isDemo: true, origen: "demo", marca: "DEMO MARCA", vendedor: "Frank Rodríguez" }]);
  return { ids: up.ids };
}

/** Asigna la F003-5005 del banco al cliente final (minera). */
export async function assignScenarioClienteFinal(store: PortalStore, ids: Record<string, number>): Promise<number> {
  return store.setClienteFinal({ bankRuc: FX.banco, documentos: ["F003-5005"], company: { id: ids[FX.clienteFinal], ruc: FX.clienteFinal }, userId: null });
}

/** Filtros que recorren las pruebas: cada uno solo y algunas combinaciones. */
export const LIST_FILTERS: Record<string, SalesListFilter> = {
  todo: {},
  "q.razon": { q: "transportes prueba" },
  "q.tildes": { q: "TRANSPÓRTES" },
  "q.ruc": { q: FX.fueraPadron },
  "q.factura": { q: "f003-05001" },
  "q.factura2": { q: "F003 5001" },
  "q.producto": { q: "valor 89" },
  "q.codigo": { q: "p1420" },
  "q.comodin": { q: "%" },
  "q.nada": { q: "zzzz" },
  medida: { medida: "295/80R22.5" },
  marca: { marca: "fenixway" },
  "tipo.servicio": { tipoLinea: "servicio" },
  "tipo.otro": { tipoLinea: "otro" },
  "tipo.neumatico": { tipoLinea: "neumatico" },
  vendedor: { vendedor: "Danyer Saaverdra" },
  desde: { desde: "2026-10-01" },
  hasta: { hasta: "2026-09-30" },
  rango: { desde: "2026-10-01", hasta: "2026-10-31" },
  leasing: { docRucs: [FX.banco], sinClienteFinal: true },
  demo: { demo: true },
  "combo.q+tipo+rango": { q: "transportes", tipoLinea: "neumatico", desde: "2026-09-01", hasta: "2026-10-31" },
  "combo.medida+vendedor": { medida: "295/80R22.5", vendedor: "Frank Rodríguez" },
  "combo.marca+desde": { marca: "FENIXWAY", desde: "2026-11-01" },
  "combo.demo+marca": { demo: true, marca: "demo marca" },
};
