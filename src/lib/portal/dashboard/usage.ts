/**
 * Bloque "Consumo" del tablero (corrida E): solo para el administrador (canSeeUsage). Lee el uso medido del store del bot
 * (tablas llm_usage / audio_usage) y lo resume con guard/report.ts: hoy y 7 días, por usuario y propósito, % del tope.
 */
import { loadUsageReport, type UsageReport } from "../../guard/report";
import { getStore } from "../../store";
import type { PriceStore } from "../../store/types";
import { canSeeUsage } from "../auth/permissions";
import { loadPortalConfig } from "../config";
import type { PortalStore, PortalUser } from "../store/types";

/** null si el usuario no es admin (el bloque no se muestra) o si no se pudo leer el uso (se registra). */
export async function loadUsageForDashboard(
  user: Pick<PortalUser, "id" | "rol" | "activo">,
  portal: Pick<PortalStore, "listUsers">,
  opts: { store?: Pick<PriceStore, "usageSummary" | "blockedSummary">; now?: Date } = {},
): Promise<UsageReport | null> {
  if (!canSeeUsage(user)) return null;
  try {
    const names = new Map<string, string>();
    for (const u of await portal.listUsers()) if (u.whatsapp) names.set(u.whatsapp, u.nombre);
    return await loadUsageReport(opts.store ?? (await getStore()), loadPortalConfig().limits, { names, now: opts.now });
  } catch (err) {
    console.error("[tablero] no pude leer el consumo:", (err as Error).message);
    return null;
  }
}
