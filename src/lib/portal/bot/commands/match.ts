/**
 * Corrida K, punto 5 — Match Venta en el bot (lógica en src/lib/portal/match/; aquí solo textos y pasos):
 *
 *  - `match` (escrito o dictado: "¿a quién le vendo mi stock?", "¿qué tengo que vender?"): los productos prioritarios con
 *    su disponible en Lima y cuántas empresas hacen match, con una lista para elegir uno (fila = `match <código>`).
 *  - `match 295/80R22.5` / `match P0433` / "a quién le ofrezco las Flama 66": las 5 mejores empresas con su porcentaje
 *    ("estimado"), el desglose en una línea, la venta real aparte ("Ya te compró…"), la migración, RUC y ubicación; una
 *    lista para elegir una (fila = su número) y *más* trae las 5 siguientes. Elegida una: *Asignármela*, *Agendar visita*,
 *    *Más empresas*. Agendar pide el día (*Hoy*, *Mañana*, *Otra fecha*; o "jueves 10am" de una vez) y la hora (opcional:
 *    *Sin hora* = 9:00) y llama a scheduleMatchVisit (asigna si no tiene dueño, atómico; sin oportunidades duplicadas; la
 *    visita queda ligada al producto). Empresas de otro vendedor no aparecen (matchesForProduct). Si el padrón no permite
 *    inferir la medida, se dice (notas del cálculo) y se muestran los clientes que ya la compraron.
 *  - `prioridad P0428` / `quitar prioridad P0428`, también por medida + modelo ("prioridad 295 flama 66") y por voz: el
 *    producto se busca en el stock propio vivo (resolveProduct); con varias coincidencias se elige de una lista.
 *  - `avance match`: por producto prioritario, disponible, cotizado (de las cotizaciones guardadas: el cotizador no
 *    cambia), pedido, restante y visitas (matchProgress / progressText).
 *
 * Deja un paso pendiente (`match`) con el producto, lo ya mostrado y la empresa elegida; otro texto que no es respuesta
 * sigue su camino (un reporte es reporte). Las respuestas por voz se transcriben una vez (fetchVoice).
 */
import { getStore } from "../../../store";
import type { PriceStore } from "../../../store/types";
import { fold } from "../../../tyre/brands";
import { BUTTON_TITLE_MAX, LIST_ROW_DESCRIPTION_MAX, LIST_ROW_TITLE_MAX, LIST_ROWS_MAX } from "../../../whatsapp/interactive";
import { loadPortalConfig } from "../../config";
import {
  canSetPriority,
  loadMatchStock,
  locationText,
  matchesForProduct,
  matchOverview,
  matchProgress,
  productLabel,
  productName,
  progressText,
  resolveProduct,
  scheduleMatchVisit,
  setPriorityAndRecalc,
  type MatchCard,
  type MatchStockProduct,
  type OwnStockSource,
} from "../../match";
import { matchCode } from "../../store/shared";
import { canAssignSelf } from "../../ui/permissions";
import { limaStartOfDay } from "../../ui/time";
import { normalizeSpoken } from "../../voice/dictation";
import { shortName } from "../companies";
import { atLimaTime, parseSpanishDateTime, parseTimeOfDay } from "../dates";
import { registerPendingHandler, registerPortalCommand, replyButtons, replyList, type PortalContext } from "../registry";
import { fetchVoice, logTranscript } from "../report";
import { clearPending, setPending, type PendingStep } from "../state";
import { heardLine } from "../voice-quote";
import { assignToMe } from "./asignarme";
import { inviteForNewAppointment } from "./cita";

export const MATCH_STEP = "match";
/** Empresas por tanda (como `mejores`). */
export const MATCH_PAGE = 5;
export const MATCH_ESTIMATE = "_El % es estimado: la medida de cada flota se deduce del padrón por tipo de vehículo. «Ya te compró» es venta real._";
export const MATCH_NO_MORE = "No hay más empresas para esta llanta. Escribe *match* para ver tus otros productos prioritarios.";
export const MATCH_NOT_PRIORITY = (label: string, code: string) => `*${label}* (${code}) no es prioridad. Escribe *prioridad ${code}* para marcarla y ver a quién ofrecérsela.`;
/** Hora de la visita cuando el vendedor no la da (la pantalla también agenda a las 9:00). */
export const MATCH_DEFAULT_HOUR = { hour: 9, minute: 0 };
/** Cuántas empresas mostradas se recuerdan (para elegir por número y no repetir). */
const MAX_SHOWN = 60;

interface ShownCompany {
  n: number;
  companyId: number;
  ruc: string;
  razonSocial: string;
  pct: number | null;
  estado: string;
}

interface MatchStep extends PendingStep {
  kind: typeof MATCH_STEP;
  code: string;
  etiqueta: string;
  /** Siguiente posición de la lista (empresas ya mostradas). */
  offset: number;
  total: number;
  shown: ShownCompany[];
  /** Empresa elegida (su companyId). */
  pick?: number | null;
  /** Agendando: preguntando el día o la hora. */
  phase?: "date" | "hour" | null;
  /** Día elegido (medianoche de Lima, ISO) mientras se pregunta la hora. */
  day?: string | null;
}

// ── dependencias (tests y simulador; por defecto el store del cotizador) ──

export interface MatchBotDeps {
  priceStore?: OwnStockSource & Pick<PriceStore, "listQuotes">;
}

let deps: MatchBotDeps = {};

/** Stock propio y cotizaciones para `prioridad` y `avance match`; null vuelve a getStore(). */
export function configureMatchBot(d: MatchBotDeps | null): void {
  deps = d ?? {};
}

async function priceSource(): Promise<OwnStockSource & Pick<PriceStore, "listQuotes">> {
  return deps.priceStore ?? (await getStore());
}

// ── utilidades ──

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);
const int = (n: number) => Math.round(n).toLocaleString("es-PE");
/** "1 empresa", "12 empresas" */
const empresas = (n: number) => `${int(n)} ${n === 1 ? "empresa" : "empresas"}`;
/** " (1 ya te compró)", " (3 ya te compraron)" */
const yaCompraron = (n: number) => (n ? ` (${int(n)} ya te ${n === 1 ? "compró" : "compraron"})` : "");
/** Las medidas que requieren revisión técnica no son para la lista general (van en la vista del producto). */
const isReviewNote = (n: string) => /^Requieren revisi[oó]n t[eé]cnica/.test(n);

/** Lo que sigue al comando, sin relleno: "mi stock?" -> "", "las flama 66" -> "flama 66". */
export function matchQuery(args: string): string {
  let t = (args ?? "").trim().replace(/^[\s¿¡,:;-]+|[\s.!?¡¿,;]+$/g, "");
  const DET = /^(?:a\s+)?(?:mi|mis|el|la|las|los|este|esta|estas|estos|nuestro|nuestra|nuestros|nuestras|de|del)\s+/i;
  for (let i = 0; i < 3; i++) t = t.replace(DET, "");
  const filler = /^(?:stock(?:\s+(?:prioritario|propio))?|(?:llantas|productos)\s+prioritari[ao]s|prioridades|llantas|productos|hoy|venta)$/i;
  return filler.test(fold(t)) || !fold(t) ? "" : t;
}

/** Título de fila: "295/80R22.5 Flama 66" (24 caracteres). */
function productRowTitle(p: Pick<MatchStockProduct, "sizeDisplay" | "model">): string {
  const model = p.model.toLowerCase().replace(/(^|[\s/-])([a-záéíóúñ])/g, (_m, a: string, b: string) => a + b.toUpperCase());
  return clip(`${p.sizeDisplay} ${model}`.trim(), LIST_ROW_TITLE_MAX);
}

/**
 * Nombre corto para la fila (24 caracteres) que distinga a las empresas: "EMPRESA DE TRANSPORTES PERU BUS S.A." -> "E.T. PERU
 * BUS" (con el prefijo largo, varias filas quedaban en "EMPRESA DE TRANSPORTES…").
 */
export function rowName(razonSocial: string): string {
  const base = shortName(razonSocial.replace(/\s+-\s+.*$/, ""))
    .replace(/^EMPRESA\s+DE\s+TRANSPORTES?(?:\s+(?:Y\s+SERVICIOS(?:\s+GENERALES)?|Y\s+TURISMO|TERRESTRES|INTERPROVINCIAL(?:ES)?|DE\s+PASAJEROS|Y\s+COMERCIALIZADORA))*\s+/i, "E.T. ")
    .replace(/^EMPRESA\s+DE\s+/i, "")
    .trim();
  return clip(base || shortName(razonSocial), LIST_ROW_TITLE_MAX);
}

const isAudio = (ctx: PortalContext) => ctx.msg.type === "audio" || ctx.msg.type === "voice";

// ── `match` (vista 1) ──

async function showOverview(ctx: PortalContext): Promise<void> {
  const cfg = loadPortalConfig().match;
  const ov = await matchOverview(ctx.store, ctx.user, { cfg });
  if (ov.vacio) {
    await ctx.reply(`🎯 *Match Venta*\n${ov.vacio}`);
    return;
  }
  const lines = [`🎯 *Match Venta* · ${int(ov.totalLlantas)} llantas prioritarias · ${empresas(ov.empresas)}`, MATCH_ESTIMATE, ""];
  for (const p of ov.productos) {
    lines.push(`• *${p.medida} ${productName({ brand: p.marca, model: p.modelo })}* (${p.code}): ${int(p.disponible)} en Lima · ${empresas(p.empresas)}${yaCompraron(p.yaCompraron)}`);
    if (p.aplicacion) lines.push(`  _${p.aplicacion}_`);
    for (const n of p.notas.filter((x) => !isReviewNote(x))) lines.push(`  ℹ️ ${n}`);
  }
  const rows = ov.productos.slice(0, LIST_ROWS_MAX).map((p) => ({
    id: `match ${p.code}`,
    title: productRowTitle({ sizeDisplay: p.medida, model: p.modelo }),
    description: clip([p.code, `${int(p.disponible)} disp.`, empresas(p.empresas), p.aplicacion ?? ""].filter(Boolean).join(" · "), LIST_ROW_DESCRIPTION_MAX),
  }));
  const more = ov.productos.length > rows.length ? ` Hay ${ov.productos.length} productos: para los demás escribe *match <código>*.` : "";
  lines.push("", `Elige un producto para ver a quién ofrecérselo (o escribe *match ${ov.productos[0].code}*).${more}`);
  await ctx.reply(lines.join("\n"));
  await replyList(ctx, "¿Qué llanta quieres vender?", "Elegir llanta", rows, { fallback: "" });
}

// ── `match <producto>` (vista 2) ──

/** Productos prioritarios con stock (foto del último cálculo) para encontrar el pedido. */
async function priorityProducts(ctx: PortalContext): Promise<{ priority: MatchStockProduct[]; all: MatchStockProduct[] }> {
  const { stock } = await loadMatchStock({ store: ctx.store, prices: null });
  const ov = await matchOverview(ctx.store, ctx.user, { cfg: loadPortalConfig().match });
  const codes = new Set(ov.productos.map((p) => p.code));
  return { priority: stock.filter((s) => codes.has(s.code)), all: stock };
}

/** resolveProduct con lo dictado normalizado ("doscientos noventa y cinco" -> 295) y, si no, tal cual. */
function resolveQuery(q: string, products: MatchStockProduct[]): ReturnType<typeof resolveProduct> {
  const spoken = normalizeSpoken(q);
  const a = resolveProduct(spoken, products);
  if (a.kind !== "none" || spoken === q) return a;
  return resolveProduct(q, products);
}

async function chooseProduct(ctx: PortalContext, products: MatchStockProduct[], command: "match" | "prioridad" | "quitar prioridad", body: string): Promise<void> {
  const rows = products.slice(0, LIST_ROWS_MAX).map((p) => ({
    id: `${command} ${p.code}`,
    title: productRowTitle(p),
    description: clip(`${p.code} · ${productLabel(p)} · ${int(p.available)} disp.`, LIST_ROW_DESCRIPTION_MAX),
  }));
  const fallback = `${body}\n${rows.map((r) => `• *${r.id}* — ${r.title}`).join("\n")}`;
  await replyList(ctx, body, "Elegir llanta", rows, { fallback });
}

async function matchProduct(ctx: PortalContext, query: string): Promise<void> {
  const { priority, all } = await priorityProducts(ctx);
  const r = resolveQuery(query, priority);
  if (r.kind === "one") return showProduct(ctx, r.product.code, 0, []);
  if (r.kind === "many") return chooseProduct(ctx, r.products, "match", `«${clip(query, 40)}» puede ser ${r.products.length} llantas prioritarias. ¿Cuál?`);
  // no es prioritaria: ¿está en el stock?
  const other = resolveQuery(query, all);
  if (other.kind === "one") {
    await ctx.reply(MATCH_NOT_PRIORITY(productLabel(other.product), other.product.code));
    return;
  }
  const list = priority.length ? ` Tus llantas prioritarias: ${priority.map((p) => `*${p.code}* ${productRowTitle(p)}`).join(" · ")}.` : "";
  await ctx.reply(`No encuentro «${clip(query, 40)}» entre tus llantas prioritarias.${list} Escribe *match* para verlas en una lista.`);
}

function cardLines(c: MatchCard, n: number): string[] {
  const pct = c.pct !== null ? ` — *${c.pct}%* estimado` : "";
  const out = [`*${n}. ${c.razonSocial}*${pct} · ${c.estado}`];
  if (c.detalle.desglose) out.push(c.detalle.desglose);
  if (c.compraTexto) out.push(`✅ ${c.compraTexto}`);
  if (c.migracionTexto) out.push(`🔁 ${c.migracionTexto}`);
  if (c.avisoCredito) out.push(c.avisoCredito);
  const where = locationText(c);
  out.push([`RUC ${c.ruc}`, where, c.tamanoTexto, c.podriaLlevarTexto].filter(Boolean).join(" · "));
  return out;
}

async function showProduct(ctx: PortalContext, code: string, offset: number, prevShown: ShownCompany[]): Promise<void> {
  const cfg = loadPortalConfig().match;
  const res = await matchesForProduct(ctx.store, ctx.user, code, {}, { cfg, limit: MATCH_PAGE, offset, now: ctx.now });
  const p = res.product;
  if (!p) {
    await clearPending(ctx.store, ctx.from);
    await ctx.reply(res.vacio ?? "Ese producto no es prioritario o ya no tiene stock. Escribe *match* para ver tus llantas prioritarias.");
    return;
  }
  if (offset > 0 && !res.empresas.length) {
    await ctx.reply(MATCH_NO_MORE);
    return;
  }
  const lines: string[] = [];
  if (offset === 0) {
    const hacen = res.total === 1 ? "hace" : "hacen";
    lines.push(`🎯 *${p.etiqueta}* (${p.code})`, [`${int(p.disponible)} en Lima`, p.aplicacion ?? "", `${empresas(res.total)} ${hacen} match${yaCompraron(p.yaCompraron)}`].filter(Boolean).join(" · "));
    for (const n of res.notas.filter((x) => !isReviewNote(x))) lines.push(`ℹ️ ${n}`);
    if (res.empresas.length) lines.push(MATCH_ESTIMATE);
  } else lines.push(`🎯 *${p.etiqueta}* (${p.code}) · más empresas`);
  const start = offset + 1;
  const shown: ShownCompany[] = res.empresas.map((c, i) => ({ n: start + i, companyId: c.companyId!, ruc: c.ruc, razonSocial: c.razonSocial, pct: c.pct, estado: c.estado }));
  for (const [i, c] of res.empresas.entries()) lines.push("", ...cardLines(c, start + i));
  if (offset === 0 && res.soloVentas.length) {
    lines.push("", "*Clientes que ya compraron esta medida* (no están en el padrón; sin %):");
    for (const c of res.soloVentas.slice(0, 5)) lines.push(`• ${c.razonSocial} · RUC ${c.ruc}${c.compraTexto ? ` · ${c.compraTexto}` : ""}`);
    if (res.soloVentas.length > 5) lines.push(`  …y ${res.soloVentas.length - 5} más (en el portal, Match Venta).`);
  }
  // medidas del mismo aro que requieren revisión técnica: aparte, nunca como match
  const review = offset === 0 ? res.notas.filter(isReviewNote) : [];
  if (!res.empresas.length) {
    if (!res.soloVentas.length) lines.push("", res.vacio ?? "Ninguna empresa del padrón hace match con esta llanta.");
    for (const n of review) lines.push("", `🔧 ${n}`);
    await clearPending(ctx.store, ctx.from);
    await ctx.reply(lines.join("\n"));
    return;
  }
  const end = offset + res.empresas.length;
  const more = res.total > end;
  const next = Math.min(MATCH_PAGE, res.total - end);
  for (const n of review) lines.push("", `🔧 ${n}`);
  lines.push("", `${start}–${end} de ${int(res.total)}.${more ? ` *más* trae las siguientes ${next}.` : " Son todas."}`);
  const step: Omit<MatchStep, "createdAt"> = { kind: MATCH_STEP, code: p.code, etiqueta: p.etiqueta, offset: end, total: res.total, shown: [...prevShown, ...shown].slice(-MAX_SHOWN), pick: null, phase: null, day: null };
  await setPending(ctx.store, ctx.from, step, ctx.now);
  await ctx.reply(lines.join("\n"));
  if (ctx.user.rol === "tecnico") {
    await ctx.reply("_Solo vendedores y supervisores asignan empresas y agendan visitas._");
    return;
  }
  const rows = shown.map((s) => ({
    id: String(s.n),
    title: rowName(s.razonSocial),
    description: clip([s.pct !== null ? `${s.pct}% estimado` : "", s.estado, s.razonSocial].filter(Boolean).join(" · "), LIST_ROW_DESCRIPTION_MAX),
  }));
  if (more) rows.push({ id: "más", title: `Ver ${next} más`, description: "Las siguientes empresas para esta llanta" });
  await replyList(ctx, "Elige una empresa para asignártela o agendar la visita.", "Elegir empresa", rows, {
    fallback: `Responde con el número de la empresa para asignártela o agendar la visita${more ? ", o *más*" : ""}.`,
  });
}

// ── elegir una empresa, asignarla y agendar ──

async function offerActions(ctx: PortalContext, step: MatchStep, s: ShownCompany): Promise<void> {
  const company = await ctx.store.getCompany(s.companyId);
  if (!company) {
    await ctx.reply("No encuentro esa empresa. Escribe *más* o *match* para empezar de nuevo.");
    return;
  }
  await setPending(ctx.store, ctx.from, { ...step, pick: company.id, phase: null, day: null }, ctx.now);
  const buttons: { id: string; title: string }[] = [];
  const mine = company.ownerUserId === ctx.user.id;
  if (!mine && canAssignSelf(ctx.user, company)) buttons.push({ id: "asignarme", title: "Asignármela" });
  buttons.push({ id: "agendar", title: "Agendar visita" });
  if (step.offset < step.total) buttons.push({ id: "más", title: "Más empresas" });
  const pct = s.pct !== null ? `${s.pct}% estimado · ` : "";
  const owner = mine ? "Tuya" : company.ownerUserId === null ? "Sin dueño" : s.estado;
  const body = `*${company.razonSocial}* · RUC ${company.ruc}\n${pct}${owner} · para *${step.etiqueta}*\n¿Qué hago?`;
  const fallback = `${body}\nResponde ${buttons.map((b) => `*${b.id}*`).join(", ")}.`;
  await replyButtons(ctx, body, buttons.map((b) => ({ id: b.id, title: clip(b.title, BUTTON_TITLE_MAX) })), { fallback });
}

const DAY_BUTTONS = [
  { id: "hoy", title: "Hoy" },
  { id: "mañana", title: "Mañana" },
  { id: "otra fecha", title: "Otra fecha" },
];

async function askDay(ctx: PortalContext, step: MatchStep, name: string): Promise<void> {
  await setPending(ctx.store, ctx.from, { ...step, phase: "date", day: null }, ctx.now);
  const body = `¿Qué día visitas a *${name}*? También puedes escribir día y hora (p. ej. *jueves 10am*).`;
  await replyButtons(ctx, body, DAY_BUTTONS, { fallback: `${body}\nResponde *hoy*, *mañana* o la fecha.` });
}

async function askHour(ctx: PortalContext, step: MatchStep, day: Date): Promise<void> {
  await setPending(ctx.store, ctx.from, { ...step, phase: "hour", day: day.toISOString() }, ctx.now);
  const body = "¿A qué hora? (p. ej. *10am*, *3pm*). Si no tienes hora, *Sin hora* y la dejo a las 9:00.";
  await replyButtons(ctx, body, [{ id: "sin hora", title: "Sin hora" }], { fallback: `${body}\nResponde la hora o *sin hora*.` });
}

async function schedule(ctx: PortalContext, step: MatchStep, startsAt: Date, voice: boolean): Promise<void> {
  if (startsAt.getTime() < limaStartOfDay(ctx.now).getTime()) {
    await ctx.reply("Esa fecha ya pasó. ¿Qué día visitas? (p. ej. *mañana 10am*)");
    await setPending(ctx.store, ctx.from, { ...step, phase: "date", day: null }, ctx.now);
    return;
  }
  const r = await scheduleMatchVisit(ctx.store, { companyId: step.pick!, productCode: step.code, user: ctx.user, startsAt, now: ctx.now, canal: voice ? "voz" : "whatsapp" });
  // el paso sigue (para *más*), sin empresa elegida
  await setPending(ctx.store, ctx.from, { ...step, pick: null, phase: null, day: null }, ctx.now);
  const tail = step.offset < step.total ? "\n*más* trae otras empresas para esta llanta." : "";
  // la visita nueva lleva la invitación de calendario como cualquier `cita` (resumen primero, .ics de respaldo después)
  const company = r.ok && !r.duplicate ? await ctx.store.getCompany(r.appointment.companyId) : null;
  const invite = company && r.ok ? await inviteForNewAppointment(ctx, company, r.appointment) : null;
  await ctx.reply([`${r.text}`, ...(invite?.lines ?? [])].join("\n") + (r.ok ? tail : ""));
  if (invite) await invite.sendIcs();
}

/** "agendar", "agendar visita", "agéndala", "agendar mañana 10am" -> lo que sigue ("mañana 10am") o "" ; null si no es. */
function agendarRest(text: string): string | null {
  const m = /^(?:agendar|agenda|agendala|agendame|agendarla|programar|programa|programala)(?:\s+(?:la\s+)?visita)?(?:\s+(?:para\s+)?(.*))?$/.exec(fold(text));
  if (!m) return null;
  // lo que sigue tal como se escribió (con "/" de las fechas): se quita la primera palabra (y "visita")
  return m[1] ? text.trim().replace(/^\S+(?:\s+(?:la\s+)?visita)?(?:\s+para)?\s*/i, "") : "";
}

const MORE_RE = /^(?:(?:ver|dame|muestrame|y)\s+)?(?:(?:las|unas)\s+)?(?:mas|siguientes|otras)(?:\s+(?:\d{1,2}|cinco))?(?:\s+(?:empresas|flotas))?$/;
const ASSIGN_RE = /^(?:asignarme|asignarmela|asignamela|asigname|asignar|asignala|me\s+la\s+asigno|tomarla|la\s+tomo)$/;
const OTHER_DATE_RE = /^(?:otra|otra\s+fecha|otro\s+dia|elegir(?:\s+fecha)?)$/;
const NO_HOUR_RE = /^(?:sin\s+hora|no\s+(?:se|tengo)(?:\s+hora)?|cualquier\s+hora|ninguna|da\s+igual)$/;

/** Día (con o sin hora) de la respuesta: "hoy", "mañana 10am", "jueves", "28/11 3pm". */
function parseDay(text: string, now: Date): { day: Date; time: { hour: number; minute: number } | null } | null {
  const d = parseSpanishDateTime(text, now);
  if (!d) return null;
  const day = limaStartOfDay(d.date);
  if (d.allDay) return { day, time: null };
  const lima = new Date(d.date.getTime() - 5 * 3600_000);
  return { day, time: { hour: lima.getUTCHours(), minute: lima.getUTCMinutes() } };
}

async function handleStep(ctx: PortalContext, step: MatchStep, raw: string, voice: boolean): Promise<boolean> {
  const text = raw.trim().replace(/[.!¡¿?]+$/g, "");
  const t = fold(text);
  if (!t) return false;
  if (MORE_RE.test(t)) {
    await showProduct(ctx, step.code, step.offset, step.shown ?? []);
    return true;
  }
  const shown = step.shown ?? [];
  // elegir una empresa por su número (fila de la lista)
  if (/^\d{1,2}$/.test(t) && step.phase !== "hour") {
    const s = shown.find((x) => x.n === Number(t));
    if (!s) {
      await ctx.reply(`No tengo la empresa ${t} en la lista. Responde con un número de la lista o *más*.`);
      return true;
    }
    await offerActions(ctx, step, s);
    return true;
  }
  const picked = step.pick ? shown.find((x) => x.companyId === step.pick) ?? null : null;
  if (ASSIGN_RE.test(t)) {
    if (!picked) return false;
    const company = await ctx.store.getCompany(picked.companyId);
    if (!company) return false;
    await assignToMe(ctx, company);
    const fresh = await ctx.store.getCompany(picked.companyId);
    if (fresh?.ownerUserId === ctx.user.id) {
      const buttons = [{ id: "agendar", title: "Agendar visita" }, ...(step.offset < step.total ? [{ id: "más", title: "Más empresas" }] : [])];
      await replyButtons(ctx, `¿Agendo la visita a *${fresh.razonSocial}* para ofrecerle *${step.etiqueta}*?`, buttons);
    }
    return true;
  }
  const rest = agendarRest(text);
  if (rest !== null) {
    if (!picked) {
      await ctx.reply("Primero elige la empresa: responde con su número en la lista.");
      return true;
    }
    if (!rest) {
      await askDay(ctx, step, picked.razonSocial);
      return true;
    }
    const d = parseDay(rest, ctx.now);
    if (!d) {
      await askDay(ctx, step, picked.razonSocial);
      return true;
    }
    if (d.time) await schedule(ctx, step, atLimaTime(d.day, d.time), voice);
    else await askHour(ctx, step, d.day);
    return true;
  }
  if (step.phase === "date" && picked) {
    if (OTHER_DATE_RE.test(t)) {
      await ctx.reply("¿Qué día? (p. ej. *jueves*, *28/11*; con hora si quieres: *jueves 10am*)");
      return true;
    }
    const d = parseDay(text, ctx.now);
    if (!d) {
      if (t.split(" ").length > 4) return false;
      await ctx.reply("No entendí la fecha. Escríbela así: *mañana*, *jueves* o *28/11* (con hora si quieres: *jueves 10am*).");
      return true;
    }
    if (d.time) await schedule(ctx, step, atLimaTime(d.day, d.time), voice);
    else await askHour(ctx, step, d.day);
    return true;
  }
  if (step.phase === "hour" && picked && step.day) {
    const day = new Date(step.day);
    if (NO_HOUR_RE.test(t)) {
      await schedule(ctx, step, atLimaTime(day, MATCH_DEFAULT_HOUR), voice);
      return true;
    }
    const tm = parseTimeOfDay(text) ?? (/^\d{1,2}$/.test(t) ? null : (() => {
      const d = parseSpanishDateTime(text, ctx.now);
      if (!d || d.allDay) return null;
      const lima = new Date(d.date.getTime() - 5 * 3600_000);
      return { hour: lima.getUTCHours(), minute: lima.getUTCMinutes() };
    })());
    const bare = /^\d{1,2}$/.test(t) ? Number(t) : null;
    const time = tm ?? (bare !== null && bare >= 1 && bare <= 23 ? { hour: bare >= 7 ? bare : bare + 12, minute: 0 } : null);
    if (!time) {
      if (t.split(" ").length > 4) return false;
      await ctx.reply("No entendí la hora. Escríbela así: *10am*, *3pm* o *15:30*; o *sin hora*.");
      return true;
    }
    await schedule(ctx, step, atLimaTime(day, time), voice);
    return true;
  }
  return false;
}

registerPendingHandler(MATCH_STEP, async (ctx, step, text) => {
  const s = step as MatchStep;
  if (isAudio(ctx) && ctx.msg.media) {
    // nota de voz como respuesta ("más", "la dos", "agéndala mañana a las diez"): se transcribe una vez
    const heard = await fetchVoice(ctx, { id: ctx.msg.media.id, mimeType: ctx.msg.media.mimeType });
    if (!heard.ok) return false;
    const spoken = normalizeSpoken(heard.text).replace(/^(?:la|el)\s+(?=\d{1,2}$)/i, "");
    // lo primero que se responda lleva "🎙 Escuché: …" (texto, botones o lista)
    let first = true;
    const tag = () => {
      if (!first) return "";
      first = false;
      void logTranscript(ctx, heard.text).catch(() => undefined);
      return `${heardLine(heard.text)}\n`;
    };
    const tagged = <T extends { fallback?: string }>(body: string, opts: T): [string, T] => {
      const t = tag();
      return [`${t}${body}`, opts.fallback ? { ...opts, fallback: `${t}${opts.fallback}` } : opts];
    };
    const voiced: PortalContext = {
      ...ctx,
      reply: (body) => ctx.reply(`${tag()}${body}`),
      replyButtons: (body, buttons, opts = {}) => {
        const [b, o] = tagged(body, opts);
        return replyButtons(ctx, b, buttons, o);
      },
      replyList: (body, label, rows, opts = {}) => {
        const [b, o] = tagged(body, opts);
        return replyList(ctx, b, label, rows, o);
      },
    };
    return handleStep(voiced, s, spoken, true);
  }
  return handleStep(ctx, s, text, false);
});

// ── comandos ──

registerPortalCommand("match", async (ctx, args) => {
  const q = matchQuery(args);
  if (!q) return showOverview(ctx);
  return matchProduct(ctx, q);
});

/** Lo que sigue a `prioridad` sin relleno ("a la flama 66" -> "flama 66"). */
function priorityQuery(args: string): string {
  let t = (args ?? "").trim().replace(/^[\s¿¡,:;-]+|[\s.!?¡¿,;]+$/g, "");
  for (let i = 0; i < 3; i++) t = t.replace(/^(?:a|al|de|del|la|el|las|los|en)\s+/i, "");
  return t.replace(/\s+(?:como\s+)?prioridad$/i, "").trim();
}

async function setPriorityCmd(ctx: PortalContext, args: string, on: boolean): Promise<void> {
  if (!canSetPriority(ctx.user)) {
    await ctx.reply("Tu rol no puede marcar prioridades.");
    return;
  }
  const q = priorityQuery(args);
  const usage = on ? "*prioridad P0428* (o medida y modelo: *prioridad 295 flama 66*)" : "*quitar prioridad P0428* (o medida y modelo)";
  if (!q) {
    await ctx.reply(`¿Qué llanta? Escríbelo así: ${usage}.`);
    return;
  }
  let prices: OwnStockSource | null = null;
  try {
    prices = await priceSource();
  } catch (err) {
    ctx.log(`match: no pude leer el stock propio: ${(err as Error).message}`);
  }
  const { stock } = await loadMatchStock({ store: ctx.store, prices });
  const products = await ctx.store.listMatchProducts();
  const onCodes = new Set(products.filter((p) => p.prioridad).map((p) => p.code));
  // quitar: solo entre las prioritarias; prender: entre las que tienen disponible (si no hay ninguna así, entre todas)
  const pool = on ? stock.filter((s) => s.available > 0) : stock.filter((s) => onCodes.has(s.code));
  let r = resolveQuery(q, pool.length ? pool : stock);
  if (r.kind === "none" && pool.length) r = resolveQuery(q, stock);
  if (r.kind === "many") {
    await chooseProduct(ctx, r.products, on ? "prioridad" : "quitar prioridad", `«${clip(q, 40)}» puede ser ${r.products.length} llantas. ¿Cuál?`);
    return;
  }
  let code: string | null = r.kind === "one" ? r.product.code : null;
  // un código que ya no está en el stock (quitar) o que no se reconoció: se intenta tal cual
  if (!code && /^[A-Za-z]{1,4}\s*-?\s*\d{2,6}[A-Za-z]?$/.test(q)) code = matchCode(q.replace(/[\s-]+/g, ""));
  if (!code) {
    await ctx.reply(`No encuentro «${clip(q, 40)}» en el stock propio. Escríbelo así: ${usage}.`);
    return;
  }
  const res = await setPriorityAndRecalc(ctx.store, { code, on, user: ctx.user, prices, now: ctx.now, log: ctx.log });
  if (!res.ok) {
    await ctx.reply(res.text);
    return;
  }
  if (on && res.stock) {
    await replyButtons(ctx, `${res.text}\n¿Vemos a quién ofrecérsela?`, [{ id: `match ${code}`, title: "Ver empresas" }], { fallback: `${res.text}\nEscribe *match ${code}* para ver a quién ofrecérsela.` });
    return;
  }
  await ctx.reply(res.text);
}

registerPortalCommand("prioridad", (ctx, args) => setPriorityCmd(ctx, args, true));
registerPortalCommand("quitar_prioridad", (ctx, args) => setPriorityCmd(ctx, args, false));

registerPortalCommand("avance_match", async (ctx) => {
  let prices: (OwnStockSource & Pick<PriceStore, "listQuotes">) | null = null;
  try {
    prices = await priceSource();
  } catch (err) {
    ctx.log(`match: no pude leer el stock propio: ${(err as Error).message}`);
  }
  let stock: MatchStockProduct[];
  try {
    stock = (await loadMatchStock({ store: ctx.store, prices })).stock;
  } catch (err) {
    ctx.log(`match: stock vivo no disponible (${(err as Error).message}); uso el del último cálculo`);
    stock = (await loadMatchStock({ store: ctx.store, prices: null })).stock;
  }
  const quotes = prices ? await prices.listQuotes({ limit: 1000 }).catch(() => []) : [];
  const rows = await matchProgress(ctx.store, { stock, quotes });
  await ctx.reply(progressText(rows));
});
