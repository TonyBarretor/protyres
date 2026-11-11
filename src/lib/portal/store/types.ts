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
  score: number | null;
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

export type CompanyOrder = "unidades" | "llantas" | "participacion";

export interface CompanySearch {
  /** Texto libre: parte de la razón social (sin tildes ni mayúsculas) o inicio del RUC. */
  q?: string;
  departamento?: string[];
  sector?: Sector[];
  minUnits?: number;
  maxUnits?: number;
  /** Marcas de vehículo (cualquiera de ellas; sin distinguir mayúsculas). */
  marcas?: string[];
  esCliente?: boolean;
  ownerUserId?: number;
  orderBy?: CompanyOrder;
  /** 1 en adelante. */
  page?: number;
  pageSize?: number;
  /** Inicio de la ventana de participación; por defecto 12 meses antes de `now`. */
  since?: Date | IsoDate;
  now?: Date;
}

export interface CompanyRow extends Company {
  /** Neumáticos vendidos a la empresa en la ventana (suma de `sales.cantidad`). */
  participacion: number;
  /** true si alguna venta demo entra en la cifra (la UI muestra "DEMO"). */
  participacionDemo: boolean;
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
  /** userId null = liberar la empresa. */
  setOwner(companyId: number, userId: number | null): Promise<Company | null>;
  searchCompanies(opts?: CompanySearch): Promise<CompanySearchResult>;
  /** Marcas de vehículo con conteo, de más a menos vehículos. */
  listMarcas(): Promise<MarcaCount[]>;
  listDepartamentos(): Promise<DepartamentoCount[]>;
  countCompanies(): Promise<number>;
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

export interface PortalStore extends CompanyRepo, FleetRepo, SalesRepo, UserRepo, ContactRepo, OpportunityRepo, ActivityRepo, AppointmentRepo, PortalConversationRepo {
  /** Escribe lo pendiente (JSON); no-op en Postgres. Los CLI la llaman antes de salir. */
  flush(): Promise<void>;
  close(): Promise<void>;
}
