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
      /** "cost": price = cost × (1 + m/100) (markup on cost) · "price": price = cost / (1 − m/100) (m% of the sale price). */
      marginBase: z.enum(["cost", "price"]).default("cost"),
      pricesIncludeTax: z.boolean().default(false),
    })
    .default({ marginPct: 15, marginBase: "cost", pricesIncludeTax: false }),
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
  /** Name of the PDF sent to the customer; tokens: {N} {NNN} {NNNN} {YY} {YYYY} {MES} {Mes} {NUMERO} {CLIENTE} {UNIDAD} {Unidad} {UB}. */
  pdfFileName: z.string().default("Cotizacion {YY} - {NNNN}"),
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

/** One item of a customer's contract: fixed price (net of IGV) and the short codes the salesman types ("2 v99"). */
export const ContractItemSchema = z.object({
  /** "v99": what the salesman types; also the key of its contract_prices row. */
  id: z.string().min(1),
  /** Other ways of writing it ("valor 99", "mixta"), compared accent / case-insensitively on word boundaries. */
  aliases: z.array(z.string()).default([]),
  brand: z.string().default(""),
  model: z.string().default(""),
  /** Default: the contract's size / ply. */
  size: z.string().optional(),
  ply: z.number().int().optional(),
  /** APLICACIÓN ("MIXT", "POST"); null = the bot asks the first time and saves the answer. */
  application: z.string().nullable().default(null),
  price: z.number(),
  /** Default: the contract's currency. */
  currency: z.string().optional(),
});
export type ContractItemConfig = z.infer<typeof ContractItemSchema>;

/** A customer's contract: the only items it buys, at fixed prices, all of one size by default. */
export const ContractSchema = z.object({
  /** Shown with "contrato prosegur" ("Contrato Prosegur 2 años · precios sin IGV"). */
  note: z.string().default(""),
  size: z.string().default(""),
  ply: z.number().int().optional(),
  currency: z.string().default("USD"),
  items: z.array(ContractItemSchema).default([]),
});
export type ContractConfig = z.infer<typeof ContractSchema>;

/** A customer with its own quote rules (config/customers.json), e.g. Prosegur and its "Formato Proveedores" Excel. */
export const CustomerProfileSchema = z.object({
  /** "Prosegur"; its folded form is the profile id ("prosegur"). */
  name: z.string(),
  /** How the salesman writes the customer ("prosegur", "prosegur s.a."), compared case / accent / punctuation-insensitively. */
  aliases: z.array(z.string()).default([]),
  /** Company printed on the quote ("PROSEGUR SA"). */
  company: z.string().default(""),
  /** Default recipient of the quote email ("" = the request's, the last quote's, or ask). */
  email: z.string().default(""),
  /** Extra document next to the 360° PDF: "prosegur" = the client's Excel "Formato Proveedores". */
  format: z.string().default(""),
  /** Terms used when the salesman does not write them. */
  defaults: z
    .object({
      paymentType: z.string().optional(),
      paymentTerm: z.string().optional(),
      deliveryTerm: z.string().optional(),
      validityDays: z.number().int().optional(),
      pricesIncludeTax: z.boolean().optional(),
    })
    .default({}),
  /** Asked for before showing options when missing: unit ("unidad:"), ub ("ub:" / "UB 1830" per item), requester ("solicitante:"). */
  required: z.array(z.enum(["unit", "ub", "requester"])).default([]),
  /** The customer's Excel template, file name pattern ({DDMMYY} {UB} {UNIDAD} {PROVEEDOR} {N}) and supplier box. */
  excel: z
    .object({
      template: z.string(),
      fileName: z.string().default("{DDMMYY}-{UB}-{UNIDAD}-{PROVEEDOR}-{N}"),
      supplierName: z.string().default(""),
      supplierRuc: z.string().default(""),
    })
    .optional(),
  /** Contract prices (Prosegur: 3 models, 2 years); the contract_prices table overrides / adds items per id. */
  contract: ContractSchema.optional(),
});
export type CustomerProfile = z.infer<typeof CustomerProfileSchema>;

export const SettingsSchema = z.object({
  company: CompanySchema,
  pricing: PricingSchema,
  quote: QuoteSchema,
  /** WhatsApp number (digits) -> signature; "default" names the entry used by the CLI / unknown numbers. */
  salespeople: z.record(z.string(), z.union([SalespersonSchema, z.string()])).default({}),
  /** Customer profiles, loaded from config/customers.json (CUSTOMERS_CONFIG) unless pilot.json has its own. */
  customers: z.array(CustomerProfileSchema).default([]),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type PricingSettings = Settings["pricing"];

export function customersPath(): string {
  return process.env.CUSTOMERS_CONFIG || path.join(process.cwd(), "config", "customers.json");
}

/** config/customers.json → { "customers": [ … ] } (validated); [] when the file does not exist. */
export function loadCustomerProfiles(file = customersPath()): CustomerProfile[] {
  if (!fs.existsSync(/* turbopackIgnore: true */ file)) return [];
  const parsed = z.object({ customers: z.array(CustomerProfileSchema).default([]) }).safeParse(JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")));
  if (!parsed.success) throw new Error(`Invalid ${file}: ${parsed.error.message}`);
  return parsed.data.customers;
}

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
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(/* turbopackIgnore: true */ file)) raw = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8"));
  if (raw.customers === undefined) raw = { ...raw, customers: loadCustomerProfiles() };
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
