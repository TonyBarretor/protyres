/**
 * Corrida J — empresas que no están en el padrón del MTC (el import solo trae flotas de 10 unidades o más).
 *
 *  - RUC: 11 dígitos, empieza con 10, 15, 16, 17 o 20 y cumple el dígito verificador de SUNAT (módulo 11).
 *  - Alta: `createCompany` = createManualCompany del store (origen "manual", dueño = quien la crea; si el RUC ya existe
 *    no duplica y devuelve esa) + oportunidad en Prospecto + contacto opcional + actividad (hito de asignación para las
 *    métricas) + puntaje de esa empresa (los datos que faltan valen 0 y la explicación lo dice, como siempre).
 *  - Vehículos cargados a mano (ficha del portal): `addVehicle` / `removeVehicle`. En una empresa creada a mano, sus
 *    unidades pasan a ser al menos los vehículos cargados y las llantas en piso, la suma de sus llantas.
 *  - Texto libre (bot, también dictado): `parseCompanyText` saca RUC, sector, departamento, unidades y contacto; lo que
 *    queda es la razón social.
 *
 * Lo usan el comando `nueva empresa` (bot/commands/nueva-empresa.ts), "Agregar empresa" de Prospectos y la ficha.
 */
import { loadPortalConfig } from "../config";
import { recalcScoresSafely, type PriceSizesSource } from "../scoring/recalc";
import { foldText } from "../store/shared";
import type { Company, FleetVehicle, ManualVehicleInput, PortalStore, PortalUser, Sector } from "../store/types";
import { parseTyreSize } from "../../tyre/spec";

// ── RUC ──

export const RUC_HELP = "El RUC tiene 11 dígitos y empieza con 10, 15, 16, 17 o 20.";
const RUC_PREFIXES = ["10", "15", "16", "17", "20"];
const RUC_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** Dígito verificador de SUNAT (módulo 11 con pesos 5 4 3 2 7 6 5 4 3 2). */
export function rucCheckDigitOk(ruc: string): boolean {
  if (!/^\d{11}$/.test(ruc)) return false;
  const sum = RUC_WEIGHTS.reduce((acc, w, i) => acc + w * Number(ruc[i]), 0);
  const r = 11 - (sum % 11);
  const check = r === 10 ? 0 : r === 11 ? 1 : r;
  return check === Number(ruc[10]);
}

/** null si el RUC sirve; si no, qué tiene mal (para decírselo al usuario). */
export function rucProblem(ruc: string): string | null {
  if (!/^\d+$/.test(ruc)) return `«${ruc}» no es un RUC. ${RUC_HELP}`;
  if (ruc.length !== 11) return `El RUC ${ruc} tiene ${ruc.length} dígitos. ${RUC_HELP}`;
  if (!RUC_PREFIXES.includes(ruc.slice(0, 2))) return `El RUC ${ruc} no empieza con 10, 15, 16, 17 ni 20. Revísalo.`;
  if (!rucCheckDigitOk(ruc)) return `El RUC ${ruc} no es válido (el último dígito no cuadra). Revísalo.`;
  return null;
}

/** Secuencia de 11 dígitos en el texto, aunque venga separada ("20 123 456 789", "20.123.456.789"); null si no hay. */
export function findRuc(text: string): { ruc: string; index: number; length: number } | null {
  const m = /(?<!\d)\d(?:[\s.-]?\d){10}(?![\d])/.exec(text);
  if (!m) return null;
  return { ruc: m[0].replace(/\D/g, ""), index: m.index, length: m[0].length };
}

// ── sector y departamento ──

export const DEPARTAMENTOS = [
  "AMAZONAS",
  "ANCASH",
  "APURIMAC",
  "AREQUIPA",
  "AYACUCHO",
  "CAJAMARCA",
  "CALLAO",
  "CUSCO",
  "HUANCAVELICA",
  "HUANUCO",
  "ICA",
  "JUNIN",
  "LA LIBERTAD",
  "LAMBAYEQUE",
  "LIMA",
  "LORETO",
  "MADRE DE DIOS",
  "MOQUEGUA",
  "PASCO",
  "PIURA",
  "PUNO",
  "SAN MARTIN",
  "TACNA",
  "TUMBES",
  "UCAYALI",
] as const;

const DEPARTAMENTO_TILDES: Record<string, string> = { ANCASH: "Áncash", APURIMAC: "Apurímac", HUANUCO: "Huánuco", JUNIN: "Junín", "SAN MARTIN": "San Martín" };

/** "LA LIBERTAD" -> "La Libertad", "JUNIN" -> "Junín" (para mostrar; se guarda como el padrón). */
export function departamentoLabel(d: string): string {
  return DEPARTAMENTO_TILDES[d] ?? d.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, sp: string, c: string) => `${sp}${c.toUpperCase()}`).replace(/ De /g, " de ");
}

const fold = (s: string) =>
  foldText(s)
    .replace(/[^a-z0-9ñ]+/g, " ")
    .trim();

/** "Lima", "junín", "La Libertad", "Cuzco" -> como los guarda el padrón ("LIMA", "JUNIN"); null si no es uno. */
export function matchDepartamento(text: string): string | null {
  const t = fold(text)
    .replace(/^(?:(?:departamento|depto|dpto|region|de|en)\s+)+/, "")
    .replace(/\bcuzco\b/, "cusco");
  if (!t) return null;
  return DEPARTAMENTOS.find((d) => fold(d) === t) ?? null;
}

/** Departamento nombrado en cualquier parte del texto (el más largo primero: "la libertad" antes que "lima"). */
function departamentoIn(text: string): { departamento: string; phrase: RegExp } | null {
  const t = ` ${fold(text).replace(/\bcuzco\b/, "cusco")} `;
  for (const d of [...DEPARTAMENTOS].sort((a, b) => b.length - a.length)) {
    if (t.includes(` ${fold(d)} `)) return { departamento: d, phrase: new RegExp(`(?<![\\p{L}])(?:(?:departamento|depto|dpto|regi[oó]n)\\s+(?:de\\s+)?)?${d.split(" ").map(letters).join("\\s+")}(?![\\p{L}])`, "iu") };
  }
  return null;
}

/** "JUNIN" -> patrón que acepta "Junín" (vocales con o sin tilde). */
function letters(word: string): string {
  return word
    .toLowerCase()
    .replace(/[aeiou]/g, (v) => `[${v}${"áéíóú"["aeiou".indexOf(v)]}]`);
}

const SECTOR_WORDS: { sector: Sector; re: RegExp }[] = [
  { sector: "mixto", re: /(?<![\p{L}])(?:mixto|mixta|ambos|carga\s+y\s+pasajeros|pasajeros\s+y\s+carga)(?![\p{L}])/iu },
  { sector: "pasajeros", re: /(?<![\p{L}])(?:pasajeros|pasajero|buses|bus|[oó]mnibus|transporte\s+de\s+personal|personal|turismo|interprovincial|urbano)(?![\p{L}])/iu },
  { sector: "carga", re: /(?<![\p{L}])(?:carga|camiones|cami[oó]n|volquetes|cisternas|log[ií]stica|minera|miner[ií]a)(?![\p{L}])/iu },
];

/** Sector dicho con sus palabras ("carga", "pasajeros", "buses", "mixto", "ambos"); null si no se reconoce. */
export function matchSector(text: string): Sector | null {
  for (const s of SECTOR_WORDS) if (s.re.test(text)) return s.sector;
  return null;
}

// ── datos de la empresa nueva ──

export interface NewCompanyContact {
  nombre: string;
  cargo: string | null;
  telefono: string | null;
}

/** Lo que se va juntando de la empresa nueva (bot: paso pendiente; portal: formulario). */
export interface NewCompanyData {
  ruc: string | null;
  razonSocial: string | null;
  sector: Sector | null;
  departamento: string | null;
  unidades: number | null;
  contacto: NewCompanyContact | null;
}

export const EMPTY_COMPANY: NewCompanyData = { ruc: null, razonSocial: null, sector: null, departamento: null, unidades: null, contacto: null };

const UNITS_RE = /(?<![\p{L}\d])(\d{1,5})\s*(?:unidades|unidad|unids?|veh[ií]culos|camiones|buses|[oó]mnibus|carros|flota)(?![\p{L}])/iu;
const CONTACT_RE = /(?<![\p{L}])(?:contacto|contactos|habl[eé]\s+con|con\s+el\s+(?:sr|señor|ing)\.?)\s*:?\s+([^;\n]+)$/iu;

/** Palabras sueltas del dictado que no son parte de la razón social. */
const FILLER_WORDS = new Set(["son", "es", "de", "del", "en", "la", "el", "y", "con", "sector", "rubro", "departamento", "ruc", "empresa", "tiene", "tienen", "ubicada", "ubicado", "esta", "queda", "razon", "social", "nombre", ""]);

/** Razón social limpia: espacios simples, sin signos al borde, mayúsculas como el padrón. */
export function cleanRazonSocial(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, "")
    .trim()
    .toUpperCase()
    .slice(0, 160);
}

/** "Juan Pérez, jefe de flota, 987 654 321" -> partes (nombre obligatorio). */
export function parseContactLine(text: string): NewCompanyContact | null {
  let t = text.trim();
  let telefono: string | null = null;
  const ph = /\+?\d[\d\s().-]{4,}\d/.exec(t);
  if (ph && ph[0].replace(/\D/g, "").length >= 6) {
    telefono = ph[0].replace(/[^\d+]/g, "");
    t = t.replace(ph[0], " ");
  }
  const parts = t
    .split(/[,;]/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const nombre = (parts[0] ?? "").replace(/[^\p{L}\s.'-]/gu, "").trim();
  if (!/\p{L}{2}/u.test(nombre)) return null;
  const cargo = parts.slice(1).join(", ").trim() || null;
  return { nombre: nombre.slice(0, 120), cargo: cargo ? cargo.slice(0, 120) : null, telefono };
}

/**
 * Datos de la empresa en un texto libre ("20123456786 Transportes Sol SAC, carga, Lima, 15 unidades, contacto Juan
 * Pérez 987654321"). Solo lo que encuentra; la razón social es lo que sobra (si sobra algo con letras).
 */
export function parseCompanyText(text: string): Partial<NewCompanyData> {
  let t = ` ${text.replace(/\s+/g, " ").trim()} `;
  const out: Partial<NewCompanyData> = {};
  const contact = CONTACT_RE.exec(t);
  if (contact) {
    const c = parseContactLine(contact[1]);
    if (c) out.contacto = c;
    t = t.slice(0, contact.index);
  }
  const ruc = findRuc(t);
  if (ruc) {
    out.ruc = ruc.ruc;
    t = `${t.slice(0, ruc.index)} ${t.slice(ruc.index + ruc.length)}`.replace(/(?<![\p{L}])ruc\s*:?\s*(?=\s|$)/iu, " ");
  }
  const units = UNITS_RE.exec(t);
  if (units) {
    out.unidades = Number(units[1]);
    t = t.replace(units[0], " ");
  }
  for (const s of SECTOR_WORDS) {
    const m = s.re.exec(t);
    if (!m) continue;
    out.sector = s.sector;
    t = t.replace(new RegExp(`(?:(?:sector|rubro|de)\\s+)?${m[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"), " ");
    break;
  }
  const dep = departamentoIn(t);
  if (dep) {
    out.departamento = dep.departamento;
    t = t.replace(dep.phrase, " ");
  }
  // lo que sobra, por partes (comas): fuera las que solo traen relleno ("son", "en", "sector"); el resto es la razón social
  const rest = cleanRazonSocial(
    t
      .split(/[,;]/)
      .map((p) => p.replace(/^\s*(?:la\s+empresa|empresa|raz[oó]n\s+social|nombre)\s*:?\s+/i, "").trim())
      .filter((p) => p && !p.split(/\s+/).every((w) => FILLER_WORDS.has(fold(w))))
      .join(" "),
  );
  if (/\p{L}{2}/u.test(rest)) out.razonSocial = rest;
  return out;
}

/** El primer dato obligatorio que falta (RUC, razón social, sector, departamento); null = completo. */
export type CompanyField = "ruc" | "razonSocial" | "sector" | "departamento";

export function missingField(d: NewCompanyData): CompanyField | null {
  if (!d.ruc || rucProblem(d.ruc)) return "ruc";
  if (!d.razonSocial) return "razonSocial";
  if (!d.sector) return "sector";
  if (!d.departamento) return "departamento";
  return null;
}

/** Línea de resumen de lo que se va a crear (WhatsApp). */
export function formatNewCompany(d: NewCompanyData): string {
  const lines = [`🏢 *${d.razonSocial ?? "(sin razón social)"}*`, `RUC ${d.ruc ?? "—"} · ${d.sector ? sectorName(d.sector) : "sector —"} · ${d.departamento ? departamentoLabel(d.departamento) : "departamento —"}`];
  lines.push(`Unidades: ${d.unidades ?? "—"}${d.contacto ? ` · Contacto: ${d.contacto.nombre}${d.contacto.cargo ? ` (${d.contacto.cargo})` : ""}${d.contacto.telefono ? ` · ${d.contacto.telefono}` : ""}` : ""}`);
  return lines.join("\n");
}

function sectorName(s: Sector): string {
  return s === "carga" ? "Carga" : s === "pasajeros" ? "Pasajeros" : "Mixto";
}

// ── alta ──

export interface CreateCompanyOptions {
  /** "whatsapp", "voz" o "portal" (canal de la actividad). */
  canal: string;
  now?: Date;
  /** Catálogo para el puntaje; una empresa recién creada no tiene medidas, así que no hace falta (null). */
  prices?: PriceSizesSource | null;
  log?: (msg: string) => void;
}

export type CreateCompanyResult = { ok: true; company: Company; created: boolean } | { ok: false; error: string };

/**
 * Crea la empresa a mano (o devuelve la que ya tiene ese RUC, sin tocarla). Al crearla: dueño = quien la crea,
 * oportunidad en Prospecto, contacto si se dio, actividad y puntaje de esa empresa.
 */
export async function createCompany(store: PortalStore, user: Pick<PortalUser, "id" | "nombre">, data: NewCompanyData, opts: CreateCompanyOptions): Promise<CreateCompanyResult> {
  const ruc = (data.ruc ?? "").replace(/\D/g, "");
  const bad = rucProblem(ruc);
  if (bad) return { ok: false, error: bad };
  const razonSocial = cleanRazonSocial(data.razonSocial ?? "");
  if (!/\p{L}{2}/u.test(razonSocial)) return { ok: false, error: "Falta la razón social." };
  if (!data.sector) return { ok: false, error: "Falta el sector (carga, pasajeros o mixto)." };
  const departamento = data.departamento ? matchDepartamento(data.departamento) : null;
  if (!departamento) return { ok: false, error: "Falta el departamento (p. ej. Lima, Arequipa, La Libertad)." };
  const unidades = data.unidades !== null && data.unidades !== undefined && Number.isFinite(data.unidades) && data.unidades >= 0 ? Math.round(data.unidades) : null;
  if (unidades !== null && unidades > 100_000) return { ok: false, error: "Las unidades no parecen correctas." };

  const now = opts.now ?? new Date();
  const { company, created } = await store.createManualCompany({ ruc, razonSocial, sector: data.sector, departamento, unidades, createdBy: user.id });
  if (!created) return { ok: true, company, created: false };
  const { opportunity } = await store.openOrCreateOpportunity({ companyId: company.id, ownerUserId: user.id, etapa: "prospecto", createdBy: user.id, at: now });
  if (data.contacto?.nombre) {
    await store.addContact({ companyId: company.id, nombre: data.contacto.nombre, cargo: data.contacto.cargo, telefono: data.contacto.telefono, createdBy: user.id });
  }
  // data.evento = "asignacion": hito de inicio para las métricas de tiempos (metrics/timeline.ts), como `asignarme`
  await store.addActivity({
    companyId: company.id,
    opportunityId: opportunity.id,
    userId: user.id,
    tipo: "nota",
    texto: `${user.nombre} creó la empresa (no está en el padrón del MTC) y quedó asignada a su nombre.`,
    canal: opts.canal,
    occurredAt: now,
    data: { evento: "asignacion", creada: true, origen: "manual", ownerUserId: user.id, previousOwnerUserId: null },
  });
  await recalcScoresSafely(store, loadPortalConfig().scoring, { companyIds: [company.id], prices: opts.prices ?? null, now, why: "empresa creada a mano", log: opts.log ?? (() => undefined) });
  return { ok: true, company: (await store.getCompany(company.id)) ?? company, created: true };
}

// ── vehículos cargados a mano ──

export interface VehicleForm {
  placa: string;
  marca?: string | null;
  clase?: string | null;
  ejes?: number | null;
  llantas?: number | null;
  medida?: string | null;
  anio?: number | null;
}

/** Placa peruana (6 caracteres, "ABC-123" / "A1B-234") o la que venga del padrón: letras y números, 5 a 8. */
export function normalizePlaca(raw: string): string | null {
  const t = raw.toUpperCase().replace(/[\s.]+/g, "");
  const flat = t.replace(/-/g, "");
  if (!/^[A-Z0-9]{5,8}$/.test(flat) || !/\d/.test(flat)) return null;
  return flat.length === 6 ? `${flat.slice(0, 3)}-${flat.slice(3)}` : t;
}

export type VehicleCheck = { ok: true; input: ManualVehicleInput } | { ok: false; error: string };

/** Valida el formulario de un vehículo (placa obligatoria; ejes 1–10; llantas 2–40; medida reconocible). */
export function checkVehicle(f: VehicleForm): VehicleCheck {
  const placa = normalizePlaca(f.placa ?? "");
  if (!placa) return { ok: false, error: "Placa no válida (p. ej. ABC-123)." };
  const ejes = f.ejes ?? null;
  if (ejes !== null && (!Number.isInteger(ejes) || ejes < 1 || ejes > 10)) return { ok: false, error: "Ejes: un número de 1 a 10." };
  const llantas = f.llantas ?? null;
  if (llantas !== null && (!Number.isInteger(llantas) || llantas < 2 || llantas > 40)) return { ok: false, error: "Llantas: un número de 2 a 40." };
  const anio = f.anio ?? null;
  if (anio !== null && (!Number.isInteger(anio) || anio < 1950 || anio > 2100)) return { ok: false, error: "Año no válido." };
  let medida: string | null = null;
  if (f.medida && f.medida.trim()) {
    const size = parseTyreSize(f.medida);
    if (!size) return { ok: false, error: `No reconozco la medida «${f.medida.trim()}» (p. ej. 295/80R22.5, 11R22.5).` };
    medida = size.canonical;
  }
  const text = (s: string | null | undefined, max: number) => (s ?? "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, max) || null;
  return { ok: true, input: { placa, marca: text(f.marca, 40), clase: text(f.clase, 40), ejes, llantas, medida, anio } };
}

export type AddVehicleResult = { ok: true; vehicle: FleetVehicle; updated: boolean } | { ok: false; error: string };

/** Unidades y llantas en piso de una empresa creada a mano, según lo cargado (unidades: nunca menos de lo declarado). */
async function syncManualCounts(store: PortalStore, company: Company): Promise<void> {
  if (company.origen !== "manual") return;
  const fleet = await store.listManualVehicles(company.id);
  const llantas = fleet.reduce((n, v) => n + (v.llantas ?? 0), 0);
  const unidades = Math.max(company.unidades, fleet.length);
  if (unidades !== company.unidades || llantas !== company.llantasPiso) await store.updateCompany(company.id, { unidades, llantasPiso: llantas });
}

/** Agrega (o corrige, misma placa) un vehículo cargado a mano y recalcula el puntaje de la empresa. */
export async function addVehicle(store: PortalStore, user: Pick<PortalUser, "id" | "nombre">, company: Company, form: VehicleForm, opts: { prices?: PriceSizesSource | null; log?: (m: string) => void; canal?: string } = {}): Promise<AddVehicleResult> {
  const check = checkVehicle(form);
  if (!check.ok) return check;
  const r = await store.addManualVehicle(company.id, check.input);
  if (!r.ok) {
    const other = await store.getCompany(r.companyId);
    return { ok: false, error: `La placa ${check.input.placa} ya está cargada a mano en ${other ? other.razonSocial : "otra empresa"}.` };
  }
  await syncManualCounts(store, company);
  const v = r.vehicle;
  const desc = [v.marca, v.clase, v.ejes ? `${v.ejes} ejes` : null, v.llantas ? `${v.llantas} llantas` : null, v.medidaProbable].filter(Boolean).join(", ");
  await store.addActivity({ companyId: company.id, userId: user.id, tipo: "nota", texto: `${user.nombre} ${r.updated ? "corrigió" : "cargó a mano"} el vehículo ${v.placa}${desc ? ` (${desc})` : ""}.`, canal: opts.canal ?? "portal", data: { evento: "vehiculo_manual", placa: v.placa } });
  await recalcScoresSafely(store, loadPortalConfig().scoring, { companyIds: [company.id], prices: opts.prices ?? null, why: "vehículo cargado a mano", log: opts.log ?? (() => undefined) });
  return { ok: true, vehicle: v, updated: r.updated };
}

/** Borra un vehículo cargado a mano (los del padrón no se borran a mano). */
export async function removeVehicle(store: PortalStore, user: Pick<PortalUser, "id" | "nombre">, company: Company, vehicleId: number, opts: { prices?: PriceSizesSource | null; log?: (m: string) => void } = {}): Promise<boolean> {
  const fleet = await store.listManualVehicles(company.id);
  const v = fleet.find((x) => x.id === vehicleId);
  if (!v || !(await store.deleteManualVehicle(company.id, vehicleId))) return false;
  if (company.origen === "manual") {
    const left = fleet.filter((x) => x.id !== vehicleId);
    await store.updateCompany(company.id, { llantasPiso: left.reduce((n, x) => n + (x.llantas ?? 0), 0) });
  }
  await store.addActivity({ companyId: company.id, userId: user.id, tipo: "nota", texto: `${user.nombre} quitó el vehículo ${v.placa} (cargado a mano).`, canal: "portal", data: { evento: "vehiculo_manual", placa: v.placa, borrado: true } });
  await recalcScoresSafely(store, loadPortalConfig().scoring, { companyIds: [company.id], prices: opts.prices ?? null, why: "vehículo cargado a mano", log: opts.log ?? (() => undefined) });
  return true;
}
