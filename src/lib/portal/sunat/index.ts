/**
 * Corrida L — domicilio fiscal, estado, condición y locales anexos del "Padrón reducido del RUC" de SUNAT.
 *
 * Para la UI (ficha, tarjetas de Match Venta y Prospectos, planificar):
 *  - store.getSunat(ruc) / getSunatByRucs(rucs): SunatRecord (dirección armada, piezas, estado, condición, ubigeo, fecha,
 *    razón social de SUNAT si difiere mucho, cantidad de anexos). store.listSunatLocales(ruc): SunatLocal[].
 *  - Las listas ya traen `sunat` (SunatBrief): searchCompanies (CompanyRow), bestCompanies (BestCompany) y Match Venta
 *    (MatchResultSummary / MatchCard, que además trae ubicacion, direccionVisible, sunatAviso y enAlerta).
 *  - direccionVisible(company, sunat): la de operación (companies.direccion, la escrita a mano) manda; si no, la fiscal
 *    con "Según SUNAT al dd/mm/aaaa". AVISO_DOMICILIO_FISCAL: la línea de aviso.
 *  - directionsLink(c, sunat) (match/company.ts): "Cómo llegar" (operación > fiscal > búsqueda aproximada) y mapsUrl().
 *  - sunatAviso(sunat, cfg): { nivel: "alerta" | "aviso", texto } o null (rojo / ámbar).
 *  - ubicacionEfectiva(company, sunat) / ubicacionTexto(): distrito real (SUNAT si está en el departamento de la empresa).
 *  - Filtro "Distrito": distritosDe(departamento) (tabla INEI) o store.listDistritos({ departamento }) (solo los que tienen
 *    empresas, con conteo); el valor es el código INEI: MatchFilters.distrito (?dist=150140) y CompanySearch.distrito.
 *  - planCompanyFrom(company, sunat) (match/schedule.ts) para proposeVisitPlan.
 *  - localesOrdenados(locales, departamento) (bot/commands/direccion.ts): los del departamento de la flota primero.
 */
export * from "./address";
export * from "./config";
export * from "./import";
export * from "./ubicacion";
export * from "./ubigeo";
