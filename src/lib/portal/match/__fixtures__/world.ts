/**
 * Corrida K — mundo de prueba de Match Venta (inventado): empresas, flotas, ventas y stock. Lo usan match.test.ts (JSON)
 * y src/test-pg/match.pg.test.ts (paridad con Postgres).
 */
import type { PriceRow } from "../../../ingest/types";
import type { StockDeduction } from "../../../store/types";
import type { FleetVehicleInput, PortalStore, SaleInput } from "../../store/types";
import { defaultMatchConfig, type MatchConfig } from "../config";
import { recalcMatch } from "../recalc";

export const NOW = new Date("2026-11-23T15:00:00Z");
export const BANK = "20100047218";

export function cfg(over: Partial<MatchConfig> = {}): MatchConfig {
  return defaultMatchConfig({
    aplicaciones: [
      { id: "traccion", nombre: "minería, construcción o carga pesada", palabras: ["traccion"], puntos: 5, sube: { sectores: [], clases: ["REMOLCADOR"], minPorcionClases: 0.3, razonSocial: ["MINER"] }, soloVentas: false },
      { id: "camioneta", nombre: "camionetas", palabras: ["camioneta"], puntos: 0, sube: { sectores: [], clases: [], minPorcionClases: 0.2, razonSocial: [] }, soloVentas: true },
      { id: "delantera", nombre: "buses y carga en carretera", palabras: ["delantera"], puntos: 5, sube: { sectores: ["pasajeros"], clases: ["OMNIBUS"], minPorcionClases: 0.2, razonSocial: [] }, soloVentas: false },
    ],
    ...over,
  } as Partial<MatchConfig>);
}

export function stockRow(code: string, size: string, model: string, by: Record<string, number>, extra: Partial<PriceRow> = {}): PriceRow {
  const reserve = Number(/reserva: (\d+)/.exec(extra.notes ?? "")?.[1] ?? 0);
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  return {
    id: `stk-${code}`,
    provider: "Protyres",
    kind: "stock",
    code,
    description: `${size} ${model}`,
    brand: "Fenixway",
    model,
    size,
    sizeDisplay: size,
    sizeRaw: size,
    isTyre: true,
    cost: null,
    priceIncludesTax: false,
    currency: "USD",
    stock: Math.max(0, total - reserve),
    stockByWarehouse: Object.keys(by).length ? by : undefined,
    priceDate: "2026-11-23",
    source: "odoo",
    sourceRef: "stock de prueba.pdf",
    ...extra,
  };
}

export const STOCK: PriceRow[] = [
  stockRow("T0433", "295/80R22.5", "FLAMA 66", { "San Luis": 58, Callao: 42 }),
  stockRow("T0949", "12R22.5", "FUERTE 89", { "San Luis": 40 }),
  stockRow("T1527", "265/65R17", "RIDGE BLADE X/RT", { "San Luis": 91 }),
  stockRow("T0428", "315/80R22.5", "FLAMA 77", { "San Luis": 20, Callao: 8 }, { notes: "reserva: 5" }),
  stockRow("AR001", "", "ARO", { "San Luis": 3 }, { isTyre: false, description: 'ARO 22.5" FIERRO' }),
];

export function source(rows: PriceRow[], deductions: StockDeduction[] = []) {
  return { allRows: async () => rows, listStockDeductions: async () => deductions };
}

export function vehicles(companyId: number, n: number, medida: string | null, clase = "CAMION", llantas: number | null = 10, prefix = "V"): FleetVehicleInput[] {
  return Array.from({ length: n }, (_, i) => ({
    companyId,
    placa: `${prefix}${companyId}${String(i).padStart(4, "0")}`,
    marca: "VOLVO",
    clase,
    anio: 2018,
    ejes: 3,
    llantas,
    llantasFuente: null,
    pesoBruto: 30000,
    chasis: null,
    departamento: "LIMA",
    origen: "carga" as const,
    medidaProbable: medida,
    confianza: medida ? ("media" as const) : null,
  }));
}

export interface World {
  store: PortalStore;
  frank: { id: number; nombre: string; rol: "vendedor"; whatsapp: string };
  juan: { id: number; nombre: string; rol: "vendedor"; whatsapp: string };
  sup: { id: number; nombre: string; rol: "supervisor" };
  ids: Record<string, number>;
}

export async function world(store: PortalStore): Promise<World> {
  const frank = (await store.upsertUser({ nombre: "Frank Prueba", whatsapp: "51900000001", rol: "vendedor" })) as World["frank"];
  const juan = (await store.upsertUser({ nombre: "Juan Prueba", whatsapp: "51900000002", rol: "vendedor" })) as World["juan"];
  const sup = (await store.upsertUser({ nombre: "Sara Supervisora", whatsapp: "51900000003", rol: "supervisor" })) as World["sup"];
  const r = await store.upsertCompanies([
    { ruc: "20000000001", razonSocial: "BUSES DEL SUR DEMO SAC", sector: "pasajeros", departamento: "LIMA", provincia: "LIMA", distrito: "ATE", unidades: 40 },
    { ruc: "20000000002", razonSocial: "MINERA ANDES DEMO SA", sector: "carga", departamento: "AREQUIPA", unidades: 20 },
    { ruc: "20000000003", razonSocial: "CARGA MIXTA DEMO SAC", sector: "carga", departamento: "LIMA", unidades: 30 },
    { ruc: "20000000004", razonSocial: "TRANSPORTES DE JUAN DEMO SAC", sector: "carga", departamento: "LIMA", unidades: 25 },
    { ruc: "20000000005", razonSocial: "MUNICIPALIDAD DISTRITAL DEMO", sector: "carga", departamento: "LIMA", unidades: 12 },
    { ruc: BANK, razonSocial: "BANCO DEMO LEASING", sector: "carga", departamento: "LIMA", unidades: 50 },
    { ruc: "20000000007", razonSocial: "FLOTA CHICA DEMO EIRL", sector: "carga", departamento: "CALLAO", unidades: 10 },
  ]);
  const ids = r.ids;
  await store.upsertFleet([
    ...vehicles(ids["20000000001"], 36, "295/80R22.5", "OMNIBUS", 6),
    ...vehicles(ids["20000000001"], 4, null, "CMTA PICKUP", 4, "P"),
    ...vehicles(ids["20000000002"], 20, "12R22.5", "CAMION", 10),
    ...vehicles(ids["20000000003"], 15, "295/80R22.5", "REMOLCADOR", 10),
    ...vehicles(ids["20000000003"], 15, "12R22.5", "CAMION", null, "W"),
    ...vehicles(ids["20000000004"], 25, "295/80R22.5", "REMOLCADOR", 10),
    ...vehicles(ids["20000000005"], 12, "295/80R22.5", "CAMION", 6),
    ...vehicles(ids[BANK], 50, "295/80R22.5", "REMOLCADOR", 10),
    ...vehicles(ids["20000000007"], 10, "11R22.5", "SEMIRREMOLQUE", 8),
  ]);
  await store.setOwner(ids["20000000004"], juan.id);
  return { store, frank, juan, sup, ids };
}

export const sale = (o: Partial<SaleInput> & Pick<SaleInput, "ruc" | "fecha" | "cantidad">): SaleInput => ({ medida: null, marca: "Fenixway", diseno: null, precioUnitario: 250, total: 250 * o.cantidad, vendedor: "Frank", origen: "excel", ...o });

/** Línea de Odoo (con detalle) para el leasing: el banco es el cliente del documento. */
export function odooLine(ruc: string, documento: string, medida: string, cantidad: number, fecha: string, codigoProducto = "T0433"): SaleInput {
  return {
    fecha,
    ruc,
    razonSocial: ruc === BANK ? "BANCO DEMO LEASING" : "CLIENTE",
    medida,
    marca: "Fenixway",
    diseno: "FLAMA 66",
    cantidad,
    precioUnitario: 900,
    total: 900 * cantidad,
    vendedor: "Frank",
    origen: "odoo",
    detalle: { lineKey: `F|${documento}|${codigoProducto}|1`, tipoDoc: "factura", documento, descripcion: `NEUMATICO ${medida} FLAMA 66`, codigoProducto, tipoLinea: "neumatico", docCliente: "ruc", cuentaUnidades: true, excluida: false, precioUnitarioUsd: 240, totalUsd: 240 * cantidad, margenPct: 20 },
  };
}

export async function load(w: World, opts: { sales?: boolean; cfg?: MatchConfig; deductions?: StockDeduction[]; stock?: PriceRow[] } = {}) {
  if (opts.sales !== false) {
    await w.store.insertSales([
      sale({ ruc: "20000000001", fecha: "2026-03-10", medida: "295/80R22.5", cantidad: 40 }),
      sale({ ruc: "20000000001", fecha: "2026-06-10", medida: "295/80R22.5", cantidad: 20 }),
      sale({ ruc: "20000000003", fecha: "2026-05-02", medida: "11R22.5", cantidad: 8 }),
      sale({ ruc: "20999999999", razonSocial: "CAMIONETAS FUERA DEL PADRON DEMO", fecha: "2026-09-01", medida: "265/65R17", cantidad: 12 }),
    ]);
  }
  const c = opts.cfg ?? cfg();
  await w.store.seedMatchProducts([
    { code: "T0433", aplicacion: "Delantera regional", prioridad: true },
    { code: "T0949", aplicacion: "Tracción bloque on/off road", prioridad: true },
    { code: "T1527", aplicacion: "Camioneta tipo RT", prioridad: true },
    { code: "T0428", aplicacion: "Delantera regional", prioridad: true },
  ], NOW);
  return recalcMatch({ store: w.store, prices: source(opts.stock ?? STOCK, opts.deductions), cfg: c, leasingRucs: [BANK], now: NOW }, "prueba");
}

