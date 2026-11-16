/**
 * PortalStore en memoria, con persistencia opcional a un archivo JSON (data/portal-store.json).
 * Sin archivo = solo memoria (tests). Con archivo: cada cambio programa una escritura atómica (tmp + rename) a los
 * DEBOUNCE_MS; `flush()` escribe ya (los CLI la llaman antes de salir).
 * Índices en memoria por id, RUC, (placa, origen) y companyId para aguantar ~150k vehículos.
 */
import fs from "node:fs";
import path from "node:path";
import { CLOSED_STAGES, isClosedStage, stageProbability } from "../stages";
import { companyNameKey, dedupeBy, defaultSince, digits, groupFleet, nameMatches, normMarca, pageOf, searchRucPrefix, searchTerms, toIsoDate, topMedidas, type FleetAggRow } from "./shared";
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
  Contact,
  ContactInput,
  ContactPatch,
  DepartamentoCount,
  FleetGroup,
  FleetKey,
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
  StageHistoryEntry,
  UpsertCompaniesResult,
  UserInput,
  VocabularyEntry,
  VocabularyInput,
  VoiceTranscript,
  VoiceTranscriptFilter,
  VoiceTranscriptInput,
} from "./types";
import type { StageId } from "../stages";
import { surveyCounts } from "./survey-shared";
import type { Survey, SurveyAnswer, SurveyAnswerInput, SurveyAnswerResult, SurveyCanal, SurveyFilter, SurveyInput, SurveyResponse } from "./types";
import { resolveCreditSave } from "../credit/changes";
import type { CompanyCredit, CreditHistoryEntry, CreditPdf, CreditSaveInput } from "./types";
import type { BestCompaniesQuery, BestCompany, RankingValidation, RankingValidationInput, ScoreInput, ScoreInputQuery, ScoreRun, ScoreRunInput, ScoreUpdate } from "./types";

interface StoredLoginToken extends LoginToken {
  usedAt: Date | null;
  createdAt: Date;
}

type Table = "companies" | "fleet" | "sales" | "users" | "contacts" | "opportunities" | "stageHistory" | "activities" | "appointments" | "vocabulary" | "purchaseOrders";

interface FileData {
  version: 1;
  seq: Partial<Record<Table, number>>;
  companies: Company[];
  fleet: FleetVehicle[];
  sales: Sale[];
  users: PortalUser[];
  loginTokens: StoredLoginToken[];
  sessions: PortalSession[];
  contacts: Contact[];
  opportunities: Opportunity[];
  stageHistory: StageHistoryEntry[];
  activities: Activity[];
  appointments: Appointment[];
  /** Encuesta (C3). */
  surveys?: Survey[];
  surveyAnswers?: SurveyAnswer[];
  portalConversations?: PortalConversation[];
  vocabulary?: VocabularyEntry[];
  /** Transcripciones de voz con lo entendido (corrida F, punto 9), las últimas MAX_VOICE_TRANSCRIPTS. */
  voiceTranscripts?: VoiceTranscript[];
  purchaseOrders?: PurchaseOrder[];
  orderProfiles?: CompanyOrderProfile[];
  /** Crédito (C4): la fila con el PDF en base64 (`pdfData`) y su historial. */
  credit?: (CompanyCredit & { pdfData: string | null })[];
  creditHistory?: CreditHistoryEntry[];
  /** Corrida G: cálculos del puntaje, validación del ranking y avisos de una sola vez. */
  scoreRuns?: ScoreRun[];
  rankingValidations?: RankingValidation[];
  userNotices?: { userId: number; aviso: string; createdAt: Date }[];
}

/** Campos Date por colección (JSON los guarda como texto ISO). */
const DATE_FIELDS: Record<string, string[]> = {
  companies: ["createdAt", "updatedAt", "scoreAt"],
  sales: ["createdAt"],
  users: ["createdAt"],
  loginTokens: ["expiresAt", "usedAt", "createdAt"],
  sessions: ["expiresAt", "createdAt"],
  contacts: ["createdAt", "updatedAt"],
  opportunities: ["proximaAccionAt", "createdAt", "updatedAt", "closedAt"],
  stageHistory: ["enteredAt", "leftAt"],
  activities: ["occurredAt", "createdAt"],
  appointments: ["startsAt", "createdAt"],
  surveys: ["enviadaAt", "respondidaAt", "expiresAt", "createdAt"],
  surveyAnswers: ["createdAt"],
  portalConversations: ["updatedAt"],
  vocabulary: ["createdAt"],
  voiceTranscripts: ["createdAt"],
  purchaseOrders: ["createdAt"],
  orderProfiles: ["updatedAt"],
  credit: ["consultadoAt", "updatedAt"],
  creditHistory: ["createdAt"],
  scoreRuns: ["runAt"],
  rankingValidations: ["createdAt"],
  userNotices: ["createdAt"],
};

const DEBOUNCE_MS = 300;
/** Transcripciones de voz que guarda el store JSON (el de Postgres las guarda todas). */
const MAX_VOICE_TRANSCRIPTS = 2000;

const fleetKey = (placa: string, origen: string) => `${origen}|${placa}`;
const normPlaca = (p: string) => p.trim().toUpperCase().replace(/\s+/g, "");
const copy = <T extends object>(o: T): T => ({ ...o });
const time = (d: Date | null | undefined) => (d ? d.getTime() : 0);

export class JsonPortalStore implements PortalStore {
  private seq: Record<Table, number> = { companies: 0, fleet: 0, sales: 0, users: 0, contacts: 0, opportunities: 0, stageHistory: 0, activities: 0, appointments: 0, vocabulary: 0, purchaseOrders: 0 };
  private companies = new Map<number, Company>();
  private companyByRuc = new Map<string, number>();
  private fleet = new Map<string, FleetVehicle>();
  private fleetByCompany = new Map<number, Set<string>>();
  private sales: Sale[] = [];
  private salesByRucIdx = new Map<string, Sale[]>();
  private users = new Map<number, PortalUser>();
  private userByWa = new Map<string, number>();
  private loginTokens = new Map<string, StoredLoginToken>();
  private sessions = new Map<string, PortalSession>();
  private contacts = new Map<number, Contact>();
  private opportunities = new Map<number, Opportunity>();
  private stageHistoryRows: StageHistoryEntry[] = [];
  private activities: Activity[] = [];
  private appointments = new Map<number, Appointment>();
  /** Encuesta (C3), con contadores propios (máximo cargado + 1). */
  private surveys = new Map<number, Survey>();
  private surveyAnswers = new Map<number, SurveyAnswer>();
  private surveySeq = { surveys: 0, answers: 0 };
  private portalConversations = new Map<string, PortalConversation>();
  private vocabulary: VocabularyEntry[] = [];
  private voiceTranscripts: VoiceTranscript[] = [];
  private purchaseOrders = new Map<number, PurchaseOrder>();
  private orderProfiles = new Map<number, CompanyOrderProfile>();
  /** Crédito (C4). Ids del historial con contador propio (máximo cargado + 1). */
  private credit = new Map<number, CompanyCredit & { pdfData: string | null }>();
  private creditHistoryRows: CreditHistoryEntry[] = [];
  private creditHistorySeq = 0;
  /** Corrida G. */
  private scoreRuns: ScoreRun[] = [];
  private rankingValidations: RankingValidation[] = [];
  private userNotices: { userId: number; aviso: string; createdAt: Date }[] = [];
  /**
   * Límite de intentos (corrida E, punto 5): solo en memoria, no va al archivo (el store JSON es de un proceso; en
   * producción manda la tabla rate_limit_hits de Postgres). Clave `bucket|ventana`.
   */
  private rateHits = new Map<string, { windowStart: number; hits: number }>();
  /** companyId -> marcas normalizadas (se invalida al cambiar la flota). */
  private marcasCache: Map<number, Set<string>> | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Marca (mtime + tamaño) del archivo tal como lo cargó o escribió este proceso: si cambia, otro proceso lo escribió. */
  private diskMark: string | null = null;

  constructor(private file: string | null = null) {
    if (file && fs.existsSync(file)) this.load(file);
    this.diskMark = this.readDiskMark();
  }

  private readDiskMark(): string | null {
    if (!this.file) return null;
    try {
      const st = fs.statSync(this.file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  /**
   * true si otro proceso escribió el archivo después de que este lo cargó o escribió (p. ej. el simulador con --persist
   * mientras corre `npm run dev`) y aquí no hay cambios sin guardar: quien lo tiene en memoria debe volver a cargarlo.
   */
  isStaleOnDisk(): boolean {
    if (!this.file || this.timer) return false;
    return this.readDiskMark() !== this.diskMark;
  }

  /** Solo memoria (tests). */
  static memory(): JsonPortalStore {
    return new JsonPortalStore(null);
  }

  // ── persistencia ──

  private load(file: string): void {
    let raw: Partial<FileData>;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); // archivo dañado: respaldo y se empieza vacío
      return;
    }
    const revive = <T>(name: string, rows: T[] | undefined): T[] => {
      const fields = DATE_FIELDS[name] ?? [];
      return (rows ?? []).map((r) => {
        const o = r as Record<string, unknown>;
        for (const f of fields) if (typeof o[f] === "string") o[f] = new Date(o[f] as string);
        return r;
      });
    };
    Object.assign(this.seq, raw.seq ?? {});
    for (const c of revive("companies", raw.companies)) this.putCompany(c);
    for (const v of raw.fleet ?? []) this.putVehicle(v);
    for (const s of revive("sales", raw.sales)) this.pushSale({ ...s, sourceRef: s.sourceRef ?? null }); // archivos previos a source_ref
    for (const u of revive("users", raw.users)) this.putUser(u);
    for (const t of revive("loginTokens", raw.loginTokens)) this.loginTokens.set(t.tokenHash, t);
    for (const s of revive("sessions", raw.sessions)) this.sessions.set(s.id, s);
    for (const c of revive("contacts", raw.contacts)) this.contacts.set(c.id, c);
    for (const o of revive("opportunities", raw.opportunities)) this.opportunities.set(o.id, o);
    this.stageHistoryRows = revive("stageHistory", raw.stageHistory);
    this.activities = revive("activities", raw.activities);
    for (const a of revive("appointments", raw.appointments)) this.appointments.set(a.id, a);
    for (const s of revive("surveys", raw.surveys)) this.surveys.set(s.id, s);
    for (const a of revive("surveyAnswers", raw.surveyAnswers)) this.surveyAnswers.set(a.surveyId, a);
    this.surveySeq.surveys = Math.max(0, ...this.surveys.keys());
    this.surveySeq.answers = Math.max(0, ...[...this.surveyAnswers.values()].map((a) => a.id));
    for (const c of revive("portalConversations", raw.portalConversations)) this.portalConversations.set(c.phone, c);
    this.vocabulary = revive("vocabulary", raw.vocabulary);
    this.voiceTranscripts = revive("voiceTranscripts", raw.voiceTranscripts);
    for (const o of revive("purchaseOrders", raw.purchaseOrders)) this.purchaseOrders.set(o.id, o);
    for (const p of revive("orderProfiles", raw.orderProfiles)) this.orderProfiles.set(p.companyId, p);
    for (const c of revive("credit", raw.credit)) this.credit.set(c.companyId, c);
    this.creditHistoryRows = revive("creditHistory", raw.creditHistory);
    this.creditHistorySeq = this.creditHistoryRows.reduce((m, h) => Math.max(m, h.id), 0);
    this.scoreRuns = revive("scoreRuns", raw.scoreRuns);
    this.rankingValidations = revive("rankingValidations", raw.rankingValidations);
    this.userNotices = revive("userNotices", raw.userNotices);
  }

  private snapshot(): FileData {
    return {
      version: 1,
      seq: this.seq,
      companies: [...this.companies.values()],
      fleet: [...this.fleet.values()],
      sales: this.sales,
      users: [...this.users.values()],
      loginTokens: [...this.loginTokens.values()],
      sessions: [...this.sessions.values()],
      contacts: [...this.contacts.values()],
      opportunities: [...this.opportunities.values()],
      stageHistory: this.stageHistoryRows,
      activities: this.activities,
      appointments: [...this.appointments.values()],
      surveys: [...this.surveys.values()],
      surveyAnswers: [...this.surveyAnswers.values()],
      portalConversations: [...this.portalConversations.values()],
      vocabulary: this.vocabulary,
      voiceTranscripts: this.voiceTranscripts,
      purchaseOrders: [...this.purchaseOrders.values()],
      orderProfiles: [...this.orderProfiles.values()],
      credit: [...this.credit.values()],
      creditHistory: this.creditHistoryRows,
      scoreRuns: this.scoreRuns,
      rankingValidations: this.rankingValidations,
      userNotices: this.userNotices,
    };
  }

  private changed(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeNow();
    }, DEBOUNCE_MS);
    this.timer.unref?.();
  }

  private writeNow(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.snapshot()));
    fs.renameSync(tmp, this.file);
    this.diskMark = this.readDiskMark();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.writeNow();
  }

  async close(): Promise<void> {
    if (this.timer) await this.flush();
  }

  private nextId(t: Table): number {
    this.seq[t] += 1;
    return this.seq[t];
  }

  // ── índices ──

  private putCompany(c: Company): void {
    this.companies.set(c.id, c);
    this.companyByRuc.set(c.ruc, c.id);
  }

  private putVehicle(v: FleetVehicle): void {
    const key = fleetKey(v.placa, v.origen);
    const prev = this.fleet.get(key);
    if (prev && prev.companyId !== v.companyId) this.fleetByCompany.get(prev.companyId)?.delete(key);
    this.fleet.set(key, v);
    let set = this.fleetByCompany.get(v.companyId);
    if (!set) this.fleetByCompany.set(v.companyId, (set = new Set()));
    set.add(key);
    this.marcasCache = null;
  }

  private pushSale(s: Sale): void {
    this.sales.push(s);
    const list = this.salesByRucIdx.get(s.ruc);
    if (list) list.push(s);
    else this.salesByRucIdx.set(s.ruc, [s]);
  }

  private putUser(u: PortalUser): void {
    this.users.set(u.id, u);
    if (u.whatsapp) this.userByWa.set(u.whatsapp, u.id);
  }

  private marcasByCompany(): Map<number, Set<string>> {
    if (this.marcasCache) return this.marcasCache;
    const m = new Map<number, Set<string>>();
    for (const v of this.fleet.values()) {
      if (!v.marca) continue;
      let s = m.get(v.companyId);
      if (!s) m.set(v.companyId, (s = new Set()));
      s.add(normMarca(v.marca));
    }
    this.marcasCache = m;
    return m;
  }

  // ── empresas ──

  async upsertCompanies(batch: CompanyInput[]): Promise<UpsertCompaniesResult> {
    const now = new Date();
    const res: UpsertCompaniesResult = { inserted: 0, updated: 0, ids: {} };
    for (const input of dedupeBy(batch, (c) => digits(c.ruc))) {
      const ruc = digits(input.ruc);
      if (!ruc) continue;
      const id = this.companyByRuc.get(ruc);
      const prev = id === undefined ? undefined : this.companies.get(id);
      if (prev) {
        prev.razonSocial = input.razonSocial;
        if (input.sector !== undefined) prev.sector = input.sector;
        if (input.departamento !== undefined) prev.departamento = input.departamento;
        if (input.unidades !== undefined) prev.unidades = input.unidades;
        if (input.llantasPiso !== undefined) prev.llantasPiso = input.llantasPiso;
        if (input.antiguedadMedia !== undefined) prev.antiguedadMedia = input.antiguedadMedia;
        prev.updatedAt = now;
        res.updated++;
        res.ids[ruc] = prev.id;
      } else {
        const c: Company = {
          id: this.nextId("companies"),
          ruc,
          razonSocial: input.razonSocial,
          sector: input.sector ?? null,
          departamento: input.departamento ?? null,
          unidades: input.unidades ?? 0,
          llantasPiso: input.llantasPiso ?? 0,
          antiguedadMedia: input.antiguedadMedia ?? null,
          esCliente: false,
          ownerUserId: null,
          temperatura: null,
          score: null,
          nivel: null,
          scoreDetalle: null,
          scoreAt: null,
          creditTermsDays: null,
          createdAt: now,
          updatedAt: now,
        };
        this.putCompany(c);
        res.inserted++;
        res.ids[ruc] = c.id;
      }
    }
    this.changed();
    return res;
  }

  async getCompany(id: number): Promise<Company | null> {
    const c = this.companies.get(id);
    return c ? copy(c) : null;
  }

  async getCompanyByRuc(ruc: string): Promise<Company | null> {
    const id = this.companyByRuc.get(digits(ruc));
    return id === undefined ? null : this.getCompany(id);
  }

  async getCompaniesByRucs(rucs: string[]): Promise<Company[]> {
    const out: Company[] = [];
    for (const ruc of new Set(rucs.map(digits))) {
      const id = this.companyByRuc.get(ruc);
      const c = id === undefined ? undefined : this.companies.get(id);
      if (c) out.push(copy(c));
    }
    return out;
  }

  async updateCompany(id: number, patch: CompanyPatch): Promise<Company | null> {
    const c = this.companies.get(id);
    if (!c) return null;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (c as unknown as Record<string, unknown>)[k] = v;
    c.updatedAt = new Date();
    this.changed();
    return copy(c);
  }

  async setOwner(companyId: number, userId: number | null, opts?: { onlyIfOwner: number | null }): Promise<Company | null> {
    if (opts && (this.companies.get(companyId)?.ownerUserId ?? null) !== opts.onlyIfOwner) return null;
    return this.updateCompany(companyId, { ownerUserId: userId });
  }

  async searchCompanies(opts: CompanySearch = {}): Promise<CompanySearchResult> {
    const since = opts.since !== undefined ? toIsoDate(opts.since) : defaultSince(opts.now);
    const terms = searchTerms(opts.q);
    const qDigits = searchRucPrefix(opts.q);
    const deps = opts.departamento?.length ? new Set(opts.departamento) : null;
    const sectors = opts.sector?.length ? new Set<string>(opts.sector) : null;
    const marcas = opts.marcas?.length ? opts.marcas.map(normMarca) : null;
    const marcaIdx = marcas ? this.marcasByCompany() : null;
    const matches: Company[] = [];
    for (const c of this.companies.values()) {
      if (terms.compact && !(nameMatches(companyNameKey(c.razonSocial), terms) || (qDigits && c.ruc.startsWith(qDigits)))) continue;
      if (deps && !(c.departamento && deps.has(c.departamento))) continue;
      if (sectors && !(c.sector && sectors.has(c.sector))) continue;
      if (opts.minUnits !== undefined && c.unidades < opts.minUnits) continue;
      if (opts.maxUnits !== undefined && c.unidades > opts.maxUnits) continue;
      if (opts.esCliente !== undefined && c.esCliente !== opts.esCliente) continue;
      if (opts.ownerUserId !== undefined && c.ownerUserId !== opts.ownerUserId) continue;
      if (opts.nivel?.length && !(c.nivel && opts.nivel.includes(c.nivel))) continue;
      if (marcas && marcaIdx) {
        const set = marcaIdx.get(c.id);
        if (!set || !marcas.some((m) => set.has(m))) continue;
      }
      matches.push(c);
    }
    const part = this.participationSync(
      matches.map((c) => c.ruc),
      since,
    );
    const rows: CompanyRow[] = matches.map((c) => ({ ...c, participacion: part[c.ruc]?.cantidad ?? 0, participacionDemo: part[c.ruc]?.demo ?? false }));
    const orderBy = opts.orderBy ?? "unidades";
    // atractivo: sin puntaje al final (como "nulls last" en Postgres)
    const val = (r: CompanyRow) => (orderBy === "atractivo" ? (r.score ?? -1) : orderBy === "llantas" ? r.llantasPiso : orderBy === "participacion" ? r.participacion : r.unidades);
    rows.sort((a, b) => val(b) - val(a) || a.razonSocial.localeCompare(b.razonSocial) || a.id - b.id);
    const { pageSize, offset } = pageOf(opts.page, opts.pageSize);
    const page = rows.slice(offset, offset + pageSize);
    if (opts.withMedidas) {
      for (const r of page) {
        const counts = new Map<string, number>();
        for (const key of this.fleetByCompany.get(r.id) ?? []) {
          const m = this.fleet.get(key)?.medidaProbable;
          if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
        }
        r.medidas = topMedidas(counts);
      }
    }
    return { rows: page, total: rows.length };
  }

  async listMarcas(): Promise<MarcaCount[]> {
    const m = new Map<string, { vehiculos: number; empresas: Set<number> }>();
    for (const v of this.fleet.values()) {
      const marca = normMarca(v.marca);
      if (!marca) continue;
      let e = m.get(marca);
      if (!e) m.set(marca, (e = { vehiculos: 0, empresas: new Set() }));
      e.vehiculos++;
      e.empresas.add(v.companyId);
    }
    return [...m.entries()].map(([marca, e]) => ({ marca, vehiculos: e.vehiculos, empresas: e.empresas.size })).sort((a, b) => b.vehiculos - a.vehiculos || a.marca.localeCompare(b.marca));
  }

  async listDepartamentos(): Promise<DepartamentoCount[]> {
    const m = new Map<string, number>();
    for (const c of this.companies.values()) if (c.departamento) m.set(c.departamento, (m.get(c.departamento) ?? 0) + 1);
    return [...m.entries()].map(([departamento, empresas]) => ({ departamento, empresas })).sort((a, b) => b.empresas - a.empresas || a.departamento.localeCompare(b.departamento));
  }

  async countCompanies(): Promise<number> {
    return this.companies.size;
  }

  // ── flota ──

  async upsertFleet(batch: FleetVehicleInput[]): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;
    for (const input of dedupeBy(batch, (v) => fleetKey(normPlaca(v.placa), v.origen))) {
      const placa = normPlaca(input.placa);
      if (!placa) continue;
      const prev = this.fleet.get(fleetKey(placa, input.origen));
      if (prev) updated++;
      else inserted++;
      this.putVehicle({ ...input, placa, id: prev?.id ?? this.nextId("fleet") });
    }
    this.changed();
    return { inserted, updated };
  }

  async replaceFleet(companyId: number, vehicles: Omit<FleetVehicleInput, "companyId">[]): Promise<{ removed: number; upserted: number }> {
    const keep = new Set(vehicles.map((v) => fleetKey(normPlaca(v.placa), v.origen)));
    let removed = 0;
    for (const key of [...(this.fleetByCompany.get(companyId) ?? [])]) {
      if (keep.has(key)) continue;
      this.fleet.delete(key);
      this.fleetByCompany.get(companyId)?.delete(key);
      removed++;
    }
    this.marcasCache = null;
    const r = await this.upsertFleet(vehicles.map((v) => ({ ...v, companyId })));
    return { removed, upserted: r.inserted + r.updated };
  }

  async pruneFleet(companyIds: number[], keep: FleetKey[]): Promise<number> {
    const keepSet = new Set(keep.map((v) => fleetKey(normPlaca(v.placa), v.origen)));
    let removed = 0;
    for (const companyId of new Set(companyIds)) {
      const keys = this.fleetByCompany.get(companyId);
      if (!keys) continue;
      for (const key of [...keys]) {
        if (keepSet.has(key)) continue;
        this.fleet.delete(key);
        keys.delete(key);
        removed++;
      }
    }
    if (removed) {
      this.marcasCache = null;
      this.changed();
    }
    return removed;
  }

  async listFleet(companyId: number): Promise<FleetVehicle[]> {
    const keys = this.fleetByCompany.get(companyId) ?? new Set<string>();
    return [...keys].map((k) => copy(this.fleet.get(k)!)).sort((a, b) => a.placa.localeCompare(b.placa));
  }

  async fleetByBrand(companyId: number): Promise<FleetGroup[]> {
    const agg = new Map<string, FleetAggRow>();
    for (const key of this.fleetByCompany.get(companyId) ?? []) {
      const v = this.fleet.get(key)!;
      const marca = v.marca ? normMarca(v.marca) : null;
      const k = [marca, v.clase, v.medidaProbable, v.confianza].join("\u0000");
      let r = agg.get(k);
      if (!r) agg.set(k, (r = { marca, clase: v.clase, medida: v.medidaProbable, confianza: v.confianza, unidades: 0, anioMin: null, anioMax: null, llantas: 0, unidadesConLlantas: 0 }));
      r.unidades++;
      if (v.anio !== null) {
        r.anioMin = r.anioMin === null ? v.anio : Math.min(r.anioMin, v.anio);
        r.anioMax = r.anioMax === null ? v.anio : Math.max(r.anioMax, v.anio);
      }
      if (v.llantas !== null) {
        r.llantas += v.llantas;
        r.unidadesConLlantas++;
      }
    }
    return groupFleet([...agg.values()]);
  }

  async countFleet(): Promise<number> {
    return this.fleet.size;
  }

  async companyOriginCounts(): Promise<CompanyOriginCounts[]> {
    const out: CompanyOriginCounts[] = [];
    for (const c of this.companies.values()) {
      const r: CompanyOriginCounts = { companyId: c.id, ruc: c.ruc, razonSocial: c.razonSocial, sector: c.sector, carga: 0, pasajeros: 0 };
      for (const key of this.fleetByCompany.get(c.id) ?? []) r[this.fleet.get(key)!.origen]++;
      out.push(r);
    }
    return out.sort((a, b) => a.companyId - b.companyId);
  }

  // ── ventas ──

  async insertSales(rows: SaleInput[]): Promise<number> {
    const now = new Date();
    for (const r of rows) {
      this.pushSale({
        id: this.nextId("sales"),
        fecha: toIsoDate(r.fecha),
        ruc: digits(r.ruc),
        razonSocial: r.razonSocial ?? null,
        medida: r.medida ?? null,
        marca: r.marca ?? null,
        diseno: r.diseno ?? null,
        cantidad: r.cantidad,
        precioUnitario: r.precioUnitario ?? null,
        total: r.total ?? null,
        vendedor: r.vendedor ?? null,
        origen: r.origen ?? null,
        isDemo: r.isDemo ?? false,
        sourceRef: r.sourceRef ?? null,
        createdAt: now,
      });
    }
    this.changed();
    return rows.length;
  }

  async deleteDemoSales(): Promise<number> {
    const before = this.sales.length;
    this.sales = this.sales.filter((s) => !s.isDemo);
    for (const [ruc, list] of this.salesByRucIdx) {
      const kept = list.filter((s) => !s.isDemo);
      if (kept.length) this.salesByRucIdx.set(ruc, kept);
      else this.salesByRucIdx.delete(ruc);
    }
    const removed = before - this.sales.length;
    if (removed) this.changed();
    return removed;
  }

  async countSalesBySource(sourceRef: string): Promise<{ total: number; firstAt: Date | null }> {
    let total = 0;
    let firstAt: Date | null = null;
    for (const s of this.sales) {
      if (s.sourceRef !== sourceRef) continue;
      total++;
      if (!firstAt || s.createdAt < firstAt) firstAt = s.createdAt;
    }
    return { total, firstAt };
  }

  async countSales(): Promise<{ total: number; demo: number }> {
    let demo = 0;
    for (const s of this.sales) if (s.isDemo) demo++;
    return { total: this.sales.length, demo };
  }

  async salesByRuc(ruc: string, since?: Date | IsoDate): Promise<Sale[]> {
    const from = since === undefined ? "" : toIsoDate(since);
    return (this.salesByRucIdx.get(digits(ruc)) ?? [])
      .filter((s) => s.fecha >= from)
      .map(copy)
      .sort((a, b) => b.fecha.localeCompare(a.fecha) || b.id - a.id);
  }

  private participationSync(rucs: string[], since: IsoDate): Record<string, Participation> {
    const out: Record<string, Participation> = {};
    for (const ruc of rucs) {
      for (const s of this.salesByRucIdx.get(ruc) ?? []) {
        if (s.fecha < since) continue;
        const p = (out[ruc] ??= { cantidad: 0, demo: false });
        p.cantidad += s.cantidad;
        if (s.isDemo) p.demo = true;
      }
    }
    return out;
  }

  async participation(rucs: string[], since: Date | IsoDate): Promise<Record<string, Participation>> {
    return this.participationSync([...new Set(rucs.map(digits))], toIsoDate(since));
  }

  async salesAggregate(since: Date | IsoDate, until: Date | IsoDate): Promise<SalesAggRow[]> {
    const from = toIsoDate(since);
    const to = toIsoDate(until);
    const groups = new Map<string, SalesAggRow>();
    for (const s of this.sales) {
      if (s.fecha < from || s.fecha > to) continue;
      const key = `${s.ruc}|${s.fecha}|${s.vendedor ?? "\u0000"}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { ruc: s.ruc, fecha: s.fecha, vendedor: s.vendedor, razonSocial: null, cantidad: 0, monto: 0, sinMonto: 0, demo: false, filas: 0 }));
      const monto = s.total ?? (s.precioUnitario !== null ? s.precioUnitario * s.cantidad : null);
      g.cantidad += s.cantidad;
      if (monto === null) g.sinMonto++;
      else g.monto += monto;
      if (s.razonSocial && (!g.razonSocial || s.razonSocial > g.razonSocial)) g.razonSocial = s.razonSocial;
      if (s.isDemo) g.demo = true;
      g.filas++;
    }
    return [...groups.values()];
  }

  // ── usuarios y sesiones ──

  async upsertUser(input: UserInput): Promise<PortalUser> {
    const wa = digits(input.whatsapp);
    if (!wa) throw new Error("upsertUser: falta el número de WhatsApp");
    const id = this.userByWa.get(wa);
    const prev = id === undefined ? undefined : this.users.get(id);
    let u: PortalUser;
    if (prev) {
      prev.nombre = input.nombre;
      prev.rol = input.rol;
      if (input.activo !== undefined) prev.activo = input.activo;
      u = prev;
    } else {
      u = { id: this.nextId("users"), nombre: input.nombre, whatsapp: wa, rol: input.rol, activo: input.activo ?? true, createdAt: new Date() };
      this.putUser(u);
    }
    this.changed();
    return copy(u);
  }

  async getUser(id: number): Promise<PortalUser | null> {
    const u = this.users.get(id);
    return u ? copy(u) : null;
  }

  async getUserByWhatsapp(whatsapp: string): Promise<PortalUser | null> {
    const id = this.userByWa.get(digits(whatsapp));
    return id === undefined ? null : this.getUser(id);
  }

  async listUsers(): Promise<PortalUser[]> {
    return [...this.users.values()].map(copy).sort((a, b) => a.id - b.id);
  }

  async saveLoginToken(token: LoginToken): Promise<void> {
    this.loginTokens.set(token.tokenHash, { ...token, usedAt: null, createdAt: new Date() });
    this.changed();
  }

  async consumeLoginToken(tokenHash: string, now: Date): Promise<number | null> {
    const t = this.loginTokens.get(tokenHash);
    if (!t || t.usedAt || t.expiresAt.getTime() <= now.getTime()) return null;
    t.usedAt = now; // sin await entre la lectura y la marca: atómico en el event loop
    this.changed();
    return t.userId;
  }

  async createSession(session: { id: string; userId: number; expiresAt: Date }): Promise<PortalSession> {
    const s: PortalSession = { ...session, createdAt: new Date() };
    this.sessions.set(s.id, s);
    this.changed();
    return copy(s);
  }

  async getSession(id: string, now: Date): Promise<PortalSession | null> {
    const s = this.sessions.get(id);
    if (!s || s.expiresAt.getTime() <= now.getTime()) return null;
    return copy(s);
  }

  async deleteSession(id: string): Promise<void> {
    if (this.sessions.delete(id)) this.changed();
  }

  // ── contactos ──

  async addContact(input: ContactInput): Promise<Contact> {
    const now = new Date();
    const c: Contact = {
      id: this.nextId("contacts"),
      companyId: input.companyId,
      nombre: input.nombre,
      cargo: input.cargo ?? null,
      telefono: input.telefono ?? null,
      email: input.email ?? null,
      notas: input.notas ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.contacts.set(c.id, c);
    this.changed();
    return copy(c);
  }

  async getContact(id: number): Promise<Contact | null> {
    const c = this.contacts.get(id);
    return c ? copy(c) : null;
  }

  async listContacts(companyId: number): Promise<Contact[]> {
    return [...this.contacts.values()]
      .filter((c) => c.companyId === companyId)
      .map(copy)
      .sort((a, b) => a.id - b.id);
  }

  async updateContact(id: number, patch: ContactPatch): Promise<Contact | null> {
    const c = this.contacts.get(id);
    if (!c) return null;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (c as unknown as Record<string, unknown>)[k] = v;
    c.updatedAt = new Date();
    this.changed();
    return copy(c);
  }

  async deleteContact(id: number): Promise<boolean> {
    const ok = this.contacts.delete(id);
    if (ok) this.changed();
    return ok;
  }

  // ── oportunidades ──

  async createOpportunity(input: OpportunityInput): Promise<Opportunity> {
    const at = input.at ?? new Date();
    const etapa: StageId = input.etapa ?? "prospecto";
    const o: Opportunity = {
      id: this.nextId("opportunities"),
      companyId: input.companyId,
      ownerUserId: input.ownerUserId ?? null,
      etapa,
      probabilidad: stageProbability(etapa),
      montoEstimado: input.montoEstimado ?? null,
      cierreEsperado: input.cierreEsperado ?? null,
      proximaAccion: input.proximaAccion ?? null,
      proximaAccionAt: input.proximaAccionAt ?? null,
      quoteNumber: input.quoteNumber ?? null,
      createdAt: at,
      updatedAt: at,
      closedAt: isClosedStage(etapa) ? at : null,
    };
    this.opportunities.set(o.id, o);
    this.stageHistoryRows.push({ id: this.nextId("stageHistory"), opportunityId: o.id, etapa, enteredAt: at, leftAt: null, changedBy: input.createdBy ?? null });
    this.changed();
    return copy(o);
  }

  async openOrCreateOpportunity(input: OpportunityInput): Promise<{ opportunity: Opportunity; created: boolean }> {
    // sin await antes de crear: nada se intercala entre la búsqueda y la creación
    const open = [...this.opportunities.values()].filter((o) => o.companyId === input.companyId && o.closedAt === null).sort((a, b) => time(b.updatedAt) - time(a.updatedAt) || b.id - a.id)[0];
    if (open) return { opportunity: copy(open), created: false };
    return { opportunity: await this.createOpportunity(input), created: true };
  }

  async getOpportunity(id: number): Promise<Opportunity | null> {
    const o = this.opportunities.get(id);
    return o ? copy(o) : null;
  }

  async getOpenOpportunity(companyId: number, ownerId?: number): Promise<Opportunity | null> {
    const [first] = await this.listOpportunities({ companyId, ownerId, open: true });
    return first ?? null;
  }

  async listOpportunities(filter: OpportunityFilter = {}): Promise<Opportunity[]> {
    const etapas = filter.etapas?.length ? new Set<string>(filter.etapas) : null;
    return [...this.opportunities.values()]
      .filter(
        (o) =>
          (filter.ownerId === undefined || o.ownerUserId === filter.ownerId) &&
          (filter.companyId === undefined || o.companyId === filter.companyId) &&
          (!etapas || etapas.has(o.etapa)) &&
          (filter.open === undefined || (o.closedAt === null) === filter.open),
      )
      .map(copy)
      .sort((a, b) => time(b.updatedAt) - time(a.updatedAt) || b.id - a.id);
  }

  async moveStage(opportunityId: number, etapa: StageId, userId: number | null, at: Date = new Date()): Promise<Opportunity | null> {
    const o = this.opportunities.get(opportunityId);
    if (!o) return null;
    if (o.etapa === etapa) return copy(o);
    for (const h of this.stageHistoryRows) if (h.opportunityId === opportunityId && h.leftAt === null) h.leftAt = at;
    this.stageHistoryRows.push({ id: this.nextId("stageHistory"), opportunityId, etapa, enteredAt: at, leftAt: null, changedBy: userId });
    o.etapa = etapa;
    o.probabilidad = stageProbability(etapa);
    o.updatedAt = at;
    o.closedAt = (CLOSED_STAGES as string[]).includes(etapa) ? at : null;
    this.changed();
    return copy(o);
  }

  async updateOpportunity(id: number, patch: OpportunityPatch): Promise<Opportunity | null> {
    const o = this.opportunities.get(id);
    if (!o) return null;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (o as unknown as Record<string, unknown>)[k] = v;
    o.updatedAt = new Date();
    this.changed();
    return copy(o);
  }

  async stageHistory(opportunityId: number): Promise<StageHistoryEntry[]> {
    return this.stageHistoryRows
      .filter((h) => h.opportunityId === opportunityId)
      .map(copy)
      .sort((a, b) => time(a.enteredAt) - time(b.enteredAt) || a.id - b.id);
  }

  async stageHistoryFor(opportunityIds: number[]): Promise<StageHistoryEntry[]> {
    const ids = new Set(opportunityIds);
    return this.stageHistoryRows
      .filter((h) => ids.has(h.opportunityId))
      .map(copy)
      .sort((a, b) => a.opportunityId - b.opportunityId || time(a.enteredAt) - time(b.enteredAt) || a.id - b.id);
  }

  // ── actividades ──

  async addActivity(input: ActivityInput): Promise<Activity> {
    const now = new Date();
    const a: Activity = {
      id: this.nextId("activities"),
      companyId: input.companyId,
      opportunityId: input.opportunityId ?? null,
      userId: input.userId ?? null,
      tipo: input.tipo,
      texto: input.texto ?? "",
      canal: input.canal ?? null,
      data: input.data ?? null,
      occurredAt: input.occurredAt ?? now,
      createdAt: now,
    };
    this.activities.push(a);
    this.changed();
    return copy(a);
  }

  async listActivities(filter: ActivityFilter = {}): Promise<Activity[]> {
    const rows = this.activities
      .filter(
        (a) =>
          (filter.companyId === undefined || a.companyId === filter.companyId) &&
          (filter.userId === undefined || a.userId === filter.userId) &&
          (filter.opportunityId === undefined || a.opportunityId === filter.opportunityId) &&
          (!filter.since || a.occurredAt.getTime() >= filter.since.getTime()) &&
          (!filter.until || a.occurredAt.getTime() < filter.until.getTime()),
      )
      .map(copy)
      .sort((a, b) => time(b.occurredAt) - time(a.occurredAt) || b.id - a.id);
    return filter.limit ? rows.slice(0, filter.limit) : rows;
  }

  // ── citas ──

  async addAppointment(input: AppointmentInput): Promise<Appointment> {
    const a: Appointment = {
      id: this.nextId("appointments"),
      companyId: input.companyId,
      opportunityId: input.opportunityId ?? null,
      userId: input.userId ?? null,
      startsAt: input.startsAt,
      lugar: input.lugar ?? null,
      conTecnico: input.conTecnico ?? false,
      notas: input.notas ?? null,
      estado: input.estado ?? "programada",
      createdAt: new Date(),
    };
    this.appointments.set(a.id, a);
    this.changed();
    return copy(a);
  }

  async getAppointment(id: number): Promise<Appointment | null> {
    const a = this.appointments.get(id);
    return a ? copy(a) : null;
  }

  async updateAppointment(id: number, patch: AppointmentPatch): Promise<Appointment | null> {
    const a = this.appointments.get(id);
    if (!a) return null;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (a as unknown as Record<string, unknown>)[k] = v;
    this.changed();
    return copy(a);
  }

  async listAppointments(filter: AppointmentFilter = {}): Promise<Appointment[]> {
    return [...this.appointments.values()]
      .filter(
        (a) =>
          (filter.userId === undefined || a.userId === filter.userId) &&
          (filter.companyId === undefined || a.companyId === filter.companyId) &&
          (filter.estado === undefined || a.estado === filter.estado) &&
          (!filter.from || a.startsAt.getTime() >= filter.from.getTime()) &&
          (!filter.to || a.startsAt.getTime() < filter.to.getTime()),
      )
      .map(copy)
      .sort((a, b) => time(a.startsAt) - time(b.startsAt) || a.id - b.id);
  }

  // ── encuesta de satisfacción (C3) ──

  async createSurvey(input: SurveyInput, opts: { onlyIfNoneSince?: Date } = {}): Promise<Survey | null> {
    // sin await entre la comprobación y la inserción: atómico en el event loop
    const since = opts.onlyIfNoneSince;
    const now = input.createdAt ?? new Date();
    if (since && [...this.surveys.values()].some((s) => s.companyId === input.companyId && s.createdAt.getTime() >= since.getTime() && surveyCounts(s, now))) return null;
    if ([...this.surveys.values()].some((s) => s.tokenHash === input.tokenHash)) throw new Error("createSurvey: token repetido");
    const s: Survey = {
      id: ++this.surveySeq.surveys,
      companyId: input.companyId,
      contactId: input.contactId ?? null,
      tokenHash: input.tokenHash,
      estado: "pendiente",
      canal: input.canal,
      createdBy: input.createdBy ?? null,
      enviadaAt: null,
      respondidaAt: null,
      expiresAt: input.expiresAt,
      createdAt: now,
    };
    this.surveys.set(s.id, s);
    this.changed();
    return copy(s);
  }

  async getSurvey(id: number): Promise<Survey | null> {
    const s = this.surveys.get(id);
    return s ? copy(s) : null;
  }

  async getSurveyByTokenHash(tokenHash: string): Promise<Survey | null> {
    for (const s of this.surveys.values()) if (s.tokenHash === tokenHash) return copy(s);
    return null;
  }

  private surveyMatches(s: Survey, filter: SurveyFilter): boolean {
    if (filter.companyId !== undefined && s.companyId !== filter.companyId) return false;
    if (filter.ownerUserId !== undefined && this.companies.get(s.companyId)?.ownerUserId !== filter.ownerUserId) return false;
    return true;
  }

  async listSurveys(filter: SurveyFilter = {}): Promise<Survey[]> {
    const rows = [...this.surveys.values()]
      .filter((s) => this.surveyMatches(s, filter) && (!filter.since || s.createdAt.getTime() >= filter.since.getTime()))
      .map(copy)
      .sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.id - a.id);
    return filter.limit ? rows.slice(0, filter.limit) : rows;
  }

  async markSurveySent(id: number, at: Date, canal?: SurveyCanal): Promise<Survey | null> {
    const s = this.surveys.get(id);
    if (!s) return null;
    if (s.estado === "pendiente") {
      s.estado = "enviada";
      s.enviadaAt = at;
      if (canal) s.canal = canal;
      this.changed();
    }
    return copy(s);
  }

  async expireSurvey(id: number): Promise<Survey | null> {
    const s = this.surveys.get(id);
    if (!s) return null;
    if (s.estado === "pendiente" || s.estado === "enviada") {
      s.estado = "vencida";
      this.changed();
    }
    return copy(s);
  }

  async answerSurvey(surveyId: number, answer: SurveyAnswerInput, now: Date): Promise<SurveyAnswerResult> {
    // sin await en medio: la comprobación y la escritura no se intercalan con otra respuesta
    const s = this.surveys.get(surveyId);
    if (!s) return { ok: false, reason: "no_existe" };
    if (s.estado === "respondida" || this.surveyAnswers.has(surveyId)) return { ok: false, reason: "respondida" };
    if (s.estado === "vencida" || s.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "vencida" };
    const a: SurveyAnswer = { id: ++this.surveySeq.answers, surveyId, ...answer, valora: [...answer.valora], createdAt: now };
    this.surveyAnswers.set(surveyId, a);
    s.estado = "respondida";
    s.respondidaAt = now;
    this.changed();
    return { ok: true, survey: copy(s), answer: { ...a, valora: [...a.valora] } };
  }

  async listSurveyResponses(filter: SurveyFilter = {}): Promise<SurveyResponse[]> {
    const out: SurveyResponse[] = [];
    for (const a of this.surveyAnswers.values()) {
      const s = this.surveys.get(a.surveyId);
      if (!s || !this.surveyMatches(s, filter)) continue;
      if (filter.since && a.createdAt.getTime() < filter.since.getTime()) continue;
      out.push({ ...a, valora: [...a.valora], companyId: s.companyId, contactId: s.contactId, canal: s.canal });
    }
    out.sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.id - a.id);
    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  // ── conversación del bot ──

  async getPortalConversation(phone: string): Promise<PortalConversation | null> {
    const c = this.portalConversations.get(digits(phone));
    return c ? { ...c, state: structuredClone(c.state) } : null;
  }

  async setPortalConversation(phone: string, state: Record<string, unknown> | null): Promise<void> {
    const key = digits(phone);
    if (!key) return;
    if (!state || Object.keys(state).length === 0) {
      if (this.portalConversations.delete(key)) this.changed();
      return;
    }
    this.portalConversations.set(key, { phone: key, state: JSON.parse(JSON.stringify(state)) as Record<string, unknown>, updatedAt: new Date() });
    this.changed();
  }

  // ── vocabulario aprendido ──

  async listVocabulary(): Promise<VocabularyEntry[]> {
    return this.vocabulary.map(copy).sort((a, b) => time(a.createdAt) - time(b.createdAt) || a.id - b.id);
  }

  async addVocabulary(input: VocabularyInput): Promise<VocabularyEntry> {
    const term = input.term.trim();
    const meaning = input.meaning.trim();
    if (!term || !meaning) throw new Error("Vocabulario: término y significado son obligatorios");
    const prev = this.vocabulary.find((v) => v.term.toLowerCase() === term.toLowerCase());
    if (prev) {
      prev.meaning = meaning;
      prev.addedBy = input.addedBy ?? null;
      this.changed();
      return copy(prev);
    }
    const row: VocabularyEntry = { id: this.nextId("vocabulary"), term, meaning, addedBy: input.addedBy ?? null, createdAt: new Date() };
    this.vocabulary.push(row);
    this.changed();
    return copy(row);
  }

  // ── registro de transcripciones de voz (corrida F, punto 9) ──

  async logVoiceTranscript(input: VoiceTranscriptInput): Promise<void> {
    const id = this.voiceTranscripts.reduce((m, v) => Math.max(m, v.id), 0) + 1;
    const row: VoiceTranscript = { id, phone: input.phone, userId: input.userId ?? null, context: input.context, transcript: input.transcript, understood: JSON.parse(JSON.stringify(input.understood)), outcome: input.outcome, createdAt: input.createdAt ?? new Date() };
    this.voiceTranscripts.push(row);
    if (this.voiceTranscripts.length > MAX_VOICE_TRANSCRIPTS) this.voiceTranscripts.splice(0, this.voiceTranscripts.length - MAX_VOICE_TRANSCRIPTS);
    this.changed();
  }

  async listVoiceTranscripts(filter: VoiceTranscriptFilter = {}): Promise<VoiceTranscript[]> {
    const rows = this.voiceTranscripts.filter(
      (v) =>
        (!filter.since || time(v.createdAt) >= time(filter.since)) &&
        (!filter.until || time(v.createdAt) < time(filter.until)) &&
        (!filter.phone || v.phone === filter.phone) &&
        (filter.userId === undefined || v.userId === filter.userId) &&
        (!filter.outcomes?.length || filter.outcomes.includes(v.outcome)),
    );
    return rows
      .sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.id - a.id)
      .slice(0, filter.limit ?? 50)
      .map((v) => ({ ...v, understood: JSON.parse(JSON.stringify(v.understood)) }));
  }

  // ── órdenes de compra y memoria del pedido ──

  async addPurchaseOrder(input: PurchaseOrderInput): Promise<PurchaseOrder> {
    const row: PurchaseOrder = {
      id: this.nextId("purchaseOrders"),
      companyId: input.companyId,
      opportunityId: input.opportunityId ?? null,
      userId: input.userId ?? null,
      numero: input.numero?.trim() || null,
      quoteNumber: input.quoteNumber ?? null,
      fileName: input.fileName ?? null,
      mimeType: input.mimeType ?? null,
      data: input.data ?? null,
      status: input.status ?? "recibida",
      createdAt: input.createdAt ?? new Date(),
    };
    this.purchaseOrders.set(row.id, row);
    this.changed();
    return copy(row);
  }

  async getPurchaseOrder(id: number): Promise<PurchaseOrder | null> {
    const o = this.purchaseOrders.get(id);
    return o ? copy(o) : null;
  }

  async updatePurchaseOrder(id: number, patch: PurchaseOrderPatch): Promise<PurchaseOrder | null> {
    const o = this.purchaseOrders.get(id);
    if (!o) return null;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (o as unknown as Record<string, unknown>)[k] = v;
    this.changed();
    return copy(o);
  }

  async listPurchaseOrders(filter: PurchaseOrderFilter = {}): Promise<PurchaseOrderSummary[]> {
    return [...this.purchaseOrders.values()]
      .filter(
        (o) =>
          (filter.companyId === undefined || o.companyId === filter.companyId) &&
          (filter.userId === undefined || o.userId === filter.userId) &&
          (filter.status === undefined || o.status === filter.status),
      )
      .map(({ data: _data, ...o }) => copy(o))
      .sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.id - a.id);
  }

  async getOrderProfile(companyId: number): Promise<CompanyOrderProfile | null> {
    const p = this.orderProfiles.get(companyId);
    return p ? { ...p, data: structuredClone(p.data) } : null;
  }

  async setOrderProfile(companyId: number, data: Record<string, unknown>): Promise<CompanyOrderProfile> {
    const row: CompanyOrderProfile = { companyId, data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>, updatedAt: new Date() };
    this.orderProfiles.set(companyId, row);
    this.changed();
    return { ...row, data: structuredClone(row.data) };
  }

  // ── crédito (C4) ──

  async getCredit(companyId: number): Promise<CompanyCredit | null> {
    const c = this.credit.get(companyId);
    if (!c) return null;
    const { pdfData: _pdf, ...row } = c;
    return copy(row);
  }

  async getCreditPdf(companyId: number): Promise<CreditPdf | null> {
    const c = this.credit.get(companyId);
    return c?.pdfData && c.pdfName ? { name: c.pdfName, mime: c.pdfMime ?? "application/pdf", data: c.pdfData } : null;
  }

  async saveCredit(companyId: number, input: CreditSaveInput, userId: number | null, at: Date = new Date()): Promise<{ credit: CompanyCredit; entry: CreditHistoryEntry | null }> {
    const stored = this.credit.get(companyId) ?? null;
    const prev = await this.getCredit(companyId);
    const { credit, pdf, cambios } = resolveCreditSave(companyId, prev, input, userId, at);
    if (Object.keys(cambios).length === 0) return { credit: prev ?? copy(credit), entry: null };
    const pdfData = pdf === undefined ? (stored?.pdfData ?? null) : (pdf?.data ?? null);
    this.credit.set(companyId, { ...credit, pdfData });
    const entry: CreditHistoryEntry = { id: ++this.creditHistorySeq, companyId, estadoAnterior: prev?.estado ?? null, estadoNuevo: credit.estado, cambios, userId, createdAt: at };
    this.creditHistoryRows.push(entry);
    this.changed();
    return { credit: copy(credit), entry: structuredClone(entry) };
  }

  async creditHistory(companyId: number): Promise<CreditHistoryEntry[]> {
    return this.creditHistoryRows
      .filter((h) => h.companyId === companyId)
      .map((h) => structuredClone(h))
      .sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.id - a.id);
  }

  // ── límite de intentos (corrida E, punto 5) ──

  async hitRateLimit(bucket: string, windowStart: Date): Promise<number> {
    const key = `${bucket}|${windowStart.getTime()}`;
    const row = this.rateHits.get(key) ?? { windowStart: windowStart.getTime(), hits: 0 };
    row.hits += 1;
    this.rateHits.set(key, row);
    // sin cron en desarrollo: si crece, se olvidan las ventanas de hace más de un día
    if (this.rateHits.size > 10_000) await this.pruneRateLimitHits(new Date(windowStart.getTime() - 24 * 3600_000));
    return row.hits;
  }

  async pruneRateLimitHits(before: Date): Promise<number> {
    let n = 0;
    for (const [k, v] of this.rateHits) {
      if (v.windowStart < before.getTime()) {
        this.rateHits.delete(k);
        n++;
      }
    }
    return n;
  }

  // ── puntaje de atractivo (corrida G) ──

  async scoringInputs(q: ScoreInputQuery): Promise<ScoreInput[]> {
    const ids = q.companyIds ? new Set(q.companyIds) : null;
    const prefs = new Set(q.marcas.map(normMarca));
    const out: ScoreInput[] = [];
    const lost = new Map<number, Date>();
    for (const o of this.opportunities.values()) {
      if (o.etapa !== "cerrado_perdido" || !o.closedAt || o.closedAt < q.lostSince) continue;
      const prev = lost.get(o.companyId);
      if (!prev || o.closedAt > prev) lost.set(o.companyId, o.closedAt);
    }
    for (const c of [...this.companies.values()].sort((a, b) => a.id - b.id)) {
      if (ids && !ids.has(c.id)) continue;
      const medidas: Record<string, number> = {};
      const marcasPreferidas: Record<string, number> = {};
      for (const key of this.fleetByCompany.get(c.id) ?? []) {
        const v = this.fleet.get(key);
        if (!v) continue;
        if (v.medidaProbable) medidas[v.medidaProbable] = (medidas[v.medidaProbable] ?? 0) + 1;
        const m = normMarca(v.marca);
        if (m && prefs.has(m)) marcasPreferidas[m] = (marcasPreferidas[m] ?? 0) + 1;
      }
      let vendidos12m = 0;
      let ventasReales = false;
      let ventasDemo = false;
      for (const s of this.salesByRucIdx.get(c.ruc) ?? []) {
        if (s.isDemo) {
          ventasDemo = true;
          continue;
        }
        ventasReales = true;
        if (s.fecha >= q.since12m) vendidos12m += s.cantidad;
      }
      out.push({
        companyId: c.id,
        ruc: c.ruc,
        unidades: c.unidades,
        llantasPiso: c.llantasPiso,
        sector: c.sector,
        departamento: c.departamento,
        antiguedadMedia: c.antiguedadMedia,
        esClienteMarcado: c.esCliente,
        medidas,
        marcasPreferidas,
        vendidos12m,
        ventasReales,
        ventasDemo,
        credito: this.credit.get(c.id)?.estado ?? null,
        perdidaAt: lost.get(c.id) ?? null,
      });
    }
    return out;
  }

  async saveScores(rows: ScoreUpdate[], at: Date): Promise<number> {
    let n = 0;
    for (const r of rows) {
      const c = this.companies.get(r.companyId);
      if (!c) continue;
      c.score = r.score;
      c.nivel = r.nivel;
      c.scoreDetalle = structuredClone(r.detalle);
      c.scoreAt = at;
      n++;
    }
    if (n) this.changed();
    return n;
  }

  async saveScoreRun(run: ScoreRunInput): Promise<ScoreRun> {
    const row: ScoreRun = { id: (this.scoreRuns.at(-1)?.id ?? 0) + 1, runAt: run.runAt ?? new Date(), empresas: run.empresas, cutA: run.cutA, cutB: run.cutB, conteo: { ...run.conteo }, duracionMs: run.duracionMs };
    this.scoreRuns.push(row);
    if (this.scoreRuns.length > 200) this.scoreRuns.splice(0, this.scoreRuns.length - 200);
    this.changed();
    return structuredClone(row);
  }

  async latestScoreRun(): Promise<ScoreRun | null> {
    const r = this.scoreRuns.at(-1);
    return r ? structuredClone(r) : null;
  }

  async bestCompanies(q: BestCompaniesQuery): Promise<{ rows: BestCompany[]; total: number }> {
    const recent = new Set<number>();
    for (const a of this.activities) if (a.occurredAt >= q.activeSince) recent.add(a.companyId);
    const eligible = [...this.companies.values()]
      .filter((c) => c.score !== null && (c.ownerUserId === null || (c.ownerUserId === q.userId && !recent.has(c.id))))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id - b.id);
    const offset = Math.max(0, q.offset ?? 0);
    const rows = eligible.slice(offset, offset + Math.max(0, q.limit)).map((c) => ({ ...structuredClone(c), propia: c.ownerUserId === q.userId }));
    return { rows, total: eligible.length };
  }

  async addRankingValidations(rows: RankingValidationInput[]): Promise<RankingValidation[]> {
    const out: RankingValidation[] = [];
    let id = this.rankingValidations.reduce((m, v) => Math.max(m, v.id), 0);
    for (const r of rows) {
      const v: RankingValidation = { id: ++id, userId: r.userId, companyId: r.companyId, nivelVendedor: r.nivelVendedor, nota: r.nota, nivelSistema: r.nivelSistema, scoreSistema: r.scoreSistema, createdAt: r.createdAt ?? new Date() };
      this.rankingValidations.push(v);
      out.push(structuredClone(v));
    }
    if (out.length) this.changed();
    return out;
  }

  async listRankingValidations(filter: { userId?: number; since?: Date } = {}): Promise<RankingValidation[]> {
    return this.rankingValidations
      .filter((v) => (filter.userId === undefined || v.userId === filter.userId) && (!filter.since || v.createdAt >= filter.since))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)
      .map((v) => structuredClone(v));
  }

  async markUserNotice(userId: number, aviso: string): Promise<boolean> {
    if (this.userNotices.some((n) => n.userId === userId && n.aviso === aviso)) return false;
    this.userNotices.push({ userId, aviso, createdAt: new Date() });
    this.changed();
    return true;
  }
}
