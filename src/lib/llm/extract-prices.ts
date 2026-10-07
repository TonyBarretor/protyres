import { z } from "zod";
import type { IngestOptions, PriceRow, PriceSource } from "../ingest/types";
import { buildRow, todayIso } from "../ingest/util";
import { dedupeRows } from "../ingest/tabular";
import { llmAvailable, structuredCall, type ContentBlock } from "./client";

export { llmAvailable };

const RowSchema = z.object({
  brand: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  size: z.string(),
  load_index: z.string().nullable().optional(),
  price: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  stock: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
});
const ListSchema = z.object({ rows: z.array(RowSchema), provider_name: z.string().nullable().optional() });

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    provider_name: { type: ["string", "null"], description: "Provider/seller name if the document states it, else null." },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          brand: { type: ["string", "null"], description: "Tyre brand, e.g. Michelin. null if unknown." },
          model: { type: ["string", "null"], description: "Model/design/pattern, e.g. X Multi Z, R268. null if none." },
          size: { type: "string", description: "Size exactly as written, e.g. 295/80R22.5, 11R22.5, 1000R20." },
          load_index: { type: ["string", "null"], description: "Load/speed index if present, e.g. 152/148M." },
          price: { type: ["number", "null"], description: "Unit price as a number (no symbols). null if no price." },
          currency: { type: ["string", "null"], description: "USD, PEN, etc. if stated; else null." },
          stock: { type: ["number", "null"], description: "Units available if stated; else null." },
          notes: { type: ["string", "null"], description: "Anything relevant: 'precio con IGV', 'oferta', 'hasta agotar stock'." },
        },
        required: ["size"],
      },
    },
  },
  required: ["rows"],
} as const;

const SYSTEM = `You extract tyre (llantas/neumáticos) price lists from provider documents and WhatsApp messages written in Spanish or English.
Rules:
- One row per tyre size+brand+model combination that has a price. Skip headers, totals, phone numbers, dates, and anything without a size.
- Keep the size exactly as written (do not convert). Keep the model as written minus the brand.
- Prices: the unit price the PROVIDER charges. If a list shows several price columns (e.g. contado/crédito, con IGV/sin IGV), choose the base/contado price and say which one in notes.
- If a message says a brand once and then lists several sizes, apply that brand to all of them.
- Never invent prices. If a line has no price, set price to null.`;

export interface LLMExtractResult {
  rows: PriceRow[];
  rowsSeen: number;
  warnings: string[];
  providerName?: string | null;
}

/**
 * Extract price rows from text, a PDF, or an image using the LLM (tool-forced JSON output).
 * Returns zero rows (with a warning) when the LLM is unavailable or fails, never throws.
 */
export async function extractPricesWithLLM(
  input: { text?: string; pdf?: Buffer; image?: { data: Buffer; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" } },
  opts: IngestOptions & { source: PriceSource },
): Promise<LLMExtractResult> {
  const warnings: string[] = [];
  if (!llmAvailable()) return { rows: [], rowsSeen: 0, warnings: ["LLM not configured (ANTHROPIC_API_KEY missing)"] };
  const content: ContentBlock[] = [];
  if (input.pdf) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: input.pdf.toString("base64") } });
  if (input.image) content.push({ type: "image", source: { type: "base64", media_type: input.image.mediaType, data: input.image.data.toString("base64") } });
  const text = input.text ? `Provider: ${opts.provider}\n\n${input.text.slice(0, 60_000)}` : `Provider: ${opts.provider}. Extract every priced tyre from the attached document.`;
  content.push({ type: "text", text });

  let raw: unknown;
  try {
    raw = await structuredCall({
      system: SYSTEM,
      content,
      toolName: "record_price_list",
      toolDescription: "Record every tyre price found in the provided material.",
      inputSchema: TOOL_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 8192,
    });
  } catch (err) {
    return { rows: [], rowsSeen: 0, warnings: [`LLM call failed: ${(err as Error).message}`] };
  }
  const parsed = ListSchema.safeParse(raw);
  if (!parsed.success) return { rows: [], rowsSeen: 0, warnings: ["LLM returned an unexpected shape"] };

  const priceDate = opts.priceDate ?? todayIso();
  const rows: PriceRow[] = [];
  for (const r of parsed.data.rows) {
    if (r.price === null || r.price === undefined) continue;
    const row = buildRow({
      provider: opts.provider,
      brand: r.brand ?? "",
      model: r.model ?? "",
      size: r.load_index ? `${r.size} ${r.load_index}` : r.size,
      cost: r.price,
      currency: r.currency ?? undefined,
      stock: r.stock ?? null,
      priceDate,
      source: opts.source,
      sourceRef: opts.sourceRef,
      notes: r.notes ?? undefined,
      raw: JSON.stringify(r),
      defaultCurrency: opts.defaultCurrency,
    });
    if (row) rows.push(row);
    else warnings.push(`unparseable size/price from LLM row: ${JSON.stringify(r)}`);
  }
  return { rows: dedupeRows(rows), rowsSeen: parsed.data.rows.length, warnings, providerName: parsed.data.provider_name };
}
