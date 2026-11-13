/**
 * PortalStore en Postgres (Supabase) con la lib `postgres`. Tablas: `npm run db:migrate`.
 * El import masivo usa inserciones por lotes (`sql(rows, cols)`) con `on conflict`.
 */
import postgres from "postgres";
import { isClosedStage, stageProbability, type StageId } from "../stages";
import { dedupeBy, defaultSince, digits, foldText, groupFleet, normMarca, pageOf, toIsoDate, type FleetAggRow } from "./shared";
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
} from "./types";

import { resolveCreditSave } from "../credit/changes";
import type { CompanyCredit, CreditChanges, CreditEstado, CreditHistoryEntry, CreditPdf, CreditSaveInput } from "./types";

import { ORPHAN_PENDING_MS, valoraList } from "./survey-shared";
import type { Survey, SurveyAnswer, SurveyAnswerInput, SurveyAnswerResult, SurveyCanal, SurveyEstado, SurveyFilter, SurveyInput, SurveyResponse } from "./types";

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;
type Fragment = postgres.PendingQuery<postgres.Row[]>;

const BATCH = 1000;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const date = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));
const normPlaca = (p: string) => p.trim().toUpperCase().replace(/\s+/g, "");

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
    creditTermsDays: num(r.credit_terms_days),
    createdAt: date(r.created_at)!,
    updatedAt: date(r.updated_at)!,
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
  };
}

function toUser(r: Row): PortalUser {
  return { id: Number(r.id), nombre: String(r.nombre), whatsapp: str(r.whatsapp), rol: r.rol as UserRole, activo: Boolean(r.activo), createdAt: date(r.created_at)! };
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

/** Mismo plegado que foldText(): minúsculas y sin tildes. */
const FOLD_FROM = "áàäâãéèëêíìïîóòöôõúùüûñç";
const FOLD_TO = "aaaaaeeeeiiiiooooouuuunc";

export class PgPortalStore implements PortalStore {
  private constructor(private sql: Sql) {}

  static connect(url: string): PgPortalStore {
    // prepare:false: pooler de Supabase. connect_timeout: si la base no contesta en 10 s, falla (el bot sigue con el
    // cotizador); idle_timeout libera conexiones ociosas de la función; max 3 por instancia.
    return new PgPortalStore(postgres(url, { prepare: false, max: 3, connect_timeout: 10, idle_timeout: 20, onnotice: () => undefined }));
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
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
      const sig = Object.keys(rec).join(",");
      const list = groups.get(sig);
      if (list) list.push(rec);
      else groups.set(sig, [rec]);
    }
    const sql = this.sql;
    for (const [sig, recs] of groups) {
      const cols = sig.split(",");
      const set = cols
        .filter((c) => c !== "ruc")
        .reduce((acc, c) => sql`${acc}, ${sql(c)} = excluded.${sql(c)}`, sql`updated_at = now()`);
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
    return res;
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

  setOwner(companyId: number, userId: number | null): Promise<Company | null> {
    return this.updateCompany(companyId, { ownerUserId: userId });
  }

  async searchCompanies(opts: CompanySearch = {}): Promise<CompanySearchResult> {
    const sql = this.sql;
    const since = opts.since !== undefined ? toIsoDate(opts.since) : defaultSince(opts.now);
    const conds: Fragment[] = [];
    const q = foldText(opts.q);
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      const byName = sql`translate(lower(c.razon_social), ${FOLD_FROM}, ${FOLD_TO}) like ${like}`;
      conds.push(/^\d+$/.test(q) ? sql`(${byName} or c.ruc like ${`${q}%`})` : byName);
    }
    if (opts.departamento?.length) conds.push(sql`c.departamento in ${sql(opts.departamento)}`);
    if (opts.sector?.length) conds.push(sql`c.sector in ${sql(opts.sector)}`);
    if (opts.minUnits !== undefined) conds.push(sql`c.unidades >= ${opts.minUnits}`);
    if (opts.maxUnits !== undefined) conds.push(sql`c.unidades <= ${opts.maxUnits}`);
    if (opts.esCliente !== undefined) conds.push(sql`c.es_cliente = ${opts.esCliente}`);
    if (opts.ownerUserId !== undefined) conds.push(sql`c.owner_user_id = ${opts.ownerUserId}`);
    if (opts.marcas?.length) {
      const marcas = [...new Set(opts.marcas.map(normMarca))];
      conds.push(sql`exists (select 1 from fleet_vehicles f where f.company_id = c.id and upper(trim(f.marca)) in ${sql(marcas)})`);
    }
    const orderCol = opts.orderBy === "llantas" ? sql`c.llantas_piso` : opts.orderBy === "participacion" ? sql`coalesce(p.cantidad, 0)` : sql`c.unidades`;
    const { pageSize, offset } = pageOf(opts.page, opts.pageSize);
    const rows = await sql`
      with p as (
        select ruc, sum(cantidad)::float8 as cantidad, bool_or(is_demo) as demo from sales where fecha >= ${since}::date group by ruc
      )
      select c.*, coalesce(p.cantidad, 0) as participacion, coalesce(p.demo, false) as participacion_demo, count(*) over () as total_count
      from companies c left join p on p.ruc = c.ruc
      where ${where(sql, conds)}
      order by ${orderCol} desc, c.razon_social asc, c.id asc
      limit ${pageSize} offset ${offset}`;
    let total = rows.length ? Number(rows[0].total_count) : 0;
    if (!rows.length && offset > 0) {
      const [{ n }] = await sql`select count(*)::int as n from companies c where ${where(sql, conds)}`;
      total = Number(n);
    }
    return {
      rows: rows.map((r): CompanyRow => ({ ...toCompany(r), participacion: Number(r.participacion), participacionDemo: Boolean(r.participacion_demo) })),
      total,
    };
  }

  async listMarcas(): Promise<MarcaCount[]> {
    const rows = await this.sql`
      select upper(trim(marca)) as marca, count(*)::int as vehiculos, count(distinct company_id)::int as empresas
      from fleet_vehicles where marca is not null and trim(marca) <> ''
      group by 1 order by vehiculos desc, marca asc`;
    return rows.map((r) => ({ marca: String(r.marca).replace(/\s+/g, " "), vehiculos: Number(r.vehiculos), empresas: Number(r.empresas) }));
  }

  async listDepartamentos(): Promise<DepartamentoCount[]> {
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
    const r = keys.length
      ? await sql`
          delete from fleet_vehicles f where f.company_id in ${sql(ids)}
          and not exists (select 1 from jsonb_to_recordset(${sql.json(keys)}::jsonb) as k(placa text, origen text) where k.placa = f.placa and k.origen = f.origen)`
      : await sql`delete from fleet_vehicles where company_id in ${sql(ids)}`;
    return r.count;
  }

  pruneFleet(companyIds: number[], keep: FleetKey[]): Promise<number> {
    return this.pruneFleetWith(this.sql, companyIds, keep);
  }

  async listFleet(companyId: number): Promise<FleetVehicle[]> {
    const rows = await this.sql`select * from fleet_vehicles where company_id = ${companyId} order by placa`;
    return rows.map(toVehicle);
  }

  async fleetByBrand(companyId: number): Promise<FleetGroup[]> {
    const rows = await this.sql`
      select upper(trim(marca)) as marca, clase, medida_probable as medida, confianza, count(*)::int as unidades,
        min(anio)::int as anio_min, max(anio)::int as anio_max, coalesce(sum(llantas), 0)::int as llantas, count(llantas)::int as con_llantas
      from fleet_vehicles where company_id = ${companyId}
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
      const chunk = rows.slice(i, i + BATCH).map((r) => ({
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
      }));
      await this.sql`insert into sales ${this.sql(chunk)}`;
    }
    return rows.length;
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
    const rows = since === undefined
      ? await this.sql`select *, fecha::text as fecha from sales where ruc = ${digits(ruc)} order by fecha desc, id desc`
      : await this.sql`select *, fecha::text as fecha from sales where ruc = ${digits(ruc)} and fecha >= ${toIsoDate(since)}::date order by fecha desc, id desc`;
    return rows.map(toSale);
  }

  async participation(rucs: string[], since: Date | IsoDate): Promise<Record<string, Participation>> {
    const list = [...new Set(rucs.map(digits).filter(Boolean))];
    const out: Record<string, Participation> = {};
    if (!list.length) return out;
    const rows = await this.sql`
      select ruc, sum(cantidad)::float8 as cantidad, bool_or(is_demo) as demo from sales
      where ruc in ${this.sql(list)} and fecha >= ${toIsoDate(since)}::date group by ruc`;
    for (const r of rows) out[String(r.ruc)] = { cantidad: Number(r.cantidad), demo: Boolean(r.demo) };
    return out;
  }

  async salesAggregate(since: Date | IsoDate, until: Date | IsoDate): Promise<SalesAggRow[]> {
    const rows = await this.sql`
      select ruc, fecha::text as fecha, vendedor, max(razon_social) as razon_social, sum(cantidad)::float8 as cantidad,
        coalesce(sum(coalesce(total, precio_unitario * cantidad)), 0)::float8 as monto,
        (count(*) filter (where total is null and precio_unitario is null))::int as sin_monto, bool_or(is_demo) as demo, count(*)::int as filas
      from sales where fecha >= ${toIsoDate(since)}::date and fecha <= ${toIsoDate(until)}::date
      group by ruc, fecha, vendedor`;
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
      insert into users (nombre, whatsapp, rol, activo) values (${input.nombre}, ${wa}, ${input.rol}, ${input.activo ?? true})
      on conflict (whatsapp) do update set nombre = excluded.nombre, rol = excluded.rol,
        activo = ${input.activo === undefined ? this.sql`users.activo` : this.sql`excluded.activo`}
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
      insert into login_tokens (token_hash, user_id, expires_at) values (${token.tokenHash}, ${token.userId}, ${token.expiresAt})
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

  async getSession(id: string, now: Date): Promise<PortalSession | null> {
    const [r] = await this.sql`select * from portal_sessions where id = ${id} and expires_at > ${now}`;
    return r ? toSession(r) : null;
  }

  async deleteSession(id: string): Promise<void> {
    await this.sql`delete from portal_sessions where id = ${id}`;
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

  async createOpportunity(input: OpportunityInput): Promise<Opportunity> {
    const at = input.at ?? new Date();
    const etapa: StageId = input.etapa ?? "prospecto";
    return this.sql.begin(async (tx) => {
      const [r] = await tx`
        insert into opportunities (company_id, owner_user_id, etapa, probabilidad, monto_estimado, cierre_esperado, proxima_accion, proxima_accion_at, quote_number, created_at, updated_at, closed_at)
        values (${input.companyId}, ${input.ownerUserId ?? null}, ${etapa}, ${stageProbability(etapa)}, ${input.montoEstimado ?? null}, ${input.cierreEsperado ?? null},
          ${input.proximaAccion ?? null}, ${input.proximaAccionAt ?? null}, ${input.quoteNumber ?? null}, ${at}, ${at}, ${isClosedStage(etapa) ? at : null})
        returning *, cierre_esperado::text as cierre_esperado`;
      await tx`insert into opportunity_stage_history (opportunity_id, etapa, entered_at, changed_by) values (${r.id}, ${etapa}, ${at}, ${input.createdBy ?? null})`;
      return toOpportunity(r);
    }) as Promise<Opportunity>;
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
      // la fila de la empresa queda bloqueada hasta el commit: dos guardados a la vez no pisan el historial
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

function toVocabulary(r: Row): VocabularyEntry {
  return { id: Number(r.id), term: String(r.term), meaning: String(r.meaning), addedBy: num(r.added_by), createdAt: date(r.created_at)! };
}
