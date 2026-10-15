/**
 * Customer profiles (config/customers.json): customers with their own quote rules. A request is a profile's when it
 * starts with one of its aliases ("prosegur\n215/75R17.5 …"), names it as the customer ("para Prosegur SA") or says
 * "para prosegur". The profile's company, email and terms are then appended to the request text as ordinary lines
 * ("para PROSEGUR SA", "pago: FACTURA" …) for the fields the salesman did not write, so they survive every re-parse.
 */
import type { CustomerProfile, Settings } from "../settings";
import { foldKey } from "../store/types";
import { fold } from "../tyre/brands";
import type { Quote, QuoteRequest } from "./types";

export type RequiredField = CustomerProfile["required"][number];

export function profileId(p: CustomerProfile): string {
  return foldKey(p.name);
}

/** The profile comes with the customer's own Excel format (today: Prosegur's "Formato Proveedores"). */
export function hasExcelFormat(p: CustomerProfile | undefined): p is CustomerProfile & { excel: NonNullable<CustomerProfile["excel"]> } {
  return !!p && p.format === "prosegur" && !!p.excel?.template;
}

export function findProfile(settings: Settings, id: string | undefined): CustomerProfile | undefined {
  return id ? settings.customers.find((p) => profileId(p) === id) : undefined;
}

/** Every way of naming the customer: aliases, name and company (longest first). */
function names(p: CustomerProfile): string[] {
  return [...new Set([...p.aliases, p.name, p.company].filter(Boolean))].sort((a, b) => b.length - a.length);
}

/** Is this customer name (as parsed from the request) the profile's customer? */
export function isProfileCustomer(p: CustomerProfile, who: string | undefined): boolean {
  const k = foldKey(who);
  return !!k && names(p).some((n) => foldKey(n) === k);
}

/** "prosegur …" / "Prosegur S.A.: …" at the very start of the message: the profile and the text after it. */
export function leadingProfile(settings: Settings, text: string): { profile: CustomerProfile; rest: string } | null {
  for (const p of settings.customers) {
    for (const n of names(p)) {
      const words = n
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean);
      if (!words.length) continue;
      const re = new RegExp(String.raw`^\s*${words.join(String.raw`[^A-Za-z0-9\n]*`)}(?![\p{L}\p{N}])[^\S\n]*[:.,;-]?`, "iu");
      const m = text.match(re);
      if (m) return { profile: p, rest: text.slice(m[0].length).replace(/^\s+/, "") };
    }
  }
  return null;
}

/** The profile a request belongs to: leading alias, "para prosegur" anywhere, or the parsed customer. */
export function detectProfile(settings: Settings, text: string, req: QuoteRequest): CustomerProfile | null {
  const lead = leadingProfile(settings, text);
  if (lead) return lead.profile;
  const t = ` ${fold(text)} `;
  for (const p of settings.customers) {
    if (names(p).some((n) => t.includes(` para ${fold(n)} `))) return p;
    if (isProfileCustomer(p, req.customerCompany) || isProfileCustomer(p, req.customerName)) return p;
  }
  return null;
}

/** Lines appended to the request for the profile's fields the salesman did not write himself. */
export function profileDefaultLines(p: CustomerProfile, req: QuoteRequest): string[] {
  const lines: string[] = [];
  const who = req.customerCompany ?? req.customerName;
  if (p.company) {
    if (!who) lines.push(`para ${p.company}`);
    else if (isProfileCustomer(p, who) && req.customerCompany !== p.company) lines.push(`cliente: ${p.company}`); // "para Prosegur" -> PROSEGUR SA
  }
  if (p.email && !req.customerEmail) lines.push(`correo ${p.email}`);
  const d = p.defaults;
  if (d.paymentType && !req.paymentType) lines.push(`pago: ${d.paymentType}`);
  if (d.paymentTerm && !req.paymentTerm) lines.push(`plazo: ${d.paymentTerm}`);
  if (d.deliveryTerm && !req.deliveryTerm) lines.push(`entrega: ${d.deliveryTerm}`);
  if (d.validityDays && !req.validityDays) lines.push(`validez: ${d.validityDays} días`);
  if (d.pricesIncludeTax !== undefined && req.showPricesWithTax === undefined) lines.push(d.pricesIncludeTax ? "con igv" : "sin igv");
  return lines;
}

/** Required fields still missing (ub counts as present when the quote has one or every line has its own). */
export function missingRequired(p: CustomerProfile, req: Pick<QuoteRequest, "unit" | "ub" | "requester"> & { lines: { ub?: string }[] }): RequiredField[] {
  return p.required.filter((f) => (f === "unit" ? !req.unit : f === "requester" ? !req.requester : !req.ub && req.lines.some((l) => !l.ub)));
}

/** The same check on a built quote (fields the salesman skipped with "ok"). */
export function missingInQuote(p: CustomerProfile, q: Quote): RequiredField[] {
  return missingRequired(p, { unit: q.unit, ub: q.ub, requester: q.requester, lines: q.items });
}

export const FIELD_LABEL: Record<RequiredField, string> = { unit: "unidad", ub: "ub", requester: "solicitante" };

const FIELD_HINT: Record<RequiredField, string> = {
  unit: "*unidad:* Ayacucho _(la unidad atendida)_",
  ub: "*ub:* 1830 _(o *UB 1830* al lado de cada llanta)_",
  requester: "*solicitante:* nombre de quien pide la cotización",
};

export function askRequired(p: CustomerProfile, missing: RequiredField[]): string {
  return `Para el formato de ${p.name} me falta:\n${missing.map((f) => `• ${FIELD_HINT[f]}`).join("\n")}\nEnvíamelos (uno por línea) o responde *ok* para seguir sin ellos.`;
}

/** What to send for a profile's quote (reply to a bare "prosegur"); six lines. */
export function profileGuide(p: CustomerProfile): string {
  return [
    `*Cotización ${p.name}* — envíame en un solo mensaje:`,
    `• las llantas con cantidad y su UB: _215/75R17.5 Fenixway Valor 99 x2 UB 1830_`,
    `• *unidad:* Ayacucho (la unidad atendida)`,
    `• *solicitante:* Johann Castañeda`,
    `• opcional: *atención:* Sr. … y *número 451* para fijar el número`,
    `Te devuelvo el PDF 360° y el Excel «Formato Proveedores» de ${p.name}, listos para *enviar*.`,
  ].join("\n");
}
