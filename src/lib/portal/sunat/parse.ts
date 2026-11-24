/**
 * Corrida L — lectura del "Padrón reducido del RUC" de SUNAT (padron_reducido_ruc.txt) y de sus locales anexos
 * (padron_reducido_local_anexo.txt). Formato comprobado con los archivos del 22-23/11/2026:
 *  - ISO-8859-1 (Latin-1), separador `|`, una fila de encabezados, cada línea termina con un `|` de más.
 *  - Vacíos como "-" (y a veces "----").
 *  - La barra invertida escapa el carácter siguiente: `\|` es un `|` dentro del campo ("EBEN EZER \| INGENIERIA…", 5
 *    filas de empresas) y `\\` una barra ("S\\N" = sin número, 26 filas).
 *  - El de anexos empieza con un espacio antes de "RUC" y su orden de columnas es distinto: se lee por NOMBRE de encabezado
 *    (sin tildes ni mayúsculas) y, si falta alguno, se falla con un mensaje que dice cuál.
 *  - En las filas "CÓDIGO DE ZONA" trae el tipo ("URB.", "A.H.") y "TIPO DE ZONA" el nombre: ver SunatPiezas.
 */
import type { SunatPiezas } from "./address";

/** Encabezado plegado: sin tildes, mayúsculas, espacios simples ("CÓDIGO DE ZONA" -> "CODIGO DE ZONA"). */
export function foldHeader(s: string): string {
  return s
    .replace(/^﻿/, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Parte una línea por `|` respetando `\|` y `\\`; descarta el campo vacío que deja el `|` final. */
export function splitPadronLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i];
    } else if (ch === "|") {
      out.push(cur);
      cur = "";
    } else if (ch !== "\r") {
      cur += ch;
    }
  }
  out.push(cur);
  if (out.length > 1 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

/** "-", "----", "" -> null; si no, sin espacios de más (y sin un `|` suelto, que no sirve en una dirección). */
export function padronValue(v: string | undefined): string | null {
  const t = (v ?? "").replace(/\|/g, " ").replace(/\s+/g, " ").trim();
  return !t || /^-+$/.test(t) ? null : t;
}

const PIEZAS: Record<keyof SunatPiezas, string> = {
  tipoVia: "TIPO DE VIA",
  nombreVia: "NOMBRE DE VIA",
  tipoZona: "CODIGO DE ZONA",
  nombreZona: "TIPO DE ZONA",
  numero: "NUMERO",
  interior: "INTERIOR",
  lote: "LOTE",
  dpto: "DEPARTAMENTO",
  manzana: "MANZANA",
  kilometro: "KILOMETRO",
};

export const RUC_HEADERS = ["RUC", "NOMBRE O RAZON SOCIAL", "ESTADO DEL CONTRIBUYENTE", "CONDICION DE DOMICILIO", "UBIGEO", ...Object.values(PIEZAS)];
export const ANEXO_HEADERS = ["RUC", "UBIGEO", ...Object.values(PIEZAS)];

export type ColumnIndex = Map<string, number>;

/** Índice de columnas por nombre; lanza si falta alguna de `required` (SUNAT cambió el formato). */
export function headerIndex(line: string, required: string[], file: string): ColumnIndex {
  const cols = splitPadronLine(line).map(foldHeader);
  const idx: ColumnIndex = new Map();
  cols.forEach((c, i) => {
    if (c && !idx.has(c)) idx.set(c, i);
  });
  const missing = required.filter((r) => !idx.has(r));
  if (missing.length) {
    throw new Error(
      `${file}: el encabezado no es el esperado del padrón reducido de SUNAT (faltan: ${missing.join(", ")}). Columnas leídas: ${cols.filter(Boolean).join(" | ") || "(ninguna)"}. ` +
        "Si SUNAT cambió el formato, revisa src/lib/portal/sunat/parse.ts.",
    );
  }
  return idx;
}

function piezasOf(f: string[], idx: ColumnIndex): SunatPiezas {
  const get = (h: string) => padronValue(f[idx.get(h)!]);
  return {
    tipoVia: get(PIEZAS.tipoVia),
    nombreVia: get(PIEZAS.nombreVia),
    tipoZona: get(PIEZAS.tipoZona),
    nombreZona: get(PIEZAS.nombreZona),
    numero: get(PIEZAS.numero),
    interior: get(PIEZAS.interior),
    lote: get(PIEZAS.lote),
    dpto: get(PIEZAS.dpto),
    manzana: get(PIEZAS.manzana),
    kilometro: get(PIEZAS.kilometro),
  };
}

export interface PadronRow {
  ruc: string;
  razonSocial: string | null;
  estado: string | null;
  condicion: string | null;
  ubigeo: string | null;
  piezas: SunatPiezas;
}

export interface AnexoRow {
  ruc: string;
  ubigeo: string | null;
  piezas: SunatPiezas;
}

const ubigeoOf = (v: string | undefined): string | null => {
  const t = padronValue(v);
  return t && /^\d{6}$/.test(t) ? t : null;
};

/** Una fila del principal (ya partida); null si el RUC no son 11 dígitos. */
export function padronRow(f: string[], idx: ColumnIndex): PadronRow | null {
  const ruc = (f[idx.get("RUC")!] ?? "").trim();
  if (!/^\d{11}$/.test(ruc)) return null;
  return {
    ruc,
    razonSocial: padronValue(f[idx.get("NOMBRE O RAZON SOCIAL")!]),
    estado: padronValue(f[idx.get("ESTADO DEL CONTRIBUYENTE")!]),
    condicion: padronValue(f[idx.get("CONDICION DE DOMICILIO")!]),
    ubigeo: ubigeoOf(f[idx.get("UBIGEO")!]),
    piezas: piezasOf(f, idx),
  };
}

/** Una fila de anexos (ya partida); null si el RUC no son 11 dígitos. */
export function anexoRow(f: string[], idx: ColumnIndex): AnexoRow | null {
  const ruc = (f[idx.get("RUC")!] ?? "").trim();
  if (!/^\d{11}$/.test(ruc)) return null;
  return { ruc, ubigeo: ubigeoOf(f[idx.get("UBIGEO")!]), piezas: piezasOf(f, idx) };
}

/**
 * Recorre las líneas (Latin-1 ya decodificado) y entrega solo las filas de `rucs` (todas si no se pasa). El RUC se mira
 * antes de partir la línea: el archivo tiene ~15 millones de filas y el portal unos miles de RUC.
 */
export async function* readPadron<T>(
  lines: AsyncIterable<string>,
  opts: { required: string[]; file: string; rucs?: Set<string>; row: (f: string[], idx: ColumnIndex) => T | null; onLine?: (n: number) => void },
): AsyncGenerator<T> {
  let idx: ColumnIndex | null = null;
  let n = 0;
  for await (const raw of lines) {
    if (idx === null) {
      if (!raw.trim()) continue;
      idx = headerIndex(raw, opts.required, opts.file);
      continue;
    }
    n++;
    if (opts.onLine && n % 1_000_000 === 0) opts.onLine(n);
    if (opts.rucs) {
      const head = raw.trimStart().slice(0, 11);
      if (!opts.rucs.has(head)) continue;
    }
    const r = opts.row(splitPadronLine(raw), idx);
    if (r) yield r;
  }
  if (idx === null) throw new Error(`${opts.file}: está vacío (no tiene ni el encabezado).`);
  opts.onLine?.(n);
}
