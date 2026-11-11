/**
 * Origen de ventas. Hoy las ventas llegan por Excel ("Subir ventas", ver xlsx.ts); el adaptador de Odoo queda como
 * interfaz: cuando conozcamos su API/reporte se implementa `OdooSalesSource.fetch` y se programa su sincronización.
 */
import type { IsoDate, SaleInput } from "../store/types";

export interface SalesSource {
  /** "excel", "odoo", ... (se guarda en `sales.origen`). */
  readonly name: string;
  /** Ventas con fecha >= `since`. */
  fetch(since: Date | IsoDate): Promise<SaleInput[]>;
}

export interface OdooSalesSourceOptions {
  url?: string;
  database?: string;
  username?: string;
  apiKey?: string;
}

/** Esqueleto: no se inventan endpoints ni modelos de Odoo hasta tener el acceso real. */
export class OdooSalesSource implements SalesSource {
  readonly name = "odoo";

  constructor(readonly options: OdooSalesSourceOptions = {}) {}

  async fetch(_since: Date | IsoDate): Promise<SaleInput[]> {
    throw new Error("OdooSalesSource: no implementado (falta el acceso a Odoo); sube las ventas en Excel desde el portal.");
  }
}
