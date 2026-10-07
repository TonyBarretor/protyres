import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const CompanySchema = z.object({
  /** Legal name (razón social). */
  name: z.string(),
  /** Brand used on documents ("360° Tyres"). */
  tradeName: z.string().default(""),
  /** Line under the salesperson's name ("360 by Professional Tyres"). */
  signatureName: z.string().default(""),
  taxId: z.string().default(""),
  address: z.string().default(""),
  phone: z.string().default(""),
  email: z.string().default(""),
  website: z.string().default(""),
  logoPath: z.string().default(""),
  /** Full-width band with logo + "COTIZACIÓN" title (optional). */
  headerImagePath: z.string().default(""),
  /** Full-width band drawn behind the signature block (optional). */
  footerImagePath: z.string().default(""),
});

const PricingSchema = z.object({
  currency: z.string().default("USD"),
  taxPct: z.number().default(18),
  taxLabel: z.string().default("IGV"),
  /** The company's own price list. */
  own: z
    .object({
      pricesIncludeTax: z.boolean().default(false),
      maxDiscountPct: z.number().default(20),
      defaultDiscountPct: z.number().default(0),
    })
    .default({ pricesIncludeTax: false, maxDiscountPct: 20, defaultDiscountPct: 0 }),
  /** Items bought from external providers. */
  provider: z
    .object({
      marginPct: z.number().default(15),
      pricesIncludeTax: z.boolean().default(false),
    })
    .default({ marginPct: 15, pricesIncludeTax: false }),
  /** Quote unit prices with tax included by default ("Impuestos: INCLUIDOS"). */
  showPricesWithTax: z.boolean().default(false),
  /** 1 = whole units, 0.5, 0.1, 0.01 */
  roundTo: z.number().default(0.01),
  quoteValidityDays: z.number().default(7),
  stalePriceDays: z.number().default(30),
  /** Units of that currency per 1 unit of the quote currency, e.g. { PEN: 3.4 } when quoting in USD. */
  exchangeRates: z.record(z.string(), z.number()).default({}),
});

const QuoteSchema = z.object({
  language: z.enum(["es", "en"]).default("es"),
  /** {MES} month name, {MM}, {YYYY}, {YY}, {NNN} / {NNNN} zero-padded counter. */
  numberFormat: z.string().default("{MES} {YYYY} - {NNN}"),
  /** First counter value used when the store has none yet. */
  counterStart: z.number().int().default(1),
  validityDays: z.number().default(7),
  deliveryTerm: z.string().default(""),
  paymentType: z.string().default(""),
  paymentTerm: z.string().default(""),
  /** Soles per dollar printed on the quote ("Tipo de cambio"). */
  exchangeRate: z.number().optional(),
  notes: z.string().default(""),
  /** Printed when a provider item (not in own stock) is quoted. */
  providerItemNote: z.string().default("Producto a pedido: entrega sujeta a disponibilidad del proveedor."),
  /** Brand -> country/origin label for the ORIGEN column. */
  brandOrigin: z.record(z.string(), z.string()).default({}),
});

export const SalespersonSchema = z.object({
  name: z.string().default(""),
  title: z.string().default(""),
  address: z.string().default(""),
  phone: z.string().default(""),
  email: z.string().default(""),
});
export type Salesperson = z.infer<typeof SalespersonSchema>;

export const SettingsSchema = z.object({
  company: CompanySchema,
  pricing: PricingSchema,
  quote: QuoteSchema,
  /** WhatsApp number (digits) -> signature; "default" names the entry used by the CLI / unknown numbers. */
  salespeople: z.record(z.string(), z.union([SalespersonSchema, z.string()])).default({}),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type PricingSettings = Settings["pricing"];

/** The signature block for a WhatsApp number (digits only), or the default one. */
export function salespersonFor(settings: Settings, phone?: string): Salesperson {
  const map = settings.salespeople;
  const key = phone?.replace(/\D/g, "");
  const pick = (k: string | undefined): Salesperson | null => {
    if (!k) return null;
    const v = map[k];
    return v && typeof v === "object" ? v : null;
  };
  const def = typeof map.default === "string" ? map.default : undefined;
  return pick(key) ?? pick(def) ?? (Object.values(map).find((v) => typeof v === "object") as Salesperson | undefined) ?? SalespersonSchema.parse({});
}

let cached: Settings | null = null;

export function settingsPath(): string {
  return process.env.PILOT_CONFIG || path.join(process.cwd(), "config", "pilot.json");
}

export function loadSettings(force = false): Settings {
  if (cached && !force) return cached;
  const file = settingsPath();
  let raw: unknown = {};
  if (fs.existsSync(/* turbopackIgnore: true */ file)) raw = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8"));
  const parsed = SettingsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${file}: ${parsed.error.message}`);
  const s = parsed.data;
  if (process.env.QUOTE_CURRENCY) s.pricing.currency = process.env.QUOTE_CURRENCY;
  cached = s;
  return s;
}

/** For tests. */
export function __setSettingsForTests(s: Settings | null): void {
  cached = s;
}
