/**
 * Corrida G, punto 5 — "tus mejores flotas para trabajar" (Hoy y el comando `mejores` del bot): las empresas de mayor
 * puntaje que no son de otro vendedor. Entran las sin dueño y las propias sin actividad de nadie en
 * `scoring.mejores.sinActividadDias`; las de otro vendedor nunca aparecen en la lista de nadie más. Sin reparto por zona
 * (decisión pendiente del supervisor, ver README).
 *
 * Orden: de mayor a menor puntaje (el bot pagina sobre ese orden con `más`); corrida L: las de estado o condición de
 * SUNAT en alerta (config/portal.json `sunat`) van al final, sin ocultarse. Hoy muestra las mismas 20 en dos grupos:
 * primero las sin dueño y luego las propias (groupForToday).
 */
import { loadPortalConfig } from "../config";
import type { SunatConfig } from "../sunat/config";
import type { BestCompany, PortalStore, PortalUser } from "../store/types";
import type { ScoringConfig } from "./config";

export async function bestFleets(
  store: PortalStore,
  user: Pick<PortalUser, "id">,
  cfg: ScoringConfig,
  opts: { now?: Date; limit?: number; offset?: number; sunat?: SunatConfig } = {},
): Promise<{ rows: BestCompany[]; total: number }> {
  const now = opts.now ?? new Date();
  const activeSince = new Date(now.getTime() - cfg.mejores.sinActividadDias * 86_400_000);
  // corrida L: estado o condición de SUNAT en alerta, al final (sin ocultarse)
  const sunat = opts.sunat ?? loadPortalConfig().sunat;
  const alerta = { estados: sunat.estadosAlerta, condiciones: sunat.condicionesAlerta };
  return store.bestCompanies({ userId: user.id, activeSince, limit: opts.limit ?? cfg.mejores.hoy, offset: opts.offset ?? 0, alerta });
}

/** Las 20 de Hoy: primero las sin dueño, luego las propias (cada grupo de mayor a menor puntaje). */
export function groupForToday(rows: readonly BestCompany[]): { sinDueno: BestCompany[]; propias: BestCompany[] } {
  return { sinDueno: rows.filter((r) => !r.propia), propias: rows.filter((r) => r.propia) };
}
