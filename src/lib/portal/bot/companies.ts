/**
 * Empresas en el bot: búsqueda (RUC exacto primero, luego razón social sin tildes ni S.A.C.), desambiguación con lista
 * numerada (paso pendiente choose_company) y la ficha que se responde por WhatsApp.
 */
import { loadPortalConfig } from "../config";
import { fichaDireccionLines } from "./commands/direccion";
import { portalBaseUrl } from "../auth/tokens";
import { stageLabel } from "../stages";
import { defaultSince, foldText, sunatBrief } from "../store/shared";
import type { Company, Confianza, FleetGroup, PortalStore } from "../store/types";
import { groupByBrand } from "../ui/fleet";
import { fold } from "../../tyre/brands";
import { fmtInt, sectorLabel } from "../ui/labels";
import { LIST_ROWS_MAX } from "../../whatsapp/interactive";
import { freeQuoter, getCompanyAction, registerPausable, registerPendingHandler, replyButtons, replyList, type PortalContext } from "./registry";
import { clearPending, setPending, type ChooseCompanyStep, type CompanyNotFoundStep, type PendingStep } from "./state";

export const MAX_OPTIONS = 5;

/** Terminaciones societarias que no cuentan al buscar: S.A.C., S.A., E.I.R.L., S.R.L., SAC, EIRL... */
const LEGAL_SUFFIX = /[\s,]+(?:s\.?\s?a\.?\s?c\.?(?:\s?s\.?)?|s\.?\s?a\.?\s?a\.?|s\.?\s?a\.?|e\.?\s?i\.?\s?r\.?\s?l\.?|s\.?\s?r\.?\s?l\.?|ltda\.?|sociedad\s+an[oó]nima(?:\s+cerrada)?)\s*$/i;

/** "Zbuss S.A.C." -> "zbuss"; sin tildes, sin signos, espacios simples. */
export function companyKey(name: string): string {
  return foldText(name.trim().replace(LEGAL_SUFFIX, ""))
    .replace(/[^a-z0-9ñ]+/g, " ")
    .trim();
}

/** "ZBUSS S.A.C." -> "ZBUSS" (para mostrar en listas). */
export function shortName(name: string): string {
  return name.trim().replace(LEGAL_SUFFIX, "").trim() || name.trim();
}

/**
 * Empresas para `q`: RUC de 11 dígitos -> esa; dígitos -> RUC que empieza así; texto -> razón social que lo contiene
 * (sin tildes ni terminación societaria). Si una coincide exactamente con el nombre buscado, solo esa.
 * Orden: más unidades primero. Devuelve hasta `limit` y el total.
 */
export async function findCompanies(store: PortalStore, q: string, limit = MAX_OPTIONS): Promise<{ rows: Company[]; total: number }> {
  const query = q.trim();
  if (!query) return { rows: [], total: 0 };
  const digitsOnly = query.replace(/[\s.-]/g, "");
  if (/^\d{11}$/.test(digitsOnly)) {
    const c = await store.getCompanyByRuc(digitsOnly);
    return c ? { rows: [c], total: 1 } : { rows: [], total: 0 };
  }
  if (/^\d{3,10}$/.test(digitsOnly)) {
    const r = await store.searchCompanies({ q: digitsOnly, pageSize: limit });
    return { rows: r.rows, total: r.total };
  }
  const key = companyKey(query);
  if (!key) return { rows: [], total: 0 };
  let res = await store.searchCompanies({ q: key, pageSize: 50 });
  let rows: Company[] = res.rows;
  let total = res.total;
  if (total === 0) {
    // razón social con signos ("E.T. SAN ISIDRO", "TRANSPORTES Y SERVICIOS-ABC"): se busca por la palabra más larga
    // y se exige que estén todas las palabras
    const words = key.split(" ").filter((w) => w.length >= 2);
    const longest = [...words].sort((a, b) => b.length - a.length)[0];
    if (longest && longest !== key) {
      res = await store.searchCompanies({ q: longest, pageSize: 500 });
      const squashed = key.replace(/ /g, "");
      rows = res.rows.filter((c) => {
        const k = companyKey(c.razonSocial);
        return k.replace(/ /g, "").includes(squashed) || words.every((w) => k.split(" ").includes(w));
      });
      total = rows.length;
    }
  }
  const exact = rows.filter((c) => companyKey(c.razonSocial).replace(/ /g, "") === key.replace(/ /g, ""));
  if (exact.length === 1) return { rows: exact, total: 1 };
  return { rows: rows.slice(0, limit), total };
}

const STOP = new Set(["para", "que", "con", "los", "las", "del", "una", "uno", "por", "como", "pero", "hoy", "ayer", "manana", "esta", "este", "todo", "bien", "hola", "gracias", "buenos", "dias", "tardes", "noches", "favor", "ellos", "ella", "quiere", "quieren", "dijo", "dice"]);

/**
 * Empresas del padrón que el texto nombra: n-gramas de 1 a 3 palabras iguales a una razón social sin S.A.C. (más largos
 * primero, hasta `maxQueries` búsquedas). Sin repetidas.
 */
export async function mentionedCompanies(store: PortalStore, text: string, maxQueries = 12, stopAtFirst = false): Promise<Company[]> {
  const words = fold(text).split(" ").filter(Boolean);
  // corrida J: las palabras con mayúscula en el texto (nombres propios: "Visité Labocer, hablé con…") van primero; en un
  // reporte largo los primeros `maxQueries` n-gramas eran todos de 3 palabras y una razón social de una palabra no se buscaba
  const proper = new Set(fold(((text ?? "").match(/(?<![\p{L}\d])\p{Lu}[\p{L}\d'’&.-]*/gu) ?? []).join(" ")).split(" ").filter(Boolean));
  const grams: { g: string; proper: boolean }[] = [];
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const g = words.slice(i, i + n);
      if (STOP.has(g[0]) || STOP.has(g[g.length - 1])) continue;
      if (n === 1 && (g[0].length < 4 || /^\d+$/.test(g[0]))) continue;
      grams.push({ g: g.join(" "), proper: proper.has(g[0]) });
    }
  }
  const ordered = [...grams.filter((x) => x.proper), ...grams.filter((x) => !x.proper)].map((x) => x.g);
  const out: Company[] = [];
  for (const g of [...new Set(ordered)].slice(0, maxQueries)) {
    const { rows } = await findCompanies(store, g, 5);
    for (const c of rows) if (companyKey(c.razonSocial) === g && !out.some((o) => o.id === c.id)) out.push(c);
    if (stopAtFirst && out.length) break;
  }
  return out;
}

/** El texto nombra una empresa del padrón (n-gramas de 1 a 3 palabras que coinciden con una razón social sin S.A.C.). */
export async function mentionsKnownCompany(store: PortalStore, text: string, maxQueries = 12): Promise<boolean> {
  return (await mentionedCompanies(store, text, maxQueries, true)).length > 0;
}

// ── texto de más (corrida D, punto 3) ──

/** Relleno antes de la empresa: "a la empresa ZBUSS", "el cliente ZBUSS", "a ZBUSS" (no "la"/"el" solos: "La Roca" es una empresa). */
const LEAD_FILLER = /^(?:(?:a|al|de|del|para|con)\s+)?(?:(?:la\s+)?empresa|el\s+cliente|cliente|el\s+ruc|ruc)\s+|^(?:a|al|de|del|para|con)\s+(?=\S)/i;
/** Cortesía que no cuenta como texto sin usar. */
const COURTESY = /^(?:(?:y\s+)?(?:por\s+favor|porfa(?:vor)?|pls|please|plis|gracias|muchas\s+gracias|mil\s+gracias|xfa|x\s+fa)[\s.,;!]*)+$/i;
const TRAILING_CONNECTOR = new Set(["y", "e", "o", "u", "a", "al", "de", "del", "la", "el", "los", "las", "para", "con", "que", "en", "por", "su", "sus"]);
/** Como máximo se prueban los primeros N palabras como nombre de empresa. */
const SPLIT_MAX_WORDS = 6;

/** Lo que sobra, limpio de separadores en los extremos; "" si solo era cortesía o signos. */
export function leftover(text: string): string {
  const t = text.replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, "").replace(/\s+/g, " ").trim();
  return !t || COURTESY.test(t) || !/[a-z0-9ñáéíóú]/i.test(t) ? "" : t;
}

/** "No usé: «y responde las preguntas del pedido»." (una línea) o "" si no sobró nada. */
export function unusedNote(rest: string): string {
  const t = leftover(rest);
  return t ? `No usé: «${t.length > 120 ? `${t.slice(0, 119).trimEnd()}…` : t}».` : "";
}

export interface CompanySplit {
  /** Lo que se busca en el padrón (nombre o RUC, tal como se escribió). */
  query: string;
  /** El texto que sobra (sin cortesías), "" si nada. */
  rest: string;
}

/**
 * La empresa al inicio del texto y lo que sobra, para tolerar texto de más ("zbuss y responde las preguntas del pedido").
 * Quita relleno inicial ("a la empresa", "el cliente"); un RUC de 11 dígitos en cualquier parte manda; si no, el prefijo
 * más largo (hasta 6 palabras) que encuentra empresas en el padrón: el texto entero con cualquier número de resultados,
 * un prefijo más corto solo si encuentra pocas (≤ 10; "transportes" sola no vale). Con `strict`, un prefijo con texto
 * detrás vale solo si alguna razón social empieza así. null = no hay empresa reconocible.
 */
export async function splitCompany(store: PortalStore, text: string, opts: { strict?: boolean } = {}): Promise<CompanySplit | null> {
  let t = text.trim().replace(/\s+/g, " ");
  for (let i = 0; i < 2; i++) t = t.replace(LEAD_FILLER, "");
  if (!t) return null;
  const ruc = /(?:^|[^\d])(\d{11})(?!\d)/.exec(t);
  if (ruc) {
    const at = t.indexOf(ruc[1]);
    const before = leftover(t.slice(0, at).replace(/\b(?:ruc|empresa|el|la|de|del|a|al)\s*$/i, ""));
    return { query: ruc[1], rest: leftover([before, t.slice(at + 11)].filter(Boolean).join(" ")) };
  }
  const words = t.split(" ");
  for (let n = Math.min(words.length, SPLIT_MAX_WORDS); n >= 1; n--) {
    const prefix = words
      .slice(0, n)
      .join(" ")
      .replace(/[\s,;:.!?]+$/, "");
    // "zbuss y" / "zbuss para": un conector al final no es parte del nombre (findCompanies ignora palabras de 1 letra)
    if (!companyKey(prefix) || (n === 1 && prefix.length < 3) || (n > 1 && TRAILING_CONNECTOR.has(fold(words[n - 1])))) continue;
    const { rows, total } = await findCompanies(store, prefix, opts.strict ? LIST_ROWS_MAX : 1);
    if (total === 0) continue;
    const rest = leftover(words.slice(n).join(" "));
    // strict (el resto puede ser un nombre de persona: `contacto`): un prefijo parcial vale solo si alguna razón social
    // empieza así ("zbuss" sí; "carlos" no por TRANSPORTES SAN CARLOS)
    if (rest && opts.strict && !rows.some((c) => companyKey(c.razonSocial).startsWith(companyKey(prefix)))) continue;
    if (n === words.length || !rest || total <= LIST_ROWS_MAX) return { query: prefix, rest };
  }
  return null;
}

export interface ResolveOptions {
  /** Línea para el usuario antes de la lista / del "no encontré" (p. ej. "No usé: «…»."). */
  note?: string;
  /**
   * Corrida J: si no está en el padrón, ofrece *Crear empresa nueva* y *Buscar otra vez* (paso company_not_found); al
   * crearla o encontrarla sigue `action` con `args` sin perder lo que ya se dio.
   */
  offerCreate?: boolean;
}

/** Corrida J: botones cuando la empresa no está en el padrón (id = el texto equivalente). */
export const NOT_FOUND_BUTTONS = [
  { id: "nueva empresa", title: "Crear empresa nueva" },
  { id: "buscar otra vez", title: "Buscar otra vez" },
];

/** "buscar otra vez", "buscar", "otra vez", "buscar de nuevo" (botón o escrito). */
export const SEARCH_AGAIN_RE = /^(?:buscar(?:la|lo)?(?:\s+(?:otra\s+vez|de\s+nuevo|otra))?|otra\s+vez|de\s+nuevo)[.!]*$/i;

/** Pasos en los que `nueva empresa` sigue el flujo en curso (la empresa no se encontró) en vez de dejarlo en pausa. */
export function offersNewCompany(step: PendingStep | null | undefined): boolean {
  if (!step) return false;
  if (step.kind === "company_not_found" || step.kind === "company_search") return true;
  return step.kind === "report_draft" && !!step.draft && step.field === "empresa";
}

/**
 * Corrida J: comandos que, con este paso en curso, son su respuesta: en el resumen del alta de una empresa,
 * `contacto Juan Pérez, …` es el contacto de la empresa nueva (no el comando `contacto`, que pediría la empresa).
 */
export function capturesCommand(step: PendingStep | null | undefined, command: string): boolean {
  return !!step && step.kind === "new_company" && step.field === null && command === "contacto";
}

/** "No encontré «X» en el padrón." con los dos botones (y su equivalente escrito). */
export async function replyNotFound(ctx: PortalContext, head: string): Promise<void> {
  const body = `${head}\nSi es una empresa nueva, *créala*; si no, búscala con otra parte del nombre o el RUC.`;
  await replyButtons(ctx, body, NOT_FOUND_BUTTONS, { fallback: `${head}\nEscribe otra parte del nombre o el RUC, o *nueva empresa* para crearla.` });
}

/**
 * Busca la empresa y, si hay una sola, la devuelve. Si hay varias, responde la lista y guarda el paso choose_company
 * (al elegir se ejecuta la acción registrada `action` con `args`): con 10 o menos, como lista interactiva de WhatsApp
 * (cada fila con el número de la opción como id) y en texto la lista numerada; con más, las 5 primeras en texto como
 * siempre. Si no hay, lo dice. null = ya respondió.
 */
export async function resolveCompany(ctx: PortalContext, query: string, action: string, args: Record<string, unknown> = {}, opts: ResolveOptions = {}): Promise<Company | null> {
  const q = query.trim();
  const note = opts.note ? `${opts.note}\n` : "";
  if (!q) {
    await ctx.reply(`${note}¿Qué empresa? Escribe el nombre o el RUC.`);
    return null;
  }
  const { rows, total } = await findCompanies(ctx.store, q, LIST_ROWS_MAX);
  if (rows.length === 0) {
    if (opts.offerCreate) {
      const step: Omit<CompanyNotFoundStep, "createdAt"> = { kind: "company_not_found", action, args, query: q };
      await setPending(ctx.store, ctx.from, step, ctx.now);
      await replyNotFound(ctx, `${note}No encontré «${q}» en el padrón.`);
      return null;
    }
    await ctx.reply(`${note}No encontré «${q}» en el padrón. Prueba con el RUC o con otra parte del nombre.`);
    return null;
  }
  if (rows.length === 1 && total === 1) {
    await clearPending(ctx.store, ctx.from);
    return rows[0];
  }
  const asList = total <= LIST_ROWS_MAX;
  const shown = asList ? rows : rows.slice(0, MAX_OPTIONS);
  const options = shown.map((c) => ({ id: c.id, label: `${c.razonSocial} · RUC ${c.ruc} · ${fmtInt(c.unidades)} unid.` }));
  const step: Omit<ChooseCompanyStep, "createdAt"> = { kind: "choose_company", action, options, args };
  await setPending(ctx.store, ctx.from, step, ctx.now);
  const more = total > options.length ? `\n_…y ${total - options.length} más: escribe más del nombre o el RUC._` : "";
  const body = `${note}Encontré ${total} empresas con «${q}». ¿Cuál? Responde con el número:\n${options.map((o, i) => `*${i + 1}.* ${o.label}`).join("\n")}${more}`;
  if (!asList) {
    await ctx.reply(body);
    return null;
  }
  // lista: id de cada fila = el número de la opción (lo mismo que escribirlo)
  const listRows = shown.map((c, i) => ({ id: String(i + 1), title: shortName(c.razonSocial), description: `RUC ${c.ruc} · ${fmtInt(c.unidades)} unid.` }));
  await replyList(ctx, body, "Elegir empresa", listRows, { fallback: body });
  return null;
}

/** Respuesta a la lista: "2", "la 2", "opción 2". Otro texto no es respuesta (se clasifica de nuevo). */
registerPendingHandler("choose_company", async (ctx, step, text) => {
  const s = step as ChooseCompanyStep;
  const m = /^(?:(?:la|el|opcion|opción|nro|n°|numero|número)\s*)?(\d{1,2})\.?$/i.exec(text.trim());
  if (!m) return false;
  const n = parseInt(m[1], 10);
  if (n < 1 || n > s.options.length) {
    await ctx.reply(`Responde con un número del 1 al ${s.options.length}, o *cancelar*.`);
    return true;
  }
  await clearPending(ctx.store, ctx.from);
  const company = await ctx.store.getCompany(s.options[n - 1].id);
  if (!company) {
    await ctx.reply("Esa empresa ya no está en el padrón.");
    return true;
  }
  const handler = getCompanyAction(s.action);
  if (!handler) {
    await ctx.reply(`*${s.action}* estará disponible pronto.`);
    return true;
  }
  await handler(ctx, company, s.args ?? {});
  return true;
});

/**
 * Corrida J: después de "No encontré «X» en el padrón" (*Crear empresa nueva* la atiende el comando `nueva empresa`).
 * *Buscar otra vez* pide el nombre; un nombre o RUC escrito (corto) se busca de nuevo con la misma acción.
 */
async function searchAgainStep(ctx: PortalContext, step: PendingStep, text: string): Promise<boolean> {
  const s = step as CompanyNotFoundStep;
  const t = text.trim();
  if (SEARCH_AGAIN_RE.test(t)) {
    // la respuesta irá escrita: con el cotizador revisando una cotización ya guardada (p. ej. tras *Enlazar*), se cierra
    const busy = await freeQuoter(ctx, "buscar otra vez");
    if (busy) {
      await ctx.reply(busy);
      return true;
    }
    const next: Omit<CompanyNotFoundStep, "createdAt"> = { kind: "company_search", action: s.action, args: s.args ?? {} };
    await setPending(ctx.store, ctx.from, next, ctx.now);
    await ctx.reply("¿Qué empresa? Escribe el nombre o el RUC.");
    return true;
  }
  // un nombre o un RUC, no un mensaje largo (un reporte o un pedido se clasifican aparte)
  if (!t || fold(t).split(" ").filter(Boolean).length > 8) return false;
  const company = await resolveCompany(ctx, t, s.action, s.args ?? {}, { offerCreate: true });
  if (!company) return true;
  const handler = getCompanyAction(s.action);
  if (!handler) {
    await ctx.reply(`*${s.action}* estará disponible pronto.`);
    return true;
  }
  await handler(ctx, company, s.args ?? {});
  return true;
}

registerPendingHandler("company_not_found", searchAgainStep);
registerPendingHandler("company_search", searchAgainStep);

/** Para qué se elegía la empresa (recordatorio de la pausa). */
const ACTION_LABEL: Record<string, string> = { empresa: "ver su ficha", asignarme: "asignártela", contacto: "el contacto", contacto_sin_nombre: "el contacto", cita: "la cita", cita_sin_fecha: "la cita", oc: "la orden de compra", prepropuesta: "la pre-propuesta", estado: "ver su estado" };

/** En pausa (corrida D, punto 7): "elegir la empresa para la cita (falta elegir…)"; *Continuar* repite la lista. */
registerPausable("choose_company", {
  async describe(_ctx, step) {
    const s = step as ChooseCompanyStep;
    return { companyId: null, label: `elegir la empresa para ${ACTION_LABEL[s.action] ?? s.action}`, missing: `falta elegir entre ${s.options.length}` };
  },
  async resume(ctx, step, prefix) {
    const s = step as ChooseCompanyStep;
    const { createdAt: _c, ...rest } = s;
    await setPending(ctx.store, ctx.from, rest, ctx.now);
    const body = `${prefix ? `${prefix}\n\n` : ""}¿Cuál? Responde con el número:\n${s.options.map((o, i) => `*${i + 1}.* ${o.label}`).join("\n")}`;
    const rows = s.options.map((o, i) => ({ id: String(i + 1), title: shortName(o.label.split(" · ")[0]), description: o.label.split(" · ").slice(1).join(" · ") }));
    await replyList(ctx, body, "Elegir empresa", rows, { fallback: body });
  },
});

// ── ficha ──

export function companyUrl(companyId: number, env: Record<string, string | undefined> = process.env): string {
  return `${portalBaseUrl(env)}/portal/empresas/${companyId}`;
}

const CONF_RANK: Record<string, number> = { alta: 3, media: 2, baja: 1 };

/** Medidas probables de la flota (inferidas), por unidades: [{ medida, unidades, confianza }]. */
export function probableSizes(groups: FleetGroup[], top = 3): { medida: string; unidades: number; confianza: Confianza | null }[] {
  const m = new Map<string, { unidades: number; conf: Map<string, number> }>();
  for (const g of groups) {
    if (!g.medidaProbable) continue;
    const e = m.get(g.medidaProbable) ?? { unidades: 0, conf: new Map<string, number>() };
    e.unidades += g.unidades;
    const c = g.confianza ?? "";
    e.conf.set(c, (e.conf.get(c) ?? 0) + g.unidades);
    m.set(g.medidaProbable, e);
  }
  return [...m.entries()]
    .map(([medida, e]) => {
      const conf = [...e.conf.entries()].sort((a, b) => b[1] - a[1] || (CONF_RANK[b[0]] ?? 0) - (CONF_RANK[a[0]] ?? 0))[0]?.[0] ?? "";
      return { medida, unidades: e.unidades, confianza: (conf || null) as Confianza | null };
    })
    .sort((a, b) => b.unidades - a.unidades || a.medida.localeCompare(b.medida))
    .slice(0, top);
}

export interface FichaOptions {
  /** true: ficha completa (asignarme); false: corta (empresa). */
  full: boolean;
  env?: Record<string, string | undefined>;
  now?: Date;
}

/** La ficha de la empresa para WhatsApp. */
export async function formatFicha(store: PortalStore, company: Company, opts: FichaOptions): Promise<string> {
  const env = opts.env ?? process.env;
  const owner = company.ownerUserId ? await store.getUser(company.ownerUserId) : null;
  const lines: string[] = [];
  lines.push(`🏢 *${company.razonSocial}*`);
  lines.push(`RUC ${company.ruc} · ${sectorLabel(company.sector)}${company.departamento ? ` · ${company.departamento}` : ""}${company.esCliente ? " · *cliente*" : ""}`);
  // corrida J: una empresa creada a mano no viene del padrón
  const fuente = company.origen === "manual" ? "_(cargado a mano: no viene del MTC)_" : "_(dato MTC)_";
  lines.push(`Unidades: *${fmtInt(company.unidades)}* · Llantas en piso: *${fmtInt(company.llantasPiso)}* ${fuente}`);
  lines.push(`Dueño: ${owner ? owner.nombre : "sin asignar"}`);
  // corrida L: dirección (la de operación manda; si no, el domicilio fiscal de SUNAT) y el aviso de SUNAT
  lines.push(...fichaDireccionLines(company, sunatBrief(await store.getSunat(company.ruc)), loadPortalConfig().sunat));
  if (opts.full) {
    const groups = await store.fleetByBrand(company.id);
    const brands = groupByBrand(groups).slice(0, 4);
    if (brands.length) lines.push(`Flota por marca: ${brands.map((b) => `${b.marca} ${fmtInt(b.unidades)}`).join(" · ")}`);
    const sizes = probableSizes(groups);
    if (sizes.length) lines.push(`Medidas probables _(inferidas)_: ${sizes.map((s) => `${s.medida} (${fmtInt(s.unidades)} unid., confianza ${s.confianza ?? "—"})`).join(" · ")}`);
    const part = (await store.participation([company.ruc], defaultSince(opts.now)))[company.ruc];
    lines.push(`Participación 12 meses: ${part && part.cantidad > 0 ? `${fmtInt(part.cantidad)} llantas${part.demo ? " *DEMO*" : ""}` : "sin ventas registradas"}`);
    const contacts = await store.listContacts(company.id);
    if (contacts.length) {
      lines.push("Contactos:");
      for (const c of contacts.slice(0, 5)) lines.push(`• ${c.nombre}${c.cargo ? ` (${c.cargo})` : ""}${c.telefono ? ` · ${c.telefono}` : ""}${c.email ? ` · ${c.email}` : ""}`);
      if (contacts.length > 5) lines.push(`• …y ${contacts.length - 5} más`);
    } else {
      lines.push("Contactos: ninguno aún _(agrega con *contacto …*)_");
    }
    const opp = await store.getOpenOpportunity(company.id);
    if (opp) lines.push(`Oportunidad: *${stageLabel(opp.etapa)}*${opp.proximaAccion ? ` · próxima acción: ${opp.proximaAccion}` : ""}`);
  }
  lines.push(`Ficha: ${companyUrl(company.id, env)}`);
  return lines.join("\n");
}
