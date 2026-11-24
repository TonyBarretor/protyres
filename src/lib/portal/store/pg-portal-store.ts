/**
 * PortalStore en Postgres (Supabase) con la lib `postgres`. Tablas: `npm run db:migrate`.
 * El import masivo usa inserciones por lotes (`sql(rows, cols)`) con `on conflict`.
 */
import postgres from "postgres";
import { serverlessPostgres } from "../../store/pg-options";
import { isClosedStage, stageProbability, type StageId } from "../stages";
import {
  dedupeBy,
  defaultSince,
  digits,
  docClienteOf,
  fromTenThousandths,
  groupFleet,
  matchCode,
  normDocumento,
  normEmail,
  normMarca,
  pageOf,
  SALES_FOLD_FROM,
  SALES_FOLD_TO,
  salesSearchWords,
  searchRucPrefix,
  searchTerms,
  toIsoDate,
  topMedidas,
  toTenThousandths,
  ttlCache,
  weightedMarginPct,
  type FleetAggRow,
} from "./shared";
import type { SaleClientDoc, SaleDetail, SaleDocType, SaleLineType, SalesClientRow, SalesClientSort, SalesListClientRow, SalesListFilter, SalesListSummary, SalesQuery, SalesUpload, SalesUploadInput, ServiceType } from "./types";
import type { DistritoCount, PortalRuc, SunatAlertMatch, SunatBrief, SunatLocal, SunatLocalInput, SunatPiezasRecord, SunatRecord, SunatRecordInput } from "./types";
import { distritoCounts } from "./shared";
import { foldPlace, lookupUbigeo } from "../sunat/ubigeo";
import type { BestCompaniesQuery, BestCompany, Nivel, RankingValidation, RankingValidationInput, ScoreDetail, ScoreInput, ScoreInputQuery, ScoreRun, ScoreRunInput, ScoreUpdate, ValidationAnswer } from "./types";
import type {
  MatchCompanyInput,
  MatchDetail,
  MatchExclusion,
  MatchFleetSize,
  MatchPriorityAction,
  MatchPriorityInput,
  MatchPriorityLogEntry,
  MatchProduct,
  MatchProductSeed,
  MatchResultInput,
  MatchResultQuery,
  MatchResultSummary,
  MatchResultView,
  MatchRun,
  MatchRunInput,
  MatchTipo,
  MatchVisit,
  MatchVisitFilter,
  MatchVisitInput,
} from "./types";
import type {
  Activity,
  ActivityFilter,
  ActivityInput,
  Appointment,
  AppointmentFilter,
  AppointmentInput,
  AppointmentPatch,
  Company,
  CompanyInput,
  CompanyOrigen,
  CompanyOriginCounts,
  CompanyOrderProfile,
  CompanyPatch,
  CompanyRow,
  CompanySearch,
  CompanySearchResult,
  Confianza,
  Contact,
  ContactInput,
  ContactPatch,
  DepartamentoCount,
  FleetGroup,
  FleetKey,
  FleetOrigen,
  FleetVehicle,
  FleetVehicleInput,
  IsoDate,
  ManualCompanyInput,
  ManualVehicleInput,
  ManualVehicleResult,
  CurrentLoginToken,
  LoginToken,
  MarcaCount,
  Opportunity,
  OpportunityFilter,
  OpportunityInput,
  OpportunityPatch,
  Participation,
  PortalConversation,
  PortalSession,
  PortalStore,
  PortalUser,
  PurchaseOrder,
  PurchaseOrderFilter,
  PurchaseOrderInput,
  PurchaseOrderPatch,
  PurchaseOrderSummary,
  Sale,
  SalesAggRow,
  SaleInput,
  Sector,
  StageHistoryEntry,
  Temperatura,
  UpsertCompaniesResult,
  UserInput,
  UserRole,
  VocabularyEntry,
  VocabularyInput,
  VoiceOutcome,
  VoiceTranscript,
  VoiceTranscriptFilter,
  VoiceTranscriptInput,
  VoiceUnderstood,
} from "./types";

import { resolveCreditSave } from "../credit/changes";
import type { CompanyCredit, CreditChanges, CreditEstado, CreditHistoryEntry, CreditPdf, CreditSaveInput } from "./types";

import { ORPHAN_PENDING_MS, valoraList } from "./survey-shared";
import type { Survey, SurveyAnswer, SurveyAnswerInput, SurveyAnswerResult, SurveyCanal, SurveyEstado, SurveyFilter, SurveyInput, SurveyResponse } from "./types";

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;
type Fragment = postgres.PendingQuery<postgres.Row[]>;

const BATCH = 1000;
/** Ver listMarcas / listDepartamentos. */
const LIST_CACHE_MS = 10 * 60_000;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const date = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));
const normPlaca = (p: string) => p.trim().toUpperCase().replace(/\s+/g, "");

/** jsonb: la librería ya lo entrega como objeto; por si llega como texto. */
function jsonOf<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

function toCompany(r: Row): Company {
  return {
    id: Number(r.id),
    ruc: String(r.ruc),
    razonSocial: String(r.razon_social ?? ""),
    sector: (r.sector as Sector | null) ?? null,
    departamento: str(r.departamento),
    unidades: Number(r.unidades ?? 0),
    llantasPiso: Number(r.llantas_piso ?? 0),
    antiguedadMedia: num(r.antiguedad_media),
    esCliente: Boolean(r.es_cliente),
    ownerUserId: num(r.owner_user_id),
    temperatura: (r.temperatura as Temperatura | null) ?? null,
    score: num(r.score),
    nivel: (r.nivel as Nivel | null) ?? null,
    scoreDetalle: jsonOf<ScoreDetail>(r.score_detalle),
    scoreAt: date(r.score_at),
    creditTermsDays: num(r.credit_terms_days),
    origen: ((r.origen as CompanyOrigen | null) ?? "mtc") as CompanyOrigen,
    createdBy: num(r.created_by),
    provincia: str(r.provincia),
    distrito: str(r.distrito),
    direccion: str(r.direccion),
    createdAt: date(r.created_at)!,
    updatedAt: date(r.updated_at)!,
  };
}

const SCORE_BATCH = 1000;
/** Filas de match_results por sentencia (unnest de 14 arreglos). */
const MATCH_BATCH = 5000;

function toScoreRun(r: Row): ScoreRun {
  const conteo = jsonOf<Record<Nivel, number>>(r.conteo) ?? { A: 0, B: 0, C: 0 };
  return { id: Number(r.id), runAt: date(r.run_at)!, empresas: Number(r.empresas), cutA: num(r.cut_a), cutB: num(r.cut_b), conteo, duracionMs: num(r.duracion_ms) };
}

function toValidation(r: Row): RankingValidation {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    companyId: Number(r.company_id),
    nivelVendedor: String(r.nivel_vendedor) as ValidationAnswer,
    nota: str(r.nota),
    nivelSistema: (r.nivel_sistema as Nivel | null) ?? null,
    scoreSistema: num(r.score_sistema),
    createdAt: date(r.created_at)!,
  };
}

function toVehicle(r: Row): FleetVehicle {
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    placa: String(r.placa),
    marca: str(r.marca),
    clase: str(r.clase),
    anio: num(r.anio),
    ejes: num(r.ejes),
    llantas: num(r.llantas),
    llantasFuente: str(r.llantas_fuente),
    pesoBruto: num(r.peso_bruto),
    chasis: str(r.chasis),
    departamento: str(r.departamento),
    origen: r.origen as FleetOrigen,
    medidaProbable: str(r.medida_probable),
    confianza: (r.confianza as Confianza | null) ?? null,
  };
}

function toSale(r: Row): Sale {
  return {
    id: Number(r.id),
    fecha: String(r.fecha),
    ruc: String(r.ruc),
    razonSocial: str(r.razon_social),
    medida: str(r.medida),
    marca: str(r.marca),
    diseno: str(r.diseno),
    cantidad: Number(r.cantidad ?? 0),
    precioUnitario: num(r.precio_unitario),
    total: num(r.total),
    vendedor: str(r.vendedor),
    origen: str(r.origen),
    isDemo: Boolean(r.is_demo),
    sourceRef: str(r.source_ref),
    createdAt: date(r.created_at)!,
    detalle: r.line_key ? toSaleDetail(r) : null,
  };
}

function toSaleDetail(r: Row): SaleDetail {
  return {
    lineKey: String(r.line_key),
    tipoDoc: (str(r.tipo_doc) ?? "otro") as SaleDocType,
    documento: String(r.documento ?? ""),
    vencimiento: r.vencimiento ? String(r.vencimiento).slice(0, 10) : null,
    moneda: str(r.moneda),
    tipoCambio: num(r.tipo_cambio),
    estadoSunat: str(r.estado_sunat),
    status: str(r.status),
    ocOdoo: str(r.oc_odoo),
    ocProveedor: str(r.oc_proveedor),
    guia: str(r.guia),
    condVenta: str(r.cond_venta),
    descripcion: String(r.descripcion ?? ""),
    codigoProducto: str(r.codigo_producto),
    tipoLinea: (str(r.tipo_linea) ?? "neumatico") as SaleLineType,
    tipoServicio: (str(r.tipo_servicio) as ServiceType | null) ?? null,
    docCliente: (str(r.doc_cliente) ?? "ruc") as SaleClientDoc,
    vendedorUserId: num(r.vendedor_user_id),
    totalSinServ: num(r.total_sin_serv),
    precioUnitarioUsd: num(r.precio_unitario_usd),
    totalUsd: num(r.total_usd),
    costoUnitario: num(r.costo_unitario),
    costoTotal: num(r.costo_total),
    costoUnitarioUsd: num(r.costo_unitario_usd),
    costoTotalUsd: num(r.costo_total_usd),
    facturaProveedor: str(r.factura_proveedor),
    proveedor: str(r.proveedor),
    monedaProveedor: str(r.moneda_proveedor),
    tipoCambioProveedor: num(r.tipo_cambio_proveedor),
    margen: str(r.margen),
    margenPct: num(r.margen_pct),
    cuentaUnidades: Boolean(r.cuenta_unidades),
    excluida: Boolean(r.excluida),
    motivoExclusion: str(r.motivo_exclusion),
    montoCalculado: Boolean(r.monto_calculado),
    totalOriginal: num(r.total_original),
    precioUnitarioOriginal: num(r.precio_unitario_original),
    advertencia: str(r.advertencia),
    uploadId: num(r.upload_id),
    clienteFinalCompanyId: num(r.cliente_final_company_id),
    clienteFinalRuc: str(r.cliente_final_ruc),
    clienteFinalAt: date(r.cliente_final_at),
    clienteFinalBy: num(r.cliente_final_by),
    updatedAt: date(r.updated_at),
  };
}

function toSalesUpload(r: Row): SalesUpload {
  return {
    id: Number(r.id),
    fileName: String(r.file_name),
    hash: String(r.hash),
    formato: r.formato === "simple" ? "simple" : "odoo",
    userId: num(r.user_id),
    userName: str(r.user_name),
    userRol: str(r.user_rol),
    inserted: Number(r.inserted ?? 0),
    updated: Number(r.updated ?? 0),
    stats: (typeof r.stats === "string" ? JSON.parse(r.stats) : (r.stats ?? {})) as Record<string, unknown>,
    createdAt: date(r.created_at)!,
  };
}

/** Columnas de sales para una línea (insertSales / upsertSaleLines); sin las del cliente final. */
function saleRow(r: SaleInput): Record<string, unknown> {
  const d = r.detalle;
  return {
    fecha: toIsoDate(r.fecha),
    ruc: digits(r.ruc),
    razon_social: r.razonSocial ?? null,
    medida: r.medida ?? null,
    marca: r.marca ?? null,
    diseno: r.diseno ?? null,
    cantidad: r.cantidad,
    precio_unitario: r.precioUnitario ?? null,
    total: r.total ?? null,
    vendedor: r.vendedor ?? null,
    origen: r.origen ?? null,
    is_demo: r.isDemo ?? false,
    source_ref: r.sourceRef ?? null,
    line_key: d?.lineKey ?? null,
    tipo_doc: d?.tipoDoc ?? null,
    documento: d?.documento ?? null,
    vencimiento: d?.vencimiento ?? null,
    moneda: d?.moneda ?? null,
    tipo_cambio: d?.tipoCambio ?? null,
    estado_sunat: d?.estadoSunat ?? null,
    status: d?.status ?? null,
    oc_odoo: d?.ocOdoo ?? null,
    oc_proveedor: d?.ocProveedor ?? null,
    guia: d?.guia ?? null,
    cond_venta: d?.condVenta ?? null,
    descripcion: d?.descripcion ?? null,
    codigo_producto: d?.codigoProducto ?? null,
    tipo_linea: d?.tipoLinea ?? null,
    tipo_servicio: d?.tipoServicio ?? null,
    doc_cliente: d?.docCliente ?? null,
    vendedor_user_id: d?.vendedorUserId ?? null,
    total_sin_serv: d?.totalSinServ ?? null,
    precio_unitario_usd: d?.precioUnitarioUsd ?? null,
    total_usd: d?.totalUsd ?? null,
    costo_unitario: d?.costoUnitario ?? null,
    costo_total: d?.costoTotal ?? null,
    costo_unitario_usd: d?.costoUnitarioUsd ?? null,
    costo_total_usd: d?.costoTotalUsd ?? null,
    factura_proveedor: d?.facturaProveedor ?? null,
    proveedor: d?.proveedor ?? null,
    moneda_proveedor: d?.monedaProveedor ?? null,
    tipo_cambio_proveedor: d?.tipoCambioProveedor ?? null,
    margen: d?.margen ?? null,
    margen_pct: d?.margenPct ?? null,
    cuenta_unidades: d ? d.cuentaUnidades : true,
    excluida: d ? d.excluida : false,
    motivo_exclusion: d?.motivoExclusion ?? null,
    monto_calculado: d?.montoCalculado ?? false,
    total_original: d?.totalOriginal ?? null,
    precio_unitario_original: d?.precioUnitarioOriginal ?? null,
    advertencia: d?.advertencia ?? null,
    upload_id: d?.uploadId ?? null,
  };
}

/**
 * N° de documento comparable en SQL, igual que normDocumento (shared.ts): mayúsculas, sin espacios, sin ceros a la izquierda
 * del correlativo. Clases POSIX y no barra invertida + s / d: dentro de un template literal de JS esa barra se pierde y a
 * Postgres le llegaba "s+" (no quitaba los espacios de "F NDI-00000001"; lo encontró la prueba de paridad de ventas-odoo).
 */
const DOC_NORM_SQL = "regexp_replace(upper(regexp_replace(coalesce(documento, ''), '[[:space:]]+', '', 'g')), '-0+([0-9])', '-\\1')";

/**
 * Corrida J, punto 5: texto donde busca la pantalla de ventas (misma regla que salesHaystack en shared.ts), sobre
 * `sales s left join companies cf on cf.id = s.cliente_final_company_id`.
 */
const SALES_HAYSTACK_SQL = `translate(lower(concat_ws(' ', s.razon_social, s.ruc, s.cliente_final_ruc, cf.razon_social, s.documento, ${DOC_NORM_SQL.replace("coalesce(documento,", "coalesce(s.documento,")},
  s.descripcion, s.marca, s.diseno, s.medida, s.codigo_producto)), '${SALES_FOLD_FROM}', '${SALES_FOLD_TO}')`;

/** Venta en soles de una línea (saleSolesTT en shared.ts). */
const SALE_SOLES_SQL = "coalesce(s.total, round(s.precio_unitario * s.cantidad, 2), 0)";
/** Línea que entra en el margen ponderado (saleInMargin en shared.ts). */
const SALE_IN_MARGIN_SQL = "s.line_key is not null and (s.margen_pct is not null or s.tipo_doc = 'nota_credito')";

/** Sumas de la pantalla de ventas (salesTotals en shared.ts); se leen con pgTotals. */
const SALES_TOTALS_SQL = `count(*)::int as lineas,
  coalesce(sum(case when s.cuenta_unidades then s.cantidad else 0 end), 0) as neum,
  coalesce(sum(${SALE_SOLES_SQL}), 0) as pen,
  coalesce(sum(coalesce(s.total_usd, 0)), 0) as usd,
  coalesce(sum(case when ${SALE_IN_MARGIN_SQL} then ${SALE_SOLES_SQL} else 0 end), 0) as m_venta,
  coalesce(sum(case when ${SALE_IN_MARGIN_SQL} then coalesce(s.costo_total, 0) else 0 end), 0) as m_costo,
  (count(*) filter (where s.tipo_doc = 'nota_credito'))::int as nc,
  coalesce(sum(${SALE_SOLES_SQL}) filter (where s.tipo_doc = 'nota_credito'), 0) as nc_pen`;

function pgTotals(r: Row | undefined): { lineas: number; neumaticos: number; pen: number; usd: number; mVenta: number; mCosto: number; nc: number; ncPen: number } {
  const tt = (v: unknown) => toTenThousandths(Number(v ?? 0));
  return {
    lineas: Number(r?.lineas ?? 0),
    neumaticos: tt(r?.neum) / 10_000,
    pen: tt(r?.pen),
    usd: tt(r?.usd),
    mVenta: tt(r?.m_venta),
    mCosto: tt(r?.m_costo),
    nc: Number(r?.nc ?? 0),
    ncPen: tt(r?.nc_pen),
  };
}

/** Columnas que una carga posterior actualiza (todas menos id, created_at, line_key y las del cliente final). */
const SALE_UPDATE_COLS = Object.keys(saleRow({ fecha: "2000-01-01", ruc: "", cantidad: 0 })).filter((c) => c !== "line_key");

function toUser(r: Row): PortalUser {
  return {
    id: Number(r.id),
    nombre: String(r.nombre),
    whatsapp: str(r.whatsapp),
    rol: r.rol as UserRole,
    activo: Boolean(r.activo),
    createdAt: date(r.created_at)!,
    email: str(r.email),
    calendarLinks: Boolean(r.calendar_links),
  };
}

function toSession(r: Row): PortalSession {
  return { id: String(r.id), userId: Number(r.user_id), expiresAt: date(r.expires_at)!, createdAt: date(r.created_at)! };
}

function toContact(r: Row): Contact {
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    nombre: String(r.nombre),
    cargo: str(r.cargo),
    telefono: str(r.telefono),
    email: str(r.email),
    notas: str(r.notas),
    createdBy: num(r.created_by),
    createdAt: date(r.created_at)!,
    updatedAt: date(r.updated_at)!,
  };
}

function toOpportunity(r: Row): Opportunity {
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    ownerUserId: num(r.owner_user_id),
    etapa: r.etapa as StageId,
    probabilidad: Number(r.probabilidad ?? 0),
    montoEstimado: num(r.monto_estimado),
    cierreEsperado: str(r.cierre_esperado),
    proximaAccion: str(r.proxima_accion),
    proximaAccionAt: date(r.proxima_accion_at),
    quoteNumber: str(r.quote_number),
    createdAt: date(r.created_at)!,
    updatedAt: date(r.updated_at)!,
    closedAt: date(r.closed_at),
  };
}

function toHistory(r: Row): StageHistoryEntry {
  return { id: Number(r.id), opportunityId: Number(r.opportunity_id), etapa: r.etapa as StageId, enteredAt: date(r.entered_at)!, leftAt: date(r.left_at), changedBy: num(r.changed_by) };
}

function toActivity(r: Row): Activity {
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    opportunityId: num(r.opportunity_id),
    userId: num(r.user_id),
    tipo: String(r.tipo),
    texto: String(r.texto ?? ""),
    canal: str(r.canal),
    data: (r.data as Record<string, unknown> | null) ?? null,
    occurredAt: date(r.occurred_at)!,
    createdAt: date(r.created_at)!,
  };
}

function toAppointment(r: Row): Appointment {
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    opportunityId: num(r.opportunity_id),
    userId: num(r.user_id),
    startsAt: date(r.starts_at)!,
    lugar: str(r.lugar),
    conTecnico: Boolean(r.con_tecnico),
    notas: str(r.notas),
    estado: String(r.estado),
    createdAt: date(r.created_at)!,
  };
}

/** camelCase -> columna, solo para los campos que se pueden parchear. */
const COMPANY_COLS: Record<string, string> = {
  razonSocial: "razon_social",
  sector: "sector",
  departamento: "departamento",
  unidades: "unidades",
  llantasPiso: "llantas_piso",
  antiguedadMedia: "antiguedad_media",
  esCliente: "es_cliente",
  ownerUserId: "owner_user_id",
  temperatura: "temperatura",
  score: "score",
  creditTermsDays: "credit_terms_days",
  provincia: "provincia",
  distrito: "distrito",
  direccion: "direccion",
};
const CONTACT_COLS: Record<string, string> = { nombre: "nombre", cargo: "cargo", telefono: "telefono", email: "email", notas: "notas" };
const OPPORTUNITY_COLS: Record<string, string> = {
  ownerUserId: "owner_user_id",
  montoEstimado: "monto_estimado",
  cierreEsperado: "cierre_esperado",
  proximaAccion: "proxima_accion",
  proximaAccionAt: "proxima_accion_at",
  quoteNumber: "quote_number",
  probabilidad: "probabilidad",
};
const PURCHASE_ORDER_COLS: Record<string, string> = { opportunityId: "opportunity_id", numero: "numero", quoteNumber: "quote_number", fileName: "file_name", mimeType: "mime_type", data: "data", status: "status" };
const APPOINTMENT_COLS: Record<string, string> = { startsAt: "starts_at", lugar: "lugar", conTecnico: "con_tecnico", notas: "notas", estado: "estado", opportunityId: "opportunity_id" };

/** Patch camelCase -> objeto por columna (ignora undefined; null sí se escribe). */
function patchColumns(patch: object, map: Record<string, string>): Record<string, postgres.ParameterOrJSON<never>> {
  const out: Record<string, postgres.ParameterOrJSON<never>> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined && map[k]) out[map[k]] = v as postgres.ParameterOrJSON<never>;
  return out;
}

/** Une fragmentos con AND (o `true` si no hay). */
function where(sql: Sql, conds: Fragment[]): Fragment {
  if (!conds.length) return sql`true`;
  return conds.slice(1).reduce((acc, c) => sql`${acc} and ${c}`, conds[0]);
}

// ── Corrida L: SUNAT en SQL (mismas reglas que sunat/ubicacion.ts; `c` = companies, `s` = sunat_padron) ──

/** foldPlace() en SQL: sin tildes, mayúsculas, solo letras/dígitos/espacios simples; '' -> null. */
function foldSql(sql: Sql, x: Fragment): Fragment {
  return sql`nullif(btrim(regexp_replace(regexp_replace(upper(translate(${x}, 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN')), '[^A-Z0-9 ]+', ' ', 'g'), ' +', ' ', 'g')), '')`;
}

/** Lima y Callao cuentan como un departamento. */
function sameDepSql(sql: Sql, a: Fragment, b: Fragment): Fragment {
  return sql`(${a} = ${b} or (${a} in ('LIMA', 'CALLAO') and ${b} in ('LIMA', 'CALLAO')))`;
}

/** sunatUbicacionAplica: SUNAT tiene distrito y su departamento es el de la empresa (o la empresa no tiene). */
function sunatAplicaSql(sql: Sql): Fragment {
  const dep = foldSql(sql, sql`c.departamento`);
  return sql`(s.distrito is not null and s.departamento is not null and (${dep} is null or ${sameDepSql(sql, dep, sql`s.departamento`)}))`;
}

/** enDistrito(ubicacionEfectiva(c, s), código) con los nombres plegados del código. */
function inDistritoSql(sql: Sql, t: { departamento: string; provincia: string; distrito: string }): Fragment {
  const aplica = sunatAplicaSql(sql);
  const dep = foldSql(sql, sql`c.departamento`);
  const effDist = sql`(case when ${aplica} then s.distrito else ${foldSql(sql, sql`c.distrito`)} end)`;
  const effProv = sql`(case when ${aplica} then s.provincia else ${foldSql(sql, sql`c.provincia`)} end)`;
  const effDep = sql`(case when ${aplica} then coalesce(${dep}, s.departamento) else ${dep} end)`;
  return sql`(${effDist} = ${t.distrito} and (${effProv} is null or ${effProv} = ${t.provincia}) and (${effDep} is null or ${sameDepSql(sql, effDep, sql`${t.departamento}::text`)}))`;
}

/** 1 si el estado o la condición de SUNAT empiezan con alguno de los prefijos (ya plegados), 0 si no. */
function alertRankSql(sql: Sql, alerta: SunatAlertMatch | undefined): Fragment {
  if (!alerta || (!alerta.estados.length && !alerta.condiciones.length)) return sql`0`;
  const est = alerta.estados.map(foldPlace).filter(Boolean);
  const con = alerta.condiciones.map(foldPlace).filter(Boolean);
  const any = (col: Fragment, list: string[]) => (list.length ? sql`exists (select 1 from unnest(${sql.array(list)}::text[]) as p(x) where ${foldSql(sql, col)} like p.x || '%')` : sql`false`);
  return sql`(case when ${any(sql`s.estado`, est)} or ${any(sql`s.condicion`, con)} then 1 else 0 end)`;
}

/** Columnas de sunat_padron para las listas, con prefijo (no chocan con c.*). */
function sunatCols(sql: Sql): Fragment {
  return sql`s.ruc as s_ruc, s.encontrado as s_encontrado, s.estado as s_estado, s.condicion as s_condicion, s.ubigeo as s_ubigeo, s.departamento as s_departamento,
    s.provincia as s_provincia, s.distrito as s_distrito, s.direccion as s_direccion, s.anexos as s_anexos, to_char(s.fecha, 'YYYY-MM-DD') as s_fecha`;
}

function toSunatBrief(r: Row): SunatBrief | null {
  if (r.s_ruc === null || r.s_ruc === undefined) return null;
  return {
    encontrado: Boolean(r.s_encontrado),
    estado: str(r.s_estado),
    condicion: str(r.s_condicion),
    ubigeo: str(r.s_ubigeo),
    departamento: str(r.s_departamento),
    provincia: str(r.s_provincia),
    distrito: str(r.s_distrito),
    direccion: str(r.s_direccion),
    anexos: Number(r.s_anexos ?? 0),
    fecha: String(r.s_fecha),
  };
}

function toSunatRecord(r: Row): SunatRecord {
  return {
    ruc: String(r.ruc),
    encontrado: Boolean(r.encontrado),
    razonSocial: str(r.razon_social),
    estado: str(r.estado),
    condicion: str(r.condicion),
    ubigeo: str(r.ubigeo),
    departamento: str(r.departamento),
    provincia: str(r.provincia),
    distrito: str(r.distrito),
    direccion: str(r.direccion),
    piezas: jsonOf<SunatPiezasRecord>(r.piezas),
    anexos: Number(r.anexos ?? 0),
    fecha: String(r.fecha_text),
    updatedAt: date(r.updated_at)!,
  };
}

function toSunatLocal(r: Row): SunatLocal {
  return {
    id: Number(r.id),
    ruc: String(r.ruc),
    ubigeo: str(r.ubigeo),
    departamento: str(r.departamento),
    provincia: str(r.provincia),
    distrito: str(r.distrito),
    direccion: str(r.direccion),
    piezas: jsonOf<SunatPiezasRecord>(r.piezas)!,
    fecha: String(r.fecha_text),
  };
}

/** Filas de sunat_padron / sunat_locales por sentencia. */
const SUNAT_BATCH = 2000;


export class PgPortalStore implements PortalStore {
  private constructor(private sql: Sql) {}

  static connect(url: string): PgPortalStore {
    // Pooler de Supabase en modo transacción: sin sentencias preparadas y sin pipelining (una consulta encolada en una
    // conexión ocupada no volvía nunca: Prospectos colgado 300 s, corrida F). Ver src/lib/store/pg-options.ts.
    // begin seguro con este pool (corrida H, reservedBegin en pg-options.ts).
    return new PgPortalStore(serverlessPostgres(url, { max: 5 }));
  }

  async flush(): Promise<void> {}

  // ── límite de intentos (corrida E, punto 5): rate_limit_hits ──

  async hitRateLimit(bucket: string, windowStart: Date): Promise<number> {
    const [r] = await this.sql`
      insert into rate_limit_hits (bucket, window_start, hits) values (${bucket}, ${windowStart}, 1)
      on conflict (bucket, window_start) do update set hits = rate_limit_hits.hits + 1, updated_at = now()
      returning hits`;
    return Number(r.hits);
  }


  async pruneRateLimitHits(before: Date): Promise<number> {
    const r = await this.sql`delete from rate_limit_hits where window_start < ${before}`;
    return r.count;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  // ── puntaje de atractivo (corrida G) ──
  // Una consulta por tabla para todas las empresas, en serie (sin consultas en cola en el intermediario de conexiones).

  async scoringInputs(q: ScoreInputQuery): Promise<ScoreInput[]> {
    const sql = this.sql;
    const ids = q.companyIds;
    if (ids && !ids.length) return [];
    const onlyIds = (col: string) => (ids ? sql`and ${sql(col)} in ${sql(ids)}` : sql``);
    const companies = await sql`
      select id, ruc, unidades, llantas_piso, sector, departamento, antiguedad_media, es_cliente from companies
      where true ${onlyIds("id")} order by id`;
    const medidas = await sql`
      select company_id, medida_probable as medida, count(*)::int as n from fleet_vehicles
      where medida_probable is not null ${onlyIds("company_id")} group by 1, 2`;
    const marcas = q.marcas.length
      ? await sql`
      select company_id, upper(trim(marca)) as marca, count(*)::int as n from fleet_vehicles
      where upper(trim(marca)) in ${sql(q.marcas)} ${onlyIds("company_id")} group by 1, 2`
      : [];
    const rucs = companies.map((c) => String(c.ruc));
    const sales = await sql`
      select coalesce(cliente_final_ruc, ruc) as ruc, coalesce(sum(cantidad) filter (where not is_demo and fecha >= ${q.since12m}::date), 0)::float8 as v12,
        bool_or(not is_demo) as reales, bool_or(is_demo) as demo
      from sales where cuenta_unidades ${ids ? sql`and coalesce(cliente_final_ruc, ruc) in ${sql(rucs.length ? rucs : [""])}` : sql``} group by 1`;
    const credit = await sql`select company_id, estado from company_credit where true ${onlyIds("company_id")}`;
    const lost = await sql`
      select company_id, max(closed_at) as at from opportunities
      where etapa = 'cerrado_perdido' and closed_at >= ${q.lostSince} ${onlyIds("company_id")} group by 1`;

    const med = new Map<number, Record<string, number>>();
    for (const m of medidas) {
      const id = Number(m.company_id);
      const o = med.get(id) ?? {};
      o[String(m.medida)] = Number(m.n);
      med.set(id, o);
    }
    const mar = new Map<number, Record<string, number>>();
    for (const m of marcas) {
      const id = Number(m.company_id);
      const o = mar.get(id) ?? {};
      const k = String(m.marca).replace(/\s+/g, " ");
      o[k] = (o[k] ?? 0) + Number(m.n);
      mar.set(id, o);
    }
    const sal = new Map(sales.map((s) => [String(s.ruc), s]));
    const cred = new Map(credit.map((c) => [Number(c.company_id), String(c.estado) as CreditEstado]));
    const los = new Map(lost.map((l) => [Number(l.company_id), date(l.at)]));
    return companies.map((c) => {
      const id = Number(c.id);
      const s = sal.get(String(c.ruc));
      return {
        companyId: id,
        ruc: String(c.ruc),
        unidades: Number(c.unidades ?? 0),
        llantasPiso: Number(c.llantas_piso ?? 0),
        sector: (c.sector as Sector | null) ?? null,
        departamento: str(c.departamento),
        antiguedadMedia: num(c.antiguedad_media),
        esClienteMarcado: Boolean(c.es_cliente),
        medidas: med.get(id) ?? {},
        marcasPreferidas: mar.get(id) ?? {},
        vendidos12m: s ? Number(s.v12) : 0,
        ventasReales: s ? Boolean(s.reales) : false,
        ventasDemo: s ? Boolean(s.demo) : false,
        credito: cred.get(id) ?? null,
        perdidaAt: los.get(id) ?? null,
      };
    });
  }

  /** Por lotes de SCORE_BATCH con unnest (una sentencia por lote, en serie). */
  async saveScores(rows: ScoreUpdate[], at: Date): Promise<number> {
    const sql = this.sql;
    let n = 0;
    for (let i = 0; i < rows.length; i += SCORE_BATCH) {
      const b = rows.slice(i, i + SCORE_BATCH);
      const r = await sql`
        update companies c set score = v.score, nivel = v.nivel, score_detalle = v.detalle::jsonb, score_at = ${at}
        from unnest(${sql.array(b.map((x) => x.companyId))}::int[], ${sql.array(b.map((x) => x.score))}::numeric[],
          ${sql.array(b.map((x) => x.nivel))}::text[], ${sql.array(b.map((x) => JSON.stringify(x.detalle)))}::text[]) as v(id, score, nivel, detalle)
        where c.id = v.id`;
      n += r.count;
    }
    return n;
  }

  async saveScoreRun(run: ScoreRunInput): Promise<ScoreRun> {
    const [r] = await this.sql`
      insert into score_runs (run_at, empresas, cut_a, cut_b, conteo, duracion_ms)
      values (${run.runAt ?? new Date()}, ${run.empresas}, ${run.cutA}, ${run.cutB}, ${this.sql.json(run.conteo)}, ${run.duracionMs})
      returning *`;
    return toScoreRun(r);
  }

  async latestScoreRun(): Promise<ScoreRun | null> {
    const [r] = await this.sql`select * from score_runs order by run_at desc, id desc limit 1`;
    return r ? toScoreRun(r) : null;
  }

  async bestCompanies(q: BestCompaniesQuery): Promise<{ rows: BestCompany[]; total: number }> {
    const sql = this.sql;
    // corrida L: estado o condición de SUNAT en alerta, al final (sin ocultarse)
    const rows = await sql`
      select c.*, ${sunatCols(sql)}, count(*) over () as total_count from companies c
      left join sunat_padron s on s.ruc = c.ruc
      where c.score is not null and (c.owner_user_id is null or (c.owner_user_id = ${q.userId}
        and not exists (select 1 from activities a where a.company_id = c.id and a.occurred_at >= ${q.activeSince})))
      order by ${alertRankSql(sql, q.alerta)} asc, c.score desc, c.id asc
      limit ${Math.max(0, q.limit)} offset ${Math.max(0, q.offset ?? 0)}`;
    return { rows: rows.map((r) => ({ ...toCompany(r), propia: num(r.owner_user_id) === q.userId, sunat: toSunatBrief(r) })), total: rows.length ? Number(rows[0].total_count) : 0 };
  }

  async addRankingValidations(rows: RankingValidationInput[]): Promise<RankingValidation[]> {
    if (!rows.length) return [];
    const values = rows.map((r) => ({
      user_id: r.userId,
      company_id: r.companyId,
      nivel_vendedor: r.nivelVendedor,
      nota: r.nota,
      nivel_sistema: r.nivelSistema,
      score_sistema: r.scoreSistema,
      created_at: r.createdAt ?? new Date(),
    }));
    const out = await this.sql`insert into ranking_validations ${this.sql(values)} returning *`;
    return out.map(toValidation);
  }

  async listRankingValidations(filter: { userId?: number; since?: Date } = {}): Promise<RankingValidation[]> {
    const conds: Fragment[] = [];
    if (filter.userId !== undefined) conds.push(this.sql`user_id = ${filter.userId}`);
    if (filter.since) conds.push(this.sql`created_at >= ${filter.since}`);
    const rows = await this.sql`select * from ranking_validations where ${where(this.sql, conds)} order by created_at desc, id desc`;
    return rows.map(toValidation);
  }

  async markUserNotice(userId: number, aviso: string): Promise<boolean> {
    const r = await this.sql`insert into user_notices (user_id, aviso) values (${userId}, ${aviso}) on conflict do nothing`;
    return r.count > 0;
  }

  // ── empresas ──

  async upsertCompanies(batch: CompanyInput[]): Promise<UpsertCompaniesResult> {
    const res: UpsertCompaniesResult = { inserted: 0, updated: 0, ids: {} };
    const rows = dedupeBy(
      batch.map((c) => ({ ...c, ruc: digits(c.ruc) })).filter((c) => c.ruc),
      (c) => c.ruc,
    );
    // Los campos opcionales que no vienen (undefined) conservan lo guardado: se agrupa por el conjunto de columnas presentes
    // y cada grupo actualiza solo las suyas. es_cliente, dueño, temperatura, score y crédito nunca los toca el import.
    const groups = new Map<string, Record<string, postgres.ParameterOrJSON<never>>[]>();
    for (const c of rows) {
      const rec: Record<string, postgres.ParameterOrJSON<never>> = { ruc: c.ruc, razon_social: c.razonSocial };
      if (c.sector !== undefined) rec.sector = c.sector;
      if (c.departamento !== undefined) rec.departamento = c.departamento;
      if (c.unidades !== undefined) rec.unidades = c.unidades;
      if (c.llantasPiso !== undefined) rec.llantas_piso = c.llantasPiso;
      if (c.antiguedadMedia !== undefined) rec.antiguedad_media = c.antiguedadMedia;
      if (c.provincia !== undefined) rec.provincia = c.provincia;
      if (c.distrito !== undefined) rec.distrito = c.distrito;
      const sig = Object.keys(rec).join(",");
      const list = groups.get(sig);
      if (list) list.push(rec);
      else groups.set(sig, [rec]);
    }
    const sql = this.sql;
    // corrida J: las creadas a mano que llegan en el padrón se fusionan (origen pasa a "mtc"; sector y departamento a mano
    // se conservan si el padrón no los trae)
    const merged: string[] = [];
    const rucs = rows.map((c) => c.ruc);
    for (let i = 0; i < rucs.length; i += BATCH) {
      const found = await sql<{ ruc: string }[]>`select ruc from companies where origen = 'manual' and ruc in ${sql(rucs.slice(i, i + BATCH))}`;
      for (const f of found) merged.push(String(f.ruc));
    }
    const keepManual = new Set(["sector", "departamento"]);
    for (const [sig, recs] of groups) {
      const cols = sig.split(",");
      const set = cols
        .filter((c) => c !== "ruc")
        .reduce(
          (acc, c) =>
            keepManual.has(c)
              ? sql`${acc}, ${sql(c)} = case when companies.origen = 'manual' and excluded.${sql(c)} is null then companies.${sql(c)} else excluded.${sql(c)} end`
              : sql`${acc}, ${sql(c)} = excluded.${sql(c)}`,
          sql`updated_at = now(), origen = 'mtc'`,
        );
      for (let i = 0; i < recs.length; i += BATCH) {
        const out = await sql<{ id: number; ruc: string; inserted: boolean }[]>`
          insert into companies ${sql(recs.slice(i, i + BATCH), cols)}
          on conflict (ruc) do update set ${set}
          returning id, ruc, (xmax = 0) as inserted`;
        for (const r of out) {
          res.ids[r.ruc] = Number(r.id);
          if (r.inserted) res.inserted++;
          else res.updated++;
        }
      }
    }
    if (merged.length) res.merged = merged.sort();
    return res;
  }

  async createManualCompany(input: ManualCompanyInput): Promise<{ company: Company; created: boolean }> {
    const ruc = digits(input.ruc);
    if (!/^\d{11}$/.test(ruc)) throw new Error(`RUC inválido: ${input.ruc}`);
    // una sola sentencia: dos altas del mismo RUC a la vez dejan una empresa
    const [r] = await this.sql`
      insert into companies (ruc, razon_social, sector, departamento, unidades, owner_user_id, origen, created_by)
      values (${ruc}, ${input.razonSocial.trim()}, ${input.sector}, ${input.departamento}, ${Math.max(0, Math.round(input.unidades ?? 0))}, ${input.createdBy}, 'manual', ${input.createdBy})
      on conflict (ruc) do nothing returning *`;
    if (r) return { company: toCompany(r), created: true };
    const existing = await this.getCompanyByRuc(ruc);
    if (!existing) throw new Error(`No pude crear ni leer la empresa ${ruc}`);
    return { company: existing, created: false };
  }

  async getCompany(id: number): Promise<Company | null> {
    const [r] = await this.sql`select * from companies where id = ${id}`;
    return r ? toCompany(r) : null;
  }

  async getCompanyByRuc(ruc: string): Promise<Company | null> {
    const [r] = await this.sql`select * from companies where ruc = ${digits(ruc)}`;
    return r ? toCompany(r) : null;
  }

  async getCompaniesByRucs(rucs: string[]): Promise<Company[]> {
    const list = [...new Set(rucs.map(digits).filter(Boolean))];
    const out: Company[] = [];
    for (let i = 0; i < list.length; i += BATCH) {
      const rows = await this.sql`select * from companies where ruc in ${this.sql(list.slice(i, i + BATCH))}`;
      for (const r of rows) out.push(toCompany(r));
    }
    return out;
  }

  async updateCompany(id: number, patch: CompanyPatch): Promise<Company | null> {
    const cols = patchColumns(patch, COMPANY_COLS);
    const [r] = Object.keys(cols).length
      ? await this.sql`update companies set ${this.sql(cols)}, updated_at = now() where id = ${id} returning *`
      : await this.sql`update companies set updated_at = now() where id = ${id} returning *`;
    return r ? toCompany(r) : null;
  }

  async setOwner(companyId: number, userId: number | null, opts?: { onlyIfOwner: number | null }): Promise<Company | null> {
    if (!opts) return this.updateCompany(companyId, { ownerUserId: userId });
    // corrida H: una sola sentencia; si otro vendedor la tomó entretanto, no se pisa
    const [r] = await this.sql`
      update companies set owner_user_id = ${userId}, updated_at = now()
      where id = ${companyId} and owner_user_id is not distinct from ${opts.onlyIfOwner} returning *`;
    return r ? toCompany(r) : null;
  }

  async searchCompanies(opts: CompanySearch = {}): Promise<CompanySearchResult> {
    const sql = this.sql;
    const since = opts.since !== undefined ? toIsoDate(opts.since) : defaultSince(opts.now);
    const conds: Fragment[] = [];
    // razon_norm: columna generada con la misma regla que companyNameKey() (src/cli/migrate.ts), con índice trigram
    const terms = searchTerms(opts.q);
    if (terms.compact) {
      const like = (w: string) => sql`c.razon_norm like ${`%${w}%`}`; // la clave solo tiene [a-z0-9]: nada que escapar
      const words = terms.words.length > 1 ? sql`(${terms.words.slice(1).reduce((acc, w) => sql`${acc} and ${like(w)}`, like(terms.words[0]))})` : null;
      const byName = words ? sql`(${like(terms.compact)} or ${words})` : like(terms.compact);
      const ruc = searchRucPrefix(opts.q);
      conds.push(ruc ? sql`(${byName} or c.ruc like ${`${ruc}%`})` : byName);
    }
    // con distrito elegido manda el distrito (igual que el store JSON): el departamento no vuelve a excluir
    if (opts.departamento?.length && !opts.distrito) conds.push(sql`c.departamento in ${sql(opts.departamento)}`);
    if (opts.distrito) {
      const t = lookupUbigeo(opts.distrito);
      conds.push(t ? inDistritoSql(sql, { departamento: foldPlace(t.departamento), provincia: foldPlace(t.provincia), distrito: foldPlace(t.distrito) }) : sql`false`);
    }
    if (opts.sector?.length) conds.push(sql`c.sector in ${sql(opts.sector)}`);
    if (opts.minUnits !== undefined) conds.push(sql`c.unidades >= ${opts.minUnits}`);
    if (opts.maxUnits !== undefined) conds.push(sql`c.unidades <= ${opts.maxUnits}`);
    if (opts.esCliente !== undefined) conds.push(sql`c.es_cliente = ${opts.esCliente}`);
    if (opts.ownerUserId !== undefined) conds.push(sql`c.owner_user_id = ${opts.ownerUserId}`);
    if (opts.nivel?.length) conds.push(sql`c.nivel in ${sql(opts.nivel)}`);
    if (opts.marcas?.length) {
      const marcas = [...new Set(opts.marcas.map(normMarca))];
      conds.push(sql`exists (select 1 from fleet_vehicles f where f.company_id = c.id and upper(trim(f.marca)) in ${sql(marcas)})`);
    }
    // atractivo: sin puntaje al final (-1 < 0..100)
    const orderCol = opts.orderBy === "atractivo" ? sql`coalesce(c.score, -1)` : opts.orderBy === "llantas" ? sql`c.llantas_piso` : opts.orderBy === "participacion" ? sql`coalesce(p.cantidad, 0)` : sql`c.unidades`;
    const { pageSize, offset } = pageOf(opts.page, opts.pageSize);
    const rows = await sql`
      with p as (
        select coalesce(cliente_final_ruc, ruc) as ruc, sum(cantidad)::float8 as cantidad, bool_or(is_demo) as demo from sales
        where cuenta_unidades and fecha >= ${since}::date group by 1
      )
      select c.*, coalesce(p.cantidad, 0) as participacion, coalesce(p.demo, false) as participacion_demo, ${sunatCols(sql)}, count(*) over () as total_count
      from companies c left join p on p.ruc = c.ruc left join sunat_padron s on s.ruc = c.ruc
      where ${where(sql, conds)}
      order by ${orderCol} desc, c.razon_social asc, c.id asc
      limit ${pageSize} offset ${offset}`;
    let total = rows.length ? Number(rows[0].total_count) : 0;
    if (!rows.length && offset > 0) {
      const [{ n }] = await sql`select count(*)::int as n from companies c left join sunat_padron s on s.ruc = c.ruc where ${where(sql, conds)}`;
      total = Number(n);
    }
    const out = rows.map((r): CompanyRow => ({ ...toCompany(r), participacion: Number(r.participacion), participacionDemo: Boolean(r.participacion_demo), sunat: toSunatBrief(r) }));
    if (opts.withMedidas && out.length) {
      // solo las empresas de la página, con el índice (company_id, medida_probable): no recorre la flota entera
      const med = await sql`
        select company_id, medida_probable as medida, count(*)::int as n from fleet_vehicles
        where company_id in ${sql(out.map((r) => r.id))} and medida_probable is not null
        group by 1, 2`;
      const counts = new Map<number, Map<string, number>>();
      for (const m of med) {
        const id = Number(m.company_id);
        const byMedida = counts.get(id) ?? new Map<string, number>();
        byMedida.set(String(m.medida), Number(m.n));
        counts.set(id, byMedida);
      }
      for (const r of out) r.medidas = topMedidas(counts.get(r.id) ?? new Map());
    }
    return { rows: out, total };
  }

  // Marcas y departamentos solo cambian con el import del MTC (otro proceso): se reutilizan 10 min por instancia.
  // listMarcas recorre los ~150 mil vehículos (~180 ms aun con índice); antes se calculaba en cada carga de Prospectos.
  private marcasCache = ttlCache(() => this.queryMarcas(), LIST_CACHE_MS);
  private departamentosCache = ttlCache(() => this.queryDepartamentos(), LIST_CACHE_MS);

  listMarcas(): Promise<MarcaCount[]> {
    return this.marcasCache();
  }

  listDepartamentos(): Promise<DepartamentoCount[]> {
    return this.departamentosCache();
  }

  private async queryMarcas(): Promise<MarcaCount[]> {
    const rows = await this.sql`
      select upper(trim(marca)) as marca, count(*)::int as vehiculos, count(distinct company_id)::int as empresas
      from fleet_vehicles where marca is not null and trim(marca) <> ''
      group by 1 order by vehiculos desc, marca asc`;
    return rows.map((r) => ({ marca: String(r.marca).replace(/\s+/g, " "), vehiculos: Number(r.vehiculos), empresas: Number(r.empresas) }));
  }

  private async queryDepartamentos(): Promise<DepartamentoCount[]> {
    const rows = await this.sql`
      select departamento, count(*)::int as empresas from companies where departamento is not null and departamento <> ''
      group by departamento order by empresas desc, departamento asc`;
    return rows.map((r) => ({ departamento: String(r.departamento), empresas: Number(r.empresas) }));
  }

  async countCompanies(): Promise<number> {
    const [{ n }] = await this.sql`select count(*)::int as n from companies`;
    return Number(n);
  }

  // ── flota ──

  private async upsertFleetWith(sql: Sql | postgres.TransactionSql, batch: FleetVehicleInput[]): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;
    const rows = dedupeBy(
      batch.map((v) => ({ ...v, placa: normPlaca(v.placa) })).filter((v) => v.placa),
      (v) => `${v.origen}|${v.placa}`,
    );
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH).map((v) => ({
        company_id: v.companyId,
        placa: v.placa,
        marca: v.marca,
        clase: v.clase,
        anio: v.anio,
        ejes: v.ejes,
        llantas: v.llantas,
        llantas_fuente: v.llantasFuente,
        peso_bruto: v.pesoBruto,
        chasis: v.chasis,
        departamento: v.departamento,
        origen: v.origen,
        medida_probable: v.medidaProbable,
        confianza: v.confianza,
      }));
      const out = await sql<{ inserted: boolean }[]>`
        insert into fleet_vehicles ${sql(chunk)}
        on conflict (placa, origen) do update set
          company_id = excluded.company_id, marca = excluded.marca, clase = excluded.clase, anio = excluded.anio, ejes = excluded.ejes,
          llantas = excluded.llantas, llantas_fuente = excluded.llantas_fuente, peso_bruto = excluded.peso_bruto, chasis = excluded.chasis,
          departamento = excluded.departamento, medida_probable = excluded.medida_probable, confianza = excluded.confianza
        returning (xmax = 0) as inserted`;
      for (const r of out) {
        if (r.inserted) inserted++;
        else updated++;
      }
    }
    return { inserted, updated };
  }

  upsertFleet(batch: FleetVehicleInput[]): Promise<{ inserted: number; updated: number }> {
    return this.upsertFleetWith(this.sql, batch);
  }

  async replaceFleet(companyId: number, vehicles: Omit<FleetVehicleInput, "companyId">[]): Promise<{ removed: number; upserted: number }> {
    const keep = vehicles.map((v) => ({ placa: v.placa, origen: v.origen }));
    return this.sql.begin(async (tx) => {
      const removed = await this.pruneFleetWith(tx, [companyId], keep);
      const r = await this.upsertFleetWith(
        tx,
        vehicles.map((v) => ({ ...v, companyId })),
      );
      return { removed, upserted: r.inserted + r.updated };
    }) as Promise<{ removed: number; upserted: number }>;
  }

  /**
   * `keep` viaja como un solo parámetro JSON. El oid con que sql.json() lo envía depende de la versión de `postgres`
   * (3.4.x: jsonb 3802; otras: json 114), así que se castea explícito a jsonb: jsonb_to_recordset funciona con ambos.
   */
  private async pruneFleetWith(sql: Sql | postgres.TransactionSql, companyIds: number[], keep: FleetKey[]): Promise<number> {
    const ids = [...new Set(companyIds)];
    if (!ids.length) return 0;
    const keys = dedupeBy(
      keep.map((v) => ({ placa: normPlaca(v.placa), origen: v.origen })).filter((v) => v.placa),
      (v) => `${v.origen}|${v.placa}`,
    );
    // corrida J: los vehículos cargados a mano (origen 'manual') nunca se podan
    const r = keys.length
      ? await sql`
          delete from fleet_vehicles f where f.company_id in ${sql(ids)} and f.origen <> 'manual'
          and not exists (select 1 from jsonb_to_recordset(${sql.json(keys)}::jsonb) as k(placa text, origen text) where k.placa = f.placa and k.origen = f.origen)`
      : await sql`delete from fleet_vehicles where company_id in ${sql(ids)} and origen <> 'manual'`;
    return r.count;
  }

  pruneFleet(companyIds: number[], keep: FleetKey[]): Promise<number> {
    return this.pruneFleetWith(this.sql, companyIds, keep);
  }

  async addManualVehicle(companyId: number, input: ManualVehicleInput): Promise<ManualVehicleResult> {
    const placa = normPlaca(input.placa);
    if (!placa) throw new Error("Falta la placa");
    // una sola sentencia: si la placa ya está cargada a mano en otra empresa, no se mueve (el where del update no la toca)
    const [r] = await this.sql`
      insert into fleet_vehicles (company_id, placa, marca, clase, anio, ejes, llantas, origen, medida_probable, confianza)
      values (${companyId}, ${placa}, ${input.marca}, ${input.clase}, ${input.anio ?? null}, ${input.ejes}, ${input.llantas}, 'manual', ${input.medida}, ${input.medida ? "alta" : null})
      on conflict (placa, origen) do update set
        marca = excluded.marca, clase = excluded.clase, anio = excluded.anio, ejes = excluded.ejes, llantas = excluded.llantas,
        medida_probable = excluded.medida_probable, confianza = excluded.confianza
      where fleet_vehicles.company_id = excluded.company_id
      returning *, (xmax = 0) as inserted`;
    if (r) return { ok: true, vehicle: toVehicle(r), updated: !r.inserted };
    const [other] = await this.sql`select company_id from fleet_vehicles where placa = ${placa} and origen = 'manual'`;
    return { ok: false, reason: "otra_empresa", companyId: Number(other?.company_id) };
  }

  async deleteManualVehicle(companyId: number, vehicleId: number): Promise<boolean> {
    const r = await this.sql`delete from fleet_vehicles where id = ${vehicleId} and company_id = ${companyId} and origen = 'manual'`;
    return r.count > 0;
  }

  async listFleet(companyId: number): Promise<FleetVehicle[]> {
    const rows = await this.sql`select * from fleet_vehicles where company_id = ${companyId} order by placa`;
    return rows.map(toVehicle);
  }

  async listManualVehicles(companyId: number): Promise<FleetVehicle[]> {
    const rows = await this.sql`select * from fleet_vehicles where company_id = ${companyId} and origen = 'manual' order by placa`;
    return rows.map(toVehicle);
  }

  async fleetByBrand(companyId: number): Promise<FleetGroup[]> {
    const rows = await this.sql`
      select upper(trim(marca)) as marca, clase, medida_probable as medida, confianza, count(*)::int as unidades,
        min(anio)::int as anio_min, max(anio)::int as anio_max, coalesce(sum(llantas), 0)::int as llantas, count(llantas)::int as con_llantas
      from fleet_vehicles where company_id = ${companyId} and origen <> 'manual'
      group by 1, clase, medida_probable, confianza`;
    const agg: FleetAggRow[] = rows.map((r) => ({
      marca: r.marca === null ? null : String(r.marca).replace(/\s+/g, " ") || null,
      clase: str(r.clase),
      medida: str(r.medida),
      confianza: (r.confianza as Confianza | null) ?? null,
      unidades: Number(r.unidades),
      anioMin: num(r.anio_min),
      anioMax: num(r.anio_max),
      llantas: Number(r.llantas),
      unidadesConLlantas: Number(r.con_llantas),
    }));
    return groupFleet(agg);
  }

  async findFleetByPlacas(placas: string[]): Promise<FleetVehicle[]> {
    const keys = [...new Set(placas.map((p) => p.toUpperCase().replace(/[\s-]+/g, "")).filter(Boolean))];
    if (!keys.length) return [];
    // la misma expresión que el índice fleet_vehicles_placa_key_idx (src/cli/migrate.ts)
    const rows = await this.sql`
      select * from fleet_vehicles where upper(replace(replace(placa, '-', ''), ' ', '')) in ${this.sql(keys)}
      order by placa, id`;
    return rows.map(toVehicle);
  }

  async countFleet(): Promise<number> {
    const [{ n }] = await this.sql`select count(*)::int as n from fleet_vehicles`;
    return Number(n);
  }

  async companyOriginCounts(): Promise<CompanyOriginCounts[]> {
    const rows = await this.sql`
      select c.id, c.ruc, c.razon_social, c.sector,
        count(f.id) filter (where f.origen = 'carga')::int as carga,
        count(f.id) filter (where f.origen = 'pasajeros')::int as pasajeros
      from companies c left join fleet_vehicles f on f.company_id = c.id
      group by c.id
      order by c.id`;
    return rows.map((r) => ({
      companyId: Number(r.id),
      ruc: String(r.ruc),
      razonSocial: String(r.razon_social),
      sector: (r.sector as Sector | null) ?? null,
      carga: Number(r.carga),
      pasajeros: Number(r.pasajeros),
    }));
  }

  // ── ventas ──

  async insertSales(rows: SaleInput[]): Promise<number> {
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH).map(saleRow);
      await this.sql`insert into sales ${this.sql(chunk)}`;
    }
    return rows.length;
  }

  async upsertSaleLines(rows: SaleInput[]): Promise<{ inserted: number; updated: number }> {
    if (rows.some((r) => !r.detalle)) throw new Error("upsertSaleLines: falta detalle.lineKey (usa insertSales para el formato simple)");
    let inserted = 0;
    let updated = 0;
    // de a 500 (cada fila lleva ~48 parámetros: 500 × 48 queda bajo el tope de 65535 de Postgres)
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({ ...saleRow(r), updated_at: null }));
      const res = await this.sql`
        insert into sales ${this.sql(chunk)}
        on conflict (line_key) where line_key is not null do update set
          ${this.sql.unsafe(SALE_UPDATE_COLS.map((c) => `${c} = excluded.${c}`).join(", "))}, updated_at = now()
        returning (xmax = 0) as inserted`;
      for (const r of res) if (r.inserted) inserted++;
      else updated++;
    }
    return { inserted, updated };
  }

  async existingSaleLineKeys(keys: string[]): Promise<Set<string>> {
    const list = [...new Set(keys)];
    const out = new Set<string>();
    for (let i = 0; i < list.length; i += 5000) {
      const rows = await this.sql`select line_key from sales where line_key in ${this.sql(list.slice(i, i + 5000))}`;
      for (const r of rows) out.add(String(r.line_key));
    }
    return out;
  }

  async querySales(f: SalesQuery): Promise<Sale[]> {
    const sql = this.sql;
    const conds = [sql`true`];
    if (!f.includeDemo) conds.push(sql`not is_demo`);
    if (!f.includeExcluded) conds.push(sql`not excluida`);
    if (f.onlyDetailed) conds.push(sql`line_key is not null`);
    if (f.companyRucs) {
      const r = f.companyRucs.map(digits);
      conds.push(sql`(ruc in ${sql(r.length ? r : [""])} or cliente_final_ruc in ${sql(r.length ? r : [""])})`);
    }
    if (f.docRucs) {
      const r = f.docRucs.map(digits);
      conds.push(sql`ruc in ${sql(r.length ? r : [""])}`);
    }
    if (f.documentos) {
      const d = f.documentos.map(normDocumento);
      conds.push(sql`${sql.unsafe(DOC_NORM_SQL)} in ${sql(d.length ? d : [""])}`);
    }
    if (f.medida) conds.push(sql`medida = ${f.medida}`);
    if (f.tipoLinea) conds.push(sql`coalesce(tipo_linea, 'neumatico') in ${sql(f.tipoLinea.length ? f.tipoLinea : [""])}`);
    if (f.sinClienteFinal) conds.push(sql`cliente_final_ruc is null`);
    const rows = await sql`
      select *, fecha::text as fecha, vencimiento::text as vencimiento from sales where ${where(sql, conds)}
      order by sales.fecha desc, sales.id desc ${f.limit ? sql`limit ${f.limit}` : sql``}`;
    return rows.map(toSale);
  }

  async setClienteFinal(input: { bankRuc: string; documentos: string[]; company: { id: number; ruc: string } | null; userId: number | null }): Promise<number> {
    const d = input.documentos.map(normDocumento);
    if (!d.length) return 0;
    const c = input.company;
    const r = await this.sql`
      update sales set cliente_final_company_id = ${c?.id ?? null}, cliente_final_ruc = ${c ? digits(c.ruc) : null},
        cliente_final_at = ${c ? this.sql`now()` : null}, cliente_final_by = ${c ? input.userId : null}
      where ruc = ${digits(input.bankRuc)} and line_key is not null
        and ${this.sql.unsafe(DOC_NORM_SQL)} in ${this.sql(d)}`;
    return r.count;
  }

  async salesByClient(): Promise<SalesClientRow[]> {
    const rows = await this.sql`
      select coalesce(cliente_final_ruc, ruc) as ruc,
        max(razon_social) filter (where cliente_final_ruc is null) as razon_social,
        sum(case when cuenta_unidades then cantidad else 0 end)::float8 as neumaticos, count(*)::int as lineas, max(sales.fecha)::text as ultima
      from sales where not is_demo and not excluida group by 1`;
    return rows.map((r) => ({
      ruc: String(r.ruc),
      razonSocial: str(r.razon_social),
      docCliente: docClienteOf(String(r.ruc)),
      neumaticos: Number(r.neumaticos ?? 0),
      lineas: Number(r.lineas ?? 0),
      ultimaFecha: String(r.ultima),
    }));
  }

  /**
   * Condición del filtro de la pantalla de ventas sobre `sales s left join companies cf on cf.id = s.cliente_final_company_id`.
   * Misma regla que salesListMatches del store JSON.
   */
  private salesListWhere(f: SalesListFilter): Fragment {
    const sql = this.sql;
    const conds = [f.demo ? sql`s.is_demo` : sql`not s.is_demo`, sql`not s.excluida`];
    if (f.medida) conds.push(sql`s.medida = ${f.medida}`);
    const marca = f.marca?.trim().toUpperCase();
    if (marca) conds.push(sql`upper(btrim(s.marca)) = ${marca}`);
    if (f.tipoLinea) conds.push(sql`coalesce(s.tipo_linea, 'neumatico') = ${f.tipoLinea}`);
    if (f.vendedor) conds.push(sql`s.vendedor = ${f.vendedor}`);
    if (f.desde) conds.push(sql`s.fecha >= ${f.desde}::date`);
    if (f.hasta) conds.push(sql`s.fecha <= ${f.hasta}::date`);
    if (f.docRucs) {
      const r = f.docRucs.map(digits);
      conds.push(sql`s.ruc in ${sql(r.length ? r : [""])}`);
    }
    if (f.sinClienteFinal) conds.push(sql`s.cliente_final_ruc is null`);
    for (const w of salesSearchWords(f.q)) {
      const hay = sql.unsafe(SALES_HAYSTACK_SQL);
      conds.push(w.doc === w.word ? sql`${hay} like ${`%${w.word}%`}` : sql`(${hay} like ${`%${w.word}%`} or ${hay} like ${`%${w.doc}%`})`);
    }
    return where(sql, conds);
  }

  async listSalesLines(f: SalesListFilter, page: { limit: number; offset: number }): Promise<Sale[]> {
    const sql = this.sql;
    const rows = await sql`
      select s.*, s.fecha::text as fecha, s.vencimiento::text as vencimiento
      from sales s left join companies cf on cf.id = s.cliente_final_company_id
      where ${this.salesListWhere(f)}
      order by s.fecha desc, s.id desc limit ${page.limit} offset ${page.offset}`;
    return rows.map(toSale);
  }

  async salesListSummary(f: SalesListFilter): Promise<SalesListSummary> {
    const sql = this.sql;
    const [r] = await sql`
      select ${sql.unsafe(SALES_TOTALS_SQL)}, count(distinct coalesce(s.cliente_final_ruc, s.ruc))::int as clientes
      from sales s left join companies cf on cf.id = s.cliente_final_company_id
      where ${this.salesListWhere(f)}`;
    const t = pgTotals(r);
    return {
      lineas: t.lineas,
      neumaticos: t.neumaticos,
      totalPen: fromTenThousandths(t.pen),
      totalUsd: fromTenThousandths(t.usd),
      margenPct: weightedMarginPct(t.mVenta, t.mCosto),
      clientes: Number(r?.clientes ?? 0),
      notasCredito: t.nc,
      notasCreditoPen: fromTenThousandths(t.ncPen),
    };
  }

  async salesListByClient(f: SalesListFilter, opts: { sort: SalesClientSort; dir: "asc" | "desc"; limit: number; offset: number }): Promise<{ rows: SalesListClientRow[]; total: number }> {
    const sql = this.sql;
    const dir = opts.dir === "asc" ? "asc" : "desc";
    const key: Record<SalesClientSort, string> = {
      neumaticos: `g.neum ${dir}`,
      total: `g.pen ${dir}`,
      ultima: `g.ultima ${dir}`,
      cliente: `translate(lower(coalesce(c.razon_social, g.doc_name, g.ruc)), '${SALES_FOLD_FROM}', '${SALES_FOLD_TO}') collate "C" ${dir}`,
      // sin margen (venta no positiva), al final en los dos sentidos
      margen: `case when g.m_venta > 0 then round((g.m_venta - g.m_costo) / g.m_venta, 10) end ${dir} nulls last`,
    };
    const rows = await sql`
      with g as (
        select coalesce(s.cliente_final_ruc, s.ruc) as ruc, ${sql.unsafe(SALES_TOTALS_SQL)}, max(s.fecha)::text as ultima,
          max(s.razon_social) filter (where s.cliente_final_ruc is null) as doc_name
        from sales s left join companies cf on cf.id = s.cliente_final_company_id
        where ${this.salesListWhere(f)}
        group by 1
      )
      select g.*, c.id as company_id, coalesce(c.razon_social, g.doc_name) as razon_social, count(*) over () as n
      from g left join companies c on c.ruc = g.ruc
      order by ${sql.unsafe(key[opts.sort])}, g.ruc collate "C" asc
      limit ${opts.limit} offset ${opts.offset}`;
    let total = Number(rows[0]?.n ?? 0);
    if (!rows.length && opts.offset > 0) {
      const [c] = await sql`select count(distinct coalesce(s.cliente_final_ruc, s.ruc))::int as n from sales s left join companies cf on cf.id = s.cliente_final_company_id where ${this.salesListWhere(f)}`;
      total = Number(c?.n ?? 0);
    }
    return {
      total,
      rows: rows.map((r) => {
        const t = pgTotals(r);
        return {
          ruc: String(r.ruc),
          companyId: num(r.company_id),
          razonSocial: str(r.razon_social),
          neumaticos: t.neumaticos,
          totalPen: fromTenThousandths(t.pen),
          totalUsd: fromTenThousandths(t.usd),
          margenPct: weightedMarginPct(t.mVenta, t.mCosto),
          ultimaFecha: String(r.ultima),
          lineas: t.lineas,
        };
      }),
    };
  }

  async salesFilterOptions(demo: boolean): Promise<{ marcas: string[]; vendedores: string[] }> {
    const sql = this.sql;
    const base = sql`from sales where is_demo = ${demo} and not excluida`;
    const [marcas, vendedores] = await Promise.all([
      sql`select distinct upper(btrim(marca)) as v ${base} and btrim(coalesce(marca, '')) <> ''`,
      sql`select distinct vendedor as v ${base} and btrim(coalesce(vendedor, '')) <> ''`,
    ]);
    const sorted = (rows: Row[]) => rows.map((r) => String(r.v)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { marcas: sorted(marcas), vendedores: sorted(vendedores) };
  }

  async recordSalesUpload(input: SalesUploadInput): Promise<SalesUpload> {
    const [r] = await this.sql`
      insert into sales_uploads (file_name, hash, formato, user_id, user_name, user_rol, inserted, updated, stats)
      values (${input.fileName}, ${input.hash}, ${input.formato}, ${input.userId}, ${input.userName}, ${input.userRol}, ${input.inserted}, ${input.updated},
        ${this.sql.json(input.stats as Parameters<typeof this.sql.json>[0])})
      returning *`;
    return toSalesUpload(r);
  }

  async listSalesUploads(limit = 20): Promise<SalesUpload[]> {
    const rows = await this.sql`select * from sales_uploads order by created_at desc, id desc limit ${limit}`;
    return rows.map(toSalesUpload);
  }

  async deleteDemoSales(): Promise<number> {
    const r = await this.sql`delete from sales where is_demo = true`;
    return r.count;
  }

  async countSalesBySource(sourceRef: string): Promise<{ total: number; firstAt: Date | null }> {
    const [r] = await this.sql`select count(*)::int as total, min(created_at) as first_at from sales where source_ref = ${sourceRef}`;
    return { total: Number(r?.total ?? 0), firstAt: date(r?.first_at) };
  }

  async countSales(): Promise<{ total: number; demo: number }> {
    const [r] = await this.sql`select count(*)::int as total, count(*) filter (where is_demo)::int as demo from sales`;
    return { total: Number(r?.total ?? 0), demo: Number(r?.demo ?? 0) };
  }

  async salesByRuc(ruc: string, since?: Date | IsoDate): Promise<Sale[]> {
    // corrida H: "order by fecha" era ambiguo (la columna y el alias fecha::text) y Postgres rechazaba la consulta: la
    // selección de encuestas (cron) y la encuesta manual fallaban. Se ordena por la columna de la tabla.
    const rows = since === undefined
      ? await this.sql`select *, fecha::text as fecha, vencimiento::text as vencimiento from sales where coalesce(cliente_final_ruc, ruc) = ${digits(ruc)} and not excluida order by sales.fecha desc, sales.id desc`
      : await this.sql`select *, fecha::text as fecha, vencimiento::text as vencimiento from sales where coalesce(cliente_final_ruc, ruc) = ${digits(ruc)} and not excluida and sales.fecha >= ${toIsoDate(since)}::date order by sales.fecha desc, sales.id desc`;
    return rows.map(toSale);
  }

  async participation(rucs: string[], since: Date | IsoDate): Promise<Record<string, Participation>> {
    const list = [...new Set(rucs.map(digits).filter(Boolean))];
    const out: Record<string, Participation> = {};
    if (!list.length) return out;
    const rows = await this.sql`
      select coalesce(cliente_final_ruc, ruc) as ruc, sum(cantidad)::float8 as cantidad, bool_or(is_demo) as demo from sales
      where cuenta_unidades and coalesce(cliente_final_ruc, ruc) in ${this.sql(list)} and fecha >= ${toIsoDate(since)}::date group by 1`;
    for (const r of rows) out[String(r.ruc)] = { cantidad: Number(r.cantidad), demo: Boolean(r.demo) };
    return out;
  }

  async salesAggregate(since: Date | IsoDate, until: Date | IsoDate): Promise<SalesAggRow[]> {
    const rows = await this.sql`
      select coalesce(cliente_final_ruc, ruc) as ruc, sales.fecha::text as fecha, vendedor, max(razon_social) as razon_social,
        sum(case when cuenta_unidades then cantidad else 0 end)::float8 as cantidad,
        coalesce(sum(coalesce(total, precio_unitario * cantidad)), 0)::float8 as monto,
        (count(*) filter (where total is null and precio_unitario is null))::int as sin_monto, bool_or(is_demo) as demo, count(*)::int as filas
      from sales where not excluida and sales.fecha >= ${toIsoDate(since)}::date and sales.fecha <= ${toIsoDate(until)}::date
      group by 1, sales.fecha, vendedor`;
    return rows.map((r) => ({
      ruc: String(r.ruc),
      fecha: String(r.fecha),
      vendedor: str(r.vendedor),
      razonSocial: str(r.razon_social),
      cantidad: Number(r.cantidad ?? 0),
      monto: Number(r.monto ?? 0),
      sinMonto: Number(r.sin_monto ?? 0),
      demo: Boolean(r.demo),
      filas: Number(r.filas ?? 0),
    }));
  }

  // ── usuarios y sesiones ──

  async upsertUser(input: UserInput): Promise<PortalUser> {
    const wa = digits(input.whatsapp);
    if (!wa) throw new Error("upsertUser: falta el número de WhatsApp");
    const [r] = await this.sql`
      insert into users (nombre, whatsapp, rol, activo, email, calendar_links)
      values (${input.nombre}, ${wa}, ${input.rol}, ${input.activo ?? true}, ${normEmail(input.email)}, ${input.calendarLinks ?? false})
      on conflict (whatsapp) do update set nombre = excluded.nombre, rol = excluded.rol,
        activo = ${input.activo === undefined ? this.sql`users.activo` : this.sql`excluded.activo`},
        email = ${input.email === undefined ? this.sql`users.email` : this.sql`excluded.email`},
        calendar_links = ${input.calendarLinks === undefined ? this.sql`users.calendar_links` : this.sql`excluded.calendar_links`}
      returning *`;
    return toUser(r);
  }

  async getUser(id: number): Promise<PortalUser | null> {
    const [r] = await this.sql`select * from users where id = ${id}`;
    return r ? toUser(r) : null;
  }

  async getUserByWhatsapp(whatsapp: string): Promise<PortalUser | null> {
    const wa = digits(whatsapp);
    if (!wa) return null;
    const [r] = await this.sql`select * from users where whatsapp = ${wa}`;
    return r ? toUser(r) : null;
  }

  async listUsers(): Promise<PortalUser[]> {
    const rows = await this.sql`select * from users order by id`;
    return rows.map(toUser);
  }

  async saveLoginToken(token: LoginToken): Promise<void> {
    await this.sql`
      insert into login_tokens (token_hash, user_id, expires_at, nonce) values (${token.tokenHash}, ${token.userId}, ${token.expiresAt}, ${token.nonce ?? null})
      on conflict (token_hash) do nothing`;
  }

  async consumeLoginToken(tokenHash: string, now: Date): Promise<number | null> {
    const [r] = await this.sql`
      update login_tokens set used_at = ${now}
      where token_hash = ${tokenHash} and used_at is null and expires_at > ${now}
      returning user_id`;
    return r ? Number(r.user_id) : null;
  }

  async createSession(session: { id: string; userId: number; expiresAt: Date }): Promise<PortalSession> {
    const [r] = await this.sql`
      insert into portal_sessions (id, user_id, expires_at) values (${session.id}, ${session.userId}, ${session.expiresAt})
      on conflict (id) do update set user_id = excluded.user_id, expires_at = excluded.expires_at
      returning *`;
    return toSession(r);
  }

  async currentLoginToken(userId: number, now: Date): Promise<CurrentLoginToken | null> {
    const [r] = await this.sql`
      select token_hash, nonce, expires_at from login_tokens
      where user_id = ${userId} and nonce is not null and expires_at > ${now}
      order by created_at desc, expires_at desc limit 1`;
    return r ? { tokenHash: String(r.token_hash), nonce: String(r.nonce), expiresAt: new Date(r.expires_at as string) } : null;
  }

  async extendLoginToken(tokenHash: string, expiresAt: Date): Promise<void> {
    await this.sql`update login_tokens set expires_at = ${expiresAt} where token_hash = ${tokenHash} and expires_at < ${expiresAt}`;
  }

  async peekLoginToken(tokenHash: string, now: Date): Promise<number | null> {
    const [r] = await this.sql`select user_id from login_tokens where token_hash = ${tokenHash} and expires_at > ${now}`;
    return r ? Number(r.user_id) : null;
  }

  useLoginTokenIntoSession(tokenHash: string, now: Date, session: { id: string; expiresAt: Date }): Promise<number | null> {
    return this.sql.begin(async (tx) => {
      const [t] = await tx`
        update login_tokens set used_at = coalesce(used_at, ${now})
        where token_hash = ${tokenHash} and expires_at > ${now}
        returning user_id`;
      if (!t) return null;
      await tx`
        insert into portal_sessions (id, user_id, expires_at) values (${session.id}, ${t.user_id}, ${session.expiresAt})
        on conflict (id) do update set user_id = excluded.user_id, expires_at = excluded.expires_at`;
      return Number(t.user_id);
    }) as Promise<number | null>;
  }

  async getSession(id: string, now: Date): Promise<PortalSession | null> {
    const [r] = await this.sql`select * from portal_sessions where id = ${id} and expires_at > ${now}`;
    return r ? toSession(r) : null;
  }

  async renewSession(id: string, expiresAt: Date): Promise<void> {
    await this.sql`update portal_sessions set expires_at = ${expiresAt} where id = ${id} and expires_at < ${expiresAt}`;
  }

  async deleteSession(id: string): Promise<void> {
    await this.sql`delete from portal_sessions where id = ${id}`;
  }

  revokeUserAccess(userId: number, now: Date): Promise<{ sessions: number; links: number }> {
    return this.sql.begin(async (tx) => {
      const sessions = await tx`delete from portal_sessions where user_id = ${userId} returning id`;
      const links = await tx`update login_tokens set expires_at = ${now} where user_id = ${userId} and expires_at > ${now} returning token_hash`;
      return { sessions: sessions.length, links: links.length };
    }) as Promise<{ sessions: number; links: number }>;
  }

  // ── contactos ──

  async addContact(input: ContactInput): Promise<Contact> {
    const [r] = await this.sql`
      insert into contacts (company_id, nombre, cargo, telefono, email, notas, created_by)
      values (${input.companyId}, ${input.nombre}, ${input.cargo ?? null}, ${input.telefono ?? null}, ${input.email ?? null}, ${input.notas ?? null}, ${input.createdBy ?? null})
      returning *`;
    return toContact(r);
  }

  async getContact(id: number): Promise<Contact | null> {
    const [r] = await this.sql`select * from contacts where id = ${id}`;
    return r ? toContact(r) : null;
  }

  async listContacts(companyId: number): Promise<Contact[]> {
    const rows = await this.sql`select * from contacts where company_id = ${companyId} order by id`;
    return rows.map(toContact);
  }

  async updateContact(id: number, patch: ContactPatch): Promise<Contact | null> {
    const cols = patchColumns(patch, CONTACT_COLS);
    const [r] = Object.keys(cols).length
      ? await this.sql`update contacts set ${this.sql(cols)}, updated_at = now() where id = ${id} returning *`
      : await this.sql`update contacts set updated_at = now() where id = ${id} returning *`;
    return r ? toContact(r) : null;
  }

  async deleteContact(id: number): Promise<boolean> {
    const r = await this.sql`delete from contacts where id = ${id}`;
    return r.count > 0;
  }

  // ── oportunidades ──

  createOpportunity(input: OpportunityInput): Promise<Opportunity> {
    return this.sql.begin((tx) => this.insertOpportunity(tx, input)) as Promise<Opportunity>;
  }

  async openOrCreateOpportunity(input: OpportunityInput): Promise<{ opportunity: Opportunity; created: boolean }> {
    return this.sql.begin(async (tx) => {
      // corrida H: bloqueo por empresa hasta el commit: dos asignaciones a la vez no crean dos oportunidades abiertas
      await tx`select pg_advisory_xact_lock(hashtext(${`opportunity-open:${input.companyId}`}))`;
      const [open] = await tx`
        select *, cierre_esperado::text as cierre_esperado from opportunities
        where company_id = ${input.companyId} and closed_at is null order by updated_at desc, id desc limit 1`;
      if (open) return { opportunity: toOpportunity(open), created: false };
      return { opportunity: await this.insertOpportunity(tx, input), created: true };
    }) as Promise<{ opportunity: Opportunity; created: boolean }>;
  }

  private async insertOpportunity(tx: postgres.TransactionSql, input: OpportunityInput): Promise<Opportunity> {
    const at = input.at ?? new Date();
    const etapa: StageId = input.etapa ?? "prospecto";
    const [r] = await tx`
      insert into opportunities (company_id, owner_user_id, etapa, probabilidad, monto_estimado, cierre_esperado, proxima_accion, proxima_accion_at, quote_number, created_at, updated_at, closed_at)
      values (${input.companyId}, ${input.ownerUserId ?? null}, ${etapa}, ${stageProbability(etapa)}, ${input.montoEstimado ?? null}, ${input.cierreEsperado ?? null},
        ${input.proximaAccion ?? null}, ${input.proximaAccionAt ?? null}, ${input.quoteNumber ?? null}, ${at}, ${at}, ${isClosedStage(etapa) ? at : null})
      returning *, cierre_esperado::text as cierre_esperado`;
    await tx`insert into opportunity_stage_history (opportunity_id, etapa, entered_at, changed_by) values (${r.id}, ${etapa}, ${at}, ${input.createdBy ?? null})`;
    return toOpportunity(r);
  }

  async getOpportunity(id: number): Promise<Opportunity | null> {
    const [r] = await this.sql`select *, cierre_esperado::text as cierre_esperado from opportunities where id = ${id}`;
    return r ? toOpportunity(r) : null;
  }

  async getOpenOpportunity(companyId: number, ownerId?: number): Promise<Opportunity | null> {
    const [first] = await this.listOpportunities({ companyId, ownerId, open: true });
    return first ?? null;
  }

  async listOpportunities(filter: OpportunityFilter = {}): Promise<Opportunity[]> {
    const sql = this.sql;
    const conds: Fragment[] = [];
    if (filter.ownerId !== undefined) conds.push(sql`owner_user_id = ${filter.ownerId}`);
    if (filter.companyId !== undefined) conds.push(sql`company_id = ${filter.companyId}`);
    if (filter.etapas?.length) conds.push(sql`etapa in ${sql(filter.etapas)}`);
    if (filter.open === true) conds.push(sql`closed_at is null`);
    if (filter.open === false) conds.push(sql`closed_at is not null`);
    const rows = await sql`select *, cierre_esperado::text as cierre_esperado from opportunities where ${where(sql, conds)} order by updated_at desc, id desc`;
    return rows.map(toOpportunity);
  }

  async moveStage(opportunityId: number, etapa: StageId, userId: number | null, at: Date = new Date()): Promise<Opportunity | null> {
    return this.sql.begin(async (tx) => {
      const [cur] = await tx`select *, cierre_esperado::text as cierre_esperado from opportunities where id = ${opportunityId} for update`;
      if (!cur) return null;
      if (cur.etapa === etapa) return toOpportunity(cur);
      await tx`update opportunity_stage_history set left_at = ${at} where opportunity_id = ${opportunityId} and left_at is null`;
      await tx`insert into opportunity_stage_history (opportunity_id, etapa, entered_at, changed_by) values (${opportunityId}, ${etapa}, ${at}, ${userId})`;
      const [r] = await tx`
        update opportunities set etapa = ${etapa}, probabilidad = ${stageProbability(etapa)}, updated_at = ${at}, closed_at = ${isClosedStage(etapa) ? at : null}
        where id = ${opportunityId} returning *, cierre_esperado::text as cierre_esperado`;
      return toOpportunity(r);
    }) as Promise<Opportunity | null>;
  }

  async updateOpportunity(id: number, patch: OpportunityPatch): Promise<Opportunity | null> {
    const cols = patchColumns(patch, OPPORTUNITY_COLS);
    const [r] = Object.keys(cols).length
      ? await this.sql`update opportunities set ${this.sql(cols)}, updated_at = now() where id = ${id} returning *, cierre_esperado::text as cierre_esperado`
      : await this.sql`update opportunities set updated_at = now() where id = ${id} returning *, cierre_esperado::text as cierre_esperado`;
    return r ? toOpportunity(r) : null;
  }

  async stageHistory(opportunityId: number): Promise<StageHistoryEntry[]> {
    const rows = await this.sql`select * from opportunity_stage_history where opportunity_id = ${opportunityId} order by entered_at asc, id asc`;
    return rows.map(toHistory);
  }

  async stageHistoryFor(opportunityIds: number[]): Promise<StageHistoryEntry[]> {
    const ids = [...new Set(opportunityIds)];
    if (!ids.length) return [];
    const rows = await this.sql`select * from opportunity_stage_history where opportunity_id in ${this.sql(ids)} order by opportunity_id asc, entered_at asc, id asc`;
    return rows.map(toHistory);
  }

  // ── actividades ──

  async addActivity(input: ActivityInput): Promise<Activity> {
    const [r] = await this.sql`
      insert into activities (company_id, opportunity_id, user_id, tipo, texto, canal, data, occurred_at)
      values (${input.companyId}, ${input.opportunityId ?? null}, ${input.userId ?? null}, ${input.tipo}, ${input.texto ?? ""}, ${input.canal ?? null},
        ${input.data ? this.sql.json(input.data as postgres.JSONValue) : null}, ${input.occurredAt ?? new Date()})
      returning *`;
    return toActivity(r);
  }

  async listActivities(filter: ActivityFilter = {}): Promise<Activity[]> {
    const sql = this.sql;
    const conds: Fragment[] = [];
    if (filter.companyId !== undefined) conds.push(sql`company_id = ${filter.companyId}`);
    if (filter.userId !== undefined) conds.push(sql`user_id = ${filter.userId}`);
    if (filter.opportunityId !== undefined) conds.push(sql`opportunity_id = ${filter.opportunityId}`);
    if (filter.since) conds.push(sql`occurred_at >= ${filter.since}`);
    if (filter.until) conds.push(sql`occurred_at < ${filter.until}`);
    const rows = filter.limit
      ? await sql`select * from activities where ${where(sql, conds)} order by occurred_at desc, id desc limit ${filter.limit}`
      : await sql`select * from activities where ${where(sql, conds)} order by occurred_at desc, id desc`;
    return rows.map(toActivity);
  }

  // ── citas ──

  async addAppointment(input: AppointmentInput): Promise<Appointment> {
    const [r] = await this.sql`
      insert into appointments (company_id, opportunity_id, user_id, starts_at, lugar, con_tecnico, notas, estado)
      values (${input.companyId}, ${input.opportunityId ?? null}, ${input.userId ?? null}, ${input.startsAt}, ${input.lugar ?? null}, ${input.conTecnico ?? false},
        ${input.notas ?? null}, ${input.estado ?? "programada"})
      returning *`;
    return toAppointment(r);
  }

  async getAppointment(id: number): Promise<Appointment | null> {
    const [r] = await this.sql`select * from appointments where id = ${id}`;
    return r ? toAppointment(r) : null;
  }

  async updateAppointment(id: number, patch: AppointmentPatch): Promise<Appointment | null> {
    const cols = patchColumns(patch, APPOINTMENT_COLS);
    if (!Object.keys(cols).length) return this.getAppointment(id);
    const [r] = await this.sql`update appointments set ${this.sql(cols)} where id = ${id} returning *`;
    return r ? toAppointment(r) : null;
  }

  async listAppointments(filter: AppointmentFilter = {}): Promise<Appointment[]> {
    const sql = this.sql;
    const conds: Fragment[] = [];
    if (filter.userId !== undefined) conds.push(sql`user_id = ${filter.userId}`);
    if (filter.companyId !== undefined) conds.push(sql`company_id = ${filter.companyId}`);
    if (filter.estado !== undefined) conds.push(sql`estado = ${filter.estado}`);
    if (filter.from) conds.push(sql`starts_at >= ${filter.from}`);
    if (filter.to) conds.push(sql`starts_at < ${filter.to}`);
    const rows = await sql`select * from appointments where ${where(sql, conds)} order by starts_at asc, id asc`;
    return rows.map(toAppointment);
  }

  // ── conversación del bot ──

  async getPortalConversation(phone: string): Promise<PortalConversation | null> {
    const key = digits(phone);
    if (!key) return null;
    const [r] = await this.sql`select * from portal_conversations where phone = ${key}`;
    if (!r) return null;
    const state = typeof r.state === "string" ? (JSON.parse(r.state) as Record<string, unknown>) : ((r.state as Record<string, unknown> | null) ?? {});
    return { phone: String(r.phone), state, updatedAt: date(r.updated_at)! };
  }

  async setPortalConversation(phone: string, state: Record<string, unknown> | null): Promise<void> {
    const key = digits(phone);
    if (!key) return;
    if (!state || Object.keys(state).length === 0) {
      await this.sql`delete from portal_conversations where phone = ${key}`;
      return;
    }
    await this.sql`
      insert into portal_conversations (phone, state, updated_at) values (${key}, ${this.sql.json(state as postgres.JSONValue)}::jsonb, now())
      on conflict (phone) do update set state = excluded.state, updated_at = now()`;
  }

  // ── encuesta de satisfacción (C3) ──

  async createSurvey(input: SurveyInput, opts: { onlyIfNoneSince?: Date } = {}): Promise<Survey | null> {
    const since = opts.onlyIfNoneSince;
    return this.sql.begin(async (tx) => {
      if (since) {
        // dos crons a la vez no crean dos encuestas para la misma empresa: bloqueo por empresa hasta el commit
        await tx`select pg_advisory_xact_lock(hashtext(${`surveys:${input.companyId}`}))`;
        // misma regla que surveyCounts (survey-shared.ts): no cuentan las nunca entregadas (vencidas o pendientes huérfanas)
        const orphanBefore = new Date((input.createdAt ?? new Date()).getTime() - ORPHAN_PENDING_MS);
        const [dup] = await tx`
          select id from surveys where company_id = ${input.companyId} and created_at >= ${since}
            and (enviada_at is not null or estado = 'respondida'
              or (estado <> 'vencida' and not (estado = 'pendiente' and created_at < ${orphanBefore}))) limit 1`;
        if (dup) return null;
      }
      const [r] = await tx`
        insert into surveys (company_id, contact_id, token_hash, estado, canal, created_by, expires_at, created_at)
        values (${input.companyId}, ${input.contactId ?? null}, ${input.tokenHash}, 'pendiente', ${input.canal}, ${input.createdBy ?? null},
          ${input.expiresAt}, ${input.createdAt ?? new Date()})
        returning *`;
      return toSurvey(r);
    }) as Promise<Survey | null>;
  }

  async getSurvey(id: number): Promise<Survey | null> {
    const [r] = await this.sql`select * from surveys where id = ${id}`;
    return r ? toSurvey(r) : null;
  }

  async getSurveyByTokenHash(tokenHash: string): Promise<Survey | null> {
    const [r] = await this.sql`select * from surveys where token_hash = ${tokenHash}`;
    return r ? toSurvey(r) : null;
  }

  private surveyConds(filter: SurveyFilter, dateCol: Fragment): Fragment[] {
    const sql = this.sql;
    const conds: Fragment[] = [];
    if (filter.companyId !== undefined) conds.push(sql`s.company_id = ${filter.companyId}`);
    if (filter.ownerUserId !== undefined) conds.push(sql`s.company_id in (select id from companies where owner_user_id = ${filter.ownerUserId})`);
    if (filter.since) conds.push(sql`${dateCol} >= ${filter.since}`);
    return conds;
  }

  async listSurveys(filter: SurveyFilter = {}): Promise<Survey[]> {
    const sql = this.sql;
    const conds = this.surveyConds(filter, sql`s.created_at`);
    const rows = await sql`
      select s.* from surveys s where ${where(sql, conds)} order by s.created_at desc, s.id desc
      ${filter.limit ? sql`limit ${filter.limit}` : sql``}`;
    return rows.map(toSurvey);
  }

  async markSurveySent(id: number, at: Date, canal?: SurveyCanal): Promise<Survey | null> {
    const [r] = await this.sql`
      update surveys set estado = 'enviada', enviada_at = ${at}, canal = coalesce(${canal ?? null}, canal)
      where id = ${id} and estado = 'pendiente' returning *`;
    return r ? toSurvey(r) : this.getSurvey(id);
  }

  async expireSurvey(id: number): Promise<Survey | null> {
    const [r] = await this.sql`update surveys set estado = 'vencida' where id = ${id} and estado in ('pendiente', 'enviada') returning *`;
    return r ? toSurvey(r) : this.getSurvey(id);
  }

  async answerSurvey(surveyId: number, answer: SurveyAnswerInput, now: Date): Promise<SurveyAnswerResult> {
    return this.sql.begin(async (tx) => {
      const [s] = await tx`select * from surveys where id = ${surveyId} for update`;
      if (!s) return { ok: false, reason: "no_existe" };
      if (s.estado === "respondida") return { ok: false, reason: "respondida" };
      if (s.estado === "vencida" || date(s.expires_at)!.getTime() <= now.getTime()) return { ok: false, reason: "vencida" };
      const [a] = await tx`
        insert into survey_answers (survey_id, nps, valora, satisfaccion_entrega, mejorar, referencia, created_at)
        values (${surveyId}, ${answer.nps}, ${tx.json(answer.valora)}::jsonb, ${answer.satisfaccionEntrega}, ${answer.mejorar}, ${answer.referencia}, ${now})
        on conflict (survey_id) do nothing returning *`;
      if (!a) return { ok: false, reason: "respondida" };
      const [u] = await tx`update surveys set estado = 'respondida', respondida_at = ${now} where id = ${surveyId} returning *`;
      return { ok: true, survey: toSurvey(u), answer: toSurveyAnswer(a) };
    }) as Promise<SurveyAnswerResult>;
  }

  async listSurveyResponses(filter: SurveyFilter = {}): Promise<SurveyResponse[]> {
    const sql = this.sql;
    const conds = this.surveyConds(filter, sql`a.created_at`);
    const rows = await sql`
      select a.*, s.company_id, s.contact_id, s.canal from survey_answers a join surveys s on s.id = a.survey_id
      where ${where(sql, conds)} order by a.created_at desc, a.id desc
      ${filter.limit ? sql`limit ${filter.limit}` : sql``}`;
    return rows.map((r) => ({ ...toSurveyAnswer(r), companyId: Number(r.company_id), contactId: num(r.contact_id), canal: r.canal as SurveyCanal }));
  }

  // ── vocabulario aprendido ──

  async listVocabulary(): Promise<VocabularyEntry[]> {
    const rows = await this.sql`select * from vocabulary order by created_at asc, id asc`;
    return rows.map(toVocabulary);
  }

  async addVocabulary(input: VocabularyInput): Promise<VocabularyEntry> {
    const term = input.term.trim();
    const meaning = input.meaning.trim();
    if (!term || !meaning) throw new Error("Vocabulario: término y significado son obligatorios");
    const [r] = await this.sql`
      insert into vocabulary (term, meaning, added_by) values (${term}, ${meaning}, ${input.addedBy ?? null})
      on conflict ((lower(term))) do update set meaning = excluded.meaning, added_by = excluded.added_by
      returning *`;
    return toVocabulary(r);
  }

  // ── registro de transcripciones de voz (corrida F, punto 9) ──

  async logVoiceTranscript(input: VoiceTranscriptInput): Promise<void> {
    await this.sql`
      insert into voice_transcripts (phone, user_id, context, transcript, understood, outcome, created_at)
      values (${input.phone}, ${input.userId ?? null}, ${input.context}, ${input.transcript}, ${this.sql.json(input.understood as unknown as postgres.JSONValue)}::jsonb, ${input.outcome}, ${input.createdAt ?? new Date()})`;
  }

  async listVoiceTranscripts(filter: VoiceTranscriptFilter = {}): Promise<VoiceTranscript[]> {
    const sql = this.sql;
    const rows = await sql`
      select * from voice_transcripts
      where true
        ${filter.since ? sql`and created_at >= ${filter.since}` : sql``}
        ${filter.until ? sql`and created_at < ${filter.until}` : sql``}
        ${filter.phone ? sql`and phone = ${filter.phone}` : sql``}
        ${filter.userId !== undefined ? sql`and user_id = ${filter.userId}` : sql``}
        ${filter.outcomes?.length ? sql`and outcome in ${sql(filter.outcomes)}` : sql``}
      order by created_at desc, id desc
      limit ${filter.limit ?? 50}`;
    return rows.map(toVoiceTranscript);
  }

  // ── órdenes de compra y memoria del pedido ──

  async addPurchaseOrder(input: PurchaseOrderInput): Promise<PurchaseOrder> {
    const [r] = await this.sql`
      insert into purchase_orders (company_id, opportunity_id, user_id, numero, quote_number, file_name, mime_type, data, status, created_at)
      values (${input.companyId}, ${input.opportunityId ?? null}, ${input.userId ?? null}, ${input.numero?.trim() || null}, ${input.quoteNumber ?? null},
        ${input.fileName ?? null}, ${input.mimeType ?? null}, ${input.data ?? null}, ${input.status ?? "recibida"}, ${input.createdAt ?? new Date()})
      returning *`;
    return toPurchaseOrder(r);
  }

  async getPurchaseOrder(id: number): Promise<PurchaseOrder | null> {
    const [r] = await this.sql`select * from purchase_orders where id = ${id}`;
    return r ? toPurchaseOrder(r) : null;
  }

  async updatePurchaseOrder(id: number, patch: PurchaseOrderPatch): Promise<PurchaseOrder | null> {
    const cols = patchColumns(patch, PURCHASE_ORDER_COLS);
    if (!Object.keys(cols).length) return this.getPurchaseOrder(id);
    const [r] = await this.sql`update purchase_orders set ${this.sql(cols)} where id = ${id} returning *`;
    return r ? toPurchaseOrder(r) : null;
  }

  async listPurchaseOrders(filter: PurchaseOrderFilter = {}): Promise<PurchaseOrderSummary[]> {
    const sql = this.sql;
    const conds: Fragment[] = [];
    if (filter.companyId !== undefined) conds.push(sql`company_id = ${filter.companyId}`);
    if (filter.userId !== undefined) conds.push(sql`user_id = ${filter.userId}`);
    if (filter.status !== undefined) conds.push(sql`status = ${filter.status}`);
    // sin `data` (el PDF en base64): los listados no lo necesitan
    const rows = await sql`
      select id, company_id, opportunity_id, user_id, numero, quote_number, file_name, mime_type, status, created_at
      from purchase_orders where ${where(sql, conds)} order by created_at desc, id desc`;
    return rows.map((r) => {
      const { data: _data, ...o } = toPurchaseOrder(r);
      return o;
    });
  }

  async getOrderProfile(companyId: number): Promise<CompanyOrderProfile | null> {
    const [r] = await this.sql`select * from company_order_profile where company_id = ${companyId}`;
    return r ? toOrderProfile(r) : null;
  }

  async setOrderProfile(companyId: number, data: Record<string, unknown>): Promise<CompanyOrderProfile> {
    const [r] = await this.sql`
      insert into company_order_profile (company_id, data, updated_at) values (${companyId}, ${this.sql.json(data as postgres.JSONValue)}::jsonb, now())
      on conflict (company_id) do update set data = excluded.data, updated_at = now()
      returning *`;
    return toOrderProfile(r);
  }

  // ── crédito (C4) ──

  async getCredit(companyId: number): Promise<CompanyCredit | null> {
    const [r] = await this.sql`select ${this.sql(CREDIT_COLS)} from company_credit where company_id = ${companyId}`;
    return r ? toCredit(r) : null;
  }

  async getCreditPdf(companyId: number): Promise<CreditPdf | null> {
    const [r] = await this.sql`select pdf_name, pdf_mime, pdf_data from company_credit where company_id = ${companyId}`;
    return r?.pdf_data && r.pdf_name ? { name: String(r.pdf_name), mime: str(r.pdf_mime) ?? "application/pdf", data: String(r.pdf_data) } : null;
  }

  async saveCredit(companyId: number, input: CreditSaveInput, userId: number | null, at: Date = new Date()): Promise<{ credit: CompanyCredit; entry: CreditHistoryEntry | null }> {
    return this.sql.begin(async (tx) => {
      // la empresa queda bloqueada hasta el commit: dos guardados a la vez no pisan el historial. Corrida H (test:pg): con
      // "for update" solo, el primer guardado no bloqueaba nada (la fila aún no existe) y dos a la vez dejaban dos entradas
      // "sin estado anterior"; el bloqueo por empresa cubre también ese caso.
      await tx`select pg_advisory_xact_lock(hashtext(${`credit:${companyId}`}))`;
      const [p] = await tx`select ${tx(CREDIT_COLS)} from company_credit where company_id = ${companyId} for update`;
      const prev = p ? toCredit(p) : null;
      const { credit: c, pdf, cambios } = resolveCreditSave(companyId, prev, input, userId, at);
      if (Object.keys(cambios).length === 0) return { credit: prev ?? c, entry: null };
      const keepPdf = pdf === undefined;
      const pdfData = pdf?.data ?? null;
      const [r] = await tx`
        insert into company_credit (company_id, estado, calificacion, linea, moneda, plazo_dias, fuente, consultado_at, consultado_por, pdf_name, pdf_mime, pdf_data, notas, updated_at, updated_by)
        values (${companyId}, ${c.estado}, ${c.calificacion}, ${c.linea}, ${c.moneda}, ${c.plazoDias}, ${c.fuente}, ${c.consultadoAt}, ${c.consultadoPor},
          ${c.pdfName}, ${c.pdfMime}, ${pdfData}, ${c.notas}, ${at}, ${userId})
        on conflict (company_id) do update set
          estado = excluded.estado, calificacion = excluded.calificacion, linea = excluded.linea, moneda = excluded.moneda,
          plazo_dias = excluded.plazo_dias, fuente = excluded.fuente, consultado_at = excluded.consultado_at, consultado_por = excluded.consultado_por,
          pdf_name = excluded.pdf_name, pdf_mime = excluded.pdf_mime,
          pdf_data = ${keepPdf ? tx`company_credit.pdf_data` : tx`excluded.pdf_data`},
          notas = excluded.notas, updated_at = excluded.updated_at, updated_by = excluded.updated_by
        returning ${tx(CREDIT_COLS)}`;
      const [h] = await tx`
        insert into company_credit_history (company_id, estado_anterior, estado_nuevo, cambios, user_id, created_at)
        values (${companyId}, ${prev?.estado ?? null}, ${c.estado}, ${tx.json(cambios as postgres.JSONValue)}::jsonb, ${userId}, ${at})
        returning *`;
      return { credit: toCredit(r), entry: toCreditHistory(h) };
    });
  }

  async creditHistory(companyId: number): Promise<CreditHistoryEntry[]> {
    const rows = await this.sql`select * from company_credit_history where company_id = ${companyId} order by created_at desc, id desc`;
    return rows.map(toCreditHistory);
  }

  // ── Match Venta (corrida K) ──
  // Una consulta por tabla (en serie). Los resultados se reemplazan enteros en una transacción con candado (dos cálculos a
  // la vez no dejan filas repetidas).

  async matchInputs(): Promise<MatchCompanyInput[]> {
    const sql = this.sql;
    const companies = await sql`
      select c.id, c.ruc, c.razon_social, c.sector, c.departamento, c.provincia, c.distrito, c.unidades, c.owner_user_id, c.es_cliente, cc.estado as credito
      from companies c left join company_credit cc on cc.company_id = c.id order by c.id`;
    const medidas = await sql`
      select company_id, medida_probable as medida, ejes, count(*)::int as n, coalesce(sum(llantas), 0)::int as llantas,
        (count(*) filter (where llantas is null))::int as sin
      from fleet_vehicles where medida_probable is not null group by 1, 2, 3`;
    const clases = await sql`select company_id, clase, count(*)::int as n from fleet_vehicles where clase is not null group by 1, 2`;
    const med = new Map<number, Record<string, MatchFleetSize>>();
    for (const m of medidas) {
      const id = Number(m.company_id);
      const o = med.get(id) ?? {};
      const f = (o[String(m.medida)] ??= { unidades: 0, llantas: 0, sinLlantas: {} });
      f.unidades += Number(m.n);
      f.llantas += Number(m.llantas);
      const sin = Number(m.sin);
      if (sin) {
        const k = m.ejes === null ? "?" : String(m.ejes);
        f.sinLlantas[k] = (f.sinLlantas[k] ?? 0) + sin;
      }
      med.set(id, o);
    }
    const cls = new Map<number, Record<string, number>>();
    for (const c of clases) {
      const id = Number(c.company_id);
      const o = cls.get(id) ?? {};
      o[String(c.clase)] = Number(c.n);
      cls.set(id, o);
    }
    return companies.map((c) => ({
      companyId: Number(c.id),
      ruc: String(c.ruc),
      razonSocial: String(c.razon_social ?? ""),
      sector: (c.sector as Sector | null) ?? null,
      departamento: str(c.departamento),
      provincia: str(c.provincia),
      distrito: str(c.distrito),
      unidades: Number(c.unidades ?? 0),
      ownerUserId: num(c.owner_user_id),
      esCliente: Boolean(c.es_cliente),
      credito: (str(c.credito) as CreditEstado | null) ?? null,
      medidas: med.get(Number(c.id)) ?? {},
      clases: cls.get(Number(c.id)) ?? {},
    }));
  }

  async listMatchProducts(): Promise<MatchProduct[]> {
    const rows = await this.sql`select * from match_products order by code`;
    return rows.map(toMatchProduct);
  }

  async seedMatchProducts(seeds: MatchProductSeed[], at: Date = new Date()): Promise<string[]> {
    const list = dedupeBy(
      seeds.map((s) => ({ ...s, code: matchCode(s.code) })).filter((s) => s.code),
      (s) => s.code,
    );
    if (!list.length) return [];
    return this.sql.begin(async (tx) => {
      const added: string[] = [];
      for (const s of list) {
        const [r] = await tx`
          insert into match_products (code, aplicacion, prioridad, prioridad_at, created_at, updated_at)
          values (${s.code}, ${s.aplicacion}, ${s.prioridad}, ${s.prioridad ? at : null}, ${at}, ${at})
          on conflict (code) do nothing returning code`;
        if (!r) continue;
        added.push(s.code);
        await tx`insert into match_priority_log (code, accion, user_id, detalle, created_at) values (${s.code}, 'sembrada', null, ${s.prioridad ? "prioridad" : null}, ${at})`;
      }
      return added;
    }) as Promise<string[]>;
  }

  async setMatchPriority(rawCode: string, on: boolean, input: MatchPriorityInput): Promise<MatchProduct | null> {
    const code = matchCode(rawCode);
    const at = input.at ?? new Date();
    return this.sql.begin(async (tx) => {
      // una sola sentencia: con onlyIfOn, solo el primero que la encuentra prendida la apaga (un solo aviso)
      const [r] = input.onlyIfOn
        ? await tx`
            update match_products set prioridad = false, sin_stock_at = ${input.accion === "sin_stock" ? at : null}, updated_at = ${at}
            where code = ${code} and prioridad returning *`
        : on
          ? await tx`
              insert into match_products (code, prioridad, prioridad_at, prioridad_by, sin_stock_at, created_at, updated_at)
              values (${code}, true, ${at}, ${input.userId}, null, ${at}, ${at})
              on conflict (code) do update set prioridad = true, prioridad_at = ${at}, prioridad_by = ${input.userId}, sin_stock_at = null, updated_at = ${at}
              returning *`
          : await tx`
              insert into match_products (code, prioridad, sin_stock_at, created_at, updated_at)
              values (${code}, false, ${input.accion === "sin_stock" ? at : null}, ${at}, ${at})
              on conflict (code) do update set prioridad = false,
                sin_stock_at = ${input.accion === "sin_stock" ? at : null}, updated_at = ${at}
              returning *`;
      if (!r) return null;
      await tx`insert into match_priority_log (code, accion, user_id, detalle, created_at) values (${code}, ${input.accion}, ${input.userId}, ${input.detalle ?? null}, ${at})`;
      return toMatchProduct(r);
    }) as Promise<MatchProduct | null>;
  }

  async setMatchApplication(rawCode: string, aplicacion: string | null, userId: number | null, at: Date = new Date()): Promise<MatchProduct> {
    const code = matchCode(rawCode);
    const value = aplicacion?.trim() || null;
    return this.sql.begin(async (tx) => {
      const [r] = await tx`
        insert into match_products (code, aplicacion, created_at, updated_at) values (${code}, ${value}, ${at}, ${at})
        on conflict (code) do update set aplicacion = ${value}, updated_at = ${at} returning *`;
      await tx`insert into match_priority_log (code, accion, user_id, detalle, created_at) values (${code}, 'aplicacion', ${userId}, ${value}, ${at})`;
      return toMatchProduct(r);
    }) as Promise<MatchProduct>;
  }

  async matchPriorityLog(code?: string): Promise<MatchPriorityLogEntry[]> {
    const rows = code
      ? await this.sql`select * from match_priority_log where code = ${matchCode(code)} order by created_at desc, id desc`
      : await this.sql`select * from match_priority_log order by created_at desc, id desc`;
    return rows.map((r) => ({ id: Number(r.id), code: String(r.code), accion: String(r.accion) as MatchPriorityAction, userId: num(r.user_id), detalle: str(r.detalle), createdAt: date(r.created_at)! }));
  }

  async saveMatchRun(run: MatchRunInput, rows: MatchResultInput[]): Promise<MatchRun> {
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('match_results'))`;
      const [r] = await tx`
        insert into match_runs (run_at, motivo, productos, empresas, filas, duracion_ms, data)
        values (${run.runAt ?? new Date()}, ${run.motivo}, ${run.productos}, ${run.empresas}, ${run.filas}, ${run.duracionMs}, ${JSON.stringify(run.data)}::jsonb)
        returning *`;
      const runId = Number(r.id);
      await tx`delete from match_results`;
      for (let i = 0; i < rows.length; i += MATCH_BATCH) {
        const b = rows.slice(i, i + MATCH_BATCH);
        await tx`
          insert into match_results (run_id, product_code, medida, company_id, ruc, razon_social, tipo, pct, llantas_medida, unidades_medida, podria_llevar, ya_compro, excluida, detalle)
          select ${runId}, v.code, v.medida, v.company_id, v.ruc, v.razon, v.tipo, v.pct, v.llantas, v.unidades, v.podria, v.compro, v.excluida, v.detalle::jsonb
          from unnest(${tx.array(b.map((x) => matchCode(x.productCode)))}::text[], ${tx.array(b.map((x) => x.medida))}::text[],
            ${tx.array(b.map((x) => x.companyId))}::int[], ${tx.array(b.map((x) => x.ruc))}::text[], ${tx.array(b.map((x) => x.razonSocial))}::text[],
            ${tx.array(b.map((x) => x.tipo))}::text[], ${tx.array(b.map((x) => x.pct))}::int[], ${tx.array(b.map((x) => x.llantasMedida))}::int[],
            ${tx.array(b.map((x) => x.unidadesMedida))}::int[], ${tx.array(b.map((x) => x.podriaLlevar))}::int[], ${tx.array(b.map((x) => x.yaCompro))}::boolean[],
            ${tx.array(b.map((x) => x.excluida))}::text[], ${tx.array(b.map((x) => JSON.stringify(x.detalle)))}::text[])
            as v(code, medida, company_id, ruc, razon, tipo, pct, llantas, unidades, podria, compro, excluida, detalle)`;
      }
      return toMatchRun(r);
    }) as Promise<MatchRun>;
  }

  async latestMatchRun(): Promise<MatchRun | null> {
    const [r] = await this.sql`select * from match_runs order by id desc limit 1`;
    return r ? toMatchRun(r) : null;
  }

  async listMatchResults(q: MatchResultQuery = {}): Promise<MatchResultView[]> {
    return (await this.matchRows(q, true)) as MatchResultView[];
  }

  async listMatchSummaries(q: MatchResultQuery = {}): Promise<MatchResultSummary[]> {
    return (await this.matchRows(q, false)) as MatchResultSummary[];
  }

  private async matchRows(q: MatchResultQuery, withDetail: boolean): Promise<(MatchResultSummary | MatchResultView)[]> {
    const sql = this.sql;
    const conds: Fragment[] = [];
    if (q.productCodes) conds.push(sql`r.product_code in ${sql(q.productCodes.length ? q.productCodes.map(matchCode) : [""])}`);
    if (q.companyIds) conds.push(sql`r.company_id in ${sql(q.companyIds.length ? q.companyIds : [-1])}`);
    if (q.tipos) conds.push(sql`r.tipo in ${sql(q.tipos.length ? q.tipos : [""])}`);
    if (q.ids) conds.push(sql`r.id in ${sql(q.ids.length ? q.ids : [-1])}`);
    if (q.minPct !== undefined) conds.push(sql`(r.pct is null or r.pct >= ${q.minPct} or r.ya_compro)`);
    // última actividad por empresa: agregada una vez (no una subconsulta por fila)
    const rows = await sql`
      select r.id, r.run_id, r.product_code, r.medida, r.company_id, r.ruc, r.razon_social, r.tipo, r.pct, r.llantas_medida, r.unidades_medida,
        r.podria_llevar, r.ya_compro, r.excluida, ${withDetail ? sql`r.detalle,` : sql``}
        c.owner_user_id, c.es_cliente, c.sector, c.departamento, c.provincia, c.distrito, c.direccion, c.unidades, cc.estado as credito, a.last as last_activity_at,
        ${sunatCols(sql)}
      from match_results r
      left join companies c on c.id = r.company_id
      left join sunat_padron s on s.ruc = r.ruc
      left join company_credit cc on cc.company_id = r.company_id
      left join (select company_id, max(occurred_at) as last from activities group by company_id) a on a.company_id = r.company_id
      where ${where(sql, conds)} order by r.id`;
    return rows.map((r) => ({
      id: Number(r.id),
      productCode: String(r.product_code),
      medida: String(r.medida),
      companyId: num(r.company_id),
      ruc: String(r.ruc),
      razonSocial: String(r.razon_social ?? ""),
      tipo: String(r.tipo) as MatchTipo,
      pct: num(r.pct),
      llantasMedida: Number(r.llantas_medida ?? 0),
      unidadesMedida: Number(r.unidades_medida ?? 0),
      podriaLlevar: num(r.podria_llevar),
      yaCompro: Boolean(r.ya_compro),
      excluida: (str(r.excluida) as MatchExclusion | null) ?? null,
      ...(withDetail ? { detalle: jsonOf<MatchDetail>(r.detalle)! } : {}),
      ownerUserId: num(r.owner_user_id),
      esCliente: Boolean(r.es_cliente),
      credito: (str(r.credito) as CreditEstado | null) ?? null,
      sector: (r.sector as Sector | null) ?? null,
      departamento: str(r.departamento),
      provincia: str(r.provincia),
      distrito: str(r.distrito),
      direccion: str(r.direccion),
      unidades: Number(r.unidades ?? 0),
      lastActivityAt: date(r.last_activity_at),
      sunat: toSunatBrief(r),
    }));
  }

  async addMatchVisit(input: MatchVisitInput): Promise<MatchVisit> {
    const [r] = await this.sql`
      insert into match_visits (appointment_id, company_id, user_id, product_code, motivo)
      values (${input.appointmentId}, ${input.companyId}, ${input.userId}, ${matchCode(input.productCode)}, ${input.motivo})
      on conflict (appointment_id) do nothing returning *`;
    if (r) return toMatchVisit(r);
    const [e] = await this.sql`select * from match_visits where appointment_id = ${input.appointmentId}`;
    return toMatchVisit(e);
  }

  async listMatchVisits(f: MatchVisitFilter = {}): Promise<MatchVisit[]> {
    const sql = this.sql;
    const conds: Fragment[] = [];
    if (f.userId !== undefined) conds.push(sql`user_id = ${f.userId}`);
    if (f.companyId !== undefined) conds.push(sql`company_id = ${f.companyId}`);
    if (f.productCode !== undefined) conds.push(sql`product_code = ${matchCode(f.productCode)}`);
    if (f.appointmentIds) conds.push(sql`appointment_id in ${sql(f.appointmentIds.length ? f.appointmentIds : [-1])}`);
    if (f.pending) conds.push(sql`activity_id is null`);
    const rows = await sql`select * from match_visits where ${where(sql, conds)} order by id`;
    return rows.map(toMatchVisit);
  }

  async markMatchVisitReported(id: number, activityId: number, at: Date = new Date()): Promise<MatchVisit | null> {
    const [r] = await this.sql`update match_visits set activity_id = ${activityId}, reported_at = ${at} where id = ${id} and activity_id is null returning *`;
    return r ? toMatchVisit(r) : null;
  }

  // ── Corrida L: SUNAT ──

  async upsertSunat(rows: SunatRecordInput[]): Promise<{ inserted: number; updated: number }> {
    const list = dedupeBy(
      rows.map((r) => ({ ...r, ruc: digits(r.ruc) })).filter((r) => r.ruc),
      (r) => r.ruc,
    );
    let inserted = 0;
    let updated = 0;
    for (let i = 0; i < list.length; i += SUNAT_BATCH) {
      const b = list.slice(i, i + SUNAT_BATCH);
      const sql = this.sql;
      const out = await sql`
        insert into sunat_padron (ruc, encontrado, razon_social, estado, condicion, ubigeo, departamento, provincia, distrito, direccion, piezas, anexos, fecha, updated_at)
        select v.ruc, v.enc, v.razon, v.estado, v.cond, v.ubigeo, v.dep, v.prov, v.dist, v.dir, v.piezas::jsonb, v.anexos, v.fecha::date, now()
        from unnest(${sql.array(b.map((x) => x.ruc))}::text[], ${sql.array(b.map((x) => x.encontrado))}::boolean[], ${sql.array(b.map((x) => x.razonSocial))}::text[],
          ${sql.array(b.map((x) => x.estado))}::text[], ${sql.array(b.map((x) => x.condicion))}::text[], ${sql.array(b.map((x) => x.ubigeo))}::text[],
          ${sql.array(b.map((x) => x.departamento))}::text[], ${sql.array(b.map((x) => x.provincia))}::text[], ${sql.array(b.map((x) => x.distrito))}::text[],
          ${sql.array(b.map((x) => x.direccion))}::text[], ${sql.array(b.map((x) => (x.piezas ? JSON.stringify(x.piezas) : null)))}::text[],
          ${sql.array(b.map((x) => x.anexos))}::int[], ${sql.array(b.map((x) => x.fecha))}::text[])
          as v(ruc, enc, razon, estado, cond, ubigeo, dep, prov, dist, dir, piezas, anexos, fecha)
        on conflict (ruc) do update set encontrado = excluded.encontrado, razon_social = excluded.razon_social, estado = excluded.estado,
          condicion = excluded.condicion, ubigeo = excluded.ubigeo, departamento = excluded.departamento, provincia = excluded.provincia,
          distrito = excluded.distrito, direccion = excluded.direccion, piezas = excluded.piezas, anexos = excluded.anexos, fecha = excluded.fecha,
          updated_at = now()
        returning (xmax = 0) as inserted`;
      for (const r of out) if (r.inserted) inserted++;
      updated += out.length - out.filter((r) => r.inserted).length;
    }
    return { inserted, updated };
  }

  async replaceSunatLocales(rucs: string[], rows: SunatLocalInput[]): Promise<{ removed: number; inserted: number }> {
    const keys = [...new Set(rucs.map(digits).filter(Boolean))];
    return this.sql.begin(async (tx) => {
      let removed = 0;
      for (let i = 0; i < keys.length; i += SUNAT_BATCH) {
        const r = await tx`delete from sunat_locales where ruc in ${tx(keys.slice(i, i + SUNAT_BATCH))}`;
        removed += r.count;
      }
      for (let i = 0; i < rows.length; i += SUNAT_BATCH) {
        const b = rows.slice(i, i + SUNAT_BATCH);
        await tx`
          insert into sunat_locales (ruc, ubigeo, departamento, provincia, distrito, direccion, piezas, fecha)
          select v.ruc, v.ubigeo, v.dep, v.prov, v.dist, v.dir, v.piezas::jsonb, v.fecha::date
          from unnest(${tx.array(b.map((x) => digits(x.ruc)))}::text[], ${tx.array(b.map((x) => x.ubigeo))}::text[], ${tx.array(b.map((x) => x.departamento))}::text[],
            ${tx.array(b.map((x) => x.provincia))}::text[], ${tx.array(b.map((x) => x.distrito))}::text[], ${tx.array(b.map((x) => x.direccion))}::text[],
            ${tx.array(b.map((x) => JSON.stringify(x.piezas)))}::text[], ${tx.array(b.map((x) => x.fecha))}::text[])
            as v(ruc, ubigeo, dep, prov, dist, dir, piezas, fecha)`;
      }
      return { removed, inserted: rows.length };
    }) as Promise<{ removed: number; inserted: number }>;
  }

  async getSunat(ruc: string): Promise<SunatRecord | null> {
    const [r] = await this.sql`select *, to_char(fecha, 'YYYY-MM-DD') as fecha_text from sunat_padron where ruc = ${digits(ruc)}`;
    return r ? toSunatRecord(r) : null;
  }

  async getSunatByRucs(rucs: string[]): Promise<SunatRecord[]> {
    const list = [...new Set(rucs.map(digits).filter(Boolean))];
    const out: SunatRecord[] = [];
    for (let i = 0; i < list.length; i += BATCH) {
      const rows = await this.sql`select *, to_char(fecha, 'YYYY-MM-DD') as fecha_text from sunat_padron where ruc in ${this.sql(list.slice(i, i + BATCH))}`;
      for (const r of rows) out.push(toSunatRecord(r));
    }
    return out;
  }

  async listSunatLocales(ruc: string): Promise<SunatLocal[]> {
    // mismo orden que el store JSON (comparación por código de carácter, sin colación)
    const rows = await this.sql`
      select *, to_char(fecha, 'YYYY-MM-DD') as fecha_text from sunat_locales where ruc = ${digits(ruc)}
      order by ubigeo collate "C" nulls last, direccion collate "C" nulls last, id`;
    return rows.map(toSunatLocal);
  }

  async listPortalRucs(): Promise<PortalRuc[]> {
    const companies = await this.sql`select ruc, razon_social, origen from companies`;
    const out = new Map<string, PortalRuc>();
    for (const c of companies) out.set(String(c.ruc), { ruc: String(c.ruc), razonSocial: String(c.razon_social ?? ""), fuente: c.origen === "manual" ? "manual" : "padron" });
    // ventas reales (sin demo): el RUC de la línea y su cliente final; la razón social de la venta más reciente
    const sales = await this.sql`
      select distinct on (x.ruc) x.ruc, x.razon from (
        select ruc, razon_social as razon, fecha, id, 0 as k from sales where not is_demo
        union all
        select cliente_final_ruc, null, fecha, id, 1 from sales where not is_demo and cliente_final_ruc is not null
      ) x where x.ruc ~ '^[0-9]{11}$'
      order by x.ruc, x.fecha desc, x.id desc, x.k`;
    for (const s of sales) {
      const ruc = String(s.ruc);
      if (!out.has(ruc)) out.set(ruc, { ruc, razonSocial: String(s.razon ?? ""), fuente: "ventas" });
    }
    return [...out.values()].sort((a, b) => (a.ruc < b.ruc ? -1 : a.ruc > b.ruc ? 1 : 0));
  }

  async listDistritos(q: { departamento?: string } = {}): Promise<DistritoCount[]> {
    const sql = this.sql;
    // agrupado en la base (cientos de filas, no una por empresa); la regla de la ubicación efectiva queda en distritoCounts
    const rows = await sql`
      select c.departamento, c.provincia, c.distrito, s.ruc is not null as s_has, s.ubigeo as s_ubigeo, s.departamento as s_departamento,
        s.provincia as s_provincia, s.distrito as s_distrito, count(*)::int as n
      from companies c left join sunat_padron s on s.ruc = c.ruc
      where c.distrito is not null or s.distrito is not null
      group by 1, 2, 3, 4, 5, 6, 7, 8`;
    const brief = (r: Row): SunatBrief | null =>
      r.s_has ? { encontrado: true, estado: null, condicion: null, ubigeo: str(r.s_ubigeo), departamento: str(r.s_departamento), provincia: str(r.s_provincia), distrito: str(r.s_distrito), direccion: null, anexos: 0, fecha: "" } : null;
    return distritoCounts(
      rows.map((r) => ({ company: { departamento: str(r.departamento), provincia: str(r.provincia), distrito: str(r.distrito) }, sunat: brief(r), n: Number(r.n) })),
      q.departamento,
    );
  }
}

function toMatchProduct(r: Row): MatchProduct {
  return {
    code: String(r.code),
    aplicacion: str(r.aplicacion),
    prioridad: Boolean(r.prioridad),
    prioridadAt: date(r.prioridad_at),
    prioridadBy: num(r.prioridad_by),
    sinStockAt: date(r.sin_stock_at),
    createdAt: date(r.created_at)!,
    updatedAt: date(r.updated_at)!,
  };
}

function toMatchRun(r: Row): MatchRun {
  return {
    id: Number(r.id),
    runAt: date(r.run_at)!,
    motivo: String(r.motivo ?? ""),
    productos: Number(r.productos ?? 0),
    empresas: Number(r.empresas ?? 0),
    filas: Number(r.filas ?? 0),
    duracionMs: Number(r.duracion_ms ?? 0),
    data: jsonOf<Record<string, unknown>>(r.data) ?? {},
  };
}

function toMatchVisit(r: Row): MatchVisit {
  return {
    id: Number(r.id),
    appointmentId: Number(r.appointment_id),
    companyId: Number(r.company_id),
    userId: num(r.user_id),
    productCode: String(r.product_code),
    motivo: str(r.motivo),
    activityId: num(r.activity_id),
    reportedAt: date(r.reported_at),
    createdAt: date(r.created_at)!,
  };
}

/** Columnas de company_credit sin pdf_data (el PDF en base64 solo lo lee getCreditPdf). */
const CREDIT_COLS = ["company_id", "estado", "calificacion", "linea", "moneda", "plazo_dias", "fuente", "consultado_at", "consultado_por", "pdf_name", "pdf_mime", "notas", "updated_at", "updated_by"];

function toCredit(r: Row): CompanyCredit {
  return {
    companyId: Number(r.company_id),
    estado: String(r.estado ?? "sin_evaluar") as CreditEstado,
    calificacion: str(r.calificacion),
    linea: num(r.linea),
    moneda: str(r.moneda),
    plazoDias: num(r.plazo_dias),
    fuente: str(r.fuente),
    consultadoAt: date(r.consultado_at),
    consultadoPor: num(r.consultado_por),
    pdfName: str(r.pdf_name),
    pdfMime: str(r.pdf_mime),
    notas: str(r.notas),
    updatedAt: date(r.updated_at)!,
    updatedBy: num(r.updated_by),
  };
}

function toCreditHistory(r: Row): CreditHistoryEntry {
  const cambios = typeof r.cambios === "string" ? (JSON.parse(r.cambios) as CreditChanges) : ((r.cambios as CreditChanges | null) ?? {});
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    estadoAnterior: (str(r.estado_anterior) as CreditEstado | null) ?? null,
    estadoNuevo: String(r.estado_nuevo) as CreditEstado,
    cambios,
    userId: num(r.user_id),
    createdAt: date(r.created_at)!,
  };
}

function toSurvey(r: Row): Survey {
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    contactId: num(r.contact_id),
    tokenHash: String(r.token_hash),
    estado: r.estado as SurveyEstado,
    canal: r.canal as SurveyCanal,
    createdBy: num(r.created_by),
    enviadaAt: date(r.enviada_at),
    respondidaAt: date(r.respondida_at),
    expiresAt: date(r.expires_at)!,
    createdAt: date(r.created_at)!,
  };
}

function toSurveyAnswer(r: Row): SurveyAnswer {
  return {
    id: Number(r.id),
    surveyId: Number(r.survey_id),
    nps: Number(r.nps),
    valora: valoraList(r.valora),
    satisfaccionEntrega: num(r.satisfaccion_entrega),
    mejorar: str(r.mejorar),
    referencia: r.referencia === null || r.referencia === undefined ? null : Boolean(r.referencia),
    createdAt: date(r.created_at)!,
  };
}

function toPurchaseOrder(r: Row): PurchaseOrder {
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    opportunityId: num(r.opportunity_id),
    userId: num(r.user_id),
    numero: str(r.numero),
    quoteNumber: str(r.quote_number),
    fileName: str(r.file_name),
    mimeType: str(r.mime_type),
    data: str(r.data),
    status: String(r.status ?? "recibida"),
    createdAt: date(r.created_at)!,
  };
}

function toOrderProfile(r: Row): CompanyOrderProfile {
  const data = typeof r.data === "string" ? (JSON.parse(r.data) as Record<string, unknown>) : ((r.data as Record<string, unknown> | null) ?? {});
  return { companyId: Number(r.company_id), data, updatedAt: date(r.updated_at)! };
}

function toVoiceTranscript(r: Row): VoiceTranscript {
  const u = (typeof r.understood === "string" ? JSON.parse(r.understood) : r.understood) as VoiceUnderstood;
  return { id: Number(r.id), phone: String(r.phone), userId: num(r.user_id), context: String(r.context), transcript: String(r.transcript), understood: u, outcome: String(r.outcome) as VoiceOutcome, createdAt: date(r.created_at)! };
}

function toVocabulary(r: Row): VocabularyEntry {
  return { id: Number(r.id), term: String(r.term), meaning: String(r.meaning), addedBy: num(r.added_by), createdAt: date(r.created_at)! };
}
