/**
 * Empresas en el bot: búsqueda (RUC exacto primero, luego razón social sin tildes ni S.A.C.), desambiguación con lista
 * numerada (paso pendiente choose_company) y la ficha que se responde por WhatsApp.
 */
import { portalBaseUrl } from "../auth/tokens";
import { stageLabel } from "../stages";
import { defaultSince, foldText } from "../store/shared";
import type { Company, Confianza, FleetGroup, PortalStore } from "../store/types";
import { groupByBrand } from "../ui/fleet";
import { fold } from "../../tyre/brands";
import { fmtInt, sectorLabel } from "../ui/labels";
import { getCompanyAction, registerPendingHandler, type PortalContext } from "./registry";
import { clearPending, setPending, type ChooseCompanyStep } from "./state";

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
  const grams: string[] = [];
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const g = words.slice(i, i + n);
      if (STOP.has(g[0]) || STOP.has(g[g.length - 1])) continue;
      if (n === 1 && (g[0].length < 4 || /^\d+$/.test(g[0]))) continue;
      grams.push(g.join(" "));
    }
  }
  const out: Company[] = [];
  for (const g of [...new Set(grams)].slice(0, maxQueries)) {
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

/**
 * Busca la empresa y, si hay una sola, la devuelve. Si hay varias, responde la lista numerada y guarda el paso
 * choose_company (al elegir se ejecuta la acción registrada `action` con `args`). Si no hay, lo dice. null = ya respondió.
 */
export async function resolveCompany(ctx: PortalContext, query: string, action: string, args: Record<string, unknown> = {}): Promise<Company | null> {
  const q = query.trim();
  if (!q) {
    await ctx.reply("¿Qué empresa? Escribe el nombre o el RUC.");
    return null;
  }
  const { rows, total } = await findCompanies(ctx.store, q);
  if (rows.length === 0) {
    await ctx.reply(`No encontré «${q}» en el padrón. Prueba con el RUC o con otra parte del nombre.`);
    return null;
  }
  if (rows.length === 1 && total === 1) {
    await clearPending(ctx.store, ctx.from);
    return rows[0];
  }
  const options = rows.slice(0, MAX_OPTIONS).map((c) => ({ id: c.id, label: `${c.razonSocial} · RUC ${c.ruc} · ${fmtInt(c.unidades)} unid.` }));
  const step: Omit<ChooseCompanyStep, "createdAt"> = { kind: "choose_company", action, options, args };
  await setPending(ctx.store, ctx.from, step, ctx.now);
  const more = total > options.length ? `\n_…y ${total - options.length} más: escribe más del nombre o el RUC._` : "";
  await ctx.reply(`Encontré ${total} empresas con «${q}». ¿Cuál? Responde con el número:\n${options.map((o, i) => `*${i + 1}.* ${o.label}`).join("\n")}${more}`);
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
  lines.push(`Unidades: *${fmtInt(company.unidades)}* · Llantas en piso: *${fmtInt(company.llantasPiso)}* _(dato MTC)_`);
  lines.push(`Dueño: ${owner ? owner.nombre : "sin asignar"}`);
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
