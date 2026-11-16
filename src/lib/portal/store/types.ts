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
export type FleetOrigen = "carga" | "pasajeros";
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
  createdAt: Date;
  updatedAt: Date;
}

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
}

export type CompanyPatch = Partial<Pick<Company, "razonSocial" | "sector" | "departamento" | "unidades" | "llantasPiso" | "antiguedadMedia" | "esCliente" | "ownerUserId" | "temperatura" | "score" | "creditTermsDays">>;

export interface UpsertCompaniesResult {
  inserted: number;
  updated: number;
  /** RUC -> id, para enlazar la flota en el mismo import. */
  ids: Record<string, number>;
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
  upsertCompanies(batch: CompanyInput[]): Promise<UpsertCompaniesResult>;
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
   */
  pruneFleet(companyIds: number[], keep: FleetKey[]): Promise<number>;
  listFleet(companyId: number): Promise<FleetVehicle[]>;
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
}

// ── Usuarios y sesiones ──

export interface PortalUser {
  id: number;
  nombre: string;
  whatsapp: string | null;
  rol: UserRole;
  activo: boolean;
  createdAt: Date;
}

export interface UserInput {
  nombre: string;
  /** Clave del upsert (solo dígitos). */
  whatsapp: string;
  rol: UserRole;
  activo?: boolean;
}

export interface LoginToken {
  tokenHash: string;
  userId: number;
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
  /** Un solo uso: si el token existe, no venció y no se usó, lo marca usado y devuelve el userId; si no, null. Atómico. */
  consumeLoginToken(tokenHash: string, now: Date): Promise<number | null>;
  createSession(session: { id: string; userId: number; expiresAt: Date }): Promise<PortalSession>;
  /** null si no existe o venció. */
  getSession(id: string, now: Date): Promise<PortalSession | null>;
  deleteSession(id: string): Promise<void>;
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

export interface PortalStore extends ScoringRepo, CompanyRepo, FleetRepo, SalesRepo, UserRepo, ContactRepo, OpportunityRepo, ActivityRepo, AppointmentRepo, PortalConversationRepo, VocabularyRepo, VoiceTranscriptRepo, PurchaseOrderRepo, CreditRepo, SurveyRepo, RateLimitRepo {
  /** Escribe lo pendiente (JSON); no-op en Postgres. Los CLI la llaman antes de salir. */
  flush(): Promise<void>;
  close(): Promise<void>;
}
