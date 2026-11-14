/**
 * Bloque "Validación del ranking" del Tablero (corrida G, punto 6): solo el administrador (canSeeRankingReport). Compara
 * las respuestas de /portal/validar-ranking con el nivel del sistema (compareValidations) y trae los nombres de las
 * empresas y vendedores que el bloque muestra (las que más difieren y las notas).
 */
import { compareValidations, type ValidationReport } from "../scoring/validation";
import type { PortalStore, PortalUser } from "../store/types";
import { canSeeRankingReport } from "../ui/permissions";

/** Cuántas diferencias y notas muestra el bloque. */
export const RANKING_DIFFS_SHOWN = 10;
export const RANKING_NOTES_SHOWN = 15;

export interface RankingDashboard {
  report: ValidationReport;
  companyName: Record<number, string>;
  userName: Record<number, string>;
}

/** null si el usuario no es admin (el bloque no se muestra) o si no se pudo leer (se registra). */
export async function loadRankingForDashboard(
  user: Pick<PortalUser, "id" | "rol" | "activo">,
  store: Pick<PortalStore, "listRankingValidations" | "getCompany" | "listUsers">,
): Promise<RankingDashboard | null> {
  if (!canSeeRankingReport(user)) return null;
  try {
    const report = compareValidations(await store.listRankingValidations());
    const ids = [...new Set([...report.diferencias.slice(0, RANKING_DIFFS_SHOWN), ...report.notas.slice(0, RANKING_NOTES_SHOWN)].map((r) => r.companyId))];
    const [companies, users] = await Promise.all([Promise.all(ids.map((id) => store.getCompany(id))), store.listUsers()]);
    const companyName: Record<number, string> = {};
    for (const c of companies) if (c) companyName[c.id] = c.razonSocial;
    const userName: Record<number, string> = {};
    for (const u of users) userName[u.id] = u.nombre;
    return { report, companyName, userName };
  } catch (err) {
    console.error("[tablero] no pude leer la validación del ranking:", (err as Error).message);
    return null;
  }
}
