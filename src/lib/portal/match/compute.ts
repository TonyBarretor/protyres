/**
 * Corrida K — el cruce de Match Venta (puro: sin store). Para cada producto prioritario y cada empresa del padrón:
 *
 *   Match % = Encaje × 50 + Volumen × 35 + Historial × 15 (+ aplicación), redondeado, tope 100. Pesos en config match.pesos.
 *    - Encaje: unidades de la flota con medida probable = la del producto / unidades de la flota ("92%").
 *    - Volumen: llantas en piso en esa medida / (match.volumenReferencia × disponible de la medida, productos
 *      prioritarios), tope 1; con menos de
 *      match.minLlantasVolumen (6) llantas, 0. Vehículos sin N_LLANTAS: se estiman por ejes (match.llantasPorEjes).
 *    - Historial: 1 si ya compró la medida (ventas reales, al cliente final en leasing), 0,5 si es cliente de otras
 *      medidas, 0 si no es cliente.
 *    - Aplicación: suma unos puntos (sin excluir) si la empresa encaja con la aplicación del producto (config
 *      match.aplicaciones: tracción -> minería / construcción / carga pesada; delantera y súper mixta -> buses y carretera).
 *  - Migración: sin flota en la medida pero con flota en una medida equivalente (mismo aro, ±3%: sizes.ts), el encaje se
 *    multiplica por 0,5 y lleva la etiqueta "Migración posible desde X: confirmar con el área técnica".
 *  - Compró la medida y no tiene flota en ella (ni equivalente): sale con su historial (el porcentaje es bajo, la insignia
 *    "Ya te compró esta medida" dice el resto).
 *  - Compró la medida y no está en el padrón: fila "solo_ventas" sin porcentaje (bloque "Clientes que ya compraron").
 *  - Entidades del Estado y bancos de leasing: se calculan y quedan marcadas (`excluida`); la vista las oculta por defecto.
 */
import { fold } from "../../tyre/brands";
import type { MatchCompanyInput, MatchDetail, MatchExclusion, MatchPurchase, MatchResultInput, MatchTipo } from "../store/types";
import type { MatchAplicacionRule, MatchConfig, MatchEquivalencia } from "./config";
import { equivalenceOf } from "./sizes";
import type { MatchStockProduct } from "./stock";
import { desgloseLine, historialText } from "./text";

/** Línea de venta real de neumáticos para el cruce (ya atribuida al cliente final en leasing). */
export interface MatchSaleLine {
  /** RUC al que cuenta (el cliente final si lo tiene). */
  ruc: string;
  /** RUC del documento (el banco en leasing). */
  docRuc: string;
  razonSocial: string | null;
  /** Medida canónica (null si la línea no la trae). */
  medida: string | null;
  fecha: string;
  /** Neumáticos (negativo en una nota de crédito). */
  cantidad: number;
  /** Precio unitario sin IGV en dólares si el reporte lo trae; si no, en soles. */
  precioUnitario: number | null;
  moneda: "USD" | "PEN" | null;
  total: number | null;
  margenPct: number | null;
  documento: string | null;
  codigoProducto: string | null;
  /** Venta a un banco de leasing sin cliente final asignado. */
  bancoSinClienteFinal: boolean;
}

export interface MatchProductInput extends MatchStockProduct {
  aplicacion: string | null;
}

export interface MatchComputeInput {
  companies: MatchCompanyInput[];
  /** Productos prioritarios con stock disponible. */
  products: MatchProductInput[];
  sales: MatchSaleLine[];
  cfg: MatchConfig;
  /** config sales.leasingRucs */
  leasingRucs: string[];
  now: Date;
}

export interface MatchComputeOutput {
  rows: MatchResultInput[];
  /** Por código: avisos para el vendedor (medida que el padrón no permite inferir, etc.). */
  notas: Record<string, string[]>;
  /** Equivalencias usadas por medida (y si salieron de la config o de la regla). */
  equivalencias: Record<string, MatchEquivalencia & { fromConfig: boolean }>;
}

const DAY = 86_400_000;

/** Llantas en piso de una medida: las conocidas + las estimadas por ejes de los vehículos sin N_LLANTAS. */
export function llantasDe(f: MatchCompanyInput["medidas"][string] | undefined, cfg: Pick<MatchConfig, "llantasPorEjes">): number {
  if (!f) return 0;
  let n = f.llantas;
  for (const [ejes, count] of Object.entries(f.sinLlantas)) n += count * (cfg.llantasPorEjes[ejes] ?? cfg.llantasPorEjes.default ?? 6);
  return n;
}

const has = (text: string, words: string[]) => {
  const t = ` ${fold(text).toUpperCase()} `;
  return words.some((w) => w && t.includes(fold(w).toUpperCase()));
};

/** Exclusión por defecto: Estado (razón social) o banco de leasing (RUC de config o razón social). */
export function exclusionOf(c: { ruc: string; razonSocial: string }, cfg: Pick<MatchConfig, "excluir">, leasingRucs: string[]): MatchExclusion | null {
  if (leasingRucs.includes(c.ruc) || has(c.razonSocial, cfg.excluir.leasing)) return "leasing";
  if (has(c.razonSocial, cfg.excluir.estado)) return "estado";
  return null;
}

/** Regla de aplicación del producto (por palabras de su aplicación); null si ninguna. */
export function aplicacionRule(aplicacion: string | null, cfg: Pick<MatchConfig, "aplicaciones">): MatchAplicacionRule | null {
  if (!aplicacion) return null;
  const t = fold(aplicacion);
  return cfg.aplicaciones.find((r) => r.palabras.some((p) => t.includes(fold(p)))) ?? null;
}

/** ¿La empresa encaja con la aplicación? (sector, porción de clases de vehículo o razón social). */
export function aplicacionFits(rule: MatchAplicacionRule, c: MatchCompanyInput): boolean {
  const s = rule.sube;
  if (c.sector && s.sectores.includes(c.sector)) return true;
  if (s.clases.length && c.unidades > 0) {
    const n = s.clases.reduce((acc, k) => acc + (c.clases[k] ?? 0), 0);
    if (n / c.unidades >= s.minPorcionClases) return true;
  }
  return s.razonSocial.length > 0 && has(c.razonSocial, s.razonSocial);
}

/** Compras de cada RUC por medida: "Ya te compró esta medida" (solo si los neumáticos netos son más de 0). */
export function purchasesByRuc(sales: MatchSaleLine[], cfg: Pick<MatchConfig, "reposicionDias">, now: Date): Map<string, Map<string, { compra: MatchPurchase; lines: MatchSaleLine[] }>> {
  const groups = new Map<string, Map<string, MatchSaleLine[]>>();
  for (const s of sales) {
    if (!s.medida) continue;
    let g = groups.get(s.ruc);
    if (!g) groups.set(s.ruc, (g = new Map()));
    const list = g.get(s.medida);
    if (list) list.push(s);
    else g.set(s.medida, [s]);
  }
  const out = new Map<string, Map<string, { compra: MatchPurchase; lines: MatchSaleLine[] }>>();
  for (const [ruc, g] of groups) {
    for (const [medida, lines] of g) {
      const cantidad = lines.reduce((n, l) => n + l.cantidad, 0);
      if (cantidad <= 0) continue;
      const positive = lines.filter((l) => l.cantidad > 0).sort((a, b) => a.fecha.localeCompare(b.fecha));
      if (!positive.length) continue;
      const last = positive.at(-1)!;
      const lastLines = positive.filter((l) => l.fecha === last.fecha);
      const priced = [...lastLines].reverse().find((l) => l.precioUnitario !== null);
      const withMargin = lines.filter((l) => l.margenPct !== null && l.total !== null && l.total > 0);
      const weight = withMargin.reduce((n, l) => n + l.total!, 0);
      const margenPct = weight > 0 ? Math.round((withMargin.reduce((n, l) => n + l.margenPct! * l.total!, 0) / weight) * 10) / 10 : null;
      const dates = [...new Set(positive.map((l) => l.fecha))].sort();
      const ritmoDias = dates.length >= 2 ? Math.round((Date.parse(dates.at(-1)!) - Date.parse(dates[0])) / DAY / (dates.length - 1)) : null;
      const since = (now.getTime() - Date.parse(last.fecha)) / DAY;
      const reponer = ritmoDias !== null && ritmoDias > 0 ? since >= ritmoDias : since >= cfg.reposicionDias;
      const compra: MatchPurchase = {
        cantidad,
        ultimaFecha: last.fecha,
        ultimaCantidad: lastLines.reduce((n, l) => n + l.cantidad, 0),
        precioUnitario: priced?.precioUnitario ?? null,
        moneda: priced?.moneda ?? null,
        margenPct,
        facturas: new Set(positive.map((l) => l.documento ?? `${l.fecha}`)).size,
        mismoProducto: false,
        ritmoDias,
        reponer,
      };
      let m = out.get(ruc);
      if (!m) out.set(ruc, (m = new Map()));
      m.set(medida, { compra, lines });
    }
  }
  return out;
}

/** RUC con neumáticos comprados (cualquier medida, netos > 0): clientes. */
function clientRucs(sales: MatchSaleLine[]): Set<string> {
  const n = new Map<string, number>();
  for (const s of sales) n.set(s.ruc, (n.get(s.ruc) ?? 0) + s.cantidad);
  return new Set([...n].filter(([, q]) => q > 0).map(([r]) => r));
}

export function computeMatches(input: MatchComputeInput): MatchComputeOutput {
  const { cfg, now } = input;
  const w = cfg.pesos;
  const notas: Record<string, string[]> = {};
  const equivalencias: MatchComputeOutput["equivalencias"] = {};
  const rows: MatchResultInput[] = [];
  const purchases = purchasesByRuc(input.sales, cfg, now);
  const clients = clientRucs(input.sales);
  const companyByRuc = new Map(input.companies.map((c) => [c.ruc, c]));
  const fleetSizes = new Set<string>();
  for (const c of input.companies) for (const m of Object.keys(c.medidas)) fleetSizes.add(m);
  const saleSizes = new Set(input.sales.map((s) => s.medida).filter((m): m is string => !!m));

  // disponible por medida (todos los productos prioritarios de esa medida): el denominador del Volumen
  const availBySize = new Map<string, number>();
  for (const p of input.products) availBySize.set(p.size, (availBySize.get(p.size) ?? 0) + p.available);

  const saleName = new Map<string, string>();
  for (const s of input.sales) if (s.razonSocial && !saleName.has(s.ruc)) saleName.set(s.ruc, s.razonSocial);

  for (const p of input.products) {
    const M = p.size;
    const { eq, fromConfig } = equivalenceOf(M, cfg, [...fleetSizes, ...saleSizes]);
    equivalencias[M] = { ...eq, fromConfig };
    const migrationSizes = eq.migracion.map((e) => e.desde);
    const denom = Math.max(1, (availBySize.get(M) ?? p.available) * cfg.volumenReferencia);
    const rule = aplicacionRule(p.aplicacion, cfg);
    const notes: string[] = [];
    let direct = 0;
    let migr = 0;

    for (const c of input.companies) {
      const bought = purchases.get(c.ruc)?.get(M);
      const units = c.medidas[M]?.unidades ?? 0;
      const migUnits = migrationSizes.map((s) => ({ s, u: c.medidas[s]?.unidades ?? 0 })).filter((x) => x.u > 0);
      let tipo: MatchTipo;
      let encaje = 0;
      let llantas = 0;
      let unidadesMedida = 0;
      let migracionDesde: string | undefined;
      if (units > 0) {
        tipo = "directo";
        unidadesMedida = units;
        encaje = c.unidades > 0 ? Math.min(1, units / c.unidades) : 0;
        llantas = llantasDe(c.medidas[M], cfg);
        direct++;
      } else if (migUnits.length) {
        tipo = "migracion";
        unidadesMedida = migUnits.reduce((n, x) => n + x.u, 0);
        migracionDesde = [...migUnits].sort((a, b) => b.u - a.u)[0].s;
        encaje = c.unidades > 0 ? Math.min(1, unidadesMedida / c.unidades) * cfg.migracion.factor : 0;
        llantas = migUnits.reduce((n, x) => n + llantasDe(c.medidas[x.s], cfg), 0);
        migr++;
      } else if (bought) {
        tipo = "directo";
      } else continue;

      const volumen = llantas < cfg.minLlantasVolumen ? 0 : Math.min(1, llantas / denom);
      const esCliente = c.esCliente || clients.has(c.ruc);
      const historial = bought ? cfg.historial.compro : esCliente ? cfg.historial.clienteOtras : 0;
      const fits = rule ? aplicacionFits(rule, c) : false;
      const puntos = { encaje: w.encaje * encaje, volumen: w.volumen * volumen, historial: w.historial * historial, aplicacion: fits && rule ? rule.puntos : 0 };
      const pct = Math.min(100, Math.round(puntos.encaje + puntos.volumen + puntos.historial + puntos.aplicacion));
      const compra = bought ? { ...bought.compra, mismoProducto: bought.lines.some((l) => l.codigoProducto === p.code) } : undefined;
      const share = c.unidades > 0 ? unidadesMedida / c.unidades : 0;
      const detalle: MatchDetail = {
        encaje: round3(encaje),
        volumen: round3(volumen),
        historial,
        puntos: { encaje: round1(puntos.encaje), volumen: round1(puntos.volumen), historial: round1(puntos.historial), aplicacion: puntos.aplicacion },
        desglose: desgloseLine({ tipo, medida: tipo === "migracion" ? migracionDesde! : M, share, llantas, minLlantas: cfg.minLlantasVolumen, historial: historialText(!!bought, esCliente), aplicacion: fits && rule ? rule.nombre : undefined }),
        ...(migracionDesde ? { migracionDesde, etiquetaMigracion: `Migración posible desde ${migracionDesde}: confirmar con el área técnica` } : {}),
        ...(fits && rule ? { aplicacion: rule.nombre } : {}),
        ...(compra ? { compra } : {}),
      };
      const cap = p.available;
      const est = Math.round(llantas * cfg.podriaLlevarFactor * (tipo === "migracion" ? cfg.migracion.factor : 1));
      const podria = Math.min(cap, Math.max(est, compra?.ultimaCantidad ?? 0));
      rows.push({
        productCode: p.code,
        medida: M,
        companyId: c.companyId,
        ruc: c.ruc,
        razonSocial: c.razonSocial,
        tipo,
        pct,
        llantasMedida: llantas,
        unidadesMedida,
        podriaLlevar: podria > 0 ? podria : null,
        yaCompro: !!bought,
        excluida: exclusionOf(c, cfg, input.leasingRucs),
        detalle,
      });
    }

    // compraron la medida y no están en el padrón: bloque aparte, sin porcentaje
    for (const [ruc, g] of purchases) {
      const bought = g.get(M);
      if (!bought || companyByRuc.has(ruc)) continue;
      const banco = bought.lines.every((l) => l.bancoSinClienteFinal);
      const name = saleName.get(ruc) ?? ruc;
      const compra = { ...bought.compra, mismoProducto: bought.lines.some((l) => l.codigoProducto === p.code) };
      rows.push({
        productCode: p.code,
        medida: M,
        companyId: null,
        ruc,
        razonSocial: name,
        tipo: "solo_ventas",
        pct: null,
        llantasMedida: 0,
        unidadesMedida: 0,
        podriaLlevar: Math.min(p.available, compra.ultimaCantidad) || null,
        yaCompro: true,
        excluida: banco ? "leasing" : exclusionOf({ ruc, razonSocial: name }, cfg, input.leasingRucs),
        detalle: {
          encaje: 0,
          volumen: 0,
          historial: cfg.historial.compro,
          puntos: { encaje: 0, volumen: 0, historial: 0, aplicacion: 0 },
          desglose: banco ? "Compra a nombre del banco de leasing, sin cliente final asignado" : "Ya te compró esta medida · no está en el padrón del MTC (sin datos de flota)",
          compra,
          ...(banco ? { bancoSinClienteFinal: true } : {}),
        },
      });
    }

    if (!direct) {
      notes.push(
        rule?.soloVentas
          ? `El padrón del MTC no dice qué empresas usan ${p.sizeDisplay}: es de carga y pasajeros y casi no trae camionetas. Esta lista sale de quién ya te la compró${migr ? " y de flotas que podrían migrar" : ""}.`
          : `El padrón del MTC no permite saber qué empresas usan ${p.sizeDisplay} (ningún tipo de vehículo se asocia a esa medida). Esta lista sale de quién ya te la compró${migr ? " y de flotas que podrían migrar desde una medida equivalente" : ""}.`,
      );
    }
    if (eq.revision.length) notes.push(`Requieren revisión técnica (mismo aro, diámetro fuera de ±${Math.round(cfg.migracion.tolerancia * 100)}%): ${eq.revision.map((e) => e.desde).join(", ")}.`);
    notas[p.code] = notes;
  }
  return { rows, notas, equivalencias };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
