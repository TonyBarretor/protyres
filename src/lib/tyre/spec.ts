/**
 * Tyre size parsing & normalization.
 *
 * Providers and customers write the same tyre many ways:
 *   "295/80R22.5", "295/80 R 22,5", "295/80 x R22.5", "295/80R22.5 152/148M", "11R22.5", "11 R 22.5",
 *   "11x22.5" (bias), "10.00R20", "1000R20", "1000-20", "7.50 16" (bias, JCH style), "155R12C", "185 R14C",
 *   "12.5/80-18", "19.5L-24", "16.9R30", "18.4-34", "300-15", "300 x R15", "28x9-15", "31x10.50R15", "25X10-12" ...
 * Everything is reduced to one canonical string so that one search covers all sources.
 */

export type TyreKind = "metric" | "numeric" | "flotation" | "industrial";

export interface TyreSize {
  /** Canonical form used for matching, e.g. "295/80R22.5", "11R22.5", "10R20", "155R12C", "12.5/80-18", "300-15". */
  canonical: string;
  /** Conventional display form, e.g. "10.00R20" instead of "10R20". */
  display: string;
  kind: TyreKind;
  /** Section width (mm for metric, inches otherwise; overall diameter for flotation). */
  width: number;
  /** Aspect ratio (metric / agricultural) or section width in inches (flotation). */
  aspect?: number;
  /** "R" radial, "-" bias. */
  construction: "R" | "-";
  /** True when the text stated the construction explicitly (R, ZR, X, -). */
  constructionExplicit: boolean;
  /** Rim diameter in inches, e.g. 22.5 */
  rim: number;
  /** e.g. "152/148" or "91" */
  loadIndex?: string;
  /** e.g. "M", "V" */
  speedIndex?: string;
  /** "LT", "P", "ST", "C" ... */
  prefix?: string;
  /** "L" for low-profile agricultural sizes like 19.5L-24. */
  suffix?: string;
  /** Text as it was found (trimmed, normalized). */
  raw: string;
}

export interface TyreSizeMatch extends TyreSize {
  /** Position of the match inside the normalized text. */
  index: number;
  /** Length of the matched text. */
  length: number;
}

const PREFIX = "(?:(?<prefix>LT|P|ST|T|C)\\s*)?";
const RIM = "(?<rim>\\d{1,2}(?:\\.\\d{1,2})?)";
const CONSTRUCTION = "(?<cons>ZRF|RF|[HSTVWYZ]R|R|B|D|-|X|×)";
// separator between width/aspect and rim: a construction letter, optionally preceded by "x" ("215/75 x R17.5"),
// or just whitespace ("295/80 22.5"). Captured whole; `constructionOf` interprets it.
const SEP = "(?<sep>\\s*(?:[X×]\\s*)?(?:ZRF|RF|[HSTVWYZ]R|R|B|D|-|X|×)\\s*|\\s+)";
const LOAD_SPEED = "(?:\\s*(?<li>\\d{2,3}(?:\\/\\d{2,3})?)\\s*(?<si>[A-Z])(?![A-Z]))?";
const TRAILING = "(?<trailing>C|LT)?"; // commercial suffix: 205/65R16C, 7.50R16LT
const NOT_BEFORE = "(?<![\\d./,])";
const NOT_AFTER = "(?![\\d.]|,\\d)";

// 295/80R22.5, 295/80 R 22.5, 295/80-22.5, 215/75 x R17.5, LT265/70R17, 205/65R16C, 295/80R22.5 152/148M, 600/65R34
const METRIC_RE = new RegExp(`${NOT_BEFORE}${PREFIX}(?<w>\\d{3})\\s*\\/\\s*(?<a>\\d{2,3})${SEP}${RIM}${TRAILING}${NOT_AFTER}${LOAD_SPEED}`, "g");

// 155R12C, 185 R14C, 145 R12, LT155R12C  (82-series, no aspect ratio)
const METRIC82_RE = new RegExp(`${NOT_BEFORE}${PREFIX}(?<w>\\d{3})\\s*(?<sep>ZR|[HSTVWYZ]R|R)\\s*${RIM}${TRAILING}${NOT_AFTER}${LOAD_SPEED}`, "g");

// 12.5/80-18, 12.5/80 X 18, 10.5/80-18, 16.9/14-30  (agricultural / industrial with aspect)
const AG_RE = new RegExp(`${NOT_BEFORE}(?<w>\\d{1,2}(?:\\.\\d)?)\\s*\\/\\s*(?<a>\\d{2,3})${SEP}${RIM}${NOT_AFTER}${LOAD_SPEED}`, "g");

// 19.5L-24, 19.5L X 24, 21L-24, 30.5L-32  (agricultural low profile)
const AGL_RE = new RegExp(`${NOT_BEFORE}(?<w>\\d{1,2}(?:\\.\\d{1,2})?)\\s?L(?:${SEP})?${RIM}${NOT_AFTER}${LOAD_SPEED}`, "g");

// 31x10.50R15, 33X12.50R20, 25X10-12, 28x9-15, 18x7-8
const FLOTATION_RE = new RegExp(`${NOT_BEFORE}(?<w>\\d{2}(?:\\.\\d{1,2})?)\\s*[Xx×]\\s*(?<a>\\d{1,2}(?:\\.\\d{1,2})?)\\s*${CONSTRUCTION}?\\s*${RIM}${NOT_AFTER}${LOAD_SPEED}`, "g");

// 11R22.5, 11 R 22.5, 11-22.5, 11x22.5, 10.00R20, 1000R20, 1000-20, 7.50R16, 9.5R17.5, 8.25R20, 16.9R30, 18.4-34, 6.50-10
const NUMERIC_RE = new RegExp(`${NOT_BEFORE}(?<w>\\d{1,2}(?:\\.\\d{1,2})?|\\d{3,4})\\s*${CONSTRUCTION}\\s*${RIM}${TRAILING}${NOT_AFTER}${LOAD_SPEED}`, "g");

// "7.00 16", "7.50 15", "5.00 12", "12.00 20": two-decimal width + space + rim = bias (JCH style)
const NUMERIC_SPACE2_RE = new RegExp(`${NOT_BEFORE}(?<w>\\d{1,2}\\.\\d{2})\\s+${RIM}${NOT_AFTER}${LOAD_SPEED}`, "g");

// "11 24.5 16PR", "11 22.5 TL" (integer width + space + rim = bias, JCH style) only when ply / tube words follow
const NUMERIC_SPACE_INT_RE = new RegExp(`${NOT_BEFORE}(?<w>\\d{1,2})\\s+(?<rim>\\d{2}\\.5|20|24)(?=\\s*(?:\\d{1,2}\\s?(?:PR|PLY)\\b|TL\\b|TT\\b|TCF\\b))`, "g");

// 300-15, 300x15, 300 x R15, 250-15 (forklift / industrial, mm width without aspect)
const INDUSTRIAL_RE = new RegExp(`${NOT_BEFORE}(?<w>\\d{3})\\s*(?:-|[X×]\\s*R?|R)\\s*(?<rim>\\d{1,2})${NOT_AFTER}`, "g");
// "300 15 18PR" (space separated) only when ply / tube words follow, so "precio 250 15 unidades" is not a size
const INDUSTRIAL_SPACE_RE = new RegExp(`${NOT_BEFORE}(?<w>\\d{3})\\s+(?<rim>\\d{1,2})(?=\\s*(?:\\d{1,2}\\s?(?:PR|PLY)\\b|TL\\b|TT\\b|TCF\\b|NEUMATIC|SOLID|$))`, "g");
const INDUSTRIAL_WIDTHS = new Set([140, 150, 180, 200, 225, 250, 300, 315, 355, 400]);

// Same as NUMERIC_RE but allows a plain space as separator ("11 22.5"). Only used when the
// whole string is a single size (anchored), to avoid false positives inside free text.
const NUMERIC_SPACE_RE = new RegExp(`^(?<w>\\d{1,2}(?:\\.\\d{1,2})?|\\d{3,4})\\s+${RIM}${LOAD_SPEED}$`);

/** Normalize text before scanning: uppercase, decimal commas -> dots, fancy chars. */
export function normalizeSizeText(input: string): string {
  return input
    .toUpperCase()
    .replace(/(\d),(\d)/g, "$1.$2") // 22,5 -> 22.5
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function trimNumber(n: number): string {
  // 22.50 -> "22.5", 22 -> "22", 8.25 -> "8.25"
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(2)));
}

function numericWidth(token: string): number | null {
  // "1000" -> 10.00, "750" -> 7.50, "1100" -> 11.00, "11" -> 11, "9.5" -> 9.5
  if (/^\d{3,4}$/.test(token)) return parseInt(token, 10) / 100;
  const n = parseFloat(token);
  return Number.isFinite(n) ? n : null;
}

/** Interpret the separator text between width and rim: "R", " x R", "-", "X", " " ... */
function constructionOf(sep: string | undefined): { construction: "R" | "-"; explicit: boolean } {
  const t = (sep ?? "").toUpperCase().trim();
  if (!t) return { construction: "R", explicit: false }; // whitespace only: assume radial
  if (/R$|RF$/.test(t)) return { construction: "R", explicit: true }; // R, ZR, HR, RF (run-flat), X R
  return { construction: "-", explicit: true }; // B, D, X, -
}

const plausibleRim = (rim: number) => rim >= 8 && rim <= 54;
const plausibleNumericWidth = (w: number) => w >= 2 && w <= 35;
const plausibleMetric = (width: number, aspect: number) => width >= 80 && width <= 750 && aspect >= 20 && aspect <= 100;

interface Parts {
  prefix?: string;
  suffix?: string;
  width: number;
  aspect?: number;
  construction: "R" | "-";
  constructionExplicit: boolean;
  rim: number;
  loadIndex?: string;
  speedIndex?: string;
  /** "C" (commercial) or "LT" written after the rim. */
  trailing?: string;
}

function build(kind: TyreKind, p: Parts, raw: string): TyreSize {
  const rimStr = trimNumber(p.rim);
  const prefix = p.prefix ?? "";
  const c = p.trailing ? p.trailing.toUpperCase() : "";
  let canonical: string;
  let display: string;
  if (kind === "metric") {
    canonical = p.aspect !== undefined ? `${prefix}${p.width}/${p.aspect}${p.construction}${rimStr}${c}` : `${prefix}${p.width}${p.construction}${rimStr}${c}`;
    display = canonical;
  } else if (kind === "flotation") {
    canonical = `${trimNumber(p.width)}X${trimNumber(p.aspect ?? 0)}${p.construction}${rimStr}`;
    display = `${trimNumber(p.width)}x${(p.aspect ?? 0).toFixed(2)}${p.construction}${rimStr}`;
  } else if (kind === "industrial") {
    canonical = `${p.width}-${rimStr}`;
    display = canonical;
  } else {
    const w = trimNumber(p.width);
    const aspect = p.aspect !== undefined ? `/${p.aspect}` : "";
    canonical = `${w}${aspect}${p.suffix ?? ""}${p.construction}${rimStr}${c}`;
    // Convention: tube-type sizes on whole-inch rims are written with two decimals (10.00R20),
    // tubeless sizes on x.5 rims with the plain width (11R22.5). Agricultural keep one decimal (16.9R30).
    const widthDisplay = p.aspect === undefined && !p.suffix && Number.isInteger(p.rim) && p.width < 16 ? p.width.toFixed(2) : w;
    display = `${widthDisplay}${aspect}${p.suffix ?? ""}${p.construction}${rimStr}${c}`;
  }
  return {
    canonical,
    display,
    kind,
    width: p.width,
    aspect: p.aspect,
    construction: p.construction,
    constructionExplicit: p.constructionExplicit,
    rim: p.rim,
    loadIndex: p.loadIndex,
    speedIndex: p.speedIndex,
    prefix: p.prefix,
    suffix: p.suffix,
    raw: raw.trim(),
  };
}

/**
 * Find every tyre size inside a piece of text (a spreadsheet cell, a PDF line, a WhatsApp message).
 * Results are ordered by position and never overlap. Patterns run from most to least specific.
 */
export function findTyreSizes(text: string): TyreSizeMatch[] {
  const norm = normalizeSizeText(text);
  const found: TyreSizeMatch[] = [];
  const push = (size: TyreSize, m: RegExpMatchArray) => {
    const index = m.index ?? 0;
    const length = m[0].length;
    if (found.some((f) => index < f.index + f.length && f.index < index + length)) return;
    found.push({ ...size, index, length });
  };

  const g = (m: RegExpMatchArray) => m.groups ?? {};

  for (const m of norm.matchAll(METRIC_RE)) {
    const { prefix, w, a, sep, rim, trailing, li, si } = g(m);
    const width = parseInt(w, 10);
    const aspect = parseInt(a, 10);
    const rimN = parseFloat(rim);
    if (!plausibleMetric(width, aspect) || !plausibleRim(rimN)) continue;
    const c = constructionOf(sep);
    push(build("metric", { prefix: prefix || undefined, width, aspect, construction: c.construction, constructionExplicit: c.explicit, rim: rimN, loadIndex: li, speedIndex: si, trailing }, m[0]), m);
  }
  for (const m of norm.matchAll(METRIC82_RE)) {
    const { prefix, w, sep, rim, trailing, li, si } = g(m);
    const width = parseInt(w, 10);
    const rimN = parseFloat(rim);
    if (width < 125 || width > 255 || !plausibleRim(rimN) || rimN > 20) continue;
    const c = constructionOf(sep);
    push(build("metric", { prefix: prefix || undefined, width, construction: c.construction, constructionExplicit: c.explicit, rim: rimN, loadIndex: li, speedIndex: si, trailing }, m[0]), m);
  }
  for (const m of norm.matchAll(AG_RE)) {
    const { w, a, sep, rim, li, si } = g(m);
    const width = parseFloat(w);
    const aspect = parseInt(a, 10);
    const rimN = parseFloat(rim);
    if (!plausibleNumericWidth(width) || aspect < 50 || aspect > 100 || !plausibleRim(rimN)) continue;
    const c = constructionOf(sep);
    push(build("numeric", { width, aspect, construction: c.construction, constructionExplicit: c.explicit, rim: rimN, loadIndex: li, speedIndex: si }, m[0]), m);
  }
  for (const m of norm.matchAll(AGL_RE)) {
    const { w, sep, rim, li, si } = g(m);
    const width = parseFloat(w);
    const rimN = parseFloat(rim);
    if (!plausibleNumericWidth(width) || !plausibleRim(rimN)) continue;
    const c = constructionOf(sep);
    // low-profile agricultural sizes are bias unless written with an R
    push(build("numeric", { width, suffix: "L", construction: c.explicit ? c.construction : "-", constructionExplicit: c.explicit, rim: rimN, loadIndex: li, speedIndex: si }, m[0]), m);
  }
  for (const m of norm.matchAll(FLOTATION_RE)) {
    const { w, a, cons, rim, li, si } = g(m);
    const diameter = parseFloat(w);
    const width = parseFloat(a);
    const rimN = parseFloat(rim);
    if (!plausibleRim(rimN) || diameter < 15 || diameter > 50 || width < 5 || width > 20) continue;
    const c = constructionOf(cons);
    push(build("flotation", { width: diameter, aspect: width, construction: c.construction, constructionExplicit: c.explicit, rim: rimN, loadIndex: li, speedIndex: si }, m[0]), m);
  }
  const forklift = (width: number, rimN: number) => width <= 3.5 && (rimN === 12 || rimN === 15); // "3.00-15" = 300-15
  for (const m of norm.matchAll(NUMERIC_RE)) {
    const { w, cons, rim, trailing, li, si } = g(m);
    const width = numericWidth(w);
    const rimN = parseFloat(rim);
    if (width === null || !plausibleNumericWidth(width) || !plausibleRim(rimN)) continue;
    const c = constructionOf(cons);
    if (forklift(width, rimN)) push(build("industrial", { width: Math.round(width * 100), construction: "-", constructionExplicit: false, rim: rimN }, m[0]), m);
    else push(build("numeric", { width, construction: c.construction, constructionExplicit: c.explicit, rim: rimN, loadIndex: li, speedIndex: si, trailing }, m[0]), m);
  }
  for (const m of norm.matchAll(NUMERIC_SPACE2_RE)) {
    const { w, rim, li, si } = g(m);
    const width = parseFloat(w);
    const rimN = parseFloat(rim);
    if (!plausibleNumericWidth(width) || !plausibleRim(rimN) || rimN > 24) continue;
    if (forklift(width, rimN)) push(build("industrial", { width: Math.round(width * 100), construction: "-", constructionExplicit: false, rim: rimN }, m[0]), m);
    else push(build("numeric", { width, construction: "-", constructionExplicit: false, rim: rimN, loadIndex: li, speedIndex: si }, m[0]), m);
  }
  for (const m of norm.matchAll(NUMERIC_SPACE_INT_RE)) {
    const { w, rim } = g(m);
    const width = parseInt(w, 10);
    const rimN = parseFloat(rim);
    if (width < 7 || width > 16 || !plausibleRim(rimN)) continue;
    push(build("numeric", { width, construction: "-", constructionExplicit: false, rim: rimN }, m[0]), m);
  }
  for (const re of [INDUSTRIAL_RE, INDUSTRIAL_SPACE_RE]) {
    for (const m of norm.matchAll(re)) {
      const { w, rim } = g(m);
      const width = parseInt(w, 10);
      const rimN = parseInt(rim, 10);
      if (!INDUSTRIAL_WIDTHS.has(width) || rimN < 8 || rimN > 20) continue;
      push(build("industrial", { width, construction: "-", constructionExplicit: false, rim: rimN }, m[0]), m);
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * Parse a string that is expected to be ONE tyre size (e.g. a "Medida" cell or a request).
 * Returns null when nothing plausible is found.
 */
export function parseTyreSize(input: string): TyreSize | null {
  if (!input) return null;
  const norm = normalizeSizeText(input);
  const matches = findTyreSizes(norm);
  if (matches.length > 0) {
    const { index: _i, length: _l, ...size } = matches[0];
    return size;
  }
  // Lenient: "11 22.5" (space only) when the whole string is just that.
  const m = norm.match(NUMERIC_SPACE_RE);
  if (m && m.groups) {
    const { w, rim, li, si } = m.groups;
    const width = numericWidth(w);
    const rimN = parseFloat(rim);
    if (width !== null && plausibleNumericWidth(width) && plausibleRim(rimN)) {
      return build("numeric", { width, construction: "R", constructionExplicit: false, rim: rimN, loadIndex: li, speedIndex: si }, norm);
    }
  }
  return null;
}

/** True when two sizes are the same tyre dimension (ignores load/speed index). */
export function sameSize(a: TyreSize | string, b: TyreSize | string): boolean {
  const ca = typeof a === "string" ? parseTyreSize(a)?.canonical : a.canonical;
  const cb = typeof b === "string" ? parseTyreSize(b)?.canonical : b.canonical;
  return !!ca && ca === cb;
}

/** Canonical without the LT/P/C prefix & suffix, for relaxed matching. */
export function sizeCore(canonical: string): string {
  return canonical.replace(/^(LT|P|ST|T|C)(?=\d)/, "").replace(/(C|LT)$/, "");
}

/** Canonical with the construction letter removed ("11R22.5" and "11-22.5" -> "11_22.5"), for loose matching. */
export function sizeLoose(canonical: string): string {
  return sizeCore(canonical).replace(/(ZR|R|-)(?=\d{1,2}(?:\.\d+)?$)/, "_");
}
