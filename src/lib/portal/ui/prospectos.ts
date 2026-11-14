/**
 * Carga de "Prospectos" (/portal): la usan la página y la medición contra la base real. Una sola ronda de consultas en
 * paralelo (empresas de la página con sus medidas probables, marcas, departamentos y usuarios) con tope de tiempo.
 */
import type { CompanySearchResult, DepartamentoCount, MarcaCount, PortalStore, PortalUser } from "../store/types";
import { PAGE_DEADLINE_MS, withDeadline } from "./deadline";
import { toCompanySearch, type ProspectFilters } from "./filters";

export interface ProspectosData {
  result: CompanySearchResult;
  marcas: MarcaCount[];
  departamentos: DepartamentoCount[];
  users: PortalUser[];
}

export function loadProspectos(store: PortalStore, filters: ProspectFilters, opts: { now?: Date; deadlineMs?: number } = {}): Promise<ProspectosData> {
  const search = { ...toCompanySearch(filters, opts.now), withMedidas: true };
  const work = Promise.all([store.searchCompanies(search), store.listMarcas(), store.listDepartamentos(), store.listUsers()]).then(
    ([result, marcas, departamentos, users]) => ({ result, marcas, departamentos, users }),
  );
  return withDeadline(work, opts.deadlineMs ?? PAGE_DEADLINE_MS, "Prospectos");
}
