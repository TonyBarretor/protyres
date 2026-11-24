import { z } from "zod";

/**
 * Corrida L (config/portal.json `sunat`): archivos del padrón reducido del RUC y qué estados / condiciones son alerta.
 * Las listas comparan por el INICIO del texto, sin tildes ni mayúsculas ("BAJA" vale para BAJA DE OFICIO, BAJA DEFINITIVA,
 * BAJA PROV. POR OFICI…). Valores que existen de verdad (archivo del 22/11/2026, RUC del portal): ver SUNAT-CORE en la
 * entrega de la corrida L.
 */
export const SunatSchema = z.looseObject({
  /** Carpeta de los zip (relativa a la raíz del repo). */
  dir: z.string().default("data/sunat"),
  archivo: z.string().default("padron_reducido_ruc.zip"),
  anexos: z.string().default("padron_reducido_local_anexo.zip"),
  /** Estados del contribuyente en alerta: en rojo y al final de Match Venta y de "mejores". */
  estadosAlerta: z.array(z.string().min(1)).default(["BAJA", "SUSPENSION TEMPORAL", "INHABILITADO", "ANULACION", "ANUL."]),
  /** Condiciones de domicilio en alerta (igual que los estados). */
  condicionesAlerta: z.array(z.string().min(1)).default(["NO HABIDO"]),
  /** Condiciones que se avisan en ámbar sin bajar la empresa (SUNAT no encontró el domicilio, aún no es NO HABIDO). */
  condicionesAviso: z.array(z.string().min(1)).default(["NO HALLADO"]),
  /** Locales anexos que el bot lista con `direccion` (los demás, resumidos por departamento). */
  anexosEnBot: z.number().int().min(1).max(30).default(5),
});

export type SunatConfig = z.infer<typeof SunatSchema>;

/** Lo que piden sunatEnAlerta / BestCompaniesQuery.alerta. */
export function alertMatch(cfg: SunatConfig): { estados: string[]; condiciones: string[] } {
  return { estados: cfg.estadosAlerta, condiciones: cfg.condicionesAlerta };
}
