/**
 * ventas-odoo, punto 9: el historial de ventas de Odoo en el bot (solo vendedor, supervisor y administrador: lleva costo y
 * margen, que son internos).
 *
 *  - `ultima venta <empresa> [medida]` ("última venta ancro 295/80R22.5", o dictado: "última venta a Ancro de doscientos
 *    noventa y cinco ochenta veintidós punto cinco"): las 3 últimas ventas de neumáticos de esa medida a ese cliente (o de
 *    cualquier medida), con fecha, producto, cantidad, precio, costo y margen en la moneda de la factura. La empresa se
 *    busca en el padrón y, si no está, por razón social o RUC en las ventas (clientes fuera del padrón).
 *  - `cliente final <factura> <empresa>` ("cliente final F003-4050 transportes x", o con el RUC): las líneas de esa
 *    factura de una entidad de leasing (sales.leasingRucs) pasan a contar para la empresa; se recalcula el puntaje del
 *    banco y de la empresa.
 */
import { loadPortalConfig } from "../../config";
import { recalcScoresSafely, type PriceSizesSource } from "../../scoring/recalc";
import { loadSalesSettings } from "../../sales/config";
import { lastTyreSales, normalizeDocInput, saleLineText } from "../../sales/history";
import { saleUnits } from "../../store/shared";
import type { Company, Sale, SalesClientRow, UserRole } from "../../store/types";
import { normalizeSpoken } from "../../voice/dictation";
import { priceSizesSource } from "../../../store/price-sizes";
import { findTyreSizes } from "../../../tyre/spec";
import { fold } from "../../../tyre/brands";
import { companyKey, findCompanies, resolveCompany, shortName, splitCompany } from "../companies";
import { registerCompanyAction, registerPortalCommand, type PortalContext } from "../registry";

/** Roles que ven ventas con costo y margen. */
export const SALES_ROLES: readonly UserRole[] = ["vendedor", "supervisor", "admin"];
const SALES_ONLY = "Las ventas (con costo y margen) las ven el vendedor, el supervisor y el administrador.";
const LAST_N = 3;

export interface SalesBotDeps {
  /** Catálogo de medidas para el puntaje (por defecto las listas de precios: src/lib/store/price-sizes.ts). */
  prices?: PriceSizesSource | null;
}

let deps: SalesBotDeps = {};

/** Tests: otro catálogo para el puntaje (null vuelve al de por defecto). */
export function configureSalesBot(d: SalesBotDeps | null): void {
  deps = d ?? {};
}

const pricesSource = (): PriceSizesSource | null => (deps.prices === undefined ? priceSizesSource : deps.prices);

async function allowed(ctx: PortalContext): Promise<boolean> {
  if (SALES_ROLES.includes(ctx.user.rol)) return true;
  await ctx.reply(SALES_ONLY);
  return false;
}

// ── ultima venta ──

/** Conectores que quedan entre la empresa y la medida: "a Ancro *de* 295/80R22.5", "zbuss *en* medida 11R22.5". */
const TRAIL_WORDS = new Set(["de", "del", "en", "la", "el", "medida", "llanta", "llantas", "neumatico", "neumaticos", "aro", "y", "con", "para"]);

export interface UltimaVentaArgs {
  /** Lo que se busca como empresa (nombre o RUC), "" si no se dijo. */
  empresa: string;
  /** Medida canónica, o null. */
  medida: string | null;
}

/**
 * "ancro 295/80R22.5" -> { empresa: "ancro", medida: "295/80R22.5" }. Dictado ("a Ancro de doscientos noventa y cinco
 * ochenta veintidós punto cinco") se normaliza como la voz (números y medidas dichas). La empresa es lo que va antes de
 * la primera palabra con cifras cuando hay medida (salvo un RUC o DNI, que es la empresa).
 */
export function parseUltimaVenta(args: string): UltimaVentaArgs {
  let t = args.trim().replace(/[.!?¡¿]+$/g, "").trim();
  if (!findTyreSizes(t).length) {
    const spoken = normalizeSpoken(t);
    if (findTyreSizes(spoken).length) t = spoken;
  }
  const sizes = findTyreSizes(t);
  if (!sizes.length) return { empresa: cleanCompany(t), medida: null };
  const words = t.split(/\s+/);
  // un RUC (o DNI) es la empresa, no el inicio de la medida
  const at = words.findIndex((w) => /\d/.test(w) && !/^\d{8,11}$/.test(w));
  const before = at < 0 ? words : words.slice(0, at);
  return { empresa: cleanCompany(before.join(" ")), medida: sizes[0].canonical };
}

function cleanCompany(s: string): string {
  const words = s.replace(/[,;:]+/g, " ").split(/\s+/).filter(Boolean);
  while (words.length && TRAIL_WORDS.has(fold(words[words.length - 1]))) words.pop();
  return words.join(" ");
}

/** Clientes de las ventas (también fuera del padrón) por RUC exacto o razón social que contiene el texto. */
async function salesClients(ctx: PortalContext, q: string): Promise<SalesClientRow[]> {
  const rows = await ctx.store.salesByClient();
  const digitsOnly = q.replace(/[\s.-]/g, "");
  if (/^\d{8,11}$/.test(digitsOnly)) return rows.filter((r) => r.ruc === digitsOnly);
  const key = companyKey(q);
  if (key.length < 3) return [];
  const squash = (x: string) => x.replace(/ /g, "");
  const words = key.split(" ");
  return rows.filter((r) => {
    const k = companyKey(r.razonSocial ?? "");
    return !!k && (squash(k).includes(squash(key)) || words.every((w) => k.split(" ").includes(w)));
  });
}

function salesReply(name: string, medida: string | null, lines: Sale[]): string {
  const head = `🧾 *Última${lines.length > 1 ? "s" : ""} venta${lines.length > 1 ? "s" : ""} a ${name}*${medida ? ` · ${medida}` : ""}`;
  return [head, ...lines.map((s) => `• ${saleLineText(s)}`), "_Costo y margen son internos: no van al cliente._"].join("\n");
}

async function showLastSales(ctx: PortalContext, who: { ruc: string; name: string }, medida: string | null): Promise<void> {
  const lines = await lastTyreSales(ctx.store, who.ruc, { medida, limit: LAST_N });
  if (lines.length) {
    await ctx.reply(salesReply(who.name, medida, lines));
    return;
  }
  if (medida) {
    const other = await lastTyreSales(ctx.store, who.ruc, { limit: 1 });
    if (other.length) {
      await ctx.reply(`No hay ventas de *${medida}* a *${who.name}* en lo cargado de Odoo. Sí hay de otras medidas: escribe *ultima venta ${who.ruc}*.`);
      return;
    }
  }
  await ctx.reply(`No hay ventas de neumáticos a *${who.name}* en lo cargado de Odoo. Si es reciente, sube el reporte de ventas en el portal (Ventas).`);
}

registerCompanyAction("ultima_venta", async (ctx, company, args) => {
  const medida = typeof args.medida === "string" ? args.medida : null;
  await showLastSales(ctx, { ruc: company.ruc, name: shortName(company.razonSocial) }, medida);
});

registerPortalCommand("ultima_venta", async (ctx, rawArgs) => {
  if (!(await allowed(ctx))) return;
  const { empresa, medida } = parseUltimaVenta(rawArgs);
  if (!empresa) {
    await ctx.reply("¿De qué cliente? Escribe *ultima venta ZBUSS 295/80R22.5* (la medida es opcional), o el RUC.");
    return;
  }
  // padrón primero (con la lista para elegir si hay varias); si no está, las ventas por razón social o RUC
  const split = await splitCompany(ctx.store, empresa);
  const inPadron = split ? (await findCompanies(ctx.store, split.query, 1)).total > 0 : false;
  if (split && inPadron) {
    const company = await resolveCompany(ctx, split.query, "ultima_venta", { medida });
    if (company) await showLastSales(ctx, { ruc: company.ruc, name: shortName(company.razonSocial) }, medida);
    return;
  }
  const clients = await salesClients(ctx, empresa);
  if (clients.length === 1) {
    const c = clients[0];
    await showLastSales(ctx, { ruc: c.ruc, name: shortName(c.razonSocial ?? c.ruc) }, medida);
    return;
  }
  if (clients.length > 1) {
    const shown = clients.slice(0, 5).map((c) => `• ${c.razonSocial ?? "—"} · RUC ${c.ruc}`);
    await ctx.reply([`Encontré ${clients.length} clientes en las ventas con «${empresa}». Escribe el RUC:`, ...shown].join("\n"));
    return;
  }
  await ctx.reply(`No encontré «${empresa}» en el padrón ni en las ventas cargadas. Prueba con el RUC o con otra parte del nombre.`);
});

// ── cliente final ──

/** N° de documento al inicio o al final: "F003-4050", "F003 4050", "B BOL-00000007", "F NDI-1". */
const DOC = String.raw`[a-z]{1,2}\s[a-z]{2,4}\s*-\s*\d{1,10}|[a-z]{1,4}\d{0,4}\s*-\s*\d{1,10}|[a-z]{1,4}\d{2,4}\s+\d{1,10}`;
const DOC_START = new RegExp(`^(${DOC})(?=\\s|$)`, "i");
const DOC_END = new RegExp(`(?:^|\\s)(${DOC})$`, "i");

export interface ClienteFinalArgs {
  documento: string;
  empresa: string;
}

/** "F003-4050 transportes x" / "transportes x F003-4050" -> { documento: "F003-4050", empresa: "transportes x" }; null sin factura. */
export function parseClienteFinal(args: string): ClienteFinalArgs | null {
  const t = args.trim().replace(/\s+/g, " ").replace(/[.]+$/, "");
  const start = DOC_START.exec(t);
  if (start) return { documento: normalizeDocInput(start[1]), empresa: t.slice(start[0].length).replace(/^[\s,:;-]+/, "").replace(/^(?:a|al|para)\s+/i, "").trim() };
  const end = DOC_END.exec(t);
  if (end) return { documento: normalizeDocInput(end[1]), empresa: t.slice(0, end.index).replace(/[\s,:;-]+$/, "").trim() };
  return null;
}

const CF_USAGE = "Escribe *cliente final F003-4050 TRANSPORTES X* (la factura del banco y la empresa, o su RUC).";

async function assignClienteFinal(ctx: PortalContext, company: Company, documento: string): Promise<void> {
  const leasing = new Set(loadSalesSettings().leasingRucs);
  const lines = (await ctx.store.querySales({ documentos: [documento], onlyDetailed: true })).filter((s) => leasing.has(s.ruc));
  if (!lines.length) {
    await ctx.reply(`Ya no encuentro la factura *${documento}* de una entidad de leasing.`);
    return;
  }
  const banks = [...new Set(lines.map((s) => s.ruc))];
  if (banks.includes(company.ruc)) {
    await ctx.reply(`*${shortName(company.razonSocial)}* es la entidad de leasing de la *${documento}*. El cliente final es la empresa que usa las llantas.`);
    return;
  }
  const before = new Set(lines.map((s) => s.detalle?.clienteFinalCompanyId).filter((id): id is number => typeof id === "number" && id !== company.id));
  let changed = 0;
  for (const bankRuc of banks) changed += await ctx.store.setClienteFinal({ bankRuc, documentos: [documento], company: { id: company.id, ruc: company.ruc }, userId: ctx.user.id });
  if (!changed) {
    await ctx.reply(`No pude asignar la *${documento}*: ya no tiene líneas.`);
    return;
  }
  // el banco deja de sumar esas llantas y la empresa (y la anterior, si cambió) las suma: su puntaje cambia
  const bankCompanies = await ctx.store.getCompaniesByRucs(banks);
  const companyIds = [...new Set([company.id, ...before, ...bankCompanies.map((c) => c.id)])];
  await recalcScoresSafely(ctx.store, loadPortalConfig().scoring, { companyIds, prices: pricesSource(), now: ctx.now, why: `cliente final ${documento}`, log: ctx.log });
  await ctx.store.flush();
  const units = lines.filter((s) => (s.detalle?.tipoLinea ?? "neumatico") === "neumatico").reduce((n, s) => n + saleUnits(s), 0);
  const bankName = lines[0].razonSocial ?? lines[0].ruc;
  const prev = before.size ? await ctx.store.getCompany([...before][0]) : null;
  const was = prev ? `\nAntes contaba para *${shortName(prev.razonSocial)}*.` : "";
  await ctx.reply(`✅ *${documento}* (${units} neumático${units === 1 ? "" : "s"}) ahora cuenta para *${shortName(company.razonSocial)}* (vía leasing con ${shortName(bankName)}).${was}`);
}

registerCompanyAction("cliente_final", async (ctx, company, args) => {
  if (typeof args.documento === "string") await assignClienteFinal(ctx, company, args.documento);
});

registerPortalCommand("cliente_final", async (ctx, rawArgs) => {
  if (!(await allowed(ctx))) return;
  const parsed = parseClienteFinal(rawArgs);
  if (!parsed) {
    await ctx.reply(`¿Qué factura? ${CF_USAGE}`);
    return;
  }
  const { documento, empresa } = parsed;
  const lines = await ctx.store.querySales({ documentos: [documento], onlyDetailed: true });
  if (!lines.length) {
    await ctx.reply(`No encontré la factura *${documento}* en las ventas cargadas de Odoo. Revisa el número (p. ej. F003-4050).`);
    return;
  }
  const leasing = new Set(loadSalesSettings().leasingRucs);
  if (!lines.some((s) => leasing.has(s.ruc))) {
    const s = lines[0];
    await ctx.reply(`La *${documento}* es de *${shortName(s.razonSocial ?? s.ruc)}* (RUC ${s.ruc}), que no es una entidad de leasing: sus neumáticos ya cuentan para ese cliente.`);
    return;
  }
  if (!empresa) {
    await ctx.reply(`¿Para qué empresa es la *${documento}*? ${CF_USAGE}`);
    return;
  }
  const split = await splitCompany(ctx.store, empresa);
  const company = await resolveCompany(ctx, split?.query ?? empresa, "cliente_final", { documento });
  if (company) await assignClienteFinal(ctx, company, documento);
});
