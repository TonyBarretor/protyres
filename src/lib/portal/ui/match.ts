/**
 * Corrida K — pantalla Match Venta (/portal/match): lo que la página necesita además de la API de src/lib/portal/match
 * (que lee lo guardado por el cálculo por lotes). Aquí solo hay parámetros de la dirección, chips de filtro, qué acciones
 * lleva cada tarjeta, el texto para cotizar con el bot, enlaces de Llamar/WhatsApp, la fecha de "Agendar visita", el
 * reparto de "Planificar visitas" y "Asignármela" desde la lista.
 *
 * Quién usa Match Venta: vendedor, supervisor y admin (el técnico no trabaja la cartera: ni menú ni página).
 * Prioridad y aplicación del producto: los mismos roles (canSetPriority). La aplicación es un dato del producto que
 * afina el cruce para todos, como la prioridad, así que se edita con el mismo permiso y queda con quién la cambió.
 */
import { canSeeAll } from "../auth/permissions";
import { DEPARTAMENTOS } from "../companies/manual";
import { matchFiltersQuery, parseMatchFilters, sizeBuckets, type MatchFilters } from "../match/read";
import { canSetPriority } from "../match/products";
import type { MatchProgressRow } from "../match/progress";
import type { PortalStore, PortalUser } from "../store/types";
import { addDays, limaDateKey, parseLimaLocal } from "./time";
import { distritoDe } from "./filters";
import { formText, type FormLike } from "./labels";

export const MATCH_PATH = "/portal/match";
export const MATCH_PLAN_PATH = "/portal/match/planificar";
/** Tarjetas por tanda ("Ver más" suma otra tanda). */
export const MATCH_PAGE = 20;
/** Tope de tarjetas en una sola página (una URL manipulada no pide 10⁹). */
export const MATCH_MAX_SHOWN = 400;
/** Tope de empresas en un reparto de visitas. */
export const MAX_PLAN = 40;
export const MAX_APLICACION = 80;

type UserLike = Pick<PortalUser, "id" | "rol" | "activo">;
type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** Match Venta: vendedor, supervisor y admin activos. */
export function canUseMatch(user: UserLike | null | undefined): boolean {
  return !!user && user.activo && canSetPriority(user);
}

/** Prender/quitar prioridad y editar la aplicación: los mismos roles que usan Match Venta. */
export function canEditMatchProduct(user: UserLike | null | undefined): boolean {
  return canUseMatch(user);
}

export interface MatchParams {
  vista: "productos" | "empresas";
  /** Producto abierto (Vista 2), o null (Vista 1). */
  code: string | null;
  filters: MatchFilters;
  /** Cuántas tarjetas mostrar (tandas de MATCH_PAGE). */
  n: number;
  /** Buscar en el stock para marcar otra prioridad ("" = cerrado). */
  buscar: string;
  /** Sección "Marcar otra llanta como prioridad" abierta. */
  agregar: boolean;
}

export function normalizeCode(v: string): string | null {
  const c = v.replace(/\s+/g, "").toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{0,29}$/.test(c) ? c : null;
}

export function parseMatchParams(sp: SP): MatchParams {
  const n = Math.trunc(Number(one(sp.n)));
  const buscar = one(sp.buscar).trim().replace(/\s+/g, " ").slice(0, 60);
  const filters = parseMatchFilters(sp);
  if (filters.departamento) {
    const dep = filters.departamento.toUpperCase();
    if ((DEPARTAMENTOS as readonly string[]).includes(dep)) filters.departamento = dep;
    else delete filters.departamento;
  }
  // corrida L: el distrito solo con un departamento que lo contiene (la lista de distritos depende del departamento)
  const dist = distritoDe(filters.departamento, filters.distrito);
  if (dist) filters.distrito = dist;
  else delete filters.distrito;
  return {
    vista: one(sp.vista) === "empresas" ? "empresas" : "productos",
    code: normalizeCode(one(sp.p)),
    filters,
    n: Number.isFinite(n) && n > MATCH_PAGE ? Math.min(MATCH_MAX_SHOWN, Math.ceil(n / MATCH_PAGE) * MATCH_PAGE) : MATCH_PAGE,
    buscar,
    agregar: one(sp.agregar) === "1" || !!buscar,
  };
}

/** Dirección de la pantalla con estos parámetros (lo que cambia en `over`). Cambiar filtros vuelve a la primera tanda. */
export function matchHref(p: MatchParams, over: Partial<MatchParams> = {}, hash = ""): string {
  const v = { ...p, ...over };
  if (over.filters || over.code !== undefined || over.vista) v.n = over.n ?? MATCH_PAGE;
  const q = new URLSearchParams();
  if (v.code) q.set("p", v.code);
  else if (v.vista === "empresas") q.set("vista", "empresas");
  if (v.code || v.vista === "empresas") for (const [k, val] of new URLSearchParams(matchFiltersQuery(v.filters))) q.set(k, val);
  if (v.n > MATCH_PAGE) q.set("n", String(v.n));
  if (!v.code && v.vista === "productos") {
    if (v.buscar) q.set("buscar", v.buscar);
    else if (v.agregar) q.set("agregar", "1");
  }
  const s = q.toString();
  return `${MATCH_PATH}${s ? `?${s}` : ""}${hash}`;
}

export interface MatchChip {
  id: string;
  label: string;
  active: boolean;
  href: string;
}

type FlagKey = "yaCompraron" | "conFlota" | "sinDueno" | "mias" | "limaCallao" | "incluirExcluidas";
const CHIPS: { key: FlagKey; label: string; off?: (keyof MatchFilters)[] }[] = [
  { key: "yaCompraron", label: "Ya me compraron" },
  { key: "conFlota", label: "Flota con la medida" },
  { key: "sinDueno", label: "Sin dueño", off: ["mias"] },
  { key: "mias", label: "Mías", off: ["sinDueno"] },
  { key: "limaCallao", label: "Lima y Callao", off: ["departamento", "distrito"] },
];

/**
 * Chips de la fila de filtros (cada uno prende o apaga su filtro y vuelve a la primera tanda). "Sin dueño" y "Mías" se
 * excluyen entre sí; "Lima y Callao" quita el departamento. Tamaño de flota: un chip por corte. Al final, "Incluir
 * Estado y leasing" (ocultos por defecto).
 */
export function filterChips(p: MatchParams, cortesFlota: number[]): MatchChip[] {
  const f = p.filters;
  const toggle = (key: keyof MatchFilters, value: unknown, off: (keyof MatchFilters)[] = []): string => {
    const next: MatchFilters = { ...f };
    if (f[key] === value) delete next[key];
    else {
      (next as Record<string, unknown>)[key] = value;
      for (const k of off) delete next[k];
    }
    return matchHref(p, { filters: next });
  };
  const chips: MatchChip[] = CHIPS.map((c) => ({ id: c.key, label: c.label, active: !!f[c.key], href: toggle(c.key, true, c.off) }));
  sizeBuckets(cortesFlota).forEach((b, i) => chips.push({ id: `tam${i}`, label: `${b.label} unid.`, active: f.tamano === i, href: toggle("tamano", i) }));
  chips.push({ id: "incluirExcluidas", label: "Incluir Estado y leasing", active: !!f.incluirExcluidas, href: toggle("incluirExcluidas", true) });
  return chips;
}

/** Campos ocultos del selector de departamento: los filtros de la vista sin departamento, distrito ni Lima y Callao ni la tanda. */
export function departamentoSelectHidden(p: MatchParams): Record<string, string> {
  const href = matchHref(p, { filters: { ...p.filters, departamento: undefined, distrito: undefined, limaCallao: undefined } });
  return Object.fromEntries([...new URLSearchParams(href.split("?")[1] ?? "")].filter(([k]) => k !== "n"));
}

/** Campos ocultos del selector de distrito: los filtros de la vista (con el departamento) sin el distrito ni la tanda. */
export function distritoSelectHidden(p: MatchParams): Record<string, string> {
  const href = matchHref(p, { filters: { ...p.filters, distrito: undefined } });
  return Object.fromEntries([...new URLSearchParams(href.split("?")[1] ?? "")].filter(([k]) => k !== "n"));
}

export function hasFilters(f: MatchFilters): boolean {
  return Object.values(f).some((v) => v !== undefined && v !== false);
}

/** Departamentos para el filtro (con "Lima y Callao" aparte). */
export const MATCH_DEPARTAMENTOS = DEPARTAMENTOS;

// ── acciones de la tarjeta ──

export type MatchActionId = "asignar" | "agendar" | "cotizar" | "ficha" | "ventas";

/**
 * Acciones de una tarjeta en orden: máximo tres visibles y el resto en "más". Asignármela solo si no tiene dueño;
 * Agendar visita si es suya, sin dueño (se la asigna al agendar) o si quien mira es supervisor/admin. Sin ficha (solo
 * ventas, fuera del padrón): "Ver ventas" en lugar de la ficha y sin agendar. Corrida L: "Cómo llegar" ya no va aquí, sino
 * junto a la dirección (con copiar), en todas las tarjetas.
 */
export function cardActions(card: { companyId: number | null; ownerUserId: number | null }, viewer: UserLike): { visibles: MatchActionId[]; mas: MatchActionId[] } {
  const all: MatchActionId[] = [];
  const working = viewer.activo && canUseMatch(viewer);
  if (card.companyId !== null) {
    if (working && card.ownerUserId === null) all.push("asignar");
    if (working && (card.ownerUserId === null || card.ownerUserId === viewer.id || canSeeAll(viewer))) all.push("agendar");
  }
  all.push("cotizar");
  all.push(card.companyId !== null ? "ficha" : "ventas");
  return { visibles: all.slice(0, 3), mas: all.slice(3) };
}

/** Lo que el vendedor le escribe al bot para cotizar: "Fenixway Flama 66 295/80R22.5 x24 para EMPRESA SAC RUC 20…". */
export function quoteText(o: { nombre: string; medida: string; disponible: number }, c: { razonSocial: string; ruc: string; podriaLlevar: number | null }): string {
  const qty = Math.max(1, Math.min(o.disponible > 0 ? o.disponible : 4, c.podriaLlevar && c.podriaLlevar > 0 ? c.podriaLlevar : 4));
  return `${o.nombre} ${o.medida} x${qty} para ${c.razonSocial} RUC ${c.ruc}`;
}

/** Chat del bot con el texto ya escrito (null si no hay número del bot configurado). */
export function botTextUrl(botNumber: string, text: string): string | null {
  const n = botNumber.replace(/\D/g, "");
  return n.length >= 8 ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
}

/**
 * Llamar y WhatsApp de un teléfono de contacto. Celular peruano (9 dígitos que empiezan con 9, con o sin 51): los dos;
 * fijo u otro formato: solo Llamar. null si no hay número utilizable.
 */
export function phoneLinks(telefono: string | null | undefined): { tel: string; wa: string | null } | null {
  const raw = (telefono ?? "").trim();
  let d = raw.replace(/\D/g, "");
  if (d.length < 6) return null;
  if (d.length === 11 && d.startsWith("51")) d = d.slice(2);
  if (d.length === 9 && d.startsWith("9")) return { tel: `tel:+51${d}`, wa: `https://wa.me/51${d}` };
  return { tel: `tel:${raw.startsWith("+") ? "+" : ""}${raw.replace(/\D/g, "")}`, wa: null };
}

// ── agendar ──

export type VisitDay = "hoy" | "manana" | "otra";

const LIMA_HOUR = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Lima", hour: "2-digit", hour12: false }).format(d)) % 24;

/**
 * Fecha y hora de "Agendar visita" (hora de Lima): hoy, mañana u otra fecha (hasta un año) y hora opcional. Sin hora,
 * las 9:00; si es hoy y ya pasaron las 9, la próxima hora en punto. Una hora de hoy que ya pasó no se acepta.
 */
export function visitStart(input: { dia: string; fecha?: string; hora?: string }, now: Date = new Date()): { ok: true; startsAt: Date } | { ok: false; error: string } {
  const today = limaDateKey(now);
  let key: string;
  if (input.dia === "hoy") key = today;
  else if (input.dia === "manana") key = limaDateKey(addDays(now, 1));
  else if (input.dia === "otra") {
    const f = (input.fecha ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !parseLimaLocal(`${f}T09:00`)) return { ok: false, error: "Elige la fecha de la visita." };
    if (f < today) return { ok: false, error: "Esa fecha ya pasó." };
    if (f > limaDateKey(addDays(now, 366))) return { ok: false, error: "Elige una fecha dentro del próximo año." };
    key = f;
  } else return { ok: false, error: "Elige el día de la visita: hoy, mañana u otra fecha." };
  const hora = (input.hora ?? "").trim();
  if (hora) {
    if (!/^\d{2}:\d{2}$/.test(hora)) return { ok: false, error: "Hora no válida." };
    const at = parseLimaLocal(`${key}T${hora}`);
    if (!at) return { ok: false, error: "Hora no válida." };
    if (at.getTime() < now.getTime() - 5 * 60_000) return { ok: false, error: "Esa hora ya pasó: elige otra." };
    return { ok: true, startsAt: at };
  }
  if (key === today && LIMA_HOUR(now) >= 9) {
    const next = Math.min(23, LIMA_HOUR(now) + 1);
    return { ok: true, startsAt: parseLimaLocal(`${key}T${String(next).padStart(2, "0")}:00`)! };
  }
  return { ok: true, startsAt: parseLimaLocal(`${key}T09:00`)! };
}

// ── planificar visitas ──

export interface PlanPick {
  companyId: number;
  code: string;
}

/** Marcas de la lista ("123:P0433"): sin repetir empresa (gana la primera), hasta MAX_PLAN. */
export function parsePlanPicks(values: string[]): PlanPick[] {
  const out: PlanPick[] = [];
  const seen = new Set<number>();
  for (const v of values) {
    const m = /^(\d{1,12}):([A-Za-z0-9._-]{1,30})$/.exec(v.trim());
    if (!m) continue;
    const companyId = Number(m[1]);
    const code = normalizeCode(m[2]);
    if (!code || !Number.isSafeInteger(companyId) || companyId <= 0 || seen.has(companyId)) continue;
    seen.add(companyId);
    out.push({ companyId, code });
    if (out.length >= MAX_PLAN) break;
  }
  return out;
}

const fmtDayLabel = new Intl.DateTimeFormat("es-PE", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });

/** "lun, 24 nov" de una clave AAAA-MM-DD. */
export function dayLabel(key: string): string {
  return fmtDayLabel.format(new Date(`${key}T12:00:00Z`));
}

/** Días a los que se puede mover una visita: hoy y los próximos `n` días de visita (lunes a sábado, sin feriados). */
export function planDayChoices(now: Date, holidays: string[] = [], n = 12): { key: string; label: string }[] {
  const h = new Set(holidays);
  const out: { key: string; label: string }[] = [];
  const today = limaDateKey(now);
  for (let i = 0; out.length < n + 1 && i < 40; i++) {
    const key = limaDateKey(addDays(now, i));
    const dow = new Date(`${key}T12:00:00Z`).getUTCDay();
    if (key !== today && (dow === 0 || h.has(key))) continue;
    out.push({ key, label: key === today ? `Hoy (${dayLabel(key)})` : dayLabel(key) });
  }
  return out;
}

export interface PlanConfirmItem {
  companyId: number;
  code: string;
  fecha: string;
  hora: string;
}

/** Formulario de "Confirmar visitas": `v` = "empresa:código", `d<empresa>` = día, `h<empresa>` = hora opcional. */
export function parsePlanConfirm(f: FormLike & { getAll(name: string): FormDataEntryValue[] }): PlanConfirmItem[] {
  const picks = parsePlanPicks(f.getAll("v").filter((x): x is string => typeof x === "string"));
  return picks.map((p) => ({ ...p, fecha: formText(f, `d${p.companyId}`, 10), hora: formText(f, `h${p.companyId}`, 5) }));
}

// ── volver y asignar ──

/** Solo rutas de Match Venta (o la ficha / Hoy) como vuelta: evita redirecciones abiertas con un "volver" manipulado. */
export function safeMatchBack(v: string): string {
  const ok = (v.startsWith(MATCH_PATH) || v.startsWith("/portal/empresas/") || v === "/portal/hoy") && !v.startsWith("//") && !v.includes("\\") && v.length <= 600;
  return ok ? v : MATCH_PATH;
}

export type AssignResult = { ok: true; text: string; already?: boolean } | { ok: false; error: string };

/**
 * "Asignármela" desde Match Venta: solo empresas sin dueño (atómico: de dos vendedores a la vez, uno la toma). Crea la
 * oportunidad en Prospecto si no tiene una abierta y deja la actividad.
 */
export async function assignFromMatch(store: PortalStore, user: Pick<PortalUser, "id" | "nombre" | "rol" | "activo">, companyId: number, now: Date = new Date()): Promise<AssignResult> {
  if (!canUseMatch(user)) return { ok: false, error: "Tu rol no puede asignarse empresas." };
  const company = await store.getCompany(companyId);
  if (!company) return { ok: false, error: "Empresa no encontrada." };
  if (company.ownerUserId === user.id) return { ok: true, already: true, text: `${company.razonSocial} ya es tuya.` };
  if (company.ownerUserId !== null) {
    const owner = await store.getUser(company.ownerUserId).catch(() => null);
    return { ok: false, error: `${company.razonSocial} ya es de ${owner?.nombre ?? "otro vendedor"}. Pide al supervisor que la reasigne.` };
  }
  if (!(await store.setOwner(company.id, user.id, { onlyIfOwner: null }))) return { ok: false, error: `Otro vendedor acaba de tomar ${company.razonSocial}.` };
  let { opportunity: opp } = await store.openOrCreateOpportunity({ companyId: company.id, ownerUserId: user.id, etapa: "prospecto", createdBy: user.id, at: now });
  if (opp.ownerUserId !== user.id) opp = (await store.updateOpportunity(opp.id, { ownerUserId: user.id })) ?? opp;
  await store.addActivity({ companyId: company.id, opportunityId: opp.id, userId: user.id, tipo: "nota", texto: `${user.nombre} se asignó la empresa (desde Match Venta).`, canal: "portal", occurredAt: now, data: { evento: "asignacion", ownerUserId: user.id, previousOwnerUserId: null } });
  return { ok: true, text: `${company.razonSocial} quedó asignada a ti.` };
}

// ── avance ──

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("es-PE")} ${n === 1 ? one : many}`;

/** "3 cotizadas · 0 en pedidos · 2 visitas (1 hecha, 0 con cotización, 0 con pedido)" */
export function progressLine(r: Pick<MatchProgressRow, "cotizado" | "pedido" | "visitas">): string {
  const v = r.visitas;
  const visitas = v.agendadas ? `${plural(v.agendadas, "visita", "visitas")} (${plural(v.hechas, "hecha", "hechas")}, ${v.conCotizacion} con cotización, ${v.conPedido} con pedido)` : "sin visitas todavía";
  return `${plural(r.cotizado, "cotizada", "cotizadas")} · ${r.pedido.toLocaleString("es-PE")} en pedidos · ${visitas}`;
}

/** Notas del producto: las de "revisión técnica" van al detalle; el resto (padrón no permite inferir…) a la vista. */
export function splitNotes(notas: string[]): { aviso: string[]; tecnicas: string[] } {
  const tecnicas = notas.filter((n) => /revisi[oó]n t[eé]cnica/i.test(n));
  return { aviso: notas.filter((n) => !tecnicas.includes(n)), tecnicas };
}

/** "LIMA / SAN ISIDRO" -> "Lima / San Isidro" (zonas del reparto; el padrón las trae en mayúsculas). */
export function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s/(-])([a-záéíóúñü])/g, (_m, a: string, b: string) => a + b.toUpperCase());
}
