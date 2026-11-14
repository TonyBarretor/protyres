/**
 * Corrida G, punto 5 — "tus mejores flotas para trabajar" (Hoy y el comando `mejores` del bot): las empresas de mayor
 * puntaje que no son de otro vendedor. Entran las sin dueño y las propias sin actividad de nadie en
 * `scoring.mejores.sinActividadDias`; las de otro vendedor nunca aparecen en la lista de nadie más. Sin reparto por zona
 * (decisión pendiente del supervisor, ver README).
 *
 * Orden: de mayor a menor puntaje (el bot pagina sobre ese orden con `más`). Hoy muestra las mismas 20 en dos grupos:
 * primero las sin dueño y luego las propias (groupForToday).
 */
import type { BestCompany, PortalStore, PortalUser } from "../store/types";
import type { ScoringConfig } from "./config";

export async function bestFleets(
  store: PortalStore,
  user: Pick<PortalUser, "id">,
  cfg: ScoringConfig,
  opts: { now?: Date; limit?: number; offset?: number } = {},
): Promise<{ rows: BestCompany[]; total: number }> {
  const now = opts.now ?? new Date();
  const activeSince = new Date(now.getTime() - cfg.mejores.sinActividadDias * 86_400_000);
  return store.bestCompanies({ userId: user.id, activeSince, limit: opts.limit ?? cfg.mejores.hoy, offset: opts.offset ?? 0 });
}

/** Las 20 de Hoy: primero las sin dueño, luego las propias (cada grupo de mayor a menor puntaje). */
export function groupForToday(rows: readonly BestCompany[]): { sinDueno: BestCompany[]; propias: BestCompany[] } {
  return { sinDueno: rows.filter((r) => !r.propia), propias: rows.filter((r) => r.propia) };
}
