import { extractText, getDocumentProxy } from "unpdf";
import type { IngestOptions, IngestResult } from "./types";
import { parsePriceLines } from "./lines";
import { dedupeRows } from "./tabular";
import { detectPdfLayout, parseOdooStockText, parseOwnListText, type PdfLayout } from "./protyres-pdf";
import { extractPricesWithLLM, llmAvailable } from "../llm/extract-prices";

export async function pdfToText(buffer: Buffer): Promise<{ text: string; pages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  return { text: (text as string) ?? "", pages: totalPages };
}

export interface PdfIngestOptions extends IngestOptions {
  /** "auto" (LLM when available), "llm", or "heuristic". */
  method?: "auto" | "llm" | "heuristic";
  /** Force a known layout instead of detecting it. */
  layout?: PdfLayout;
}

/**
 * PDF price list -> rows.
 *  - Known client layouts (own price list, Odoo stock export) are parsed with dedicated readers.
 *  - Other text PDFs: line heuristics (or the LLM on the extracted text when available).
 *  - Scanned PDFs (no text layer): the LLM reading the PDF itself; otherwise a warning.
 */
export async function ingestPdf(buffer: Buffer, opts: PdfIngestOptions): Promise<IngestResult> {
  const warnings: string[] = [];
  const { text, pages } = await pdfToText(buffer);
  const hasText = text.replace(/\s+/g, "").length > 50;
  const layout = opts.layout ?? (hasText ? detectPdfLayout(text) : "generic");
  if (layout === "own-list") return parseOwnListText(text, { ...opts, kind: "own" });
  if (layout === "odoo-stock") return parseOdooStockText(text, { ...opts, kind: "stock" });

  const method = opts.method ?? "auto";
  const useLlm = method === "llm" || (method === "auto" && llmAvailable());

  if (useLlm) {
    const res = await extractPricesWithLLM(hasText ? { text } : { pdf: buffer }, { ...opts, source: "pdf" });
    if (res.rows.length > 0 || !hasText) {
      return {
        rows: dedupeRows(res.rows),
        warnings: [...warnings, ...res.warnings],
        stats: { source: "pdf", sourceRef: opts.sourceRef, provider: opts.provider, rowsSeen: res.rowsSeen, rowsParsed: res.rows.length, rowsSkipped: Math.max(0, res.rowsSeen - res.rows.length), method: hasText ? "llm-text" : "llm-pdf" },
      };
    }
    warnings.push("LLM extraction returned no rows; falling back to line heuristics");
  }

  if (!hasText) {
    warnings.push(`PDF has no text layer (${pages} page(s)); it is probably scanned. Set ANTHROPIC_API_KEY to read it with the LLM, or ask the provider for the Excel.`);
    return {
      rows: [],
      warnings,
      stats: { source: "pdf", sourceRef: opts.sourceRef, provider: opts.provider, rowsSeen: 0, rowsParsed: 0, rowsSkipped: 0, method: "none" },
    };
  }

  const parsed = parsePriceLines(text, { ...opts, source: "pdf" });
  const rows = dedupeRows(parsed.rows);
  if (parsed.seen > 0 && rows.length / parsed.seen < 0.5) warnings.push(`only ${rows.length} of ${parsed.seen} size lines produced a price; check the PDF layout or enable the LLM`);
  return {
    rows,
    warnings: [...warnings, ...parsed.warnings],
    stats: { source: "pdf", sourceRef: opts.sourceRef, provider: opts.provider, rowsSeen: parsed.seen, rowsParsed: rows.length, rowsSkipped: parsed.seen - rows.length, method: "heuristic-lines" },
  };
}
