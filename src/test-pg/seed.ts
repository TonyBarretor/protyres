/**
 * Corrida H, punto 2 — siembra la base temporal de test:pg con los datos locales (data/portal-store.json y
 * data/store.json), para correr el guion de Frank contra Postgres. Solo LEE esos archivos (fs.readFileSync; ningún
 * store los abre, así nada puede escribirlos) y escribe en la base de pruebas por los métodos de los stores.
 *
 * Se siembra lo que el guion necesita: usuarios, empresas del padrón (sin dueño ni puntaje: el simulador recalcula),
 * flota (toda, o la de `fleetRucs`), ventas, lista de precios, cotizaciones y contadores. Se deja fuera lo que el guion
 * crea o no usa: oportunidades, historial, contactos, actividades, citas, enlaces y sesiones, conversaciones,
 * encuestas, OC, crédito, mensajes, fotos, archivos de cotización, precios de contrato y marcas de Drive.
 */
import fs from "node:fs";
import type { PriceRow } from "../lib/ingest/types";
import type { Quote } from "../lib/quote/types";
import { PgPortalStore } from "../lib/portal/store/pg-portal-store";
import type { Company, FleetVehicle, PortalUser, Sale } from "../lib/portal/store/types";
import { PgStore } from "../lib/store/pg-store";

export interface SeedOptions {
  portalFile: string;
  storeFile: string;
  /** Solo la flota de estas empresas (RUC); por defecto toda. */
  fleetRucs?: string[];
  log?: (m: string) => void;
}

export interface SeedResult {
  users: number;
  companies: number;
  fleet: number;
  sales: number;
  prices: number;
  quotes: number;
  ms: number;
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

export async function seedFromLocalData(url: string, opts: SeedOptions): Promise<SeedResult> {
  const t0 = Date.now();
  const log = opts.log ?? (() => undefined);
  const p = readJson(opts.portalFile);
  const q = readJson(opts.storeFile);
  const portal = PgPortalStore.connect(url);
  const prices = await PgStore.connect(url);
  try {
    const users = (p.users as PortalUser[] | undefined) ?? [];
    for (const u of users) if (u.whatsapp) await portal.upsertUser({ nombre: u.nombre, whatsapp: u.whatsapp, rol: u.rol, activo: u.activo });

    const companies = (p.companies as Company[] | undefined) ?? [];
    const up = await portal.upsertCompanies(
      companies.map((c) => ({ ruc: c.ruc, razonSocial: c.razonSocial, sector: c.sector, departamento: c.departamento, unidades: c.unidades, llantasPiso: c.llantasPiso, antiguedadMedia: c.antiguedadMedia })),
    );
    log(`seed: ${companies.length} empresas (${Date.now() - t0} ms)`);

    // ids del JSON -> ids nuevos, por RUC
    const rucOf = new Map(companies.map((c) => [c.id, c.ruc]));
    const only = opts.fleetRucs ? new Set(opts.fleetRucs) : null;
    const fleet = ((p.fleet as FleetVehicle[] | undefined) ?? []).flatMap((v) => {
      const ruc = rucOf.get(v.companyId);
      const id = ruc ? up.ids[ruc] : undefined;
      if (!id || (only && !only.has(ruc!))) return [];
      const { id: _id, ...rest } = v;
      return [{ ...rest, companyId: id }];
    });
    const f = await portal.upsertFleet(fleet);
    log(`seed: ${f.inserted + f.updated} vehículos (${Date.now() - t0} ms)`);

    const sales = (p.sales as Sale[] | undefined) ?? [];
    await portal.insertSales(sales.map(({ id: _i, createdAt: _c, ...s }) => s));

    const rows = Object.values((q.prices as Record<string, PriceRow> | undefined) ?? {});
    for (let i = 0; i < rows.length; i += 2000) await prices.upsertRows(rows.slice(i, i + 2000));
    log(`seed: ${rows.length} precios (${Date.now() - t0} ms)`);
    const quotes = Object.values((q.quotes as Record<string, Quote> | undefined) ?? {});
    for (const quote of quotes) await prices.saveQuote(quote);
    for (const [name, value] of Object.entries((q.counters as Record<string, number> | undefined) ?? {})) await prices.setQuoteCounter(value, name);

    return { users: users.length, companies: companies.length, fleet: fleet.length, sales: sales.length, prices: rows.length, quotes: quotes.length, ms: Date.now() - t0 };
  } finally {
    await portal.close();
    await prices.close();
  }
}
