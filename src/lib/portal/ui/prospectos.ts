/**
 * Carga de "Prospectos" (/portal): la usan la página y la medición contra la base real. Una sola ronda de consultas en
 * paralelo (empresas de la página con sus medidas probables, marcas, departamentos, usuarios y, corrida L, los distritos
 * del departamento elegido) con tope de tiempo.
 */
import type { CompanySearchResult, DepartamentoCount, DistritoCount, MarcaCount, PortalStore, PortalUser } from "../store/types";
import { PAGE_DEADLINE_MS, withDeadline } from "./deadline";
import { toCompanySearch, type ProspectFilters } from "./filters";

export interface ProspectosData {
  result: CompanySearchResult;
  marcas: MarcaCount[];
  departamentos: DepartamentoCount[];
  users: PortalUser[];
  /** Corrida L: distritos del departamento elegido (con empresas), para el filtro; [] sin departamento. */
  distritos: DistritoCount[];
}

export function loadProspectos(store: PortalStore, filters: ProspectFilters, opts: { now?: Date; deadlineMs?: number } = {}): Promise<ProspectosData> {
  const search = { ...toCompanySearch(filters, opts.now), withMedidas: true };
  const distritos = filters.departamento ? store.listDistritos({ departamento: filters.departamento }) : Promise.resolve([] as DistritoCount[]);
  const work = Promise.all([store.searchCompanies(search), store.listMarcas(), store.listDepartamentos(), store.listUsers(), distritos]).then(
    ([result, marcas, departamentos, users, distritos]) => ({ result, marcas, departamentos, users, distritos }),
  );
  return withDeadline(work, opts.deadlineMs ?? PAGE_DEADLINE_MS, "Prospectos");
}
