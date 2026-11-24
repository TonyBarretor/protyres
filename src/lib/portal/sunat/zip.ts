/**
 * Corrida L — lee UNA entrada de un .zip en streaming, sin descomprimir a disco ni cargarla en memoria y sin dependencias:
 * el directorio central (al final del archivo) da el método, los tamaños, la fecha y dónde empieza el encabezado local; los
 * datos se leen con fs.createReadStream desde ahí y pasan por zlib.createInflateRaw() (deflate) o tal cual (stored).
 * No soporta zip64 (entradas o archivos de más de 4 GB: el padrón de SUNAT tiene 395 MB comprimido y 1,58 GB adentro) ni
 * cifrado: en ese caso falla con un mensaje claro.
 */
import fs from "node:fs";
import readline from "node:readline";
import type { Readable } from "node:stream";
import zlib from "node:zlib";

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  size: number;
  /**
   * Fecha y hora de la entrada en hora de Lima ("2026-11-23T02:59:40"): del campo extra UT (segundos UTC) si lo trae,
   * pasado a America/Lima; si no, la fecha DOS tal cual (hora local de quien armó el zip; SUNAT lo arma en hora de Lima).
   */
  modified: string;
  /** Inicio del encabezado local en el archivo. */
  localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = fs.readSync(fd, buf, off, len - off, pos + off);
    if (n === 0) break;
    off += n;
  }
  return off === len ? buf : buf.subarray(0, off);
}

/** Fecha y hora DOS -> "AAAA-MM-DDTHH:MM:SS". */
function dosDate(date: number, time: number): string {
  const y = 1980 + (date >> 9);
  const mo = (date >> 5) & 0xf;
  const d = date & 0x1f;
  const h = time >> 11;
  const mi = (time >> 5) & 0x3f;
  const s = (time & 0x1f) * 2;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}`;
}

/** Segundos UTC -> "AAAA-MM-DDTHH:MM:SS" en hora de Lima. */
function limaDateTime(secs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(secs * 1000));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}`;
}

/** mtime UTC del campo extra 0x5455 ("UT", extended timestamp), o null. */
function utMtime(extra: Buffer): number | null {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (id === 0x5455 && len >= 5 && extra[p + 4] & 1) return extra.readUInt32LE(p + 5);
    p += 4 + len;
  }
  return null;
}

/** Las entradas del zip (del directorio central). */
export function listZipEntries(file: string): ZipEntry[] {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error(`${file}: no es un .zip (no encuentro el fin del directorio central).`);
    const count = tail.readUInt16LE(eocd + 10);
    const cenSize = tail.readUInt32LE(eocd + 12);
    const cenOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cenSize === 0xffffffff || cenOffset === 0xffffffff) throw new Error(`${file}: es un zip64 (más de 4 GB o 65 535 entradas); no está soportado. Descomprímelo y pasa el .txt.`);
    const cen = readAt(fd, cenOffset, cenSize);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cen.length || cen.readUInt32LE(p) !== CEN_SIG) throw new Error(`${file}: directorio central dañado (entrada ${i + 1}).`);
      const flags = cen.readUInt16LE(p + 8);
      const method = cen.readUInt16LE(p + 10);
      const time = cen.readUInt16LE(p + 12);
      const date = cen.readUInt16LE(p + 14);
      const compressedSize = cen.readUInt32LE(p + 20);
      const usize = cen.readUInt32LE(p + 24);
      const nameLen = cen.readUInt16LE(p + 28);
      const extraLen = cen.readUInt16LE(p + 30);
      const commentLen = cen.readUInt16LE(p + 32);
      const localOffset = cen.readUInt32LE(p + 42);
      const name = cen.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
      if (compressedSize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) throw new Error(`${file}: la entrada ${name} es zip64 (más de 4 GB); no está soportada. Descomprímela y pasa el .txt.`);
      if (flags & 0x1) throw new Error(`${file}: la entrada ${name} está cifrada.`);
      const ut = utMtime(cen.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen));
      out.push({ name, method, compressedSize, size: usize, modified: ut !== null ? limaDateTime(ut) : dosDate(date, time), localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * La entrada `name` (o la única / la primera .txt si no se dice) como stream de bytes descomprimidos. El tamaño
 * descomprimido se comprueba al final (un zip truncado falla en vez de dar menos filas en silencio).
 */
export function openZipEntry(file: string, name?: string): { entry: ZipEntry; stream: Readable } {
  const entries = listZipEntries(file).filter((e) => !e.name.endsWith("/"));
  const entry = name ? entries.find((e) => e.name === name) : (entries.find((e) => /\.txt$/i.test(e.name)) ?? entries[0]);
  if (!entry) throw new Error(`${file}: ${name ? `no tiene la entrada ${name}` : "está vacío"}. Entradas: ${entries.map((e) => e.name).join(", ") || "(ninguna)"}.`);
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${file}: la entrada ${entry.name} usa un método de compresión no soportado (${entry.method}).`);
  const fd = fs.openSync(file, "r");
  let loc: Buffer;
  try {
    loc = readAt(fd, entry.localOffset, 30);
  } finally {
    fs.closeSync(fd);
  }
  if (loc.length < 30 || loc.readUInt32LE(0) !== LOC_SIG) throw new Error(`${file}: encabezado local dañado en ${entry.name}.`);
  const start = entry.localOffset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
  const raw = fs.createReadStream(file, { start, end: entry.compressedSize ? start + entry.compressedSize - 1 : start - 1, highWaterMark: 1 << 20 });
  if (entry.method === 0) return { entry, stream: raw };
  const inflate = zlib.createInflateRaw({ chunkSize: 1 << 20 });
  let total = 0;
  inflate.on("data", (b: Buffer) => {
    total += b.length;
  });
  inflate.on("end", () => {
    if (total !== entry.size) inflate.destroy(new Error(`${file}: ${entry.name} quedó incompleto (${total} de ${entry.size} bytes): el zip está truncado o dañado.`));
  });
  raw.on("error", (e) => inflate.destroy(e));
  return { entry, stream: raw.pipe(inflate) };
}

/** Líneas de texto Latin-1 de un stream (sin el salto de línea). */
export function latin1Lines(stream: Readable): AsyncIterable<string> {
  stream.setEncoding("latin1");
  return readline.createInterface({ input: stream, crlfDelay: Infinity });
}

/** Líneas de un .zip (su entrada .txt) o de un .txt suelto, con la fecha de la entrada / del archivo (hora de Lima). */
export function openPadronLines(file: string): { lines: AsyncIterable<string>; modified: string; entryName: string } {
  if (/\.zip$/i.test(file)) {
    const { entry, stream } = openZipEntry(file);
    return { lines: latin1Lines(stream), modified: entry.modified, entryName: entry.name };
  }
  const st = fs.statSync(file);
  return { lines: latin1Lines(fs.createReadStream(file, { highWaterMark: 1 << 20 })), modified: limaDateTime(Math.floor(st.mtimeMs / 1000)), entryName: file };
}
