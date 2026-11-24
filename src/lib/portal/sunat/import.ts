/**
 * Corrida L — `npm run portal:import-sunat`: domicilio fiscal, estado y condición de SUNAT (padron_reducido_ruc.zip) y
 * locales anexos (padron_reducido_local_anexo.zip) de los RUC del portal: empresas del padrón MTC, manuales y clientes de
 * ventas (store.listPortalRucs). Lee los zip en streaming (zip.ts) y se queda solo con esos RUC (unos miles de ~15 millones
 * de filas).
 *
 *  - Idempotente: sunat_padron se reemplaza por RUC y los locales de cada RUC del portal se reemplazan enteros. Un archivo
 *    más nuevo actualiza sin duplicar; un RUC que ya no está en el padrón queda con encontrado = false.
 *  - Nunca toca companies: la dirección de operación escrita por el vendedor (companies.direccion) manda y no se pisa; la
 *    razón social del portal tampoco (la de SUNAT se guarda aparte solo si difiere mucho).
 *  - Fecha ("según SUNAT al …"): la de la entrada del zip del padrón principal en hora de Lima, que es cuando SUNAT generó
 *    el archivo (padron_reducido_ruc.txt: 23/11/2026 02:59 de Lima = 07:59 UTC; `unzip -l` en una máquina con otra zona
 *    la muestra como 22/11 23:59). No la del archivo descargado (que dice cuándo se bajó, no de cuándo son los datos).
 *    `fecha` la reemplaza si hace falta. Los locales llevan la fecha de su propio zip (23/11/2026 03:01).
 *  - Match Venta y las listas leen lo de SUNAT en vivo (join por RUC): no hace falta recalcular nada después.
 */
import { companyNameKey } from "../store/shared";
import type { IsoDate, PortalStore, SunatLocalInput, SunatRecordInput } from "../store/types";
import { jaroWinkler } from "../voice/fuzzy";
import { buildAddress, emptyPiezas } from "./address";
import { ANEXO_HEADERS, anexoRow, padronRow, readPadron, RUC_HEADERS, type AnexoRow, type PadronRow } from "./parse";
import { foldPlace, lookupUbigeo } from "./ubigeo";
import { openPadronLines } from "./zip";

export interface SunatImportSummary {
  fecha: IsoDate;
  fechaAnexos: IsoDate | null;
  /** RUC del portal buscados (por fuente). */
  rucs: number;
  porFuente: Record<string, number>;
  /** Filas leídas de cada archivo (sin el encabezado). */
  filas: number;
  filasAnexos: number;
  encontradas: number;
  noEncontradas: number;
  /** Encontradas con dirección armada (las personas naturales vienen con todo en "-"). */
  conDireccion: number;
  conAnexos: number;
  anexos: number;
  /** De las encontradas: estado / condición -> cuántas. */
  estados: Record<string, number>;
  condiciones: Record<string, number>;
  /** Códigos de ubigeo de RUC del portal que no están en la tabla (domicilio o anexo) -> cuántas filas. */
  ubigeosSinTabla: Record<string, number>;
  /** Razón social de SUNAT guardada aparte (difiere mucho de la del portal). */
  razonDistinta: number;
  inserted: number;
  updated: number;
  localesBorrados: number;
  ms: number;
  /** Memoria residente máxima vista (MB). */
  rssMaxMb: number;
  heapMaxMb: number;
}

/** Formas societarias y palabras que no distinguen una razón social de otra. */
const LEGAL = /\b(?:s\.?\s?a\.?\s?c\.?|s\.?\s?a\.?\s?a\.?|s\.?\s?r\.?\s?l\.?|e\.?\s?i\.?\s?r\.?\s?l\.?|s\.?\s?a\.?|s\.?\s?c\.?\s?r\.?\s?l\.?|sociedad an[oó]nima(?: cerrada| abierta)?|sociedad comercial de responsabilidad limitada|empresa individual de responsabilidad limitada|en liquidaci[oó]n|y\/o|cia|compa[nñ][ií]a)\b/gi;

function nameKey(s: string): string {
  return companyNameKey(s.replace(LEGAL, " "));
}

const words = (s: string) =>
  s
    .replace(LEGAL, " ")
    .split(/[^\p{L}\d]+/u)
    .map((w) => companyNameKey(w))
    .filter((w) => w && !["y", "e", "de", "del", "la", "las", "los", "el"].includes(w));

/**
 * ¿La razón social de SUNAT difiere mucho de la del portal? No difiere si, sin forma societaria, signos ni mayúsculas,
 * es igual o una contiene a la otra, son las mismas palabras en otro orden (personas naturales: el MTC pone el nombre
 * primero y SUNAT el apellido) o cada palabra de la más corta es abreviatura de una de la otra ("EXP TRANSP STA CLARA" =
 * "EXPRESO TRANSPORTES SANTA CLARA"; "STA" por "SANTA": mismas letras iniciales y en orden).
 */
export function razonDifiere(portal: string | null | undefined, sunat: string | null | undefined): boolean {
  if (!sunat) return false;
  const a = nameKey(portal ?? "");
  const b = nameKey(sunat);
  if (!a) return true;
  if (!b || a === b || a.includes(b) || b.includes(a)) return false;
  const wa = words(portal ?? "");
  const wb = words(sunat);
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const abbrev = (x: string, y: string) => x[0] === y[0] && [...x].every(((i) => (ch: string) => (i = y.indexOf(ch, i) + 1) > 0)(0));
  const pool = [...long];
  let hit = 0;
  for (const w of short) {
    const k = pool.findIndex((x) => x === w || abbrev(w, x) || abbrev(x, w));
    if (k >= 0) {
      hit++;
      pool.splice(k, 1);
    }
  }
  if (short.length && hit / short.length >= 0.85 && short.length / long.length >= 0.6) return false;
  return jaroWinkler(a, b) < 0.9;
}

function placeOf(ubigeo: string | null): { departamento: string | null; provincia: string | null; distrito: string | null } {
  const u = lookupUbigeo(ubigeo);
  return u ? { departamento: foldPlace(u.departamento), provincia: foldPlace(u.provincia), distrito: foldPlace(u.distrito) } : { departamento: null, provincia: null, distrito: null };
}

export interface SunatImportOptions {
  store: PortalStore;
  /** Padrón principal (.zip o .txt). */
  archivo: string;
  /** Locales anexos (.zip o .txt); null = no se importan (los que había se conservan). */
  anexos: string | null;
  /** Reemplaza la fecha del archivo ("AAAA-MM-DD"). */
  fecha?: IsoDate;
  log?: (m: string) => void;
}

export async function importSunat(opts: SunatImportOptions): Promise<SunatImportSummary> {
  const t0 = Date.now();
  const log = opts.log ?? (() => undefined);
  let rssMax = 0;
  let heapMax = 0;
  const sample = () => {
    const m = process.memoryUsage();
    rssMax = Math.max(rssMax, m.rss);
    heapMax = Math.max(heapMax, m.heapUsed);
  };
  sample();
  const portal = await opts.store.listPortalRucs();
  const byRuc = new Map(portal.map((p) => [p.ruc, p]));
  const rucs = new Set(byRuc.keys());
  const porFuente: Record<string, number> = {};
  for (const p of portal) porFuente[p.fuente] = (porFuente[p.fuente] ?? 0) + 1;
  log(`RUC del portal: ${rucs.size.toLocaleString("es-PE")} (${Object.entries(porFuente).map(([k, n]) => `${k} ${n.toLocaleString("es-PE")}`).join(", ")})`);

  // 1. padrón principal
  const main = openPadronLines(opts.archivo);
  const fecha = opts.fecha ?? main.modified.slice(0, 10);
  log(`Padrón: ${main.entryName} (generado ${main.modified.replace("T", " ")} hora de Lima; datos "según SUNAT al ${fecha.split("-").reverse().join("/")}")`);
  const found = new Map<string, PadronRow>();
  let filas = 0;
  for await (const r of readPadron(main.lines, {
    required: RUC_HEADERS,
    file: opts.archivo,
    rucs,
    row: padronRow,
    onLine: (n) => {
      filas = n;
      sample();
      if (n % 5_000_000 === 0) log(`  ${n.toLocaleString("es-PE")} filas leídas (${found.size.toLocaleString("es-PE")} del portal, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    },
  })) {
    found.set(r.ruc, r);
  }
  sample();
  log(`Padrón leído: ${filas.toLocaleString("es-PE")} filas, ${found.size.toLocaleString("es-PE")} RUC del portal en ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // 2. locales anexos
  const locales = new Map<string, AnexoRow[]>();
  let filasAnexos = 0;
  let fechaAnexos: IsoDate | null = null;
  if (opts.anexos) {
    const ax = openPadronLines(opts.anexos);
    fechaAnexos = opts.fecha ?? ax.modified.slice(0, 10);
    for await (const r of readPadron(ax.lines, {
      required: ANEXO_HEADERS,
      file: opts.anexos,
      rucs,
      row: anexoRow,
      onLine: (n) => {
        filasAnexos = n;
        sample();
      },
    })) {
      if (emptyPiezas(r.piezas) && !r.ubigeo) continue;
      const list = locales.get(r.ruc);
      if (list) list.push(r);
      else locales.set(r.ruc, [r]);
    }
    sample();
    log(`Locales anexos leídos: ${filasAnexos.toLocaleString("es-PE")} filas, ${[...locales.values()].reduce((n, l) => n + l.length, 0).toLocaleString("es-PE")} de ${locales.size.toLocaleString("es-PE")} RUC del portal`);
  }

  // 3. registros
  const estados: Record<string, number> = {};
  const condiciones: Record<string, number> = {};
  const sinTabla: Record<string, number> = {};
  const records: SunatRecordInput[] = [];
  const localRows: SunatLocalInput[] = [];
  let conDireccion = 0;
  let razonDistinta = 0;
  for (const ruc of rucs) {
    const r = found.get(ruc);
    const ax = locales.get(ruc) ?? [];
    for (const a of ax) {
      if (a.ubigeo && !lookupUbigeo(a.ubigeo)) sinTabla[a.ubigeo] = (sinTabla[a.ubigeo] ?? 0) + 1;
      localRows.push({ ruc, ubigeo: a.ubigeo, ...placeOf(a.ubigeo), direccion: buildAddress(a.piezas, a.ubigeo), piezas: a.piezas, fecha: fechaAnexos ?? fecha });
    }
    if (!r) {
      records.push({ ruc, encontrado: false, razonSocial: null, estado: null, condicion: null, ubigeo: null, departamento: null, provincia: null, distrito: null, direccion: null, piezas: null, anexos: ax.length, fecha });
      continue;
    }
    if (r.estado) estados[r.estado] = (estados[r.estado] ?? 0) + 1;
    if (r.condicion) condiciones[r.condicion] = (condiciones[r.condicion] ?? 0) + 1;
    if (r.ubigeo && !lookupUbigeo(r.ubigeo)) sinTabla[r.ubigeo] = (sinTabla[r.ubigeo] ?? 0) + 1;
    const direccion = buildAddress(r.piezas, r.ubigeo);
    if (direccion) conDireccion++;
    const distinta = razonDifiere(byRuc.get(ruc)?.razonSocial, r.razonSocial);
    if (distinta) razonDistinta++;
    records.push({
      ruc,
      encontrado: true,
      razonSocial: distinta ? r.razonSocial : null,
      estado: r.estado,
      condicion: r.condicion,
      ubigeo: r.ubigeo,
      ...placeOf(r.ubigeo),
      direccion,
      piezas: emptyPiezas(r.piezas) ? null : r.piezas,
      anexos: ax.length,
      fecha,
    });
  }

  // 4. guardar
  const up = await opts.store.upsertSunat(records);
  const loc = opts.anexos ? await opts.store.replaceSunatLocales([...rucs], localRows) : { removed: 0, inserted: 0 };
  sample();
  return {
    fecha,
    fechaAnexos,
    rucs: rucs.size,
    porFuente,
    filas,
    filasAnexos,
    encontradas: found.size,
    noEncontradas: rucs.size - found.size,
    conDireccion,
    conAnexos: [...locales.values()].filter((l) => l.length).length,
    anexos: localRows.length,
    estados,
    condiciones,
    ubigeosSinTabla: sinTabla,
    razonDistinta,
    inserted: up.inserted,
    updated: up.updated,
    localesBorrados: loc.removed,
    ms: Date.now() - t0,
    rssMaxMb: Math.round(rssMax / 1048576),
    heapMaxMb: Math.round(heapMax / 1048576),
  };
}

const sorted = (o: Record<string, number>) =>
  Object.entries(o)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${n.toLocaleString("es-PE")}`)
    .join(" · ");

export function formatSunatSummary(s: SunatImportSummary): string {
  const f = (n: number) => n.toLocaleString("es-PE");
  return [
    `Según SUNAT al ${s.fecha.split("-").reverse().join("/")}${s.fechaAnexos && s.fechaAnexos !== s.fecha ? ` (locales anexos al ${s.fechaAnexos.split("-").reverse().join("/")})` : ""}.`,
    `RUC del portal: ${f(s.rucs)}. En el padrón de SUNAT: ${f(s.encontradas)}; no aparecen: ${f(s.noEncontradas)}.`,
    `Con dirección armada: ${f(s.conDireccion)}. Con locales anexos: ${f(s.conAnexos)} (${f(s.anexos)} locales).`,
    `Estado: ${sorted(s.estados) || "—"}`,
    `Condición: ${sorted(s.condiciones) || "—"}`,
    `Ubigeos sin correspondencia en la tabla: ${sorted(s.ubigeosSinTabla) || "ninguno"}`,
    `Razón social de SUNAT distinta (guardada aparte): ${f(s.razonDistinta)}.`,
    `Guardado: ${f(s.inserted)} nuevas, ${f(s.updated)} actualizadas; locales reemplazados (${f(s.localesBorrados)} anteriores borrados).`,
    `Filas leídas: ${f(s.filas)} del padrón, ${f(s.filasAnexos)} de anexos. Tiempo ${(s.ms / 1000).toFixed(1)} s; memoria máxima ${s.rssMaxMb} MB (heap ${s.heapMaxMb} MB).`,
  ].join("\n");
}
