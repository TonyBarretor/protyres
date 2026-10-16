/**
 * File names of the documents sent with a quote. The PDF is named after the quote number ("OCTUBRE 2026 - 451.pdf",
 * spaces kept) unless the salesman chose another name ("archivo: …"); the customer's Excel format has its own pattern.
 */
import type { Settings } from "../settings";
import { quoteSerial } from "./build";
import type { Quote } from "./types";

export const PDF_MIME = "application/pdf";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Only the characters file systems / mail clients reject (/ \ : * ? " < > |, control chars) become "-"; spaces stay. */
export function cleanFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** "name" + ext, without doubling an extension the salesman already typed ("Cotización.pdf"). */
export function withExtension(name: string, ext: string): string {
  const base = cleanFileName(name).replace(new RegExp(`\\${ext}$`, "i"), "").trim();
  return `${base || "cotizacion"}${ext}`;
}

const MONTHS_ES = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase());

/**
 * A file name from a pattern and the quote: {N} serial · {NNN} / {NNNN} zero-padded · {YY} / {YYYY} · {MES} / {Mes} ·
 * {NUMERO} the whole quote number · {CLIENTE} · {UNIDAD} / {Unidad} (upper / title case) · {UB} the UBs ("1830", "1829 y 2013") ·
 * {DDMMYY} · {PROVEEDOR} (passed in). A token with no value disappears along with a dangling " - UB" / "-" next to it.
 */
export function fileNameFromPattern(pattern: string, quote: Pick<Quote, "number" | "date" | "unit" | "ub" | "items" | "customer">, settings: Settings, extra: Record<string, string> = {}): string {
  const serial = quoteSerial(quote.number, settings.quote.numberFormat);
  const [y, m, d] = quote.date.split("-");
  const month = MONTHS_ES[parseInt(m, 10) - 1] ?? m;
  const ubs = [...new Set([quote.ub, ...quote.items.map((i) => i.ub)].filter((u): u is string => !!u))];
  const tokens: Record<string, string> = {
    N: serial !== undefined ? String(serial) : "",
    NNN: serial !== undefined ? String(serial).padStart(3, "0") : "",
    NNNN: serial !== undefined ? String(serial).padStart(4, "0") : "",
    YY: y.slice(2),
    YYYY: y,
    MES: month,
    Mes: month[0] + month.slice(1).toLowerCase(),
    DDMMYY: `${d}${m}${y.slice(2)}`,
    NUMERO: quote.number,
    CLIENTE: quote.customer.company ?? quote.customer.name ?? "",
    UNIDAD: (quote.unit ?? "").toUpperCase(),
    Unidad: titleCase(quote.unit ?? ""),
    UB: ubs.length <= 1 ? (ubs[0] ?? "") : `${ubs.slice(0, -1).join(", ")} y ${ubs[ubs.length - 1]}`,
    ...extra,
  };
  let name = pattern.replace(/\{(\w+)\}/g, (all, k: string) => (k in tokens ? tokens[k] : all));
  name = name
    .replace(/\s*-\s*UBs?\s*$/i, "") // "… - UB" with no UB
    .replace(/\s*-\s*UBs?\s*(?=-)/i, " ") // "… - UB -…" in the middle
    .replace(/-{2,}/g, "-")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s-]+|[\s-]+$/g, "");
  return name || quote.number;
}

/** "Cotizacion 26 - 0456.pdf" (settings.quote.pdfFileName), or the name set with "archivo: …". */
export function pdfFileName(quote: Pick<Quote, "number" | "date" | "unit" | "ub" | "items" | "customer" | "files">, settings: Settings): string {
  return withExtension(quote.files?.pdfName || fileNameFromPattern(settings.quote.pdfFileName, quote, settings), ".pdf");
}
