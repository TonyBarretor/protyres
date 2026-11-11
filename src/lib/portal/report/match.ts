/**
 * Coincidencia de empresas por nombre o RUC dentro de una lista dada (las del vendedor), sin tocar el store.
 * Misma normalización que bot/companies.ts (sin tildes, sin terminación societaria); copiada aquí para que las librerías
 * de voz y reportes no dependan del registro de comandos del bot.
 */
import { foldText } from "../store/shared";

const LEGAL_SUFFIX = /[\s,]+(?:s\.?\s?a\.?\s?c\.?(?:\s?s\.?)?|s\.?\s?a\.?\s?a\.?|s\.?\s?a\.?|e\.?\s?i\.?\s?r\.?\s?l\.?|s\.?\s?r\.?\s?l\.?|ltda\.?|sociedad\s+an[oó]nima(?:\s+cerrada)?)\s*$/i;

/** Empresa de la lista del vendedor (asignadas o con oportunidad). */
export interface CompanyRef {
  id: number;
  razonSocial: string;
  ruc: string;
}

/** "Zbuss S.A.C." -> "zbuss". */
export function nameKey(name: string): string {
  return foldText(name.trim().replace(LEGAL_SUFFIX, ""))
    .replace(/[^a-z0-9ñ]+/g, " ")
    .trim();
}

/** "ZBUSS S.A.C." -> "ZBUSS". */
export function displayName(name: string): string {
  return name.trim().replace(LEGAL_SUFFIX, "").trim() || name.trim();
}

/** Palabras que no identifican a una empresa por sí solas. */
const GENERIC = new Set(["transportes", "transporte", "empresa", "de", "del", "la", "el", "los", "y", "e", "turismo", "servicios", "grupo", "inversiones", "corporacion", "peru", "cargo", "carga", "comercial", "logistica", "sociedad", "general", "llantas", "neumaticos", "camiones", "buses", "flota", "hermanos", "asociados", "internacional", "nacional", "express", "negocios", "distribuidora", "multiservicios", "industrial", "importaciones"]);

function distinctive(key: string): string {
  return key
    .split(" ")
    .filter((w) => w && !GENERIC.has(w))
    .join(" ");
}

const contains = (hay: string, needle: string) => !!needle && ` ${hay} `.includes(` ${needle} `);

/**
 * Empresas de `companies` mencionadas en `text` (o que coinciden con el nombre `text`): RUC de 11 dígitos exacto; si no,
 * nombre completo contenido; si no, nombre sin palabras genéricas ("ZBUSS" para "Transportes Zbuss S.A.C."). Más largo primero.
 */
export function matchCompanies(text: string, companies: CompanyRef[]): CompanyRef[] {
  if (!text.trim() || !companies.length) return [];
  for (const m of text.matchAll(/(?<!\d)(\d{11})(?!\d)/g)) {
    const hit = companies.find((c) => c.ruc === m[1]);
    if (hit) return [hit];
  }
  const t = nameKey(text);
  const full = companies.filter((c) => contains(t, nameKey(c.razonSocial)));
  const exact = full.filter((c) => nameKey(c.razonSocial) === t);
  if (exact.length) return exact;
  if (full.length) return full.sort((a, b) => nameKey(b.razonSocial).length - nameKey(a.razonSocial).length);
  const partial = companies.filter((c) => {
    const d = distinctive(nameKey(c.razonSocial));
    return d.length >= 3 && contains(t, d);
  });
  if (partial.length) return partial;
  // todas las palabras distintivas dichas ("zbuss" para "Transportes Zbuss Express")
  const words = (c: CompanyRef) => distinctive(nameKey(c.razonSocial)).split(" ").filter((w) => w.length >= 4);
  const all = companies.filter((c) => words(c).length > 0 && words(c).every((w) => contains(t, w)));
  if (all.length) return all;
  // alguna palabra distintiva larga ("andino" -> Expreso Andino y Expreso Andino Cargo): candidatas para preguntar
  return companies.filter((c) => words(c).some((w) => w.length >= 5 && contains(t, w)));
}

/** La empresa del nombre/RUC que dio el modelo, o candidatas si hay varias. */
export function resolveCompanyRef(empresa: { nombre: string; ruc?: string | null } | null, companies: CompanyRef[]): { companyId: number | null; candidates: CompanyRef[] } {
  if (!empresa) return { companyId: null, candidates: [] };
  const ruc = (empresa.ruc ?? "").replace(/\D/g, "");
  if (ruc.length === 11) {
    const hit = companies.find((c) => c.ruc === ruc);
    if (hit) return { companyId: hit.id, candidates: [hit] };
  }
  const hits = matchCompanies(empresa.nombre, companies);
  if (hits.length === 1) return { companyId: hits[0].id, candidates: hits };
  return { companyId: null, candidates: hits.slice(0, 5) };
}
