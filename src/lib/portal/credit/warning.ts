/**
 * Aviso de crédito al cotizar a una empresa `sin evaluar` (o sin fila de crédito) o `rechazado`. Lo usa el mensaje del
 * portal tras enlazar una cotización (quotes/link.ts) y el bot en `oc`; nunca los mensajes del cotizador.
 */
import { shortName } from "../bot/companies";
import type { Company, CompanyCredit, PortalStore } from "../store/types";
import { creditEstadoOf } from "./states";

/** Línea de aviso para el vendedor, o null si el crédito no lo requiere (en evaluación, aprobado, observado). */
export function creditWarningLine(company: Pick<Company, "razonSocial">, credit: Pick<CompanyCredit, "estado"> | null): string | null {
  const estado = creditEstadoOf(credit);
  const who = shortName(company.razonSocial);
  if (estado === "sin_evaluar") return `⚠️ Crédito de *${who}*: sin evaluar. Antes de dar plazo, evalúalo en la ficha del portal.`;
  if (estado === "rechazado") return `⛔ Crédito RECHAZADO para *${who}*: no ofrezcas plazo sin revisar la ficha del portal.`;
  return null;
}

export async function creditWarning(store: Pick<PortalStore, "getCredit">, company: Pick<Company, "id" | "razonSocial">): Promise<string | null> {
  return creditWarningLine(company, await store.getCredit(company.id));
}
