/**
 * Datos del portal comercial: empresas del padrón MTC, su flota, ventas, usuarios/sesiones y el CRM (contactos,
 * oportunidades con historial de etapas, actividades y citas).
 *
 * Dos implementaciones con el mismo comportamiento: Postgres (pg-portal-store.ts) y JSON/en memoria (json-portal-store.ts).
 * La interfaz está partida por área (CompanyRepo, SalesRepo, ...): las fases B (bot) y C (tablero, crédito, encuesta)
 * añaden un repo nuevo y lo suman a `PortalStore` sin tocar los existentes.
 *
 * Convenciones: tipos en camelCase; marcas de tiempo como `Date`; fechas de calendario (ventas, cierre esperado) como
 * texto `AAAA-MM-DD`; RUC y números de WhatsApp solo dígitos.
 */
import type { StageId } from "../stages";

export type Sector = "carga" | "pasajeros" | "mixto";
export type Temperatura = "caliente" | "tibio" | "frio";
/** carga / pasajeros: padrón MTC. manual (corrida J): vehículo cargado a mano en la ficha; el import del MTC no lo toca. */
export type FleetOrigen = "carga" | "pasajeros" | "manual";
/** De dónde salió la empresa: padrón MTC (import) o creada a mano (corrida J, `nueva empresa` / "Agregar empresa"). */
export type CompanyOrigen = "mtc" | "manual";
export type Confianza = "alta" | "media" | "baja";
export type UserRole = "vendedor" | "supervisor" | "tecnico" | "admin";

/** Fecha de calendario "AAAA-MM-DD". */
export type IsoDate = string;

// ── Empresas y flota ──

export interface Company {
  id: number;
  ruc: string;
  razonSocial: string;
  sector: Sector | null;
  /** Departamento principal (donde está la mayor parte de la flota). */
  departamento: string | null;
  unidades: number;
  llantasPiso: number;
  antiguedadMedia: number | null;
  esCliente: boolean;
  ownerUserId: number | null;
  temperatura: Temperatura | null;
  /** Puntaje de atractivo 0–100 (corrida G, `npm run portal:recalc-score`); null = aún no calculado. */
  score: number | null;
  /** Nivel A/B/C del puntaje (percentil y frenos). Opcional en objetos armados a mano; los stores siempre lo traen. */
  nivel?: Nivel | null;
  /** Aporte de cada factor y frenos aplicados (de aquí sale la explicación). */
  scoreDetalle?: ScoreDetail | null;
  scoreAt?: Date | null;
  /** Plazo de crédito habitual en días (fase B lo propone al cotizar). */
  creditTermsDays: number | null;
  /**
   * Corrida J: "manual" = creada a mano (no está en el padrón: su flota no viene del MTC); al aparecer su RUC en el padrón
   * se fusiona y pasa a "mtc". Opcional en objetos armados a mano; los stores siempre lo traen.
   */
  origen?: CompanyOrigen;
  /** Corrida J: quién la creó a mano (null en las del padrón). */
  createdBy?: number | null;
  /**
   * Corrida K: provincia y distrito principales (los más frecuentes de su flota de pasajeros: el padrón de carga solo trae
   * departamento) y dirección escrita a mano en el portal ("Agregar dirección"; el padrón no la trae). Opcionales en objetos
   * armados a mano; los stores siempre los traen (null si no hay).
   */
  provincia?: string | null;
  distrito?: string | null;
  direccion?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Corrida J: empresa creada a mano (fuera del padrón). Queda asignada a `createdBy`. */
export interface ManualCompanyInput {
  ruc: string;
  razonSocial: string;
  sector: Sector | null;
  departamento: string | null;
  unidades?: number | null;
  createdBy: number;
}

/** Corrida J: vehículo cargado a mano en la ficha (marca, clase, ejes, llantas, medida y placa). */
export interface ManualVehicleInput {
  placa: string;
  marca: string | null;
  clase: string | null;
  ejes: number | null;
  llantas: number | null;
  /** Medida declarada (canónica, "295/80R22.5"); se guarda como medida_probable con confianza alta. */
  medida: string | null;
  anio?: number | null;
}

export type ManualVehicleResult = { ok: true; vehicle: FleetVehicle; updated: boolean } | { ok: false; reason: "otra_empresa"; companyId: number };

/**
 * Lo que trae el import del padrón. Al reimportar (mismo RUC) se actualizan solo estos campos: es_cliente, dueño,
 * temperatura, score y crédito, que se trabajan en el portal, se conservan.
 */
export interface CompanyInput {
  ruc: string;
  razonSocial: string;
  sector?: Sector | null;
  departamento?: string | null;
  unidades?: number;
  llantasPiso?: number;
  antiguedadMedia?: number | null;
  /** Corrida K: provincia y distrito principales (solo el padrón de pasajeros los trae). */
  provincia?: string | null;
  distrito?: string | null;
}

export type CompanyPatch = Partial<
  Pick<Company, "razonSocial" | "sector" | "departamento" | "unidades" | "llantasPiso" | "antiguedadMedia" | "esCliente" | "ownerUserId" | "temperatura" | "score" | "creditTermsDays" | "provincia" | "distrito" | "direccion">
>;

export interface UpsertCompaniesResult {
  inserted: number;
  updated: number;
  /** RUC -> id, para enlazar la flota en el mismo import. */
  ids: Record<string, number>;
  /**
   * Corrida J: RUC de empresas creadas a mano que llegaron en este lote (se fusionaron con el padrón: pasan a origen "mtc";
   * dueño, contactos, actividad, oportunidades y vehículos cargados a mano se conservan). Solo si hubo alguna.
   */
  merged?: string[];
}

export interface FleetVehicle {
  id: number;
  companyId: number;
  placa: string;
  marca: string | null;
  clase: string | null;
  anio: number | null;
  /** Dato MTC. */
  ejes: number | null;
  /** Dato MTC. */
  llantas: number | null;
  /** Corte del padrón del que salió `llantas` (p. ej. "20241231"); null si no se encontró. */
  llantasFuente: string | null;
  /** Kg. */
  pesoBruto: number | null;
  chasis: string | null;
  departamento: string | null;
  origen: FleetOrigen;
  /** Inferida (config/tyre-inference.json), no dato MTC. */
  medidaProbable: string | null;
  confianza: Confianza | null;
}

export type FleetVehicleInput = Omit<FleetVehicle, "id">;

export type FleetKey = Pick<FleetVehicle, "placa" | "origen">;

export type CompanyOrder = "atractivo" | "unidades" | "llantas" | "participacion";

export interface CompanySearch {
  /**
   * Texto libre: razón social sin tildes, mayúsculas, espacios ni signos ("z buss" = "ZBUSS"; varias palabras deben estar
   * todas) o inicio del RUC. Ver searchTerms() en shared.ts.
   */
  q?: string;
  departamento?: string[];
  sector?: Sector[];
  minUnits?: number;
  maxUnits?: number;
  /** Marcas de vehículo (cualquiera de ellas; sin distinguir mayúsculas). */
  marcas?: string[];
  esCliente?: boolean;
  ownerUserId?: number;
  /** Niveles del puntaje (cualquiera de ellos). */
  nivel?: Nivel[];
  /** Por defecto "unidades" (Prospectos pasa "atractivo"). Con "atractivo", las empresas sin puntaje van al final. */
  orderBy?: CompanyOrder;
  /** 1 en adelante. */
  page?: number;
  pageSize?: number;
  /** Inicio de la ventana de participación; por defecto 12 meses antes de `now`. */
  since?: Date | IsoDate;
  now?: Date;
  /** true: cada fila trae `medidas` (lista de Prospectos). */
  withMedidas?: boolean;
}

/** Medida probable (inferida, config/tyre-inference.json) y cuántas unidades de la flota la llevan. */
export interface MedidaCount {
  medida: string;
  unidades: number;
}

export interface CompanyRow extends Company {
  /** Neumáticos vendidos a la empresa en la ventana (suma de `sales.cantidad`). */
  participacion: number;
  /** true si alguna venta demo entra en la cifra (la UI muestra "DEMO"). */
  participacionDemo: boolean;
  /** Con `withMedidas`: hasta 3 medidas probables de su flota, de más a menos unidades. */
  medidas?: MedidaCount[];
}

export interface CompanySearchResult {
  rows: CompanyRow[];
  total: number;
}

export interface MarcaCount {
  marca: string;
  vehiculos: number;
  empresas: number;
}

export interface DepartamentoCount {
  departamento: string;
  empresas: number;
}

/** Flota de una empresa agrupada por marca y clase. */
export interface FleetGroup {
  marca: string | null;
  clase: string | null;
  anioMin: number | null;
  anioMax: number | null;
  unidades: number;
  /** Suma de llantas (dato MTC) de las unidades que lo tienen. */
  llantas: number;
  /** Unidades con dato de llantas. */
  unidadesConLlantas: number;
  /** Medida probable más frecuente del grupo (inferida). */
  medidaProbable: string | null;
  /** Confianza más frecuente de esa medida. */
  confianza: Confianza | null;
}

export interface CompanyRepo {
  /**
   * Import del padrón. Corrida J: una empresa creada a mano con ese RUC se fusiona (origen pasa a "mtc"); los datos del
   * padrón mandan, salvo sector y departamento que, si el padrón no los trae, conservan lo cargado a mano.
   */
  upsertCompanies(batch: CompanyInput[]): Promise<UpsertCompaniesResult>;
  /**
   * Corrida J: crea la empresa a mano (origen "manual", dueño = quien la crea) en una sola operación; si el RUC ya existe
   * no toca nada y devuelve esa (`created` false).
   */
  createManualCompany(input: ManualCompanyInput): Promise<{ company: Company; created: boolean }>;
  getCompany(id: number): Promise<Company | null>;
  getCompanyByRuc(ruc: string): Promise<Company | null>;
  /** Las empresas de esos RUC que existen (una consulta; sin orden garantizado). */
  getCompaniesByRucs(rucs: string[]): Promise<Company[]>;
  updateCompany(id: number, patch: CompanyPatch): Promise<Company | null>;
  /**
   * userId null = liberar la empresa. Con `onlyIfOwner` (corrida H) solo cambia si el dueño actual es ese (null = sin
   * dueño), en una sola operación; si otro la tomó entretanto, no la toca y devuelve null.
   */
  setOwner(companyId: number, userId: number | null, opts?: { onlyIfOwner: number | null }): Promise<Company | null>;
  searchCompanies(opts?: CompanySearch): Promise<CompanySearchResult>;
  /** Marcas de vehículo con conteo, de más a menos vehículos. */
  listMarcas(): Promise<MarcaCount[]>;
  listDepartamentos(): Promise<DepartamentoCount[]>;
  countCompanies(): Promise<number>;
}

/** Empresa con su flota contada por origen (recálculo del sector sin reimportar el padrón). */
export interface CompanyOriginCounts {
  companyId: number;
  ruc: string;
  razonSocial: string;
  sector: Sector | null;
  carga: number;
  pasajeros: number;
}

export interface FleetRepo {
  /** Inserta o actualiza por (placa, origen); reimportar no duplica. Una placa puede pasar a otra empresa. */
  upsertFleet(batch: FleetVehicleInput[]): Promise<{ inserted: number; updated: number }>;
  /** Deja como flota de la empresa exactamente `vehicles` (borra las que ya no están). */
  replaceFleet(companyId: number, vehicles: Omit<FleetVehicleInput, "companyId">[]): Promise<{ removed: number; upserted: number }>;
  /**
   * Poda por lotes (import del padrón): borra los vehículos de `companyIds` cuyo (placa, origen) no está en `keep`.
   * Llamar después de upsertFleet, que ya movió a su empresa actual las placas que cambiaron de dueño. Devuelve cuántos borró.
   * Corrida J: nunca borra los vehículos cargados a mano (origen "manual"); replaceFleet tampoco.
   */
  pruneFleet(companyIds: number[], keep: FleetKey[]): Promise<number>;
  /**
   * Corrida J: agrega (o actualiza, si la placa ya estaba cargada a mano en esa empresa) un vehículo cargado a mano. Si la
   * placa ya está cargada a mano en OTRA empresa no la mueve: { ok: false, reason: "otra_empresa" }.
   */
  addManualVehicle(companyId: number, vehicle: ManualVehicleInput): Promise<ManualVehicleResult>;
  /** Corrida J: borra un vehículo cargado a mano de esa empresa (los del padrón no). true si lo borró. */
  deleteManualVehicle(companyId: number, vehicleId: number): Promise<boolean>;
  listFleet(companyId: number): Promise<FleetVehicle[]>;
  /**
   * Corrida J: los vehículos de esas placas en todo el padrón (cualquier empresa), comparando sin guion, espacios ni
   * mayúsculas ("ABC-123" = "abc123"). Una placa puede salir dos veces (carga y pasajeros). Orden: placa, id.
   */
  findFleetByPlacas(placas: string[]): Promise<FleetVehicle[]>;
  /** Corrida J: los vehículos cargados a mano de la empresa (origen "manual"), por placa. */
  listManualVehicles(companyId: number): Promise<FleetVehicle[]>;
  /** Flota del padrón (corrida J: sin los vehículos cargados a mano, que la ficha muestra aparte). */
  fleetByBrand(companyId: number): Promise<FleetGroup[]>;
  countFleet(): Promise<number>;
  /** Todas las empresas (también las sin flota, con 0 y 0) con sus vehículos contados por origen; orden por id. */
  companyOriginCounts(): Promise<CompanyOriginCounts[]>;
}

// ── Ventas ──

export interface SaleInput {
  fecha: IsoDate;
  ruc: string;
  razonSocial?: string | null;
  medida?: string | null;
  marca?: string | null;
  diseno?: string | null;
  cantidad: number;
  precioUnitario?: number | null;
  total?: number | null;
  vendedor?: string | null;
  /** "excel", "odoo", "demo", ... */
  origen?: string | null;
  isDemo?: boolean;
  /** De dónde salió la carga, para no repetirla: "xlsx:<sha256 del archivo>". */
  sourceRef?: string | null;
  /** Detalle del reporte de Odoo (ventas-odoo); las ventas del formato simple no lo traen. */
  detalle?: SaleDetailInput | null;
}

/** Tipo de línea de una venta: solo `neumatico` cuenta para participación, "es cliente", consumo y puntaje. */
export type SaleLineType = "neumatico" | "servicio" | "otro";

/** Documento: las notas de crédito restan (cantidad y montos vienen ya con signo); las de débito no suman unidades. */
export type SaleDocType = "factura" | "boleta" | "nota_credito" | "nota_debito" | "otro";

/** Documento del cliente: RUC (11), DNI (8, persona natural: venta minorista) u otro (fila con advertencia). */
export type SaleClientDoc = "ruc" | "dni" | "otro";

/**
 * Tipos de servicio normalizados (ventas-odoo, punto 4). El contrato de neumáticos viene en tres componentes
 * (personal / insumos / equipos), cada uno con su tipo.
 */
export const SERVICE_TYPES = [
  "enllante",
  "desenllante",
  "balanceo",
  "alineamiento",
  "rotacion",
  "parchado",
  "cambio_neumaticos",
  "mantenimiento_correctivo",
  "reencauche",
  "contrato_personal",
  "contrato_insumos",
  "contrato_equipos",
  "software",
  "otros",
] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

/**
 * Campos de una línea del reporte de Odoo. Montos y tipo de cambio tal como vienen en el archivo (no se recalculan); en
 * una nota de crédito van con signo negativo, igual que la cantidad. Costos, proveedor y margen son internos: los ven
 * vendedor, supervisor y admin, nunca un documento para el cliente.
 */
export interface SaleDetailInput {
  /** Clave estable de la línea: tipo de documento + N° + código de producto + n.º de aparición del código en el documento. */
  lineKey: string;
  tipoDoc: SaleDocType;
  documento: string;
  vencimiento?: IsoDate | null;
  moneda?: string | null;
  tipoCambio?: number | null;
  estadoSunat?: string | null;
  /** STATUS del reporte (columna del bloque COMPRA). */
  status?: string | null;
  ocOdoo?: string | null;
  /** "OC PROVEEDOR": en las notas de crédito trae "Reversión de: <factura>, <motivo>". */
  ocProveedor?: string | null;
  guia?: string | null;
  condVenta?: string | null;
  descripcion: string;
  codigoProducto?: string | null;
  tipoLinea: SaleLineType;
  tipoServicio?: ServiceType | null;
  docCliente: SaleClientDoc;
  vendedorUserId?: number | null;
  totalSinServ?: number | null;
  precioUnitarioUsd?: number | null;
  totalUsd?: number | null;
  costoUnitario?: number | null;
  costoTotal?: number | null;
  costoUnitarioUsd?: number | null;
  costoTotalUsd?: number | null;
  facturaProveedor?: string | null;
  proveedor?: string | null;
  monedaProveedor?: string | null;
  tipoCambioProveedor?: number | null;
  /** MARGEN tal como viene ("19.68%", "SERVICIO SIN COSTO") y su número (19.68) si lo tiene. */
  margen?: string | null;
  margenPct?: number | null;
  /** false: la línea no suma neumáticos (no es neumático, nota de débito, nota de crédito solo de monto, STATUS excluido). */
  cuentaUnidades: boolean;
  /** Venta anulada (ESTADO SUNAT o TIPO DOC; o un STATUS de sales.excludeStatus): se guarda, pero no cuenta en nada. */
  excluida: boolean;
  /** Por qué se excluyó ("ESTADO SUNAT: Anulado", "TIPO DOC: Factura Anulada", "STATUS: …"); null si cuenta. */
  motivoExclusion?: string | null;
  /**
   * true: TOTAL VTA S/ (o VTA UND S/) venía en 0 con su par en dólares distinto de 0, y el monto en soles de `total` /
   * `precioUnitario` se calculó con el T.C. de la línea. Los valores del archivo quedan en totalOriginal / precioUnitarioOriginal.
   */
  montoCalculado?: boolean;
  totalOriginal?: number | null;
  precioUnitarioOriginal?: number | null;
  advertencia?: string | null;
  uploadId?: number | null;
}

/** Línea de venta guardada con su detalle de Odoo y el cliente final (leasing), si se asignó. */
export interface SaleDetail extends Required<Omit<SaleDetailInput, "uploadId">> {
  uploadId: number | null;
  /** Cliente final (leasing): la empresa del portal a la que se le atribuyen los neumáticos en lugar del banco. */
  clienteFinalCompanyId: number | null;
  clienteFinalRuc: string | null;
  clienteFinalAt: Date | null;
  clienteFinalBy: number | null;
  updatedAt: Date | null;
}

export interface Sale {
  id: number;
  fecha: IsoDate;
  ruc: string;
  razonSocial: string | null;
  medida: string | null;
  marca: string | null;
  diseno: string | null;
  cantidad: number;
  precioUnitario: number | null;
  total: number | null;
  vendedor: string | null;
  origen: string | null;
  isDemo: boolean;
  sourceRef: string | null;
  createdAt: Date;
  /** null en las ventas del formato simple y las demo. */
  detalle: SaleDetail | null;
}

export interface Participation {
  cantidad: number;
  demo: boolean;
}

/**
 * Ventas agregadas por (RUC, fecha, vendedor) en una ventana (tablero, bloque C2). `monto` = suma de `total` o, si falta,
 * `precioUnitario × cantidad`; las filas sin ninguno de los dos no suman monto y se cuentan en `sinMonto`.
 */
export interface SalesAggRow {
  ruc: string;
  fecha: IsoDate;
  /** Texto tal como llegó en la venta (sin normalizar); null si no tenía. */
  vendedor: string | null;
  /** Una razón social de las ventas del grupo (la mayor alfabéticamente). */
  razonSocial: string | null;
  cantidad: number;
  monto: number;
  /** Filas sin total ni precio unitario. */
  sinMonto: number;
  /** true si alguna venta del grupo es demo. */
  demo: boolean;
  filas: number;
}

export interface SalesRepo {
  insertSales(rows: SaleInput[]): Promise<number>;
  deleteDemoSales(): Promise<number>;
  /** Ventas ya guardadas con ese `sourceRef` y cuándo se cargó la primera (null si ninguna). */
  countSalesBySource(sourceRef: string): Promise<{ total: number; firstAt: Date | null }>;
  /** Ventas guardadas: total y cuántas son demo (pantalla "Subir ventas"). */
  countSales(): Promise<{ total: number; demo: number }>;
  /** Ventas del RUC desde `since` (inclusive), la más reciente primero. */
  salesByRuc(ruc: string, since?: Date | IsoDate): Promise<Sale[]>;
  /** RUC -> neumáticos vendidos desde `since`; solo trae los RUC con ventas. */
  participation(rucs: string[], since: Date | IsoDate): Promise<Record<string, Participation>>;
  /** Ventas con fecha entre `since` y `until` (ambas inclusive) agrupadas por (RUC, fecha, vendedor); sin orden garantizado. */
  salesAggregate(since: Date | IsoDate, until: Date | IsoDate): Promise<SalesAggRow[]>;
  /**
   * ventas-odoo: guarda líneas con `detalle.lineKey`; si la clave ya existe, actualiza todo menos el cliente final (una
   * carga posterior no lo borra). Las filas sin `detalle` se rechazan (usar insertSales).
   */
  upsertSaleLines(rows: SaleInput[]): Promise<{ inserted: number; updated: number }>;
  /** De estas claves, las que ya están guardadas. */
  existingSaleLineKeys(keys: string[]): Promise<Set<string>>;
  /** Líneas según el filtro, la más reciente primero (fecha, id). */
  querySales(filter: SalesQuery): Promise<Sale[]>;
  /**
   * Asigna (o quita, con `company: null`) el cliente final a todas las líneas de esos documentos del RUC del banco.
   * Devuelve las líneas cambiadas.
   */
  setClienteFinal(input: { bankRuc: string; documentos: string[]; company: { id: number; ruc: string } | null; userId: number | null }): Promise<number>;
  /** Resumen por RUC (al que cuentan las líneas): neumáticos netos, líneas, última fecha y una razón social. Sin demo. */
  salesByClient(): Promise<SalesClientRow[]>;
  recordSalesUpload(input: SalesUploadInput): Promise<SalesUpload>;
  listSalesUploads(limit?: number): Promise<SalesUpload[]>;
  /**
   * Corrida J, punto 5 (pantalla general de ventas): una página de líneas según el filtro, la más reciente primero
   * (fecha, id). Sin las excluidas (ventas anuladas). Pagina en la base: no trae las demás.
   */
  listSalesLines(filter: SalesListFilter, page: { limit: number; offset: number }): Promise<Sale[]>;
  /** Resumen del filtro (calculado en la base): líneas, neumáticos netos, totales S/ y US$, margen ponderado, clientes. */
  salesListSummary(filter: SalesListFilter): Promise<SalesListSummary>;
  /** Vista "Por cliente": una fila por RUC al que cuenta la línea (cliente final si lo hay), ordenada y paginada en la base. */
  salesListByClient(filter: SalesListFilter, opts: { sort: SalesClientSort; dir: "asc" | "desc"; limit: number; offset: number }): Promise<{ rows: SalesListClientRow[]; total: number }>;
  /** Marcas y vendedores distintos de las ventas (reales o demo), para los filtros; orden alfabético. */
  salesFilterOptions(demo: boolean): Promise<{ marcas: string[]; vendedores: string[] }>;
}

/**
 * Filtro de la pantalla general de ventas (/portal/ventas/lista). Todos los campos se combinan (y). Las líneas excluidas
 * (ventas anuladas) nunca salen.
 */
export interface SalesListFilter {
  /**
   * Texto libre: cada palabra tiene que aparecer (sin mayúsculas ni tildes) en la razón social, el RUC, el RUC o la razón
   * social del cliente final, el N° de documento (también sin ceros a la izquierda del correlativo), la descripción, la
   * marca, el diseño, la medida o el código del producto.
   */
  q?: string;
  /** Medida canónica (canonicalMedida). */
  medida?: string;
  /** Marca, sin distinguir mayúsculas. */
  marca?: string;
  tipoLinea?: SaleLineType;
  /** Vendedor tal como viene en la venta. */
  vendedor?: string;
  /** Fechas inclusive (AAAA-MM-DD). */
  desde?: IsoDate;
  hasta?: IsoDate;
  /** Solo líneas de estos RUC de documento (la pantalla pasa los de sales.leasingRucs para "solo leasing sin cliente final"). */
  docRucs?: string[];
  /** Solo líneas sin cliente final asignado. */
  sinClienteFinal?: boolean;
  /** true: solo las ventas demo; si no, solo las reales (nunca se mezclan). */
  demo?: boolean;
}

/**
 * Resumen de un filtro. Montos en soles (`total`, o precio × cantidad en las ventas sin total) y en dólares (`total_usd`
 * del reporte de Odoo): las notas de crédito restan porque vienen con signo.
 * Margen ponderado (en %, 2 decimales) = (Σ venta S/ − Σ costo S/) ÷ Σ venta S/ sobre las líneas con margen numérico en el
 * reporte y las notas de crédito (que revierten venta y costo, o solo venta si corrigen el monto). Equivale al margen de
 * cada línea ponderado por su venta en soles. Los servicios "SERVICIO SIN COSTO" no entran (darían 100 %). null si la
 * venta de esas líneas no es positiva.
 */
export interface SalesListSummary {
  lineas: number;
  neumaticos: number;
  totalPen: number;
  totalUsd: number;
  margenPct: number | null;
  clientes: number;
  notasCredito: number;
  /** Suma de las notas de crédito en soles (negativa). */
  notasCreditoPen: number;
}

export type SalesClientSort = "neumaticos" | "total" | "margen" | "ultima" | "cliente";

export interface SalesListClientRow {
  /** RUC al que cuentan las líneas (el del cliente final si se asignó). */
  ruc: string;
  /** Empresa del padrón con ese RUC (para enlazar su ficha), o null. */
  companyId: number | null;
  /** Razón social del padrón o, si no está, la mayor de sus documentos (sin las de leasing); null si no hay ninguna. */
  razonSocial: string | null;
  neumaticos: number;
  totalPen: number;
  totalUsd: number;
  margenPct: number | null;
  ultimaFecha: IsoDate;
  lineas: number;
}

export interface SalesQuery {
  /**
   * Líneas de estas empresas: RUC del documento o RUC del cliente final (una línea con cliente final sale en la ficha del
   * banco y en la de la empresa).
   */
  companyRucs?: string[];
  /** Solo por RUC del documento. */
  docRucs?: string[];
  documentos?: string[];
  /** Medida canónica (parseTyreSize().canonical). */
  medida?: string;
  tipoLinea?: SaleLineType[];
  /** Solo líneas sin cliente final. */
  sinClienteFinal?: boolean;
  /** Por defecto false: las líneas excluidas (ventas anuladas) no salen. */
  includeExcluded?: boolean;
  /** Por defecto false: las ventas demo no salen. */
  includeDemo?: boolean;
  /** Solo líneas con detalle de Odoo. */
  onlyDetailed?: boolean;
  limit?: number;
}

export interface SalesClientRow {
  ruc: string;
  razonSocial: string | null;
  docCliente: SaleClientDoc;
  /** Neumáticos netos (las notas de crédito ya restan). */
  neumaticos: number;
  lineas: number;
  ultimaFecha: IsoDate;
}

export interface SalesUploadInput {
  fileName: string;
  hash: string;
  formato: "odoo" | "simple";
  userId: number | null;
  userName: string | null;
  userRol: string | null;
  inserted: number;
  updated: number;
  /** Resumen de la vista previa (rango de fechas, líneas por tipo, ...), tal cual se mostró. */
  stats: Record<string, unknown>;
}

export interface SalesUpload extends SalesUploadInput {
  id: number;
  createdAt: Date;
}

// ── Usuarios y sesiones ──

export interface PortalUser {
  id: number;
  nombre: string;
  whatsapp: string | null;
  rol: UserRole;
  activo: boolean;
  createdAt: Date;
  /** Corrida J: correo para la invitación de calendario de las citas (null = sin correo; no se le envía). */
  email?: string | null;
  /** Corrida J: añadir a la cita los enlaces "Agregar a Outlook web" / "Agregar a Google Calendar" (apagado por defecto). */
  calendarLinks?: boolean;
}

export interface UserInput {
  nombre: string;
  /** Clave del upsert (solo dígitos). */
  whatsapp: string;
  rol: UserRole;
  activo?: boolean;
  /** Sin la clave (undefined) se conserva el que tenía; null lo borra. */
  email?: string | null;
  /** Sin la clave se conserva (por defecto false al crear). */
  calendarLinks?: boolean;
}

export interface LoginToken {
  tokenHash: string;
  userId: number;
  expiresAt: Date;
  /**
   * Hotfix login 2: con él se vuelve a armar el mismo enlace (token = HMAC(PORTAL_SESSION_SECRET, nonce)) para que `portal`
   * lo reenvíe en vez de crear otro. Los enlaces de antes no lo tienen.
   */
  nonce?: string | null;
}

/** El enlace vigente de un usuario que se puede reenviar (hotfix login 2). */
export interface CurrentLoginToken {
  tokenHash: string;
  nonce: string;
  expiresAt: Date;
}

export interface PortalSession {
  /** Hash del valor de la cookie. */
  id: string;
  userId: number;
  expiresAt: Date;
  createdAt: Date;
}

export interface UserRepo {
  upsertUser(input: UserInput): Promise<PortalUser>;
  getUser(id: number): Promise<PortalUser | null>;
  getUserByWhatsapp(whatsapp: string): Promise<PortalUser | null>;
  listUsers(): Promise<PortalUser[]>;
  saveLoginToken(token: LoginToken): Promise<void>;
  /**
   * Un solo uso: si el token existe, no venció y no se usó, lo marca usado y devuelve el userId; si no, null. Atómico.
   * (Primitiva de antes; desde el hotfix login 2 la entrada usa useLoginTokenIntoSession, reutilizable.)
   */
  consumeLoginToken(tokenHash: string, now: Date): Promise<number | null>;
  /** Hotfix login 2: el enlace más reciente del usuario, vigente y que se puede reenviar (con nonce); null si no hay. */
  currentLoginToken(userId: number, now: Date): Promise<CurrentLoginToken | null>;
  /** Hotfix login 2: alarga el vencimiento del enlace hasta `expiresAt` (nunca lo acorta). */
  extendLoginToken(tokenHash: string, expiresAt: Date): Promise<void>;
  /** Hotfix login 2: userId si el enlace existe y no venció (ni anulado); null si no. No lo gasta ni lo marca. */
  peekLoginToken(tokenHash: string, now: Date): Promise<number | null>;
  createSession(session: { id: string; userId: number; expiresAt: Date }): Promise<PortalSession>;
  /**
   * Entrada con el enlace: si existe y no venció (hotfix login 2: sirve las veces que haga falta hasta vencer; la primera
   * deja `used_at`), crea la sesión. En UNA operación confirmada antes de volver (Postgres: una transacción en una conexión
   * reservada). userId, o null si el enlace no existe, venció o fue anulado (entonces no hay sesión).
   */
  useLoginTokenIntoSession(tokenHash: string, now: Date, session: { id: string; expiresAt: Date }): Promise<number | null>;
  /** null si no existe o venció. */
  getSession(id: string, now: Date): Promise<PortalSession | null>;
  /** Hotfix login 2: alarga la sesión hasta `expiresAt` (con el uso; nunca la acorta). */
  renewSession(id: string, expiresAt: Date): Promise<void>;
  deleteSession(id: string): Promise<void>;
  /** Hotfix login 2 (`cerrar portal`): borra todas las sesiones del usuario y anula sus enlaces vigentes. Cuántos. */
  revokeUserAccess(userId: number, now: Date): Promise<{ sessions: number; links: number }>;
}

// ── CRM ──

export interface Contact {
  id: number;
  companyId: number;
  nombre: string;
  cargo: string | null;
  telefono: string | null;
  email: string | null;
  notas: string | null;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContactInput {
  companyId: number;
  nombre: string;
  cargo?: string | null;
  telefono?: string | null;
  email?: string | null;
  notas?: string | null;
  createdBy?: number | null;
}

export type ContactPatch = Partial<Pick<Contact, "nombre" | "cargo" | "telefono" | "email" | "notas">>;

export interface ContactRepo {
  addContact(input: ContactInput): Promise<Contact>;
  getContact(id: number): Promise<Contact | null>;
  listContacts(companyId: number): Promise<Contact[]>;
  updateContact(id: number, patch: ContactPatch): Promise<Contact | null>;
  deleteContact(id: number): Promise<boolean>;
}

export interface Opportunity {
  id: number;
  companyId: number;
  ownerUserId: number | null;
  etapa: StageId;
  probabilidad: number;
  montoEstimado: number | null;
  cierreEsperado: IsoDate | null;
  proximaAccion: string | null;
  proximaAccionAt: Date | null;
  quoteNumber: string | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

export interface OpportunityInput {
  companyId: number;
  ownerUserId?: number | null;
  /** Por defecto "prospecto". */
  etapa?: StageId;
  montoEstimado?: number | null;
  cierreEsperado?: IsoDate | null;
  proximaAccion?: string | null;
  proximaAccionAt?: Date | null;
  quoteNumber?: string | null;
  /** Quién la crea (queda en el primer registro del historial). */
  createdBy?: number | null;
  /** Momento de creación / entrada en la primera etapa; por defecto ahora. */
  at?: Date;
}

/** La etapa se cambia solo con moveStage (guarda historial). */
export type OpportunityPatch = Partial<Pick<Opportunity, "ownerUserId" | "montoEstimado" | "cierreEsperado" | "proximaAccion" | "proximaAccionAt" | "quoteNumber" | "probabilidad">>;

export interface OpportunityFilter {
  ownerId?: number;
  companyId?: number;
  etapas?: StageId[];
  /** true = solo abiertas (sin closed_at); false = solo cerradas. */
  open?: boolean;
}

export interface StageHistoryEntry {
  id: number;
  opportunityId: number;
  etapa: StageId;
  enteredAt: Date;
  leftAt: Date | null;
  changedBy: number | null;
}

export interface OpportunityRepo {
  createOpportunity(input: OpportunityInput): Promise<Opportunity>;
  getOpportunity(id: number): Promise<Opportunity | null>;
  /** La abierta más reciente de la empresa (del dueño indicado, si se pasa). */
  getOpenOpportunity(companyId: number, ownerId?: number): Promise<Opportunity | null>;
  /**
   * La abierta más reciente de la empresa o, si no hay, una nueva con `input` (corrida H): en una sola operación, así
   * dos asignaciones a la vez (doble toque, dos instancias) no dejan dos oportunidades abiertas.
   */
  openOrCreateOpportunity(input: OpportunityInput): Promise<{ opportunity: Opportunity; created: boolean }>;
  /** Más reciente (updated_at) primero. */
  listOpportunities(filter?: OpportunityFilter): Promise<Opportunity[]>;
  /**
   * Cambia de etapa: cierra la fila abierta del historial (left_at = at), abre otra (entered_at = at), fija la probabilidad
   * de la etapa y closed_at (en etapas cerradas; se limpia si se reabre). Misma etapa = sin cambios. null si no existe.
   */
  moveStage(opportunityId: number, etapa: StageId, userId: number | null, at?: Date): Promise<Opportunity | null>;
  updateOpportunity(id: number, patch: OpportunityPatch): Promise<Opportunity | null>;
  /** Más antigua primero. */
  stageHistory(opportunityId: number): Promise<StageHistoryEntry[]>;
  /** Historial de varias oportunidades en una consulta (tablero); por oportunidad y, dentro, la más antigua primero. */
  stageHistoryFor(opportunityIds: number[]): Promise<StageHistoryEntry[]>;
}

export type ActivityTipo = "visita" | "llamada" | "nota" | "cotizacion" | "oc" | "cita" | (string & {});
export type ActivityCanal = "whatsapp" | "portal" | "voz" | (string & {});

export interface Activity {
  id: number;
  companyId: number;
  opportunityId: number | null;
  userId: number | null;
  tipo: ActivityTipo;
  texto: string;
  canal: ActivityCanal | null;
  data: Record<string, unknown> | null;
  occurredAt: Date;
  createdAt: Date;
}

export interface ActivityInput {
  companyId: number;
  opportunityId?: number | null;
  userId?: number | null;
  tipo: ActivityTipo;
  texto?: string;
  canal?: ActivityCanal | null;
  data?: Record<string, unknown> | null;
  /** Por defecto ahora. */
  occurredAt?: Date;
}

export interface ActivityFilter {
  companyId?: number;
  userId?: number;
  opportunityId?: number;
  /** occurred_at >= since */
  since?: Date;
  /** occurred_at < until */
  until?: Date;
  limit?: number;
}

export interface ActivityRepo {
  addActivity(input: ActivityInput): Promise<Activity>;
  /** Más reciente (occurred_at) primero. */
  listActivities(filter?: ActivityFilter): Promise<Activity[]>;
}

export type AppointmentEstado = "programada" | "realizada" | "cancelada" | (string & {});

export interface Appointment {
  id: number;
  companyId: number;
  opportunityId: number | null;
  userId: number | null;
  startsAt: Date;
  lugar: string | null;
  conTecnico: boolean;
  notas: string | null;
  estado: AppointmentEstado;
  createdAt: Date;
}

export interface AppointmentInput {
  companyId: number;
  opportunityId?: number | null;
  userId?: number | null;
  startsAt: Date;
  lugar?: string | null;
  conTecnico?: boolean;
  notas?: string | null;
  estado?: AppointmentEstado;
}

export type AppointmentPatch = Partial<Pick<Appointment, "startsAt" | "lugar" | "conTecnico" | "notas" | "estado" | "opportunityId">>;

export interface AppointmentFilter {
  userId?: number;
  companyId?: number;
  /** starts_at >= from */
  from?: Date;
  /** starts_at < to */
  to?: Date;
  estado?: AppointmentEstado;
}

export interface AppointmentRepo {
  addAppointment(input: AppointmentInput): Promise<Appointment>;
  getAppointment(id: number): Promise<Appointment | null>;
  updateAppointment(id: number, patch: AppointmentPatch): Promise<Appointment | null>;
  /** La más próxima primero. */
  listAppointments(filter?: AppointmentFilter): Promise<Appointment[]>;
}

// ── Conversación del bot (fase B) ──

/**
 * Estado del portal en la conversación de WhatsApp de un usuario (paso pendiente: elegir empresa de una lista, confirmar
 * un reporte, preguntas del pedido...). Separado del estado del cotizador (`conversations`): el bot del portal lo
 * interpreta (src/lib/portal/bot/state.ts); el store solo lo guarda como JSON.
 */
export interface PortalConversation {
  /** Solo dígitos. */
  phone: string;
  state: Record<string, unknown>;
  updatedAt: Date;
}

export interface PortalConversationRepo {
  getPortalConversation(phone: string): Promise<PortalConversation | null>;
  /** null (o {}) borra el estado. */
  setPortalConversation(phone: string, state: Record<string, unknown> | null): Promise<void>;
}

// ── Vocabulario aprendido (fase B, voz) ──

/**
 * Término que el bot aprendió con `aprende X = Y`: `term` es como sale en la transcripción ("flama setenta y siete") y
 * `meaning` lo que significa ("Flama 77"). Único sin distinguir mayúsculas: volver a aprender el mismo término lo reemplaza.
 */
export interface VocabularyEntry {
  id: number;
  term: string;
  meaning: string;
  addedBy: number | null;
  createdAt: Date;
}

export interface VocabularyInput {
  term: string;
  meaning: string;
  addedBy?: number | null;
}

export interface VocabularyRepo {
  /** Más antiguo primero. */
  listVocabulary(): Promise<VocabularyEntry[]>;
  /** Inserta o, si el término ya existe (sin distinguir mayúsculas), actualiza su significado y quién lo añadió. */
  addVocabulary(input: VocabularyInput): Promise<VocabularyEntry>;
}

// ── Registro de transcripciones de voz (corrida F, punto 9: revisar los fallos del piloto con `npm run voice:review`) ──

/** Lo que el bot entendió de una nota de voz (para revisar desde consola; nunca en pantalla del portal). */
export interface VoiceUnderstood {
  /** Medidas canónicas que quedaron ("295/80R22.5"). */
  sizes: string[];
  quantities: number[];
  brand: string | null;
  design: string | null;
  customer: string | null;
  /** Lo que el bot tuvo que preguntar o no entendió ("medida «7 50 16»: 7.5R16 / 7.5-16", "sin medida"). */
  questions: string[];
  /** Lo corregido por parecido ("Fenix Way" -> Fenixway, "2 9 5 80 R 22.5" -> 295/80R22.5). */
  fixes: { from: string; to: string }[];
  /** El texto que se pasó al cotizador (si se llegó a armar). */
  text?: string | null;
}

/** ok = pasó al cotizador; pregunta = el bot preguntó (medida o cliente); fallo = no entendió la medida. */
export type VoiceOutcome = "ok" | "pregunta" | "fallo";

export interface VoiceTranscriptInput {
  phone: string;
  userId: number | null;
  /** cotizacion · medida (respuesta a "¿qué medida es?") · correccion · seguimiento (tras elegir cliente o medida). */
  context: string;
  transcript: string;
  understood: VoiceUnderstood;
  outcome: VoiceOutcome;
  createdAt?: Date;
}

export interface VoiceTranscript extends Required<Omit<VoiceTranscriptInput, "createdAt">> {
  id: number;
  createdAt: Date;
}

export interface VoiceTranscriptFilter {
  limit?: number;
  since?: Date;
  until?: Date;
  phone?: string;
  userId?: number;
  outcomes?: VoiceOutcome[];
}

export interface VoiceTranscriptRepo {
  logVoiceTranscript(input: VoiceTranscriptInput): Promise<void>;
  /** Más reciente primero. */
  listVoiceTranscripts(filter?: VoiceTranscriptFilter): Promise<VoiceTranscript[]>;
}

// ── Órdenes de compra y memoria del pedido por cliente (fase B, `oc`) ──

/**
 * Orden de compra que el vendedor recibió del cliente (`oc <empresa> [n°]`, con el PDF o la imagen adjunta o sin ella).
 * `data` = bytes en base64 (como quote_files). `status`: "recibida" al llegar; "pedido_generado" cuando el bot ya armó el
 * Excel para Patricia.
 */
export interface PurchaseOrder {
  id: number;
  companyId: number;
  opportunityId: number | null;
  userId: number | null;
  /** N° de OC del cliente ("4500123"). */
  numero: string | null;
  /** Cotización en la que se basa (número completo del cotizador). */
  quoteNumber: string | null;
  fileName: string | null;
  mimeType: string | null;
  data: string | null;
  status: string;
  createdAt: Date;
}

export interface PurchaseOrderInput {
  companyId: number;
  opportunityId?: number | null;
  userId?: number | null;
  numero?: string | null;
  quoteNumber?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  data?: string | null;
  /** Por defecto "recibida". */
  status?: string;
  /** Por defecto ahora. */
  createdAt?: Date;
}

/** Una OC en un listado: sin `data` (el PDF en base64 solo lo trae getPurchaseOrder). */
export type PurchaseOrderSummary = Omit<PurchaseOrder, "data">;

export type PurchaseOrderPatch = Partial<Pick<PurchaseOrder, "opportunityId" | "numero" | "quoteNumber" | "fileName" | "mimeType" | "data" | "status">>;

export interface PurchaseOrderFilter {
  companyId?: number;
  userId?: number;
  status?: string;
}

/**
 * Lo que el bot recuerda de un cliente para el pedido (direcciones, contacto, agencia y las últimas respuestas a las
 * preguntas). El store lo guarda como JSON; el bot lo interpreta (src/lib/portal/order/profile.ts).
 */
export interface CompanyOrderProfile {
  companyId: number;
  data: Record<string, unknown>;
  updatedAt: Date;
}

export interface PurchaseOrderRepo {
  addPurchaseOrder(input: PurchaseOrderInput): Promise<PurchaseOrder>;
  getPurchaseOrder(id: number): Promise<PurchaseOrder | null>;
  updatePurchaseOrder(id: number, patch: PurchaseOrderPatch): Promise<PurchaseOrder | null>;
  /** Más reciente primero. Sin `data` (el archivo): para eso, getPurchaseOrder. */
  listPurchaseOrders(filter?: PurchaseOrderFilter): Promise<PurchaseOrderSummary[]>;
  getOrderProfile(companyId: number): Promise<CompanyOrderProfile | null>;
  /** Reemplaza el perfil completo (quien llama mezcla con el anterior). */
  setOrderProfile(companyId: number, data: Record<string, unknown>): Promise<CompanyOrderProfile>;
}

// ── Crédito (fase C, bloque C4) ──

/** Estados de la evaluación crediticia; transiciones válidas en src/lib/portal/credit/states.ts. */
export type CreditEstado = "sin_evaluar" | "en_evaluacion" | "aprobado" | "observado" | "rechazado";

/**
 * Evaluación crediticia de una empresa (tabla company_credit, una fila por empresa). Sin fila = `sin_evaluar`.
 * Sin el PDF del reporte (base64): ese solo lo trae getCreditPdf; aquí van su nombre y tipo.
 */
export interface CompanyCredit {
  companyId: number;
  estado: CreditEstado;
  /** Calificación del reporte tal como la da la fuente ("A", "Normal", "CPP"...). */
  calificacion: string | null;
  /** Línea aprobada. */
  linea: number | null;
  /** "USD" | "PEN". */
  moneda: string | null;
  /** Plazo aprobado en días. */
  plazoDias: number | null;
  /** De dónde salió la evaluación ("manual", "Equifax (reporte en PDF)", ...). */
  fuente: string | null;
  consultadoAt: Date | null;
  consultadoPor: number | null;
  pdfName: string | null;
  pdfMime: string | null;
  notas: string | null;
  updatedAt: Date;
  updatedBy: number | null;
}

/** El PDF del reporte adjunto (data = bytes en base64). */
export interface CreditPdf {
  name: string;
  mime: string;
  data: string;
}

/**
 * Lo que se guarda: la evaluación completa (los campos ausentes quedan null). `pdf`: undefined = se conserva el adjunto,
 * null = se quita, objeto = se reemplaza.
 */
export interface CreditSaveInput {
  estado: CreditEstado;
  calificacion?: string | null;
  linea?: number | null;
  moneda?: string | null;
  plazoDias?: number | null;
  fuente?: string | null;
  consultadoAt?: Date | null;
  consultadoPor?: number | null;
  notas?: string | null;
  pdf?: CreditPdf | null;
}

/** Cambio de un campo en el historial: [antes, después] (fechas como texto ISO; el PDF por su nombre). */
export type CreditChanges = Record<string, [unknown, unknown]>;

export interface CreditHistoryEntry {
  id: number;
  companyId: number;
  /** null si la empresa no tenía fila (equivale a sin_evaluar). */
  estadoAnterior: CreditEstado | null;
  estadoNuevo: CreditEstado;
  cambios: CreditChanges;
  userId: number | null;
  createdAt: Date;
}

export interface CreditRepo {
  /** null si la empresa nunca se evaluó (= sin_evaluar). Sin el PDF. */
  getCredit(companyId: number): Promise<CompanyCredit | null>;
  getCreditPdf(companyId: number): Promise<CreditPdf | null>;
  /**
   * Guarda la evaluación y, en la misma operación (transacción en Postgres), una fila de historial con los campos que
   * cambiaron. Sin cambios = no escribe nada (`entry` null). No valida transiciones: eso lo hace src/lib/portal/credit.
   */
  saveCredit(companyId: number, input: CreditSaveInput, userId: number | null, at?: Date): Promise<{ credit: CompanyCredit; entry: CreditHistoryEntry | null }>;
  /** Más reciente primero. */
  creditHistory(companyId: number): Promise<CreditHistoryEntry[]>;
}

// ── Encuesta de satisfacción (fase C, bloque C3) ──

/** pendiente = creada, aún no entregada; enviada = correo enviado o enlace entregado al vendedor; vencida = pasó expires_at o falló el envío. */
export type SurveyEstado = "pendiente" | "enviada" | "respondida" | "vencida";
/** email = correo directo al contacto; whatsapp_vendedor = el vendedor reenvía el enlace; manual = botón de la ficha (copiar enlace). */
export type SurveyCanal = "email" | "whatsapp_vendedor" | "manual";

/** Encuesta: solo se guarda el sha256 del token del enlace (/encuesta/<token>); el token no se puede recuperar. */
export interface Survey {
  id: number;
  companyId: number;
  contactId: number | null;
  tokenHash: string;
  estado: SurveyEstado;
  canal: SurveyCanal;
  createdBy: number | null;
  enviadaAt: Date | null;
  respondidaAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface SurveyInput {
  companyId: number;
  contactId?: number | null;
  tokenHash: string;
  canal: SurveyCanal;
  createdBy?: number | null;
  expiresAt: Date;
  /** Por defecto ahora. */
  createdAt?: Date;
}

export interface SurveyAnswerInput {
  /** Recomendación 0–10. */
  nps: number;
  /** Ids de src/lib/portal/survey/questions.ts (hasta 3). */
  valora: string[];
  /** Satisfacción con la última entrega 1–5. */
  satisfaccionEntrega: number | null;
  mejorar: string | null;
  /** ¿Podemos citar su experiencia como referencia? */
  referencia: boolean | null;
}

export interface SurveyAnswer extends SurveyAnswerInput {
  id: number;
  surveyId: number;
  createdAt: Date;
}

/** Respuesta con los datos de su encuesta (ficha y tablero). */
export interface SurveyResponse extends SurveyAnswer {
  companyId: number;
  contactId: number | null;
  canal: SurveyCanal;
}

export interface SurveyFilter {
  companyId?: number;
  /** Solo empresas cuyo dueño actual es este usuario. */
  ownerUserId?: number;
  /** created_at >= since (encuestas) / created_at de la respuesta >= since (respuestas). */
  since?: Date;
  limit?: number;
}

export type SurveyAnswerResult = { ok: true; survey: Survey; answer: SurveyAnswer } | { ok: false; reason: "no_existe" | "respondida" | "vencida" };

export interface SurveyRepo {
  /**
   * Crea la encuesta (estado pendiente). Con `onlyIfNoneSince`, de forma atómica (bloqueo por empresa en Postgres) no crea
   * nada y devuelve null si la empresa ya tiene una encuesta desde esa fecha que cuente (ver `surveyCounts`).
   */
  createSurvey(input: SurveyInput, opts?: { onlyIfNoneSince?: Date }): Promise<Survey | null>;
  getSurvey(id: number): Promise<Survey | null>;
  getSurveyByTokenHash(tokenHash: string): Promise<Survey | null>;
  /** Más reciente primero. */
  listSurveys(filter?: SurveyFilter): Promise<Survey[]>;
  /** pendiente -> enviada (enviada_at = at, y canal si se pasa). null si no existe. */
  markSurveySent(id: number, at: Date, canal?: SurveyCanal): Promise<Survey | null>;
  /** pendiente/enviada -> vencida (no toca las respondidas). null si no existe. */
  expireSurvey(id: number): Promise<Survey | null>;
  /**
   * Una sola respuesta, atómica: solo si la encuesta está pendiente/enviada y no venció; guarda la respuesta y la marca
   * respondida en la misma operación (transacción en Postgres). Si no, dice por qué.
   */
  answerSurvey(surveyId: number, answer: SurveyAnswerInput, now: Date): Promise<SurveyAnswerResult>;
  /** Respuestas (más reciente primero) con su empresa. */
  listSurveyResponses(filter?: SurveyFilter): Promise<SurveyResponse[]>;
}

/**
 * Corrida E, punto 5: contadores del límite de intentos de las entradas públicas (src/lib/portal/auth/rate-limit.ts).
 * `bucket` ya viene hasheado (nunca una IP ni un token en claro).
 */
export interface RateLimitRepo {
  /** Suma 1 al contador de (bucket, ventana) de forma atómica y devuelve el total de esa ventana. */
  hitRateLimit(bucket: string, windowStart: Date): Promise<number>;
  /** Borra las ventanas que empezaron antes de `before` (limpieza del cron). Devuelve cuántas. */
  pruneRateLimitHits(before: Date): Promise<number>;
}

// ── Puntaje de atractivo (corrida G) ──

export type Nivel = "A" | "B" | "C";
export type ScoreFactorId = "potencial" | "encaje" | "espacio" | "familiaridad" | "cercania" | "antiguedad";

/**
 * Lo que se guarda en companies.score_detalle: el aporte de cada factor (valor 0–1 y puntos) con los datos que lo
 * explican, y los frenos. El texto para el vendedor se arma al mostrarlo (src/lib/portal/scoring/explain.ts).
 */
export interface ScoreDetail {
  v: 1;
  factores: ScoreFactor[];
  frenos: ScoreBrake[];
  /** Nivel por percentil, antes de los frenos. */
  nivelBase: Nivel | null;
}

export interface ScoreFactor {
  id: ScoreFactorId;
  /** 0–1. */
  valor: number;
  /** Aporte al puntaje (valor × peso, reescalado a 100). */
  puntos: number;
  /** Puntos máximos del factor. */
  max: number;
  /** true = faltaba el dato: vale 0 y la explicación lo dice. */
  sinDato: boolean;
  /** Datos para explicarlo (números de la empresa, no del modelo). */
  dato: Record<string, string | number | boolean | null>;
}

export type ScoreBrake = { id: "credito"; estado: string } | { id: "perdida"; dias: number };

/** Lo que el cálculo necesita de cada empresa (una consulta por tabla para todas, o para las indicadas). */
export interface ScoreInput {
  companyId: number;
  ruc: string;
  unidades: number;
  llantasPiso: number;
  sector: Sector | null;
  departamento: string | null;
  antiguedadMedia: number | null;
  /** Marcada como cliente en el portal (p. ej. al registrar una OC). */
  esClienteMarcado: boolean;
  /** Unidades por medida probable (sin las que no tienen medida inferida). */
  medidas: Record<string, number>;
  /** Unidades por marca de vehículo preferida (marca normalizada). */
  marcasPreferidas: Record<string, number>;
  /** Neumáticos vendidos (ventas reales, sin demo) desde `since12m`. */
  vendidos12m: number;
  /** Tiene alguna venta real (no demo), de cualquier fecha. */
  ventasReales: boolean;
  /** Tiene ventas demo (y ninguna real: se trata como prospecto). */
  ventasDemo: boolean;
  credito: CreditEstado | null;
  /** Cierre de la oportunidad perdida más reciente desde `lostSince` (null si ninguna). */
  perdidaAt: Date | null;
}

export interface ScoreInputQuery {
  /** Solo estas empresas (recálculo puntual); sin esto, todas. */
  companyIds?: number[];
  /** Marcas preferidas (normalizadas con normMarca). */
  marcas: string[];
  since12m: IsoDate;
  lostSince: Date;
}

export interface ScoreUpdate {
  companyId: number;
  score: number;
  nivel: Nivel;
  detalle: ScoreDetail;
}

export interface ScoreRun {
  id: number;
  runAt: Date;
  empresas: number;
  /** Puntaje mínimo para A y para B en ese cálculo (los usa el recálculo de una sola empresa). */
  cutA: number | null;
  cutB: number | null;
  conteo: Record<Nivel, number>;
  duracionMs: number | null;
}

export type ScoreRunInput = Omit<ScoreRun, "id" | "runAt"> & { runAt?: Date };

/** Empresa de "tus mejores flotas" (Hoy y el bot). */
export interface BestCompany extends Company {
  /** true = ya es del usuario (sin actividad reciente); false = sin dueño. */
  propia: boolean;
}

export interface BestCompaniesQuery {
  userId: number;
  /** Las propias entran si nadie registró actividad con ellas desde esta fecha. */
  activeSince: Date;
  limit: number;
  offset?: number;
}

export type ValidationAnswer = Nivel | "desconocida";

export interface RankingValidation {
  id: number;
  userId: number;
  companyId: number;
  nivelVendedor: ValidationAnswer;
  nota: string | null;
  /** Nivel y puntaje del sistema cuando el vendedor respondió. */
  nivelSistema: Nivel | null;
  scoreSistema: number | null;
  createdAt: Date;
}

export type RankingValidationInput = Omit<RankingValidation, "id" | "createdAt"> & { createdAt?: Date };

export interface ScoringRepo {
  scoringInputs(q: ScoreInputQuery): Promise<ScoreInput[]>;
  /** Guarda puntaje, nivel y detalle (por lotes en Postgres). Devuelve cuántas empresas actualizó. */
  saveScores(rows: ScoreUpdate[], at: Date): Promise<number>;
  saveScoreRun(run: ScoreRunInput): Promise<ScoreRun>;
  latestScoreRun(): Promise<ScoreRun | null>;
  /** Con puntaje, sin dueño o del usuario sin actividad reciente; de mayor a menor puntaje. Nunca las de otro vendedor. */
  bestCompanies(q: BestCompaniesQuery): Promise<{ rows: BestCompany[]; total: number }>;
  addRankingValidations(rows: RankingValidationInput[]): Promise<RankingValidation[]>;
  /** Más reciente primero. */
  listRankingValidations(filter?: { userId?: number; since?: Date }): Promise<RankingValidation[]>;
  /** Marca el aviso como dado: true si es la primera vez (atómico), false si ya se había dado. */
  markUserNotice(userId: number, aviso: string): Promise<boolean>;
}

// ── Match Venta (corrida K) ──

/** Cambios de la marca de prioridad (y de la aplicación) de un producto del stock propio; quedan en match_priority_log. */
export type MatchPriorityAction = "activar" | "quitar" | "sin_stock" | "aplicacion" | "sembrada";

/**
 * Producto del stock propio en Match Venta, ligado al CÓDIGO de Odoo ("P0433"): sobrevive a una carga nueva de stock.
 * `prioridad`: el vendedor lo quiere vender ya. `sinStockAt`: la prioridad se apagó sola al llegar el disponible a 0.
 */
export interface MatchProduct {
  code: string;
  /** "Delantera regional", "Tracción bloque on/off road"… (editable). */
  aplicacion: string | null;
  prioridad: boolean;
  prioridadAt: Date | null;
  prioridadBy: number | null;
  sinStockAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MatchProductSeed {
  code: string;
  aplicacion: string | null;
  prioridad: boolean;
}

export interface MatchPriorityLogEntry {
  id: number;
  code: string;
  accion: MatchPriorityAction;
  userId: number | null;
  detalle: string | null;
  createdAt: Date;
}

export interface MatchPriorityInput {
  userId: number | null;
  accion: MatchPriorityAction;
  detalle?: string | null;
  at?: Date;
  /** Solo si la prioridad sigue prendida (apagado automático: un solo aviso aunque dos procesos lo intenten). */
  onlyIfOn?: boolean;
}

/** Flota de una empresa en una medida probable: unidades, llantas conocidas y vehículos sin N_LLANTAS por número de ejes. */
export interface MatchFleetSize {
  unidades: number;
  llantas: number;
  /** ejes ("2", "3"; "?" sin ejes) -> vehículos sin llantas en el padrón (se estiman con match.llantasPorEjes). */
  sinLlantas: Record<string, number>;
}

/** Lo que el cruce necesita de cada empresa (una consulta por tabla, todas las empresas). */
export interface MatchCompanyInput {
  companyId: number;
  ruc: string;
  razonSocial: string;
  sector: Sector | null;
  departamento: string | null;
  provincia: string | null;
  distrito: string | null;
  unidades: number;
  ownerUserId: number | null;
  esCliente: boolean;
  credito: CreditEstado | null;
  /** Medida probable -> flota en esa medida. */
  medidas: Record<string, MatchFleetSize>;
  /** Clase de vehículo -> unidades. */
  clases: Record<string, number>;
}

export type MatchTipo = "directo" | "migracion" | "solo_ventas";
export type MatchExclusion = "estado" | "leasing";

/** "Ya te compró esta medida": dato real (ventas de Odoo), nunca mezclado con la estimación. */
export interface MatchPurchase {
  /** Neumáticos netos de la medida. */
  cantidad: number;
  ultimaFecha: IsoDate;
  /** Cantidad de la última compra (todas las líneas de esa fecha). */
  ultimaCantidad: number;
  /** Precio unitario de la última compra (sin IGV) y su moneda. */
  precioUnitario: number | null;
  moneda: "USD" | "PEN" | null;
  /** Margen ponderado de las compras de la medida (%). */
  margenPct: number | null;
  facturas: number;
  /** Alguna línea fue de este mismo código de producto. */
  mismoProducto: boolean;
  /** Días promedio entre compras (con 2 o más fechas). */
  ritmoDias: number | null;
  /** "le tocaría reponer" según su ritmo (o sin ritmo, pasado match.reposicionDias). */
  reponer: boolean;
}

/** Cómo salió el porcentaje (se guarda con el resultado; de aquí sale el desglose). */
export interface MatchDetail {
  /** Factores 0–1. */
  encaje: number;
  volumen: number;
  historial: number;
  /** Puntos de cada factor y de la aplicación (sumados y redondeados dan el porcentaje). */
  puntos: { encaje: number; volumen: number; historial: number; aplicacion: number };
  /** El desglose en una línea ("92% de su flota usa 12R22.5 · 368 llantas en piso · aún no es cliente"). */
  desglose: string;
  /** Migración: medida de la flota desde la que migraría y la etiqueta para el vendedor. */
  migracionDesde?: string;
  etiquetaMigracion?: string;
  /** Por qué la aplicación la sube ("buses y carga en carretera"). */
  aplicacion?: string;
  compra?: MatchPurchase;
  /** Solo ventas: llantas compradas a un banco de leasing sin cliente final asignado. */
  bancoSinClienteFinal?: boolean;
}

export interface MatchResultInput {
  productCode: string;
  medida: string;
  /** null: compró la medida pero no está en el padrón (bloque "Clientes que ya compraron esta medida"). */
  companyId: number | null;
  ruc: string;
  razonSocial: string;
  tipo: MatchTipo;
  /** null en solo_ventas (sin flota no hay porcentaje). */
  pct: number | null;
  llantasMedida: number;
  unidadesMedida: number;
  podriaLlevar: number | null;
  yaCompro: boolean;
  excluida: MatchExclusion | null;
  detalle: MatchDetail;
}

export interface MatchResult extends MatchResultInput {
  id: number;
}

/** Resultado con los datos vivos de la empresa (dueño, crédito, ubicación, última actividad) para mostrarlo. */
export interface MatchResultView extends MatchResult, MatchCompanyLive {}

/** Lo mismo sin el detalle (listas largas: filtros, conteos y orden; el detalle se pide solo para la página). */
export type MatchResultSummary = Omit<MatchResult, "detalle"> & MatchCompanyLive;

export interface MatchCompanyLive {
  ownerUserId: number | null;
  esCliente: boolean;
  credito: CreditEstado | null;
  sector: Sector | null;
  departamento: string | null;
  provincia: string | null;
  distrito: string | null;
  direccion: string | null;
  unidades: number;
  lastActivityAt: Date | null;
}

export interface MatchResultQuery {
  productCodes?: string[];
  companyIds?: number[];
  tipos?: MatchTipo[];
  ids?: number[];
  /** Solo pct >= minPct, las que ya compraron y las de solo ventas. */
  minPct?: number;
}

export interface MatchRunInput {
  motivo: string;
  productos: number;
  empresas: number;
  filas: number;
  duracionMs: number;
  /** Foto del stock de los productos y notas por producto (lo lee la vista sin ir a la tabla de precios). */
  data: Record<string, unknown>;
  runAt?: Date;
}

export interface MatchRun extends Omit<MatchRunInput, "runAt"> {
  id: number;
  runAt: Date;
}

/** Visita agendada desde Match Venta: ligada a la cita y al producto que la originó, con su motivo. */
export interface MatchVisit {
  id: number;
  appointmentId: number;
  companyId: number;
  userId: number | null;
  productCode: string;
  /** "ofrecer 295/80R22.5 Flama 66: ya te compró 40 en marzo" */
  motivo: string | null;
  /** La actividad (visita) con la que el vendedor la reportó; null mientras no se reporta. */
  activityId: number | null;
  reportedAt: Date | null;
  createdAt: Date;
}

export interface MatchVisitInput {
  appointmentId: number;
  companyId: number;
  userId: number | null;
  productCode: string;
  motivo: string | null;
}

export interface MatchVisitFilter {
  userId?: number;
  companyId?: number;
  productCode?: string;
  appointmentIds?: number[];
  /** true = solo sin reportar. */
  pending?: boolean;
}

export interface MatchRepo {
  /** Empresas con su flota por medida probable y por clase, dueño, cliente y crédito. */
  matchInputs(): Promise<MatchCompanyInput[]>;
  listMatchProducts(): Promise<MatchProduct[]>;
  /** Agrega los códigos que no existen (idempotente: no toca los que ya están). Devuelve los agregados. */
  seedMatchProducts(seeds: MatchProductSeed[], at?: Date): Promise<string[]>;
  /** Prende / apaga la prioridad (crea el producto si no existe) y deja el registro. null si `onlyIfOn` y ya estaba apagada. */
  setMatchPriority(code: string, on: boolean, input: MatchPriorityInput): Promise<MatchProduct | null>;
  setMatchApplication(code: string, aplicacion: string | null, userId: number | null, at?: Date): Promise<MatchProduct>;
  /** Más reciente primero. */
  matchPriorityLog(code?: string): Promise<MatchPriorityLogEntry[]>;
  /** Guarda un cálculo completo: reemplaza todos los resultados (atómico) y registra la corrida. */
  saveMatchRun(run: MatchRunInput, rows: MatchResultInput[]): Promise<MatchRun>;
  latestMatchRun(): Promise<MatchRun | null>;
  listMatchResults(q?: MatchResultQuery): Promise<MatchResultView[]>;
  /** Como listMatchResults sin el detalle (rápido para miles de filas). */
  listMatchSummaries(q?: MatchResultQuery): Promise<MatchResultSummary[]>;
  addMatchVisit(input: MatchVisitInput): Promise<MatchVisit>;
  listMatchVisits(filter?: MatchVisitFilter): Promise<MatchVisit[]>;
  /** La visita quedó reportada con esa actividad (solo la primera vez). */
  markMatchVisitReported(id: number, activityId: number, at?: Date): Promise<MatchVisit | null>;
}

export interface PortalStore extends ScoringRepo, CompanyRepo, FleetRepo, SalesRepo, UserRepo, ContactRepo, OpportunityRepo, ActivityRepo, AppointmentRepo, PortalConversationRepo, VocabularyRepo, VoiceTranscriptRepo, PurchaseOrderRepo, CreditRepo, SurveyRepo, RateLimitRepo, MatchRepo {
  /** Escribe lo pendiente (JSON); no-op en Postgres. Los CLI la llaman antes de salir. */
  flush(): Promise<void>;
  close(): Promise<void>;
}
