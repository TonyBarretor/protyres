/**
 * Proveedor de buró de crédito: punto de enganche para consultar a una central de riesgo por RUC.
 *
 *  - `manual` (por defecto): no consulta nada afuera. Devuelve lo que el equipo ya cargó en la ficha (estado, calificación,
 *    línea, plazo...) y recuerda que la consulta se hace a mano y el PDF del reporte se adjunta en la ficha.
 *  - `equifax`: ESQUELETO. No hace llamadas: lanza "Equifax/Infocorp no configurado". Para implementarlo hacen falta las
 *    credenciales del contrato y la documentación oficial de su API (ver README, sección "Crédito"). Aquí no se asume
 *    ningún endpoint, formato ni campo de Equifax/Infocorp.
 *
 * Selección: CREDIT_BUREAU_PROVIDER=manual|equifax (por defecto manual).
 */
import { digits } from "../store/shared";
import type { CreditEstado, PortalStore } from "../store/types";

export interface CreditReport {
  /** Proveedor que respondió ("manual", "equifax"). */
  provider: string;
  ruc: string;
  /** Estado guardado (manual) o propuesto por el buró; null si no hay datos. */
  estado: CreditEstado | null;
  calificacion: string | null;
  linea: number | null;
  moneda: string | null;
  plazoDias: number | null;
  fuente: string | null;
  consultadoAt: Date | null;
  /** true si hay un PDF del reporte adjunto en la ficha. */
  tienePdf: boolean;
  /** Texto para mostrar ("consulta manual: adjunta el PDF del reporte en la ficha"). */
  mensaje: string;
}

export interface CreditBureauProvider {
  readonly name: string;
  consultar(ruc: string): Promise<CreditReport>;
}

export const MANUAL_MESSAGE = "consulta manual: adjunta el PDF del reporte en la ficha";

/** Lo guardado en el portal para la empresa de ese RUC; nunca sale a internet. */
export class ManualCreditProvider implements CreditBureauProvider {
  readonly name = "manual";
  constructor(private store: Pick<PortalStore, "getCompanyByRuc" | "getCredit">) {}

  async consultar(ruc: string): Promise<CreditReport> {
    const r = digits(ruc);
    const company = r ? await this.store.getCompanyByRuc(r) : null;
    const credit = company ? await this.store.getCredit(company.id) : null;
    return {
      provider: this.name,
      ruc: r,
      estado: credit?.estado ?? (company ? "sin_evaluar" : null),
      calificacion: credit?.calificacion ?? null,
      linea: credit?.linea ?? null,
      moneda: credit?.moneda ?? null,
      plazoDias: credit?.plazoDias ?? null,
      fuente: credit?.fuente ?? null,
      consultadoAt: credit?.consultadoAt ?? null,
      tienePdf: !!credit?.pdfName,
      mensaje: company ? MANUAL_MESSAGE : `RUC ${r || ruc} no está en el portal; ${MANUAL_MESSAGE}`,
    };
  }
}

/**
 * Esqueleto de Equifax/Infocorp. Sin contrato ni documentación oficial no hay implementación: cualquier consulta falla
 * con un error claro. No hace ninguna llamada de red.
 */
export class EquifaxCreditProvider implements CreditBureauProvider {
  readonly name = "equifax";
  async consultar(_ruc: string): Promise<CreditReport> {
    throw new Error("Equifax/Infocorp no configurado");
  }
}

export function getCreditBureauProvider(store: Pick<PortalStore, "getCompanyByRuc" | "getCredit">, name = process.env.CREDIT_BUREAU_PROVIDER || "manual"): CreditBureauProvider {
  switch (name.trim().toLowerCase()) {
    case "equifax":
    case "infocorp":
      return new EquifaxCreditProvider();
    case "manual":
    case "":
      return new ManualCreditProvider(store);
    default:
      throw new Error(`CREDIT_BUREAU_PROVIDER desconocido: ${name} (usa manual o equifax)`);
  }
}
