/**
 * Quotes are not price lists. A file sent to the bot is refused for ingestion when it looks like a quote or a request:
 *   - our own quote format: a row with the headers ITEM + MEDIDA + MARCA (in a PDF: "ITEM MEDIDA MARCA" in a row)
 *   - Prosegur's "Formato Proveedores": "COTIZACIÓN PROVEEDORES", "Formato Proveedores" or "Nombre de Archivo:"
 *   - a document titled COTIZACIÓN (its first text) with "Cliente:" / "Atención:" boxes
 * A provider's own quotation addressed to us ("Cliente: PROFESSIONAL TYRES S.A.C.") is an offer of prices, so it is
 * not refused (Prosegur's format always is).
 */
import { fold } from "../tyre/brands";
import { pdfToText } from "./pdf";
import { isHtml, loadExcel, loadHtmlTable, type SheetData } from "./tabular";

export type QuoteDocumentKind = "own-quote" | "prosegur" | "quote";

export interface QuoteDetectOptions {
  /** Our company names / RUC (a quotation addressed to them is a provider's offer). */
  ownNames?: string[];
}

export const QUOTE_FILE_REFUSAL = "Esto parece una cotización, no una lista de precios, así que no la cargo. Escríbeme el pedido como texto (llantas con cantidad, cliente, correo…)";

const DEFAULT_OWN_NAMES = ["Professional Tyres", "360 Tyres", "20565716396"];
const PROSEGUR_MARKS = /\bcotizacion proveedores\b|\bformato proveedores\b|\bnombre de archivo\b/;
const ADDRESSEE_LABEL = /^(?:cliente|se[ñn]or(?:es)?|raz[oó]n social|empresa)\s*:/i;
const CLIENT_BOX = /^(?:cliente|atenci[oó]n|se[ñn]or(?:es)?)\s*:/i;

function ownKeys(opts: QuoteDetectOptions): string[] {
  return (opts.ownNames?.length ? opts.ownNames : DEFAULT_OWN_NAMES).map((n) => fold(n)).filter(Boolean);
}

function namesUs(text: string, own: string[]): boolean {
  const f = ` ${fold(text)} `;
  return own.some((o) => f.includes(` ${o} `));
}

/** Spreadsheet rule set (first 60 rows of every sheet). */
export function detectQuoteInSheets(sheets: SheetData[], opts: QuoteDetectOptions = {}): QuoteDocumentKind | null {
  const own = ownKeys(opts);
  let ownHeaders = false;
  let titled = false;
  let toUs = false;
  for (const sheet of sheets) {
    if (fold(sheet.name).includes("formato proveedores")) return "prosegur";
    let first: string | undefined;
    let clientBox = false;
    for (const row of sheet.rows.slice(0, 60)) {
      const cells = row.map((c) => (c ?? "").trim());
      const folded = cells.map((c) => fold(c));
      if (folded.some((c) => PROSEGUR_MARKS.test(c))) return "prosegur";
      if (first === undefined) first = cells.find(Boolean);
      if (["item", "medida", "marca"].every((h) => folded.includes(h))) ownHeaders = true;
      cells.forEach((c, i) => {
        if (CLIENT_BOX.test(c)) clientBox = true;
        // "Cliente: | PROFESSIONAL TYRES S.A.C." (same cell after the colon, or the next cells of the row)
        if (ADDRESSEE_LABEL.test(c) && namesUs([c.replace(/^[^:]*:/, ""), ...cells.slice(i + 1, i + 4)].join(" "), own)) toUs = true;
      });
    }
    if (first && /^cotizaci[oó]n\b/i.test(first) && clientBox) titled = true;
  }
  if (toUs) return null;
  if (ownHeaders) return "own-quote";
  return titled ? "quote" : null;
}

/** PDF rule set, on the extracted text. */
export function detectQuoteInText(text: string, opts: QuoteDetectOptions = {}): QuoteDocumentKind | null {
  const f = fold(text);
  if (PROSEGUR_MARKS.test(f)) return "prosegur";
  const own = ownKeys(opts);
  for (const m of text.matchAll(/\b(?:Cliente|Se[ñn]or(?:es)?|Raz[oó]n social|Empresa)\s*:\s*([^\n]{0,80})/gi)) if (namesUs(m[1], own)) return null;
  if (/\bitem\s+medida\s+marca\b/.test(f)) return "own-quote";
  if (/^\s*COTIZACI[OÓ]N\b/i.test(text) && /\b(?:Cliente|Atenci[oó]n)\s*:/i.test(text)) return "quote";
  return null;
}

/** An .xlsx / .xls (also HTML exports) or PDF file: is it a quote? null for anything else or unreadable files. */
export async function detectQuoteDocument(data: Buffer, opts: QuoteDetectOptions & { fileName?: string; mimeType?: string } = {}): Promise<QuoteDocumentKind | null> {
  const name = opts.fileName ?? "";
  const mt = (opts.mimeType ?? "").toLowerCase();
  try {
    if (mt.includes("pdf") || /\.pdf$/i.test(name)) return detectQuoteInText((await pdfToText(data)).text, opts);
    if (mt.includes("spreadsheet") || mt.includes("excel") || mt.includes("html") || /\.xlsx?$/i.test(name)) {
      const sheets = isHtml(data) ? loadHtmlTable(data.toString("utf8"), name || "html") : await loadExcel(data);
      return detectQuoteInSheets(sheets, opts);
    }
  } catch {
    return null; // unreadable here: the ingestion reports its own error
  }
  return null;
}
