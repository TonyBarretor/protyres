/**
 * Avisos que no llegaron por la ventana de 24 h de WhatsApp (bloque B6): el cron los guarda en el estado del portal del
 * usuario (bot/state.ts, `notices`) y routePortal los manda en un mensaje aparte cuando el usuario vuelve a escribir.
 */
import type { PortalNotice } from "../bot/state";

export const NOTICES_HEADER = "📬 *Avisos pendientes* (no te llegaron porque WhatsApp no me deja escribirte si pasan 24 h sin un mensaje tuyo):";

/** Un solo mensaje con todos los avisos, del más antiguo al más reciente. */
export function noticesMessage(notices: readonly PortalNotice[]): string {
  return [NOTICES_HEADER, ...notices.map((n) => n.text.trim())].join("\n\n");
}
