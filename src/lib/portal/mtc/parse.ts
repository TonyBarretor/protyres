/**
 * MTC padrón (registro de vehículos habilitados) parser.
 *
 * Three CSV layouts from datos abiertos MTC, recognised by header:
 *  - carga 2025 ("Carga Nacional_25.csv"): dd/mm/aaaa dates, decimal comma, N_LLANTAS = "ND".
 *  - carga 2022–2024 ("Carga Nacional_22-24.csv"): same columns, AAAAMMDD dates, decimal point, real N_LLANTAS.
 *  - pasajeros 2022–2025 ("Parque_Habilitado_Terrestre_Pasajeros_2022-2025.csv"): different columns, some with
 *    spaces in the name ("ANIO_ FABR", "N_ EJES"), N_LLANTAS present.
 *
 * Common facts: ";" separator, Latin-1 (with a few lines that are actually UTF-8 → repaired per line), CRLF,
 * "ND"/"-"/empty → null, FECHA_CORTE = AAAAMMDD. Some razón social values contain "&AMP;" (an HTML entity whose ";"
 * splits the field): we turn it into "&" before splitting, so those rows are recovered instead of shifted.
 * Rows that still have the wrong number of columns, or whose FECHA_CORTE is not AAAAMMDD, are discarded and counted.
 *
 * Units: `pesoBruto` is always **kg** (integer). Carga publishes P_BRUTO in kg (30000) and pasajeros in tonnes (9.4);
 * a few rows of each file use the other unit, so the rule is per value: raw < 100 → tonnes (× 1000), otherwise kg.
 * No real vehicle weighs < 100 kg nor ≥ 100 t, so the rule is unambiguous; 0/negative → null.
 * Counts: llantas outside 1..40 and ejes outside 1..12 are garbage (Excel date serials like 43544 appear) → null.
 */
import fs from "node:fs";
import readline from "node:readline";

export type MtcOrigin = "carga" | "pasajeros";

export interface MtcVehicle {
  origen: MtcOrigin;
  ruc: string;
  razonSocial: string;
  placa: string;
  marca: string | null;
  /** Normalised: uppercase, no accents, canonical spelling (see normalizeClase). */
  clase: string | null;
  anio: number | null;
  ejes: number | null;
  llantas: number | null;
  /** Gross vehicle weight in kg (see header note). */
  pesoBruto: number | null;
  chasis: string | null;
  departamento: string | null;
  /** Only in pasajeros. */
  provincia: string | null;
  /** Only in pasajeros (corrida K). */
  distrito: string | null;
  /** Permit valid until, AAAAMMDD (null if the field is not a date, e.g. "DS. 009-2004-MTC"). */
  vigenciaHasta: string | null;
  /** AAAAMMDD. */
  fechaCorte: string;
}

export type DiscardReason = "columnas" | "fecha_corte" | "ruc" | "placa";

export interface ParseStats {
  /** Data lines read (header and blank lines excluded). */
  leidas: number;
  validas: number;
  descartadas: Record<DiscardReason, number>;
  /** Valid rows per FECHA_CORTE. */
  porCorte: Record<string, number>;
}

export function newStats(): ParseStats {
  return { leidas: 0, validas: 0, descartadas: { columnas: 0, fecha_corte: 0, ruc: 0, placa: 0 }, porCorte: {} };
}

export interface MtcHeader {
  format: MtcOrigin;
  /** Column count expected on every row. */
  width: number;
  /** Normalised column name (no spaces, uppercase) → index. */
  cols: Map<string, number>;
}

export type RowResult = { ok: true; vehicle: MtcVehicle } | { ok: false; reason: DiscardReason };

const CARGA_REQUIRED = ["RUC", "RAZON_SOCIAL", "PLACA", "ANIO_FAB", "N_CHASIS", "MARCA", "CLASE", "N_LLANTAS", "N_EJES", "P_BRUTO", "DEPARTAMENTO", "FECHA_CORTE"];
const PASAJEROS_REQUIRED = ["RUC", "RAZON_SOCIAL", "PLACA", "ANIO_FABR", "N_CHASIS", "MARCA", "CLASE", "N_LLANTAS", "N_EJES", "P_BRUTO", "DEPARTAMENTO", "PROVINCIA", "FECHA_CORTE"];

/** Recognise the layout from the header line. Throws on an unknown header. */
export function parseHeader(line: string): MtcHeader {
  const names = stripEol(line).replace(/^﻿/, "").split(";").map((h) => h.replace(/\s+/g, "").toUpperCase());
  const cols = new Map<string, number>();
  names.forEach((n, i) => cols.set(n, i));
  let format: MtcOrigin;
  if (cols.has("PERMISO_OPER") && cols.has("ANIO_FAB")) format = "carga";
  else if (cols.has("AMB_OPERA") || cols.has("ANIO_FABR")) format = "pasajeros";
  else throw new Error(`Cabecera MTC no reconocida: ${line.slice(0, 120)}`);
  const missing = (format === "carga" ? CARGA_REQUIRED : PASAJEROS_REQUIRED).filter((c) => !cols.has(c));
  if (missing.length) throw new Error(`Cabecera MTC (${format}) sin columnas: ${missing.join(", ")}`);
  return { format, width: names.length, cols };
}

function stripEol(line: string): string {
  return line.replace(/\r?\n$/, "").replace(/\r$/, "");
}

/** Mixed-encoding files: a line that is really UTF-8 shows up as "Ã‘" etc. when read as Latin-1 → re-decode it. */
export function repairMojibake(line: string): string {
  if (!/[ÂÃ][\u0080-¿]/.test(line)) return line;
  const utf8 = Buffer.from(line, "latin1").toString("utf8");
  return utf8.includes("�") ? line : utf8;
}

/** Split one line on ";" honouring double quotes ("a;b" and "" escapes). "&AMP;" is turned into "&" first. */
export function splitLine(line: string): string[] {
  const s = stripEol(line).replace(/&AMP;/gi, "&");
  const out: string[] = [];
  let i = 0;
  const n = s.length;
  while (i <= n) {
    if (s[i] === '"') {
      let val = "";
      i++;
      for (;;) {
        if (i >= n) break;
        if (s[i] === '"') {
          if (s[i + 1] === '"') {
            val += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        val += s[i++];
      }
      // Anything after the closing quote up to the separator is kept verbatim (malformed but harmless).
      const next = s.indexOf(";", i);
      const end = next === -1 ? n : next;
      val += s.slice(i, end);
      out.push(val);
      i = end + 1;
    } else {
      const next = s.indexOf(";", i);
      const end = next === -1 ? n : next;
      out.push(s.slice(i, end));
      i = end + 1;
    }
  }
  return out;
}

const NULLS = new Set(["", "ND", "N/D", "-", "--", "NULL", "S/N"]);

function clean(v: string | undefined): string | null {
  if (v == null) return null;
  const t = v.replace(/\s+/g, " ").trim();
  return NULLS.has(t.toUpperCase()) ? null : t;
}

export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Uppercase, no accents, single spaces; null for ND/empty. */
export function normalizeText(v: string | null | undefined): string | null {
  const c = clean(v ?? undefined);
  return c == null ? null : stripAccents(c).toUpperCase();
}

const CLASE_ALIASES: Record<string, string> = {
  SEMIREMOLQUE: "SEMIRREMOLQUE",
  "SEMI REMOLQUE": "SEMIRREMOLQUE",
  "STAT. WAGON": "STATION WAGON",
  "STAT WAGON": "STATION WAGON",
  "STATION WAGON": "STATION WAGON",
};

/** "Ómnibus" → "OMNIBUS", "SEMIREMOLQUE"/"Semirremolque" → "SEMIRREMOLQUE", "STAT. WAGON" → "STATION WAGON". */
export function normalizeClase(v: string | null | undefined): string | null {
  const t = normalizeText(v);
  if (t == null) return null;
  return CLASE_ALIASES[t] ?? t;
}

/** Number with decimal comma or point; null for ND/empty/garbage. */
export function parseNumber(v: string | null | undefined): number | null {
  const c = clean(v ?? undefined);
  if (c == null) return null;
  const n = Number(c.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Positive integer (ejes, llantas); 0, negatives and decimals → null. */
export function parsePositiveInt(v: string | null | undefined): number | null {
  const n = parseNumber(v);
  return n != null && Number.isInteger(n) && n > 0 ? n : null;
}

/** Plausible counts: N_LLANTAS of the 2023 cut sometimes holds an Excel date serial (43544…) → null. */
export const MAX_LLANTAS = 40;
export const MAX_EJES = 12;

function parseCount(v: string | undefined, max: number): number | null {
  const n = parsePositiveInt(v);
  return n != null && n <= max ? n : null;
}

function parseYear(v: string | undefined): number | null {
  const n = parsePositiveInt(v);
  return n != null && n >= 1900 && n <= 2100 ? n : null;
}

/** Gross weight → kg. Raw < 100 is taken as tonnes (pasajeros, and a few carga rows), otherwise kg. */
export function pesoToKg(v: string | null | undefined): number | null {
  const n = parseNumber(v);
  if (n == null || n <= 0) return null;
  return Math.round(n < 100 ? n * 1000 : n);
}

/** AAAAMMDD or dd/mm/aaaa → AAAAMMDD; anything else → null. */
export function parseDate(v: string | null | undefined): string | null {
  const c = clean(v ?? undefined);
  if (c == null) return null;
  if (/^\d{8}$/.test(c)) return c;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(c);
  return m ? `${m[3]}${m[2].padStart(2, "0")}${m[1].padStart(2, "0")}` : null;
}

function cleanRazonSocial(v: string | undefined): string {
  // Some names come wrapped in literal quotes ("""S.E.M. KER S.A.C.""" → "S.E.M. KER S.A.C.").
  return (clean(v) ?? "").replace(/^"+|"+$/g, "").trim();
}

/** Turn already-split fields into a vehicle, or a discard reason. */
export function parseRow(fields: string[], header: MtcHeader): RowResult {
  if (fields.length !== header.width) return { ok: false, reason: "columnas" };
  const get = (name: string) => {
    const i = header.cols.get(name);
    return i == null ? undefined : fields[i];
  };
  const fechaCorte = (get("FECHA_CORTE") ?? "").trim();
  if (!/^\d{8}$/.test(fechaCorte)) return { ok: false, reason: "fecha_corte" };
  const ruc = (get("RUC") ?? "").replace(/\D/g, "");
  if (ruc.length !== 11) return { ok: false, reason: "ruc" };
  const placa = (normalizeText(get("PLACA")) ?? "").replace(/[\s-]/g, "");
  if (!placa) return { ok: false, reason: "placa" };
  const carga = header.format === "carga";
  return {
    ok: true,
    vehicle: {
      origen: header.format,
      ruc,
      razonSocial: cleanRazonSocial(get("RAZON_SOCIAL")),
      placa,
      marca: normalizeText(get("MARCA")),
      clase: normalizeClase(get("CLASE")),
      anio: parseYear(get(carga ? "ANIO_FAB" : "ANIO_FABR")),
      ejes: parseCount(get("N_EJES"), MAX_EJES),
      llantas: parseCount(get("N_LLANTAS"), MAX_LLANTAS),
      pesoBruto: pesoToKg(get("P_BRUTO")),
      chasis: normalizeText(get("N_CHASIS")),
      departamento: normalizeText(get("DEPARTAMENTO")),
      provincia: carga ? null : normalizeText(get("PROVINCIA")),
      distrito: carga ? null : normalizeText(get("DISTRITO")),
      vigenciaHasta: parseDate(get("VIGENCIA_HASTA")),
      fechaCorte,
    },
  };
}

/** Parse one raw data line (Latin-1 decoded) — sync, for tests and for the streaming reader. */
export function parseLine(line: string, header: MtcHeader): RowResult {
  return parseRow(splitLine(repairMojibake(line)), header);
}

function count(stats: ParseStats, r: RowResult): void {
  stats.leidas++;
  if (r.ok) {
    stats.validas++;
    stats.porCorte[r.vehicle.fechaCorte] = (stats.porCorte[r.vehicle.fechaCorte] ?? 0) + 1;
  } else stats.descartadas[r.reason]++;
}

export interface ParseOptions {
  /** Keep only these FECHA_CORTE values (others are still counted as valid in stats, just not returned). */
  cuts?: string[];
}

/** Sync parse of a whole (small) file's text — for tests and fixtures. */
export function parseMtcText(text: string, opts: ParseOptions = {}): { header: MtcHeader; vehicles: MtcVehicle[]; stats: ParseStats } {
  const lines = text.split("\n");
  const header = parseHeader(lines[0] ?? "");
  const stats = newStats();
  const vehicles: MtcVehicle[] = [];
  const cuts = opts.cuts ? new Set(opts.cuts) : null;
  for (const line of lines.slice(1)) {
    if (!stripEol(line).trim()) continue;
    const r = parseLine(line, header);
    count(stats, r);
    if (r.ok && (!cuts || cuts.has(r.vehicle.fechaCorte))) vehicles.push(r.vehicle);
  }
  return { header, vehicles, stats };
}

/** Same as parseMtcText for a Latin-1 buffer. */
export function parseMtcBuffer(buf: Buffer, opts: ParseOptions = {}) {
  return parseMtcText(buf.toString("latin1"), opts);
}

/**
 * Stream a padrón file line by line (Latin-1). Yields the valid vehicles (optionally filtered by cut) and fills
 * `stats` as it goes. Memory stays flat regardless of file size.
 */
export async function* streamMtcFile(file: string, stats: ParseStats = newStats(), opts: ParseOptions = {}): AsyncGenerator<MtcVehicle> {
  const rl = readline.createInterface({ input: fs.createReadStream(/* turbopackIgnore: true */ file, { encoding: "latin1" }), crlfDelay: Infinity });
  const cuts = opts.cuts ? new Set(opts.cuts) : null;
  let header: MtcHeader | null = null;
  try {
    for await (const line of rl) {
      if (header == null) {
        header = parseHeader(line);
        continue;
      }
      if (!line.trim()) continue;
      const r = parseLine(line, header);
      count(stats, r);
      if (r.ok && (!cuts || cuts.has(r.vehicle.fechaCorte))) yield r.vehicle;
    }
  } finally {
    rl.close();
  }
}

/** Convenience: read the whole file into an array (streamed). */
export async function readMtcFile(file: string, opts: ParseOptions = {}): Promise<{ vehicles: MtcVehicle[]; stats: ParseStats }> {
  const stats = newStats();
  const vehicles: MtcVehicle[] = [];
  for await (const v of streamMtcFile(file, stats, opts)) vehicles.push(v);
  return { vehicles, stats };
}
