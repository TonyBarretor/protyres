/**
 * Pruebas y simulador (ventas-odoo): carga un reporte de Odoo armado con odoo-fixture por el mismo camino que "Subir
 * ventas" (lectura del .xlsx, vista previa y guardado con recálculo del puntaje). Solo datos inventados.
 */
import type { PortalStore, PortalUser } from "../store/types";
import type { PriceSizesSource } from "../scoring/recalc";
import { DEFAULT_SALES_SETTINGS } from "./config";
import { commitOdooUpload, previewOdooUpload, type CommitResult } from "./import";
import { buildOdooXlsx, type OdooFixtureLine } from "./odoo-fixture";
import { readSalesXlsx } from "./xlsx";

export async function seedOdoo(
  store: PortalStore,
  lines: OdooFixtureLine[],
  user: Pick<PortalUser, "id" | "nombre" | "rol">,
  opts: { fileName?: string; prices?: PriceSizesSource | null; log?: (m: string) => void } = {},
): Promise<CommitResult> {
  const buf = await buildOdooXlsx(lines);
  const r = await readSalesXlsx(buf, { users: await store.listUsers(), settings: DEFAULT_SALES_SETTINGS });
  if (!r.odoo) throw new Error("el fixture no se leyó como reporte de Odoo");
  const stats = await previewOdooUpload(store, r.odoo);
  const hash = `fixture-${lines.length}-${lines.map((l) => l.documento).join(",")}`;
  return commitOdooUpload({ store, parsed: r.odoo, fileName: opts.fileName ?? "ventas-prueba.xlsx", hash, user, stats, prices: opts.prices ?? null, log: opts.log ?? (() => undefined) });
}
