import { z } from "zod";
import { structuredCall, type ContentBlock } from "./client";

const LineSchema = z.object({
  raw: z.string().nullable().optional(),
  size: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  quantity: z.number().int().positive().nullable().optional(),
  position: z.enum(["DEL", "TRAC", "MIX", "OTR", "TRL"]).nullable().optional(),
  application: z.string().nullable().optional(),
  plate: z.string().nullable().optional(),
  ub: z.string().nullable().optional(),
  ply: z.number().int().nullable().optional(),
  description: z.string().nullable().optional(),
});

export const RequestSchema = z.object({
  lines: z.array(LineSchema).nullable().optional(),
  customer_name: z.string().nullable().optional(),
  customer_company: z.string().nullable().optional(),
  customer_email: z.string().nullable().optional(),
  discount_pct: z.number().nullable().optional(),
  margin_pct: z.number().nullable().optional(),
  prices_include_tax: z.boolean().nullable().optional(),
  attention: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  payment_type: z.string().nullable().optional(),
  payment_term: z.string().nullable().optional(),
  delivery_term: z.string().nullable().optional(),
  validity_days: z.number().int().nullable().optional(),
  unit: z.string().nullable().optional(),
  ub: z.string().nullable().optional(),
  requester: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type LLMRequest = z.infer<typeof RequestSchema>;

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      description: "One entry per product requested. Merge only rows that are identical in every attribute (summing the quantity). Rows of the same size that differ in position (mixta vs tracción vs delantera), model or ply are DIFFERENT products: keep one entry each with its own quantity — never add them up ('2 mixtas y 8 de tracción' = two entries, 2 and 8).",
      items: {
        type: "object",
        properties: {
          raw: { type: ["string", "null"], description: "The original text of this line." },
          size: { type: ["string", "null"], description: "Tyre size exactly as written (e.g. 11R22.5, 12.5/80-18, 300-15), or null for non-tyre items." },
          brand: { type: ["string", "null"], description: "Requested tyre brand, or null if not specified." },
          model: { type: ["string", "null"], description: "Requested model/design/pattern (e.g. G377, R4, Super Traction), or null." },
          quantity: { type: ["integer", "null"], description: "Units requested; null if not stated (means 1)." },
          position: { type: ["string", "null"], enum: ["DEL", "TRAC", "MIX", "OTR", "TRL", null], description: "DEL = delantera/direccional, TRAC = posterior/tracción, MIX = mixta, OTR = off-road/minera, TRL = trailer." },
          ply: { type: ["integer", "null"], description: "Ply rating if stated (12 PLY, 16PR)." },
          application: { type: ["string", "null"], description: "The application/use words exactly as the salesman wrote them, upper case ('MIXT DEL', 'POST ON/OFF', 'MIXTA', 'MONTACARGAS', 'ARO' for a rim); null if none." },
          plate: { type: ["string", "null"], description: "Vehicle plate given for this line ('BLM-923'), or null." },
          ub: { type: ["string", "null"], description: "The customer's UB code written on this line ('UB 1830' -> '1830', 3-5 digits), or null. Never a quantity." },
          description: { type: ["string", "null"], description: "For non-tyre items (parches, cámaras, aros, válvulas): the item description." },
        },
      },
    },
    customer_name: { type: ["string", "null"], description: "Contact person's name, if any." },
    customer_company: { type: ["string", "null"], description: "Customer company, if any." },
    customer_email: { type: ["string", "null"], description: "Email address to send the quote to, if any." },
    discount_pct: { type: ["number", "null"], description: "Discount percentage the salesman wants to apply, if stated." },
    margin_pct: { type: ["number", "null"], description: "Margin percentage the salesman wants on provider items ('margen 10%'), if stated. Never a discount." },
    prices_include_tax: { type: ["boolean", "null"], description: "true if the request says prices should include IGV, false if 'sin IGV', null if not stated." },
    attention: { type: ["string", "null"], description: "Person the quote is addressed to ('Atención: Sra. Karen Ordoñez')." },
    address: { type: ["string", "null"], description: "Customer address or delivery place." },
    payment_type: { type: ["string", "null"], description: "Payment type if stated (factura crédito, letras, contado)." },
    payment_term: { type: ["string", "null"], description: "Payment term if stated ('45 días')." },
    delivery_term: { type: ["string", "null"], description: "Delivery term if stated ('48 hrs post OC')." },
    validity_days: { type: ["integer", "null"], description: "Quote validity in days if stated." },
    unit: { type: ["string", "null"], description: "The customer's branch / unit the quote is for ('unidad: Ayacucho', 'unidad atendida', 'sede'), or null." },
    ub: { type: ["string", "null"], description: "UB code for the whole request ('ub: 1830'), when not given per line; null otherwise." },
    requester: { type: ["string", "null"], description: "Person who requested the quote at the customer ('solicitante: Johann Castañeda'), or null." },
    notes: { type: ["string", "null"], description: "Deadline, urgency, or anything else relevant." },
  },
  required: ["lines"],
} as const;

const SYSTEM = `You read tyre (llantas/neumáticos) purchase requests in Spanish or English: a salesman's short note, a customer's WhatsApp message (possibly with a photo or screenshot), or a formal RFQ email with a table.
Extract every requested product as a line. Do not invent values: use null for anything not stated. "x4", "4 unidades", "02 llantas", "cuatro" all mean quantity 4. A quantity before a position word is that group's quantity ("2 mixtas y 8 de tracción": 2 MIX + 8 TRAC, two lines). "UB 1830" is the customer's UB code for the line (field ub), never a quantity or a size; "número 451" is the quote number, not a product. Keep sizes exactly as written. For photos of a tyre sidewall, read the size, brand and model if legible.`;

export async function parseRequestWithLLM(text: string, extra: ContentBlock[] = []): Promise<LLMRequest | null> {
  try {
    const raw = await structuredCall<unknown>({
      system: SYSTEM,
      content: [...extra, { type: "text", text: text || "Extract the request from the attached material." }],
      toolName: "record_request",
      toolDescription: "Record the structured tyre request.",
      inputSchema: TOOL_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 2048,
    });
    if (!raw) return null;
    const parsed = RequestSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
