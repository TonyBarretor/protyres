/**
 * Ventas de demostración (`npm run portal:seed-demo` / `portal:clear-demo`).
 *
 * Elige 8–12 empresas que ya estén en `companies`: primero las conocidas (ANCRO, INNOVA AMBIENTAL, TURISMO JAKSA,
 * PROSEGUR, MOVIL BUS, buscadas por nombre) y completa con las de más unidades. Para cada una genera facturas de los
 * últimos 12 meses con su medida probable dominante (inferida del padrón), marcas del catálogo del repo y precios
 * plausibles (USD sin IGV, como las listas del cotizador). Todo con `isDemo = true`, `origen = "demo"`, vendedor Frank.
 *
 * Determinista: misma semilla + mismo `now` + mismas empresas = mismas ventas. Sembrar borra antes las demo
 * (deleteDemoSales), así que repetirlo no duplica; las ventas reales (is_demo = false) nunca se tocan.
 */
import { defaultSince, foldText, toIsoDate } from "../store/shared";
import type { Company, IsoDate, PortalStore, SaleInput } from "../store/types";

export const DEMO_TARGETS = ["ANCRO", "INNOVA AMBIENTAL", "TURISMO JAKSA", "PROSEGUR", "MOVIL BUS"];
export const DEMO_SEED = 360;
export const DEMO_VENDEDOR = "Frank";
export const DEMO_COMPANY_COUNT = 10;

interface CatalogItem {
  marca: string;
  diseno: string;
  /** USD sin IGV por neumático. */
  precio: [number, number];
}

/** Marcas del catálogo (config/pilot.json brandOrigin, config/customers.json); precios orientativos por medida. */
export const DEMO_CATALOG: Record<string, CatalogItem[]> = {
  "295/80R22.5": [
    { marca: "Fenixway", diseno: "Valor 99", precio: [255, 285] },
    { marca: "Linglong", diseno: "KTS300", precio: [235, 260] },
    { marca: "Marshal", diseno: "KRS50", precio: [275, 310] },
  ],
  "11R22.5": [
    { marca: "Fenixway", diseno: "Valor 89", precio: [225, 250] },
    { marca: "Linglong", diseno: "KLD200", precio: [205, 230] },
    { marca: "Marshal", diseno: "KRD02", precio: [240, 270] },
  ],
  "12R22.5": [
    { marca: "Fenixway", diseno: "Valor 89", precio: [245, 270] },
    { marca: "Linglong", diseno: "KLD200", precio: [225, 250] },
  ],
  "385/65R22.5": [
    { marca: "Linglong", diseno: "KTL200", precio: [300, 340] },
    { marca: "Fenixway", diseno: "Flama 77", precio: [320, 355] },
  ],
  "215/75R17.5": [
    { marca: "Fenixway", diseno: "Valor 99", precio: [118, 128] },
    { marca: "Fenixway", diseno: "Flama 77", precio: [112, 120] },
    { marca: "Linglong", diseno: "KTS300", precio: [105, 115] },
  ],
  "235/75R17.5": [
    { marca: "Fenixway", diseno: "Valor 99", precio: [140, 155] },
    { marca: "Linglong", diseno: "KLD200", precio: [128, 140] },
    { marca: "Marshal", diseno: "KRS03", precio: [150, 165] },
  ],
};

/** Medida para empresas sin medida inferida (flota liviana o sin datos). */
export const DEMO_FALLBACK_MEDIDA = "11R22.5";

export interface DemoCompany {
  ruc: string;
  razonSocial: string;
  unidades: number;
  llantasPiso: number;
  /** Medidas probables de su flota, la más frecuente primero. */
  medidas: string[];
}

export interface GenerateDemoOptions {
  now?: Date;
  seed?: number;
}

/** PRNG mulberry32 (determinista, sin dependencias). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Ventas demo de los últimos 12 meses para las empresas dadas (puro y determinista). */
export function generateDemoSales(companies: DemoCompany[], opts: GenerateDemoOptions = {}): SaleInput[] {
  const now = opts.now ?? new Date();
  const seed = opts.seed ?? DEMO_SEED;
  const since: IsoDate = defaultSince(now);
  const out: SaleInput[] = [];
  for (const c of companies) {
    const rnd = mulberry32(seed ^ hash(c.ruc));
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
    const llantas = c.llantasPiso > 0 ? c.llantasPiso : c.unidades * 6;
    // Entre 4 % y 20 % de sus llantas en piso al año (mínimo 8, máximo 1.200).
    const anual = Math.max(8, Math.min(1200, Math.round(llantas * (0.04 + rnd() * 0.16))));
    const facturas = 4 + Math.floor(rnd() * 9);
    const medidas = c.medidas.length ? c.medidas : [DEMO_FALLBACK_MEDIDA];
    // Una o dos marcas "de cabecera" por empresa, como un cliente real.
    const preferida = rnd();
    for (let i = 0; i < facturas; i++) {
      const r = rnd();
      const medida = r < 0.75 || medidas.length === 1 ? medidas[0] : medidas[1 + Math.floor(rnd() * Math.min(2, medidas.length - 1))];
      const items = DEMO_CATALOG[medida] ?? DEMO_CATALOG[DEMO_FALLBACK_MEDIDA];
      const item = rnd() < 0.7 ? items[Math.floor(preferida * items.length)] : pick(items);
      const base = anual / facturas;
      const cantidad = Math.max(2, 2 * Math.round((base * (0.5 + rnd())) / 2));
      const [min, max] = item.precio;
      const precioUnitario = round2(min + rnd() * (max - min));
      let fecha = new Date(now.getTime() - (1 + Math.floor(rnd() * 360)) * 86400000);
      if (toIsoDate(fecha) < since) fecha = new Date(now.getTime() - 86400000);
      out.push({
        fecha: toIsoDate(fecha),
        ruc: c.ruc,
        razonSocial: c.razonSocial,
        medida: DEMO_CATALOG[medida] ? medida : DEMO_FALLBACK_MEDIDA,
        marca: item.marca,
        diseno: item.diseno,
        cantidad,
        precioUnitario,
        total: round2(precioUnitario * cantidad),
        vendedor: DEMO_VENDEDOR,
        origen: "demo",
        isDemo: true,
      });
    }
  }
  return out.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.ruc.localeCompare(b.ruc));
}

export interface DemoPick {
  companies: DemoCompany[];
  /** Objetivos encontrados (nombre buscado → empresa). */
  found: { target: string; ruc: string; razonSocial: string }[];
  missing: string[];
}

async function toDemoCompany(store: PortalStore, c: Company): Promise<DemoCompany> {
  const byMedida = new Map<string, number>();
  for (const g of await store.fleetByBrand(c.id)) if (g.medidaProbable) byMedida.set(g.medidaProbable, (byMedida.get(g.medidaProbable) ?? 0) + g.unidades);
  const medidas = [...byMedida.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m]) => m);
  return { ruc: c.ruc, razonSocial: c.razonSocial, unidades: c.unidades, llantasPiso: c.llantasPiso, medidas };
}

/** Busca los objetivos por nombre (palabra completa; si hay varias, la de más unidades) y completa con las más grandes. */
export async function pickDemoCompanies(store: PortalStore, opts: { targets?: string[]; count?: number } = {}): Promise<DemoPick> {
  const targets = opts.targets ?? DEMO_TARGETS;
  const count = Math.max(1, opts.count ?? DEMO_COMPANY_COUNT);
  const chosen = new Map<string, Company>();
  const found: DemoPick["found"] = [];
  const missing: string[] = [];
  for (const target of targets) {
    const q = foldText(target);
    const word = new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
    const { rows } = await store.searchCompanies({ q, orderBy: "unidades", pageSize: 50 });
    const hit = rows.find((r) => word.test(foldText(r.razonSocial)) && !chosen.has(r.ruc));
    if (hit) {
      chosen.set(hit.ruc, hit);
      found.push({ target, ruc: hit.ruc, razonSocial: hit.razonSocial });
    } else missing.push(target);
  }
  if (chosen.size < count) {
    const { rows } = await store.searchCompanies({ orderBy: "unidades", pageSize: count * 2 });
    for (const r of rows) {
      if (chosen.size >= count) break;
      if (!chosen.has(r.ruc)) chosen.set(r.ruc, r);
    }
  }
  const companies: DemoCompany[] = [];
  for (const c of [...chosen.values()].slice(0, Math.max(count, found.length))) companies.push(await toDemoCompany(store, c));
  return { companies, found, missing };
}

export interface SeedDemoResult extends DemoPick {
  deleted: number;
  inserted: number;
  sales: SaleInput[];
}

/** Borra las ventas demo y las vuelve a crear. */
export async function seedDemoSales(store: PortalStore, opts: GenerateDemoOptions & { count?: number; targets?: string[] } = {}): Promise<SeedDemoResult> {
  const pick = await pickDemoCompanies(store, opts);
  const deleted = await store.deleteDemoSales();
  const sales = generateDemoSales(pick.companies, opts);
  const inserted = sales.length ? await store.insertSales(sales) : 0;
  return { ...pick, deleted, inserted, sales };
}

/** Borra solo las ventas demo (is_demo = true). */
export function clearDemoSales(store: PortalStore): Promise<number> {
  return store.deleteDemoSales();
}
