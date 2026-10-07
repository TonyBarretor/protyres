import type { IngestOptions, IngestResult } from "./types";
import { parsePriceLines } from "./lines";
import { dedupeRows } from "./tabular";
import { extractPricesWithLLM, llmAvailable } from "../llm/extract-prices";
import { findTyreSizes } from "../tyre/spec";

export interface WhatsAppIngestOptions extends IngestOptions {
  method?: "auto" | "llm" | "heuristic";
}

/** Does this message look like a provider price message (at least one size and one number)? */
export function looksLikePriceMessage(text: string): boolean {
  const sizes = findTyreSizes(text);
  if (sizes.length === 0) return false;
  const numbers = text.match(/\d+[.,]?\d*/g) ?? [];
  return numbers.length > sizes.length;
}

/** A provider's WhatsApp message (forwarded by the salesman) -> rows. */
export async function ingestWhatsAppText(text: string, opts: WhatsAppIngestOptions): Promise<IngestResult> {
  const method = opts.method ?? "auto";
  const useLlm = method === "llm" || (method === "auto" && llmAvailable());
  const warnings: string[] = [];
  if (useLlm) {
    const res = await extractPricesWithLLM({ text }, { ...opts, source: "whatsapp" });
    if (res.rows.length > 0) {
      return {
        rows: dedupeRows(res.rows),
        warnings: res.warnings,
        stats: { source: "whatsapp", sourceRef: opts.sourceRef, provider: opts.provider, rowsSeen: res.rowsSeen, rowsParsed: res.rows.length, rowsSkipped: Math.max(0, res.rowsSeen - res.rows.length), method: "llm" },
      };
    }
    warnings.push("LLM extraction returned no rows; falling back to regex");
  }
  const parsed = parsePriceLines(text, { ...opts, source: "whatsapp" });
  const rows = dedupeRows(parsed.rows);
  return {
    rows,
    warnings: [...warnings, ...parsed.warnings],
    stats: { source: "whatsapp", sourceRef: opts.sourceRef, provider: opts.provider, rowsSeen: parsed.seen, rowsParsed: rows.length, rowsSkipped: parsed.seen - rows.length, method: "regex" },
  };
}
