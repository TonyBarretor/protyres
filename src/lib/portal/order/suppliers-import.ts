/**
 * Importación repetible de la lista de proveedores (corrida H, 3b): Excel de contactos -> tabla `suppliers` del store
 * del cotizador, con el proveedor del cotizador que corresponde a cada uno (config/providers.json, proveedores con
 * listas cargadas y config/portal.json orders.supplierProviders). Volver a importar actualiza nombre, contacto, teléfono,
 * correo y marcas, y conserva las últimas condiciones de pago y entrega que el vendedor dio en sus pedidos.
 */
import { loadProvidersConfig } from "../../ingest/sources";
import type { PriceStore, Supplier } from "../../store/types";
import { loadPortalConfig } from "../config";
import { parseSuppliersXlsx, providerForSupplier } from "./suppliers";

export interface SupplierImportResult {
  suppliers: Supplier[];
  inserted: number;
  updated: number;
  warnings: string[];
}

/** Proveedores que el cotizador conoce: los de config/providers.json (con sus alias) y los que tienen filas en las listas. */
export async function knownProviders(store: PriceStore): Promise<{ name: string; aliases?: string[] }[]> {
  const cfg = loadProvidersConfig();
  const out = new Map<string, { name: string; aliases?: string[] }>();
  for (const [name, p] of Object.entries(cfg.providers ?? {})) out.set(name.toLowerCase(), { name, aliases: p.aliases });
  for (const s of cfg.sources ?? []) if (s.provider && !out.has(s.provider.toLowerCase())) out.set(s.provider.toLowerCase(), { name: s.provider });
  for (const p of await store.providers().catch(() => [])) if (!out.has(p.provider.toLowerCase())) out.set(p.provider.toLowerCase(), { name: p.provider });
  return [...out.values()];
}

export async function importSuppliers(store: PriceStore, buffer: Buffer, opts: { dryRun?: boolean } = {}): Promise<SupplierImportResult> {
  const { suppliers, warnings } = await parseSuppliersXlsx(buffer);
  if (!suppliers.length) return { suppliers, inserted: 0, updated: 0, warnings };
  const providers = await knownProviders(store);
  const overrides = loadPortalConfig().orders.supplierProviders;
  for (const x of suppliers) x.provider = providerForSupplier(x.name, providers, overrides);
  if (opts.dryRun) return { suppliers, inserted: 0, updated: 0, warnings };
  const r = await store.upsertSuppliers(suppliers);
  return { suppliers, ...r, warnings };
}
