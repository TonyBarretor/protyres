/**
 * Corrida K — equivalencias de medida para Match Venta (migración posible / requiere revisión técnica).
 *
 * Diámetro exterior (mm) = aro × 25,4 + 2 × ancho × perfil / 100.
 *  - Métricas ("295/80R22.5"): ancho y perfil de la medida.
 *  - Sin perfil, ancho en pulgadas ("12R22.5", "11R22.5", "10.00R20"): ancho × 25,4 y el perfil nominal de las
 *    convencionales por aro (config match.perfilConvencional: 85 en 22.5/19.5/17.5, 95 en el resto). Con 85: 12R22.5 =
 *    1090 mm y 11R22.5 = 1047 mm (catálogos: 1085 y 1054); es una convención, el técnico la puede cambiar.
 *  - Sin perfil, ancho en mm ("185R14C"): serie 82.
 *  - Flotación ("31x10.50R15"): el primer número ya es el diámetro en pulgadas.
 *
 * Regla: SOLO el mismo aro exacto (17 ≠ 17.5), diámetro dentro de ±tolerancia (3%) y ancho de sección que no difiera más
 * de match.migracion.maxDiferenciaAnchoMm (30 mm) es "migración posible"; el resto del mismo aro va aparte como "requiere
 * revisión técnica". Otro aro nunca aparece. El ancho descarta las anchas de eje simple (385/65R22.5 frente a 295/80R22.5:
 * mismo diámetro, 90 mm más ancha, otra llanta). Ancho sin perfil: pulgadas × 25,4 (11R22.5 = 279 mm).
 */
import { parseTyreSize, sizeCore } from "../../tyre/spec";
import type { MatchConfig, MatchEquivalencia } from "./config";

/** Medida canónica ("295/80R22.5"); null si no es una medida. */
export function canonicalSize(s: string | null | undefined): string | null {
  return s ? (parseTyreSize(s)?.canonical ?? null) : null;
}

/** Candidata a equivalencia: sin LT/C ("265/70R17LT" es 265/70R17) y sin medidas de moto (ancho métrico < 155 mm). */
function candidateSize(s: string): string | null {
  const c = canonicalSize(s);
  if (!c) return null;
  const t = parseTyreSize(c)!;
  if (t.kind === "metric" && t.width < 155) return null;
  return sizeCore(c);
}

export function rimOf(size: string): number | null {
  return parseTyreSize(size)?.rim ?? null;
}

/** Diámetro exterior en mm (null si no se puede calcular). */
export function outerDiameterMm(size: string, perfilConvencional: MatchConfig["perfilConvencional"]): number | null {
  const t = parseTyreSize(size);
  if (!t || !t.rim) return null;
  const rim = t.rim * 25.4;
  if (t.kind === "flotation") return t.width * 25.4;
  if (t.kind === "metric") {
    const aspect = t.aspect ?? 82;
    return rim + (2 * t.width * aspect) / 100;
  }
  if (t.kind === "numeric") {
    const aspect = perfilConvencional[String(t.rim)] ?? perfilConvencional.default ?? 95;
    return rim + (2 * t.width * 25.4 * aspect) / 100;
  }
  return null;
}

export interface SizeComparison {
  desde: string;
  /** (diámetro de `desde` − diámetro de la medida) / diámetro de la medida, en % con un decimal. */
  diferenciaPct: number;
  /** Ancho de `desde` − ancho de la medida, en mm (null si alguno no se puede calcular). */
  diferenciaAnchoMm?: number | null;
}

/** Ancho de sección en mm (null si no se puede calcular: flotación y otras). */
export function sectionWidthMm(size: string): number | null {
  const t = parseTyreSize(size);
  if (!t) return null;
  if (t.kind === "metric") return t.width;
  if (t.kind === "numeric") return Math.round(t.width * 25.4 * 10) / 10;
  return null;
}

/**
 * Equivalencias de una medida frente a unas candidatas: mismo aro y dentro de la tolerancia -> migración; mismo aro
 * fuera -> revisión. Ordenadas por diferencia absoluta.
 */
export function equivalencesFor(target: string, candidates: Iterable<string>, cfg: Pick<MatchConfig, "perfilConvencional" | "migracion">): MatchEquivalencia {
  const out: MatchEquivalencia = { migracion: [], revision: [] };
  const t = canonicalSize(target);
  if (!t) return out;
  const rim = rimOf(t);
  const d = outerDiameterMm(t, cfg.perfilConvencional);
  if (rim === null || d === null) return out;
  const w = sectionWidthMm(t);
  const maxW = cfg.migracion.maxDiferenciaAnchoMm ?? 30;
  const seen = new Set<string>([t]);
  for (const raw of candidates) {
    const c = candidateSize(raw);
    if (!c || seen.has(c)) continue;
    seen.add(c);
    if (rimOf(c) !== rim) continue; // aro exacto: 17 no es 17.5
    const dc = outerDiameterMm(c, cfg.perfilConvencional);
    if (dc === null) continue;
    const diff = (dc - d) / d;
    const wc = sectionWidthMm(c);
    const dw = w !== null && wc !== null ? Math.round((wc - w) * 10) / 10 : null;
    const entry = { desde: c, diferenciaPct: Math.round(diff * 1000) / 10, diferenciaAnchoMm: dw };
    // ancho desconocido: no se puede asegurar que encaje -> revisión
    const anchoOk = dw !== null && Math.abs(dw) <= maxW + 1e-9;
    if (Math.abs(diff) <= cfg.migracion.tolerancia + 1e-9 && anchoOk) out.migracion.push(entry);
    else out.revision.push(entry);
  }
  const byAbs = (a: SizeComparison, b: SizeComparison) => Math.abs(a.diferenciaPct) - Math.abs(b.diferenciaPct) || a.desde.localeCompare(b.desde);
  out.migracion.sort(byAbs);
  out.revision.sort(byAbs);
  return out;
}

/** Medidas comunes de camioneta y camión que se comparan siempre, además de las del padrón, del stock y de las ventas. */
export const COMMON_SIZES = [
  "245/70R17",
  "245/75R17",
  "255/70R17",
  "265/70R17",
  "235/65R17",
  "225/65R17",
  "235/80R17",
  "225/70R19.5",
  "245/70R19.5",
  "265/70R19.5",
  "275/70R22.5",
  "275/80R22.5",
  "315/70R22.5",
  "385/65R22.5",
  "425/65R22.5",
  "13R22.5",
  "225/75R17.5",
  "235/75R17.5",
  "8.25R20",
  "10R20",
  "11R20",
  "12R20",
];

/** Tabla de equivalencias para varias medidas (la que va a config/portal.json match.equivalencias). */
export function buildEquivalenceTable(targets: string[], candidates: Iterable<string>, cfg: Pick<MatchConfig, "perfilConvencional" | "migracion">): Record<string, MatchEquivalencia> {
  const cands = [...new Set([...candidates, ...COMMON_SIZES])];
  const out: Record<string, MatchEquivalencia> = {};
  for (const t of targets) {
    const c = canonicalSize(t);
    if (c) out[c] = equivalencesFor(c, cands, cfg);
  }
  return out;
}

/** La de la config si está; si no, la regla sobre las medidas dadas (medida prioritaria nueva, aún sin tabla). */
export function equivalenceOf(size: string, cfg: MatchConfig, candidates: Iterable<string>): { eq: MatchEquivalencia; fromConfig: boolean } {
  const conf = cfg.equivalencias[size];
  if (conf) return { eq: conf, fromConfig: true };
  return { eq: equivalencesFor(size, [...candidates, ...COMMON_SIZES], cfg), fromConfig: false };
}

/** config/portal.json con match.equivalencias reemplazada por `table`, sin reformatear el resto del archivo. */
export function replaceEquivalencias(text: string, table: Record<string, MatchEquivalencia>): string {
  const body = Object.entries(table)
    .map(([size, eq]) => {
      const list = (xs: { desde: string; diferenciaPct: number }[]) => `[${xs.map((x) => `{ "desde": "${x.desde}", "diferenciaPct": ${x.diferenciaPct} }`).join(", ")}]`;
      return `      "${size}": {\n        "migracion": ${list(eq.migracion)},\n        "revision": ${list(eq.revision)}\n      }`;
    })
    .join(",\n");
  const value = body ? `{\n${body}\n    }` : "{}";
  const key = text.indexOf('"equivalencias":', text.indexOf('"match":'));
  if (key < 0) throw new Error('config/portal.json no tiene "match": { "equivalencias": … }');
  const start = text.indexOf("{", key);
  let depth = 0;
  let end = start;
  for (; end < text.length; end++) {
    if (text[end] === "{") depth++;
    else if (text[end] === "}" && --depth === 0) break;
  }
  return `${text.slice(0, start)}${value}${text.slice(end + 1)}`;
}
