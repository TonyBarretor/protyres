/**
 * Customer profiles (config/customers.json): customers with their own quote rules. A request is a profile's when it
 * starts with one of its aliases ("prosegur\n215/75R17.5 …"), names it as the customer ("para Prosegur SA") or says
 * "para prosegur". The profile's company, email and terms are then appended to the request text as ordinary lines
 * ("para PROSEGUR SA", "pago: FACTURA" …) for the fields the salesman did not write, so they survive every re-parse.
 */
import type { CustomerProfile, Settings } from "../settings";
import { foldKey } from "../store/types";
import { fold } from "../tyre/brands";
import { parseRequestRegex } from "./request";
import type { Quote, QuoteItem, QuoteRequest } from "./types";

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

/** The profile's quotes carry a unit and a UB (Prosegur): "prosegur ayacucho 1830" sets them. */
export function usesUnits(p: CustomerProfile): boolean {
  return p.required.includes("unit") || p.required.includes("ub");
}

/** Words that end the unit in "prosegur ayacucho …" (they start something else). */
const HEADER_STOP = new Set(["ub", "para", "cliente", "correo", "email", "cotizar", "cotiza", "coti", "cotizacion", "pedido", "urgente", "solicitante", "atencion", "atn", "con", "sin", "x"]);
/** Leading words that are not part of the unit's name ("prosegur unidad ayacucho", "prosegur sede de lima"). */
const UNIT_LEAD = new Set(["unidad", "sede", "de", "del"]);
const UNIT_LOWER = new Set(["de", "del", "la", "las", "los", "el", "y"]);

/** "AYACUCHO" -> "Ayacucho", "cerro de pasco" -> "Cerro de Pasco". */
function unitName(words: string[]): string {
  return words
    .map((w, i) => {
      const l = w.toLocaleLowerCase("es");
      return i > 0 && UNIT_LOWER.has(l) ? l : l.charAt(0).toLocaleUpperCase("es") + l.slice(1);
    })
    .join(" ");
}

/** The tail of the header line after the customer's name: unit words, then an optional "ub", then a 3–5 digit UB. */
function parseHeaderTail(tail: string, startsItem: (rest: string) => boolean): { unit?: string; ub?: string; consumed: number } {
  const words: string[] = [];
  let ub: string | undefined;
  let consumed = 0;
  const tokens = [...tail.matchAll(/\S+/g)];
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k][0].replace(/^[:.,;-]+/, "");
    const at = tokens[k].index! + tokens[k][0].length;
    if (!tok) continue; // a lone separator ("prosegur - ayacucho")
    const glued = tok.match(/^u\.?b\.?:?(\d{3,5})$/i);
    if (glued) {
      [ub, consumed] = [glued[1], at];
      break;
    }
    if (/^u\.?b\.?:?$/i.test(tok)) {
      const next = tokens[k + 1];
      if (next && /^\d{3,5}$/.test(next[0])) [ub, consumed] = [next[0], next.index! + next[0].length];
      break;
    }
    if (/^\d{3,5}$/.test(tok)) {
      [ub, consumed] = [tok, at];
      break;
    }
    const w = tok.replace(/[:.]+$/, "");
    if (!/^[\p{L}][\p{L}'.-]*$/u.test(w) || HEADER_STOP.has(fold(w)) || startsItem(tail.slice(tokens[k].index!))) break;
    words.push(w);
    consumed = at;
  }
  while (words.length && UNIT_LEAD.has(fold(words[0]))) words.shift();
  return { unit: words.length ? unitName(words) : undefined, ub, consumed };
}

/**
 * The unit and UB written right after the customer's name on the same line: "prosegur ayacucho 1830", "prosegur
 * ayacucho ub 1830", "coti para prosegur ayacucho" (unit = the words up to a 3–5 digit number, an item code or the
 * end of the line / a comma). Returns them and the text without those words (the name itself stays).
 * `startsItem` tells whether the rest of the line starts with an item ("prosegur ayacucho v99 x2").
 */
export function splitProfileHeader(p: CustomerProfile, text: string, startsItem: (rest: string) => boolean = () => false): { unit?: string; ub?: string; text: string } {
  // emails blanked: "compras@prosegur.com" is not the customer's name
  const masked = text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (m) => " ".repeat(m.length));
  let best: { at: number; end: number } | null = null;
  for (const n of names(p)) {
    const words = n
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean);
    if (!words.length) continue;
    const m = masked.match(new RegExp(String.raw`(?<![\p{L}\p{N}])${words.join(String.raw`[^A-Za-z0-9\n]*`)}(?![\p{L}\p{N}])`, "iu"));
    if (m?.index === undefined) continue;
    // the first mention wins; for the same position, the longest name ("prosegur s.a." before "prosegur")
    if (!best || m.index < best.at || (m.index === best.at && m.index + m[0].length > best.end)) best = { at: m.index, end: m.index + m[0].length };
  }
  if (!best) return { text };
  const lineEnd = text.indexOf("\n", best.end);
  const end = lineEnd < 0 ? text.length : lineEnd;
  const sep = text.slice(best.end, end).search(/[,;]/);
  const segEnd = sep < 0 ? end : best.end + sep;
  const tail = text.slice(best.end, segEnd);
  const head = parseHeaderTail(tail, startsItem);
  if (!head.consumed) return { text };
  return { unit: head.unit, ub: head.ub, text: text.slice(0, best.end) + tail.slice(head.consumed) + text.slice(segEnd) };
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

/**
 * The request text of a profile's quote: the leading name taken off ("prosegur …"), the header's unit / UB as
 * "unidad:" / "ub:" lines on top (where later corrections override them), and the profile's defaults for what the
 * salesman did not write. `pending`: header lines of an earlier bare "prosegur ayacucho 1830". `bare`: the message
 * had nothing else (a bare "prosegur", or only its header, then in `header`).
 */
export function profileRequestText(settings: Settings, p: CustomerProfile, text: string, opts: { startsItem?: (rest: string) => boolean; pending?: string } = {}): { text: string; bare: boolean; header: string[] } {
  const head = usesUnits(p) ? splitProfileHeader(p, text, opts.startsItem) : { text, unit: undefined, ub: undefined };
  const lead = leadingProfile(settings, head.text);
  const body = (lead && profileId(lead.profile) === profileId(p) ? lead.rest : head.text).replace(/^[\s,;]+/, "");
  const header = [head.unit ? `unidad: ${head.unit}` : "", head.ub ? `ub: ${head.ub}` : ""].filter(Boolean);
  if (!body.trim()) return { text: header.join("\n"), bare: true, header };
  const full = [opts.pending, ...header, body].filter(Boolean).join("\n");
  const defaults = profileDefaultLines(p, parseRequestRegex(full));
  return { text: defaults.length ? `${full}\n${defaults.join("\n")}` : full, bare: false, header };
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

/** How the salesman writes the customer ("prosegur"). */
export function profileKey(p: CustomerProfile): string {
  return fold(p.aliases[0] ?? p.name);
}

/**
 * What to send for a profile's quote (reply to a bare "prosegur"). With a contract, three lines: the header, one line
 * per item code, enviar. Without one, the six-line guide for free-text items.
 */
export function profileGuide(p: CustomerProfile, contractIds: string[] = []): string {
  if (contractIds.length) {
    const [a, b] = contractIds;
    return [
      `Primera línea: *${profileKey(p)} ayacucho 1830* (unidad y UB)`,
      `Debajo, una llanta por línea: *2 ${a}*${b ? `, *4 ${b}*` : ""} (códigos: ${contractIds.join(", ")})`,
      `Te mando PDF + Excel; revisa y responde *enviar*.`,
    ].join("\n");
  }
  return [
    `*Cotización ${p.name}* — envíame en un solo mensaje:`,
    `• las llantas con cantidad y su UB: _215/75R17.5 Fenixway Valor 99 x2 UB 1830_`,
    `• *unidad:* Ayacucho (la unidad atendida)`,
    `• *solicitante:* Johann Castañeda`,
    `• opcional: *atención:* Sr. … y *número 451* para fijar el número`,
    `Te devuelvo el PDF 360° y el Excel «Formato Proveedores» de ${p.name}, listos para *enviar*.`,
  ].join("\n");
}

/** "Prosegur · Ayacucho · UB 1830 · solicitante Johann Castañeda": first line of the profile's short messages. */
export function profileHead(p: CustomerProfile, q: { unit?: string; ub?: string; requester?: string }): string {
  return [p.name, q.unit, q.ub ? `UB ${q.ub}` : "", q.requester ? `solicitante ${q.requester}` : ""].filter(Boolean).join(" · ");
}

/** "215/75R17.5 18PR Fenixway Valor 99 MIXT x2" (+ plate, + the item's own UB when it is not the quote's). */
export function shortItemLabel(it: Pick<QuoteItem, "size" | "sizeDisplay" | "ply" | "brand" | "model" | "description" | "application" | "plate" | "ub" | "quantity">, quoteUb?: string): string {
  const what = it.size ? [`${it.sizeDisplay || it.size}${it.ply ? ` ${it.ply}PR` : ""}`, it.brand, it.model].filter(Boolean).join(" ") : it.description;
  const refs = [it.application, it.plate, it.ub && it.ub !== quoteUb ? `UB ${it.ub}` : ""].filter(Boolean).join(" ");
  return `${what}${refs ? ` ${refs}` : ""} x${it.quantity}`;
}
