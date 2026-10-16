import type { TyreSize } from "../tyre/spec";
import type { Position } from "../tyre/attrs";
import type { PriceRow } from "../ingest/types";

/** One thing the customer wants (a tyre size, or a free-text item like a patch or a rim). */
export interface RequestLine {
  raw: string;
  size?: TyreSize;
  brand?: string;
  model?: string;
  quantity: number;
  position?: Position;
  ply?: number;
  /** Free description for non-tyre items ("PARCHE RS-35 VIPAL"). */
  text?: string;
  /** APLICACIÓN as the salesman wrote it ("MIXT DEL", "POST ON/OFF", "ARO"); overrides what the price list says. */
  application?: string;
  /** Vehicle plate the customer gave for this line ("BLM-923"); printed next to the size. */
  plate?: string;
  /** The customer's UB code for this line ("UB 1830": Prosegur's cost-center / vehicle unit, 3–5 digits). */
  ub?: string;
  /**
   * The customer's contract item this line is ("2 v99" on a Prosegur request): quoted at the contract price, never
   * from the price lists (no options). `price` is net of IGV, in `currency`.
   */
  contract?: { id: string; price: number; currency: string };
}

export interface QuoteRequest {
  raw: string;
  lines: RequestLine[];
  customerName?: string;
  customerCompany?: string;
  customerEmail?: string;
  customerRef?: string;
  /** "Atención: Sra. Karen Ordoñez" */
  attention?: string;
  /** Customer address printed on the quote. */
  address?: string;
  /** Salesman's discount on own-list items (validated against the list's maximum). */
  discountPct?: number;
  /** "con IGV" / "sin IGV" in the request. */
  showPricesWithTax?: boolean;
  /** Per-quote commercial terms ("pago: factura crédito", "plazo: 45 días", "entrega: 48 hrs post OC", "validez: 5 días", "tc 3.4"). */
  paymentType?: string;
  paymentTerm?: string;
  deliveryTerm?: string;
  validityDays?: number;
  exchangeRate?: number;
  /** "unidad: Ayacucho" / "unidad atendida:" / "sede:" (the customer's branch the quote is for). */
  unit?: string;
  /** "ub: 1830": UB for the items that have none of their own. */
  ub?: string;
  /** "solicitante: Johann Castañeda" (who asked for the quote at the customer). */
  requester?: string;
  /** "número 451" written as a line of the request: this quote's counter. */
  quoteNumber?: number;
  notes?: string;
  /** which parser produced the fields */
  parsedBy: "regex" | "llm" | "llm+regex";
}

export interface Candidate {
  row: PriceRow;
  /** Inventory row joined by code / description (own items). */
  stockRow?: PriceRow;
  /** Units available (own stock or provider stock); null = unknown. */
  available: number | null;
  /** List price per unit before discount, net of tax, in the quote currency (own items). */
  listNet?: number;
  /** Discount applied to the list price (own items). */
  discountPct: number;
  /** Provider cost per unit net of tax in the quote currency (provider items). */
  costNet?: number;
  /** Unit sell price net of tax. */
  unitNet: number;
  /** Unit sell price including tax. */
  unitWithTax: number;
  ageDays: number;
  stale: boolean;
  relaxedSize: boolean;
  brandMismatch: boolean;
  positionMismatch: boolean;
  /** 0..1 similarity to the requested model (1 when no model requested). */
  modelScore: number;
  converted: boolean;
  reasons: string[];
}

export interface LineCandidates {
  line: RequestLine;
  candidates: Candidate[];
}

export interface QuoteItem {
  description: string;
  code?: string;
  brand: string;
  model: string;
  size: string;
  sizeDisplay: string;
  loadIndex?: string;
  speedIndex?: string;
  ply?: number;
  quantity: number;
  /** Net unit price (without tax). */
  unitPrice: number;
  /** Net list price before discount (own items), for the "P. lista / Dscto" columns. */
  listPrice?: number;
  discountPct: number;
  total: number;
  /** "own" = from stock/own list, "provider" = bought to order, "manual" = price typed by the salesman, "contract" = the customer's contract price */
  origin: "own" | "provider" | "manual" | "contract";
  /** APLICACIÓN column ("DELANTERA", "MIXTA", "MONTACARGAS"...). */
  application?: string;
  /** Vehicle plate given by the customer, printed after the size ("11R22.5 18PR BVV-704"). */
  plate?: string;
  /** The line's own UB ("1830"); items without one use the quote's `ub`. */
  ub?: string;
  /** ORIGEN column ("CHINA PREMIUM", "INDIA"...). */
  countryOfOrigin?: string;
  /** Product photo (URL, or data: URI for uploaded photos) printed on the "Fotos" annex page. */
  photoUrl?: string;
  /** Technical sheet image printed next to the photo. */
  sheetUrl?: string;
  /** Where the photo came from ("Steel", "WhatsApp", "web"). */
  photoSource?: string;
  // internal (not printed on the quote)
  provider: string;
  unitCost?: number;
  priceDate: string;
  rowId?: string;
  available: number | null;
}

export interface EmailDraft {
  to: string;
  subject: string;
  body: string;
}

export interface Quote {
  number: string;
  /** yyyy-mm-dd */
  date: string;
  validUntil: string;
  validityDays: number;
  currency: string;
  customer: { name?: string; company?: string; email?: string; phone?: string; ref?: string; attention?: string; address?: string };
  items: QuoteItem[];
  subtotal: number;
  taxPct: number;
  taxLabel: string;
  tax: number;
  total: number;
  /** Unit prices on the document are shown including tax. */
  pricesIncludeTax: boolean;
  notes: string;
  paymentType: string;
  paymentTerm: string;
  deliveryTerm: string;
  exchangeRate?: number;
  /** Customer's branch ("AYACUCHO"), default UB and requester (Prosegur's "Formato Proveedores"). */
  unit?: string;
  ub?: string;
  requester?: string;
  /** Customer profile (config/customers.json) this quote follows, e.g. "prosegur" (adds its Excel format). */
  customerProfile?: string;
  /** File names chosen by the salesman ("archivo: …", "archivo excel: …"), without extension. */
  files?: { pdfName?: string; xlsxName?: string };
  salesperson: { name: string; title: string; address: string; email: string; phone: string };
  status: "draft" | "sent" | "cancelled";
  emailDraft?: EmailDraft;
  pdfPath?: string;
  requestText: string;
  requestedBy?: string;
  createdAt: string;
  sentAt?: string;
}
