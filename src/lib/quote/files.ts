/**
 * File names of the documents sent with a quote. The PDF is named after the quote number ("OCTUBRE 2026 - 451.pdf",
 * spaces kept) unless the salesman chose another name ("archivo: …"); the customer's Excel format has its own pattern.
 */
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

/** "OCTUBRE 2026 - 451.pdf", or the name set with "archivo: …". */
export function pdfFileName(quote: Pick<Quote, "number" | "files">): string {
  return withExtension(quote.files?.pdfName || quote.number, ".pdf");
}
