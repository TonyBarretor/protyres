/**
 * Customer contracts. Prosegur buys three models under a two-year contract at fixed prices (net of IGV), all
 * 215/75R17.5 18PR, so the salesman only types the item codes:
 *
 *   prosegur ayacucho 1830     <- header: unit + UB (profiles.ts, splitProfileHeader)
 *   2 v99                      <- contract lines: "2 v99", "v99 x2", "215 mixta v99 quiero 2", "v89 x4 ub 1845",
 *   4 v89                         "215/75R17.5 18PR Fenixway Valor 99 x2"
 *
 * The effective contract is config/customers.json ("contract") with the contract_prices rows applied: the DB wins per
 * item id, field by field, and ids only in the DB are extra items. Contract lines become quote items at the contract
 * price, without price-list options; the other lines of the request go through the normal parser.
 */
import type { CustomerProfile, PricingSettings, Settings } from "../settings";
import type { StoredContractItem } from "../store/types";
import { llmAvailable } from "../llm/client";
import { extractPly } from "../tyre/attrs";
import { findBrandInText, fold } from "../tyre/brands";
import { findTyreSizes, normalizeSizeText, parseTyreSize } from "../tyre/spec";
import { convertCurrency, fmtMoney, r2 } from "./pricing";
import { prosegurDescription } from "./prosegur-xlsx";
import { extractApplication, extractPlate, extractUb, parseQuantity, parseRequest, parseRequestRegex, withoutRefs } from "./request";
import type { QuoteItem, QuoteRequest, RequestLine } from "./types";

/** A contract item as quoted: the config's item with its contract_prices row applied. */
export interface ContractItem {
  /** "v99" (lower case) */
  id: string;
  aliases: string[];
  brand: string;
  model: string;
  /** "215/75R17.5" */
  size: string;
  ply?: number;
  /** null = not known yet: the bot asks the first time and saves the answer */
  application: string | null;
  /** net of IGV, in `currency` */
  price: number;
  currency: string;
  /** "db" = changed (or added) from WhatsApp, stored in contract_prices */
  source: "config" | "db";
  /** Also in config/customers.json (deleting its row brings the config's values back). */
  inConfig: boolean;
  updatedBy?: string;
  updatedAt?: string;
}

export interface Contract {
  note: string;
  /** Defaults for items that do not say theirs. */
  size: string;
  ply?: number;
  currency: string;
  items: ContractItem[];
}

/** The profile's effective contract (null when it has none): config items, then the stored rows on top. */
export function resolveContract(profile: CustomerProfile, stored: StoredContractItem[] = []): Contract | null {
  const c = profile.contract;
  if (!c && !stored.length) return null;
  const size = c?.size ?? "";
  const ply = c?.ply;
  const currency = c?.currency ?? "USD";
  const items: ContractItem[] = (c?.items ?? []).map((i) => ({
    id: i.id.trim().toLowerCase(),
    aliases: i.aliases,
    brand: i.brand,
    model: i.model,
    size: i.size || size,
    ply: i.ply ?? ply,
    application: i.application ?? null,
    price: i.price,
    currency: i.currency || currency,
    source: "config",
    inConfig: true,
  }));
  for (const r of stored) {
    const id = r.id.trim().toLowerCase();
    const at = items.findIndex((i) => i.id === id);
    const base = at >= 0 ? items[at] : undefined;
    const price = r.price ?? base?.price;
    if (price === undefined) continue; // an extra item without a price cannot be quoted
    const merged: ContractItem = {
      id,
      aliases: r.aliases?.length ? r.aliases : (base?.aliases ?? [id]),
      brand: r.brand || base?.brand || "",
      model: r.model || base?.model || "",
      size: r.size || base?.size || size,
      ply: r.ply ?? base?.ply ?? ply,
      application: r.application || base?.application || null,
      price,
      currency: r.currency || base?.currency || currency,
      source: "db",
      inConfig: !!base,
      updatedBy: r.updatedBy,
      updatedAt: r.updatedAt,
    };
    if (at >= 0) items[at] = merged;
    else items.push(merged);
  }
  return { note: c?.note ?? "", size, ply, currency, items };
}

/** The row written to contract_prices for an item (every field, so the row alone describes it). */
export function toStored(i: ContractItem): StoredContractItem {
  return { id: i.id, brand: i.brand, model: i.model, size: i.size, ply: i.ply, application: i.application, price: i.price, currency: i.currency, aliases: i.aliases };
}

/** An item by its code ("v99", any case) or one of its names ("valor 99", "Flama 77"). */
export function findContractItem(contract: Contract, ref: string): ContractItem | undefined {
  const k = fold(ref);
  if (!k) return undefined;
  return contract.items.find((i) => fold(i.id) === k) ?? contract.items.find((i) => [i.model, `${i.brand} ${i.model}`, ...i.aliases].some((a) => fold(a) === k));
}

/** "215/75R17.5 18PR" */
function sizeLabel(i: Pick<ContractItem, "size" | "ply">): string {
  return `${parseTyreSize(i.size)?.display ?? i.size}${i.ply ? ` ${i.ply}PR` : ""}`.trim();
}

/** "v99 · Fenixway Valor 99 · 215/75R17.5 18PR · MIXT · US$ 123.17" */
export function contractItemLabel(i: ContractItem): string {
  return [i.id, [i.brand, i.model].filter(Boolean).join(" "), sizeLabel(i), i.application ?? "sin aplicación", fmtMoney(i.price, i.currency)].filter(Boolean).join(" · ");
}

/** The contract price in the quote currency (converted with pricing.exchangeRates when the contract's differs). */
export function contractUnitPrice(c: { price: number; currency: string }, pricing: PricingSettings): number {
  return r2(convertCurrency(c.price, c.currency, pricing).value); // without a rate the contract's number is used as it is
}

/** A contract line as a quote item: the contract price (or the salesman's "precio N …"), never a discount. */
export function contractQuoteItem(line: RequestLine, quantity: number, settings: Settings, unitPriceOverride?: number): QuoteItem {
  const c = line.contract!;
  const price = contractUnitPrice(c, settings.pricing);
  const unitPrice = unitPriceOverride ?? price;
  const brand = line.brand ?? "";
  const originKey = Object.keys(settings.quote.brandOrigin).find((k) => fold(k) === fold(brand));
  const it: QuoteItem = {
    description: "",
    code: c.id,
    brand,
    model: line.model ?? "",
    size: line.size?.canonical ?? "",
    sizeDisplay: line.size?.display ?? "",
    ply: line.ply,
    quantity,
    unitPrice,
    listPrice: price,
    discountPct: 0,
    total: r2(unitPrice * quantity),
    origin: "contract",
    application: line.application,
    plate: line.plate,
    ub: line.ub,
    countryOfOrigin: originKey ? settings.quote.brandOrigin[originKey] : undefined,
    provider: "contrato",
    priceDate: new Date().toISOString().slice(0, 10),
    available: null,
  };
  // "215/75R17.5 18PR FENIXWAY VALOR 99", as in the Excel's Descripción column
  it.description = line.size ? prosegurDescription(it) : (line.text ?? [brand, it.model].filter(Boolean).join(" "));
  return it;
}

// ---------- reading the shorthand ----------

/** Lower case without accents, character by character: same length as the input, so match positions apply to it. */
function plain(s: string): string {
  let out = "";
  for (const ch of s) {
    const b = ch.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    out += b.length === ch.length ? b : ch;
  }
  return out;
}

interface AliasPattern {
  item: ContractItem;
  re: RegExp;
  /** the code, the model or a name with digits; position words ("mixta", "post") are weak: hints only */
  strong: boolean;
}

/** Every way of writing each item: its code, model, brand + model and aliases; words may be glued or spaced ("v 99"), plural allowed. */
function aliasPatterns(items: ContractItem[]): AliasPattern[] {
  const out: AliasPattern[] = [];
  for (const item of items) {
    const own = new Set([item.id, item.model, `${item.brand} ${item.model}`].map(fold).filter(Boolean));
    for (const a of new Set([...own, ...item.aliases.map(fold)].filter(Boolean))) {
      const words = a.split(" ").filter(Boolean); // fold() leaves only [a-z0-9 ]
      out.push({ item, re: new RegExp(String.raw`(?<![a-z0-9])${words.join(String.raw`[^a-z0-9\n]*`)}(?:e?s)?(?![a-z0-9])`, "g"), strong: own.has(a) || /\d/.test(a) });
    }
  }
  return out;
}

interface Hit {
  item: ContractItem;
  start: number;
  end: number;
  strong: boolean;
}

/** Alias matches in a segment, left to right; of two overlapping matches the longer one stays. */
function findHits(seg: string, patterns: AliasPattern[]): Hit[] {
  const p = plain(seg);
  const all: Hit[] = [];
  for (const pat of patterns) for (const m of p.matchAll(pat.re)) all.push({ item: pat.item, start: m.index!, end: m.index! + m[0].length, strong: pat.strong });
  all.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: Hit[] = [];
  for (const h of all) if (!kept.some((k) => h.start < k.end && k.start < h.end)) kept.push(h);
  return kept;
}

/** Does the text start with one of the items' codes or names? (Ends the unit in "prosegur ayacucho v99 x2".) */
export function startsWithContractAlias(text: string, items: ContractItem[]): boolean {
  const p = plain(text);
  return aliasPatterns(items).some((pat) => new RegExp(pat.re.source, "y").test(p));
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** A line or segment that sets a field ("unidad: …", "entrega: 48 HRS POST OC", "para PROSEGUR SA", "sin igv"…): never an item. */
const FIELD = /^(?:[\p{L}][\p{L} .]{0,30}:|(?:para|cliente|correo|email|mail|atenci[oó]n|atn|att|direcci[oó]n|dir|pago|forma de pago|tipo de pago|plazo|entrega|validez|vigencia|tc|t\.c\.|tipo de cambio|unidad|sede|ub|u\.b\.|solicitante|n[uú]mero|nro|n[°º]|nombre|archivo|dscto|dcto|descuento|con igv|sin igv|ref|referencia)(?![\p{L}\p{N}]))/iu;
const NUMBER_WORDS: Record<string, number> = { una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12 };

const canonicalOf = (size: string) => parseTyreSize(size)?.canonical ?? size;

/** Canonical tyre sizes written in a segment (plates and UBs blanked first). */
function sizesIn(seg: string): string[] {
  return findTyreSizes(normalizeSizeText(withoutRefs(seg))).map((s) => s.canonical);
}

/** Quantity, UB and plate of a contract segment: codes, sizes ("215", "215/75", "18pr") and the UB never count as the quantity. */
function contractLine(seg: string, item: ContractItem, hits: Hit[]): RequestLine {
  const blank = (m: string) => " ".repeat(m.length);
  let t = seg;
  for (const h of hits) t = t.slice(0, h.start) + " ".repeat(h.end - h.start) + t.slice(h.end); // codes and position words
  const ub = extractUb(t);
  const plate = extractPlate(t);
  t = withoutRefs(t)
    .replace(/\d{3}\s*\/\s*\d{2,3}(?:\s*(?:x\s*)?(?:z?r|-)\s*\d{1,2}(?:[.,]\d{1,2})?)?/gi, blank) // 215/75R17.5, 215/75
    .replace(/\b\d{1,2}\s*(?:pr|ply|lonas)\b/gi, blank) // 18PR
    .replace(/(?<![\w.])r\s?\d{1,2}(?:[.,]\d{1,2})?(?![\w.])/gi, blank); // R17.5
  const width = parseTyreSize(item.size)?.width;
  if (width) t = t.replace(new RegExp(String.raw`(?<![\w./,])${width}(?![\w./,])`, "g"), blank); // "215"
  const numbers = [...t.matchAll(/(?<![\w.,/])(\d{1,5})(?![\w.,/])/g)].map((m) => m[1]);
  const word = plain(t).match(new RegExp(String.raw`(?<![a-z])(${Object.keys(NUMBER_WORDS).join("|")})(?![a-z])`));
  // "x2", "2 unds", "2 llantas", "quiero 2", "dos"; a bare 4–5 digit number is the line's UB
  const quantity = parseQuantity(t) ?? (word ? NUMBER_WORDS[word[1]] : undefined) ?? numbers.map(Number).find((n) => n > 0 && n < 100) ?? 1;
  const size = parseTyreSize(item.size);
  return {
    raw: seg.trim(),
    size: size ?? undefined,
    text: size ? undefined : [item.brand, item.model].filter(Boolean).join(" "),
    brand: item.brand || undefined,
    model: item.model || undefined,
    quantity,
    ply: item.ply,
    application: item.application ?? undefined, // the contract fixes it; position words were only hints
    plate,
    ub: ub ?? numbers.find((n) => n.length >= 4),
    contract: { id: item.id, price: item.price, currency: item.currency },
  };
}

/** Cut a segment with several items before each new item (and before the number just in front of it: "2 v99 4 v89"). */
function cutAtItems(seg: string, hits: Hit[]): string[] {
  const cuts: number[] = [];
  let prev: ContractItem | undefined;
  for (const h of hits) {
    if (prev && h.item !== prev) {
      let i = h.start;
      while (i > 0 && /\s/.test(seg[i - 1])) i--;
      const num = seg.slice(0, i).match(/(?:^|\s)(\d{1,3})$/);
      cuts.push(num ? i - num[1].length : h.start);
    }
    prev = h.item;
  }
  const parts: string[] = [];
  let from = 0;
  for (const c of cuts) {
    parts.push(seg.slice(from, c));
    from = c;
  }
  parts.push(seg.slice(from));
  return parts.map((p) => p.trim()).filter(Boolean);
}

type Classified = RequestLine[] | "foreign" | null;

/**
 * One segment of a line: its contract lines, "foreign" (it names another tyre size: a price-list item), or null (not
 * a contract item). `afterForeign`: position words after a foreign size belong to it ("295/80R22.5 2 mixtas, 8 de tracción").
 */
function classify(seg: string, patterns: AliasPattern[], contractSizes: Set<string>, afterForeign: boolean, depth = 0): Classified {
  const clean = seg.replace(EMAIL, (m) => " ".repeat(m.length));
  const sizes = sizesIn(clean);
  if (sizes.some((s) => !contractSizes.has(s))) return "foreign";
  const hits = findHits(clean, patterns);
  if (!hits.length) return null;
  const strong = hits.filter((h) => h.strong);
  const lead = strong.length ? strong : afterForeign ? [] : hits;
  if (!lead.length) return null;
  // several items in one segment: "2 v99 y 4 posteriores" (split at "y"), "2 v99 4 v89" (cut before each code)
  const tryParts = (parts: string[]): RequestLine[] | null => {
    if (parts.length < 2 || depth >= 3) return null;
    const sub = parts.map((p) => classify(p, patterns, contractSizes, afterForeign, depth + 1));
    return sub.every((x) => Array.isArray(x)) ? sub.flatMap((x) => x as RequestLine[]) : null;
  };
  if (new Set(hits.map((h) => h.item)).size > 1) {
    const bySeparator = tryParts(clean.split(/\s+(?:y|e|\+|&)\s+/i));
    if (bySeparator) return bySeparator;
  }
  if (new Set(lead.map((h) => h.item)).size > 1) {
    const byCode = tryParts(cutAtItems(clean, lead));
    if (byCode) return byCode;
  }
  const item = lead[0].item;
  // position words alone only make an item when the segment looks like one ("2 mixtas", "mixta x2", "mixta")
  if (!strong.length && !/\d/.test(clean) && clean.trim().split(/\s+/).length > 3) return null;
  const brand = findBrandInText(clean)?.brand;
  if (brand && item.brand && fold(brand) !== fold(item.brand)) return null; // "Michelin … mixta"
  if (sizes.length && !sizes.includes(canonicalOf(item.size))) return null;
  return [contractLine(clean, item, hits)];
}

/** Same item, UB and plate on two lines: one line (quantities added, as the normal parser merges identical lines). */
function mergeContractLines(lines: RequestLine[]): RequestLine[] {
  const out: RequestLine[] = [];
  for (const l of lines) {
    const prev = out.find((m) => m.contract?.id === l.contract?.id && m.ub === l.ub && m.plate === l.plate);
    if (prev) prev.quantity += l.quantity;
    else out.push({ ...l });
  }
  return out;
}

/**
 * The request's contract lines (newline- or comma-separated) and the rest of its text (field lines and other items, for
 * the normal parser). A line is a contract line when it names an item: its code, model or an alias (accent / case-
 * insensitive, whole words); a line with another tyre size or another brand is not.
 */
export function splitContractLines(text: string, items: ContractItem[]): { lines: RequestLine[]; rest: string } {
  const patterns = aliasPatterns(items);
  const sizes = new Set(items.map((i) => canonicalOf(i.size)));
  const lines: RequestLine[] = [];
  const rest: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[\s•\-–*·]+/, "");
    if (!line.trim() || !patterns.length || FIELD.test(line)) {
      rest.push(raw);
      continue;
    }
    const keep: string[] = [];
    const found: RequestLine[] = [];
    let afterForeign = false;
    // commas split segments, except a decimal comma ("17,5")
    for (const part of line.split(/;|(?<!\d),|,(?!\d)/)) {
      const seg = part.trim();
      if (!seg) continue;
      const c = FIELD.test(seg) ? null : classify(seg, patterns, sizes, afterForeign);
      if (c === "foreign") afterForeign = true;
      if (Array.isArray(c)) found.push(...c);
      else keep.push(seg);
    }
    if (!found.length) {
      rest.push(raw);
      continue;
    }
    lines.push(...found);
    if (keep.length) rest.push(keep.join(", "));
  }
  return { lines: mergeContractLines(lines), rest: rest.join("\n") };
}

/** The text is nothing but contract lines ("4 v89", "2 v99, 4 v89"): those lines; null when it has anything else. */
export function onlyContractLines(text: string, items: ContractItem[]): RequestLine[] | null {
  if (!text.trim() || !items.length) return null;
  const split = splitContractLines(text, items);
  return split.lines.length && !split.rest.trim() ? split.lines : null;
}

/** parseRequestRegex for a request of a customer with a contract: contract lines first, then the other items. */
export function parseContractRequestRegex(text: string, items: ContractItem[]): QuoteRequest {
  const split = splitContractLines(text, items);
  if (!split.lines.length) return parseRequestRegex(text);
  // the fields (terms, customer, email…) are read from the whole text, the other items from what is left
  return { ...parseRequestRegex(text), lines: [...split.lines, ...parseRequestRegex(split.rest).lines] };
}

/** parseRequest for a request of a customer with a contract: the LLM, when configured, only reads the non-contract lines. */
export async function parseContractRequest(text: string, items: ContractItem[]): Promise<QuoteRequest> {
  const split = splitContractLines(text, items);
  if (!split.lines.length) return parseRequest(text);
  const base = parseRequestRegex(text);
  const others = parseRequestRegex(split.rest).lines;
  if (!others.length || !llmAvailable()) return { ...base, lines: [...split.lines, ...others] };
  const llm = await parseRequest(split.rest);
  return { ...llm, raw: text, lines: [...split.lines, ...llm.lines] };
}

// ---------- admin: a new item ----------

/**
 * "f66 = Fenixway Flama 66 215/75R17.5 18PR POST 118.00" ("contrato prosegur nuevo: …"): code, brand, model, size and
 * ply (default: the contract's), APLICACIÓN (optional) and the price net of IGV at the end. A Spanish error text when
 * something is missing.
 */
export function parseNewContractItem(spec: string, contract: Contract | null): ContractItem | string {
  const m = spec.trim().match(/^([\p{L}\p{N}][\p{L}\p{N}.-]*)\s*[=:]\s*(\S.*)$/u);
  if (!m) return "Escríbelo así: *nuevo: f66 = Fenixway Flama 66 215/75R17.5 18PR POST 118.00*";
  const id = m[1].toLowerCase();
  let desc = m[2].trim();
  const price = desc.match(/(?:^|\s)(?:us\$|\$|usd)?\s*(\d+(?:[.,]\d{1,2})?)\s*(?:usd)?$/i);
  if (!price || price.index === undefined) return "Falta el precio sin IGV al final, p.ej. *… POST 118.00*";
  desc = desc.slice(0, price.index).trim();
  const size = findTyreSizes(normalizeSizeText(desc))[0]?.display ?? contract?.size ?? "";
  if (!size) return "Falta la medida, p.ej. *215/75R17.5*";
  const ply = extractPly(desc) ?? contract?.ply;
  const application = extractApplication(desc) ?? null;
  // the model is what is left once brand, size, ply and application are taken out, as the admin typed it
  const b = findBrandInText(desc);
  let rest = desc;
  let brand = b?.brand ?? "";
  if (b) rest = rest.replace(new RegExp(b.alias.split(" ").join(String.raw`[^\p{L}\p{N}]*`), "iu"), " ");
  rest = rest
    .replace(/\d{3}\s*\/\s*\d{2,3}\s*(?:x\s*)?(?:z?r|-)?\s*\d{1,2}(?:[.,]\d{1,2})?/gi, " ")
    .replace(/\b\d{1,2}\s*(?:pr|ply|lonas)\b/gi, " ");
  if (application) rest = rest.replace(new RegExp(String.raw`(?<![\w/-])${application.replace(/[/ ]/g, String.raw`[\s/]*`)}(?![\w/-])`, "gi"), " ");
  rest = rest.replace(/\s+/g, " ").trim();
  if (!brand) [brand, rest] = [rest.split(" ")[0] ?? "", rest.split(" ").slice(1).join(" ")];
  if (!brand || !rest) return "Falta la marca o el modelo, p.ej. *Fenixway Flama 66*";
  return { id, aliases: [id, fold(rest)], brand, model: rest, size, ply, application, price: parseFloat(price[1].replace(",", ".")), currency: contract?.currency ?? "USD", source: "db", inConfig: false };
}
