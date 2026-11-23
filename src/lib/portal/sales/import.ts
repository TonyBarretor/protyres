/**
 * ventas-odoo: vista previa y guardado de un reporte de ventas de Odoo ya leído (odoo.ts), fuera de las server actions
 * para poder probarlo con el store JSON y con Postgres.
 *
 *  - previewOdooUpload: suma a las estadísticas del archivo lo que depende de la base: empresas enlazadas con el padrón y
 *    fuera de él, y líneas nuevas frente a ya guardadas (por su clave estable).
 *  - commitOdooUpload: registra la carga (quién, cuándo, resumen), guarda las líneas con upsert (una carga posterior
 *    actualiza sin duplicar y sin tocar el cliente final ya asignado) y recalcula el puntaje de las empresas afectadas.
 *  - notifyAdminsOfUpload: si subió un vendedor, una línea por WhatsApp a cada administrador (si la ventana de 24 h está
 *    cerrada, queda como aviso pendiente en su conversación con el bot).
 */
import { addNotice } from "../bot/state";
import { isWindowError } from "../bot/commands/cita";
import { loadPortalConfig } from "../config";
import { recalcScoresSafely, type PriceSizesSource } from "../scoring/recalc";
import { recalcMatchSafely } from "../match/recalc";
import { digits, saleCountRuc } from "../store/shared";
import type { PortalStore, PortalUser, SalesUpload } from "../store/types";
import type { WhatsAppClient } from "../../whatsapp/client";
import type { OdooParseResult, OdooStats } from "./odoo";

export interface CompanyLinkRow {
  ruc: string;
  razonSocial: string | null;
  companyId: number | null;
  neumaticos: number;
  lineas: number;
}

export interface OdooPreviewStats extends OdooStats {
  empresas: { enPadron: number; fueraDelPadron: number };
  /** Empresas (RUC de 11 dígitos) por neumáticos netos del archivo, las 20 primeras, con su enlace al padrón. */
  topEmpresas: CompanyLinkRow[];
  /** RUC de 11 dígitos que no están en el padrón (se guardan igual: "cliente fuera del padrón"). */
  fueraDelPadron: CompanyLinkRow[];
  lineasNuevas: number;
  lineasExistentes: number;
}

/** Empresas del archivo agrupadas por RUC (las excluidas no cuentan), con su empresa del padrón si existe. */
async function companiesOf(store: PortalStore, parsed: OdooParseResult): Promise<CompanyLinkRow[]> {
  const by = new Map<string, CompanyLinkRow>();
  for (const r of parsed.rows) {
    const d = r.detalle!;
    if (d.excluida || d.docCliente !== "ruc") continue;
    const row = by.get(r.ruc) ?? { ruc: r.ruc, razonSocial: r.razonSocial ?? null, companyId: null, neumaticos: 0, lineas: 0 };
    if (d.cuentaUnidades) row.neumaticos += r.cantidad;
    row.lineas++;
    by.set(r.ruc, row);
  }
  const found = await store.getCompaniesByRucs([...by.keys()]);
  for (const c of found) {
    const row = by.get(digits(c.ruc));
    if (row) row.companyId = c.id;
  }
  return [...by.values()].sort((a, b) => b.neumaticos - a.neumaticos || b.lineas - a.lineas || a.ruc.localeCompare(b.ruc));
}

export async function previewOdooUpload(store: PortalStore, parsed: OdooParseResult): Promise<OdooPreviewStats> {
  const companies = await companiesOf(store, parsed);
  const existing = await store.existingSaleLineKeys(parsed.rows.map((r) => r.detalle!.lineKey));
  return {
    ...parsed.stats,
    empresas: { enPadron: companies.filter((c) => c.companyId).length, fueraDelPadron: companies.filter((c) => !c.companyId).length },
    topEmpresas: companies.slice(0, 20),
    fueraDelPadron: companies.filter((c) => !c.companyId),
    lineasNuevas: parsed.rows.length - existing.size,
    lineasExistentes: existing.size,
  };
}

export interface CommitInput {
  store: PortalStore;
  parsed: OdooParseResult;
  fileName: string;
  hash: string;
  user: Pick<PortalUser, "id" | "nombre" | "rol">;
  stats: OdooPreviewStats;
  prices?: PriceSizesSource | null;
  log?: (m: string) => void;
}

export interface CommitResult {
  upload: SalesUpload;
  inserted: number;
  updated: number;
  /** Empresas del padrón cuyo puntaje se recalculó. */
  empresasRecalculadas: number;
}

export async function commitOdooUpload(input: CommitInput): Promise<CommitResult> {
  const { store, parsed } = input;
  // lo que se guarda en el historial: el resumen sin las listas largas
  const { fueraDelPadron: _f, advertencias, dudosas, ...rest } = input.stats;
  // nuevas y actualizadas se cuentan antes de guardar (el historial queda con las cifras de esta carga)
  const existing = await store.existingSaleLineKeys(parsed.rows.map((r) => r.detalle!.lineKey));
  const upload = await store.recordSalesUpload({
    fileName: input.fileName,
    hash: input.hash,
    formato: "odoo",
    userId: input.user.id,
    userName: input.user.nombre,
    userRol: input.user.rol,
    inserted: parsed.rows.length - existing.size,
    updated: existing.size,
    stats: { ...rest, advertencias: advertencias.length, dudosas: dudosas.length },
  });
  // RUC a los que contaban antes las líneas de este archivo (por si una recarga cambia el cliente)
  const before = await store.querySales({ documentos: [...new Set(parsed.rows.map((r) => r.detalle!.documento))], includeExcluded: true, onlyDetailed: true });
  const rows = parsed.rows.map((r) => ({ ...r, detalle: { ...r.detalle!, uploadId: upload.id }, sourceRef: `odoo:${input.hash}` }));
  const { inserted, updated } = await store.upsertSaleLines(rows);
  const rucs = new Set<string>([...rows.map((r) => r.ruc), ...before.map(saleCountRuc)]);
  const companies = await store.getCompaniesByRucs([...rucs]);
  const r = await recalcScoresSafely(store, loadPortalConfig().scoring, { prices: input.prices ?? null, companyIds: companies.map((c) => c.id), why: "subida de ventas de Odoo", log: input.log });
  // corrida K: "Ya te compró esta medida" y el historial del match salen de las ventas
  await recalcMatchSafely({ store, why: "subida de ventas de Odoo", log: input.log });
  await store.flush();
  return { upload: { ...upload, inserted, updated }, inserted, updated, empresasRecalculadas: r?.empresas ?? 0 };
}

/** Texto de una línea para el administrador. */
export function uploadNoticeText(user: Pick<PortalUser, "nombre">, fileName: string, res: { inserted: number; updated: number }, stats: Pick<OdooStats, "desde" | "hasta" | "neumaticosNetos">): string {
  const rango = stats.desde && stats.hasta ? ` (${stats.desde} a ${stats.hasta})` : "";
  return `${user.nombre} subió ventas: ${fileName}${rango}, ${res.inserted} líneas nuevas y ${res.updated} actualizadas, ${stats.neumaticosNetos} neumáticos netos.`;
}

export interface AdminNoticeResult {
  to: string;
  status: "enviado" | "aviso_pendiente" | "error";
  error?: string;
}

/** Avisa a cada administrador activo con WhatsApp. Nunca lanza. */
export async function notifyAdminsOfUpload(store: PortalStore, client: Pick<WhatsAppClient, "sendText"> | null, text: string, log: (m: string) => void = console.log): Promise<AdminNoticeResult[]> {
  const out: AdminNoticeResult[] = [];
  let admins: PortalUser[] = [];
  try {
    admins = (await store.listUsers()).filter((u) => u.activo && u.rol === "admin" && !!u.whatsapp);
  } catch (err) {
    log(`[ventas] no pude leer los administradores: ${(err as Error).message}`);
    return out;
  }
  for (const a of admins) {
    const to = a.whatsapp!;
    try {
      if (!client) throw new Error("WhatsApp no configurado");
      await client.sendText(to, text);
      out.push({ to, status: "enviado" });
    } catch (err) {
      const pending = !client || isWindowError(err);
      try {
        if (pending) await addNotice(store, to, { text, createdAt: new Date().toISOString(), kind: "subida_ventas" });
        out.push({ to, status: pending ? "aviso_pendiente" : "error", error: (err as Error).message });
      } catch (e) {
        out.push({ to, status: "error", error: (e as Error).message });
      }
      log(`[ventas] aviso al administrador ${to.slice(-4)}: ${(err as Error).message}`);
    }
  }
  return out;
}
