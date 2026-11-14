/**
 * Medidas dictadas guiadas por el catálogo (corrida F, punto 9). Prueba real con Deepgram (14/11):
 *   "Cotízame 8 Fenix Way valor 99 en 295 80, ER 22.5 para ZBUSS."  -> la coma y "ER" rompían la medida; las cifras sueltas
 *     se leyeron como precio (295) y cantidad (8) y quedó "… 22.5 x8", que el cotizador leyó como la medida 22.5-8.
 *   "2 9 5 80 R 22.5."  (solo la medida, cuando el bot la pidió) -> los dígitos sueltos no formaban el ancho.
 *
 * En vez de más expresiones sueltas, se mira la zona de la medida como una secuencia de números:
 *  1. Zona: números seguidos, con lo que puede ir entre ellos al dictar una medida: espacios, la R en todas sus formas
 *     transcritas ("R", "r", "ER", "erre", "ere", "ar"), separadores ("/", "-", "por", "x", "barra", "slash", "sobre", comas,
 *     puntos) y "aro"/"rin". Cualquier otra palabra la corta ("8 Fenixway Valor 99 en 295 80 R 22.5": la zona es
 *     "295 80 R 22.5"; el 8 y el 99 quedan fuera).
 *  2. Candidatas: cada tramo seguido de números de la zona, agrupado en ancho/perfil/aro o ancho/aro. Dentro de un grupo,
 *     números separados solo por espacios se unen ("2 9 5" -> 295, "22 5" -> 22.5, "7 50" -> 7.50); la R solo puede ir
 *     antes del aro. Sin R dicha se prueba radial y, si el aro no es .5, también convencional ("7 50 16": 7.50R16 o 7.50-16).
 *  3. Contra el catálogo: valen las candidatas que existen en él (canónicas, o la misma medida con LT/C). Gana el tramo que
 *     usa más números (la cantidad suelta delante, "8 295 80 22.5", queda fuera porque "8295" no es medida). Una sola
 *     medida -> se usa; varias -> se pregunta; ninguna -> la zona se deja escrita en limpio ("275 80 R 22") para que el
 *     cotizador/checkSizes la lean y pregunten.
 *  Sin catálogo (no se pudo leer) se acepta lo plausible (ancho, perfil y aro de llanta), solo radial.
 *
 * Puro (sin store ni red). Entrada: texto con los números ya en cifras (dictation.ts spokenToDigits).
 */
import { fold } from "../../tyre/brands";
import { parseTyreSize, sizeCore } from "../../tyre/spec";

const R_WORDS = new Set(["r", "er", "erre", "ere", "ar", "rr", "err"]);
const SEP_WORDS = new Set(["por", "x", "barra", "slash", "sobre"]);
const NEUTRAL_WORDS = new Set(["aro", "rin", "rim"]);
/** Aros de llanta (para lo plausible sin catálogo y para "22 5" -> 22.5). */
const RIMS = new Set([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 17.5, 19.5, 22.5, 24.5]);

type Kind = "num" | "R" | "dash" | "sep" | "ws" | "other";
interface Tok {
  kind: Kind;
  raw: string;
  start: number;
  end: number;
}

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)|(\p{L}+)|(\s+)|([^\s\p{L}\d])/gu)) {
    const start = m.index!;
    const raw = m[0];
    let kind: Kind;
    if (m[1]) kind = "num";
    else if (m[2]) {
      const w = fold(raw);
      // una "x" pegada a la cifra que sigue es cantidad escrita ("x8"), no separador
      if (w === "x" && /^\d/.test(text.slice(start + raw.length))) kind = "other";
      else kind = R_WORDS.has(w) ? "R" : SEP_WORDS.has(w) || NEUTRAL_WORDS.has(w) ? "sep" : "other";
    } else if (m[3]) kind = "ws";
    else kind = raw === "-" ? "dash" : /[/,.;:×]/.test(raw) ? "sep" : "other";
    out.push({ kind, raw, start, end: start + raw.length });
  }
  return out;
}

/** Qué hay entre dos números de la zona: solo espacios, una R, un guion u otro separador. */
type Gap = "ws" | "R" | "dash" | "sep";

interface Zone {
  start: number;
  end: number;
  nums: Tok[];
  /** gaps[k] = entre nums[k] y nums[k+1]. */
  gaps: Gap[];
}

function zonesOf(toks: Tok[]): Zone[] {
  const zones: Zone[] = [];
  let cur: { nums: Tok[]; gaps: Gap[]; between: Kind[] } | null = null;
  const close = () => {
    if (cur && cur.nums.length >= 2) zones.push({ start: cur.nums[0].start, end: cur.nums[cur.nums.length - 1].end, nums: cur.nums, gaps: cur.gaps });
    cur = null;
  };
  for (const t of toks) {
    if (t.kind === "other") {
      close();
      continue;
    }
    if (t.kind === "num") {
      if (!cur) cur = { nums: [], gaps: [], between: [] };
      if (cur.nums.length) {
        const b = cur.between;
        cur.gaps.push(b.includes("R") ? "R" : b.includes("dash") ? "dash" : b.includes("sep") ? "sep" : "ws");
      }
      cur.nums.push(t);
      cur.between = [];
    } else if (cur) {
      cur.between.push(t.kind);
      // dos separadores fuertes seguidos ("22.5. 8") cortan la zona
      if (cur.between.filter((k) => k === "sep").length > 2) close();
    }
  }
  close();
  return zones;
}

/** Las formas de un grupo de números unidos solo por espacios: "2 9 5" -> ["295"], "22 5" -> ["225", "22.5"], "7 50" -> ["750", "7.50"]. */
function groupForms(nums: string[]): string[] {
  if (nums.length === 1) return [nums[0]];
  if (nums.some((n) => n.includes("."))) return [];
  const out: string[] = [];
  const joined = nums.join("");
  if (joined.length <= 4) out.push(joined);
  if (nums.length === 2 && nums[1].length <= 2) out.push(`${nums[0]}.${nums[1]}`);
  return out;
}

export interface SizeCandidate {
  canonical: string;
  /** Números de la zona usados (más = mejor). */
  used: number;
  /** Índices [desde, hasta] dentro de zone.nums. */
  from: number;
  to: number;
  /** La R (o el guion) se dijo antes del aro: a igual cantidad de números, gana ("6 12 R 20" = 6 y 12R20, no 6R12). */
  said: boolean;
}

/** Todas las candidatas de una zona que acepta `accept` (en el catálogo, o plausibles). */
function candidatesOf(zone: Zone, accept: (canonical: string) => string[]): SizeCandidate[] {
  const out: SizeCandidate[] = [];
  const n = zone.nums.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < Math.min(n, i + 7); j++) {
      // cortes del tramo [i..j] en 2 o 3 grupos; un grupo solo une números separados por espacios
      const cuts: number[][] = [];
      for (let a = i; a < j; a++) {
        cuts.push([a]);
        for (let b = a + 1; b < j; b++) cuts.push([a, b]);
      }
      for (const cut of cuts) {
        const bounds = [i - 1, ...cut, j];
        const groups: string[][] = [];
        let ok = true;
        for (let g = 0; g < bounds.length - 1 && ok; g++) {
          const from = bounds[g] + 1;
          const to = bounds[g + 1];
          for (let k = from; k < to; k++) if (zone.gaps[k] !== "ws") ok = false;
          groups.push(zone.nums.slice(from, to + 1).map((t) => t.raw));
        }
        if (!ok) continue;
        // la R solo antes del aro (un guion antes, "295-80", es un separador más)
        const boundaryGaps = cut.map((c) => zone.gaps[c]);
        if (boundaryGaps.slice(0, -1).some((g) => g === "R")) continue;
        const last = boundaryGaps[boundaryGaps.length - 1];
        const forms = groups.map(groupForms);
        if (forms.some((f) => !f.length)) continue;
        const combos: string[][] = forms.reduce<string[][]>((acc, f) => acc.flatMap((p) => f.map((x) => [...p, x])), [[]]);
        for (const parts of combos) {
          // sin R ni guion dichos: radial, y también convencional si el aro no es .5 (las de aro .5 son radiales)
          const cons = last === "R" ? ["R"] : last === "dash" ? ["-"] : /\.5$/.test(parts[parts.length - 1]) ? ["R"] : ["R", "-"];
          for (const c of cons) {
            const written = parts.length === 3 ? `${parts[0]}/${parts[1]}${c}${parts[2]}` : `${parts[0]}${c}${parts[1]}`;
            const p = parseTyreSize(written);
            if (!p) continue;
            // lo que parseTyreSize leyó debe ser todo lo escrito (sin descartar cifras)
            if (p.raw.replace(/\s/g, "") !== written.toUpperCase()) continue;
            for (const canonical of accept(p.canonical)) out.push({ canonical, used: j - i + 1, from: i, to: j, said: last === "R" || last === "dash" });
          }
        }
      }
    }
  }
  return out;
}

/** Plausible sin catálogo: métrica de camión/auto (ancho 125–445, perfil 30–95) o numérica (ancho 6–14 o 6.50–12.00), aro de llanta. */
function plausible(canonical: string): boolean {
  const p = parseTyreSize(canonical);
  if (!p || !RIMS.has(p.rim) || p.construction !== "R") return false;
  if (p.kind === "metric") return p.aspect !== undefined && p.width >= 125 && p.width <= 445 && p.aspect >= 30 && p.aspect <= 95;
  // anchos con decimales de verdad (7.50, 8.25, 9.5, 12.00), no "6 12" pegado como 6.12
  if (p.kind === "numeric") return p.aspect === undefined && !p.suffix && p.width >= 6 && p.width <= 14 && [0, 0.25, 0.5, 0.75].includes(Math.round((p.width % 1) * 100) / 100);
  return false;
}

export interface ResolvedSize {
  /** Lo dictado, tal como quedó en el texto ("295 80, ER 22.5"). */
  from: string;
  /** La medida canónica. */
  to: string;
  /** true si la lectura de siempre (sin catálogo) ya daba esta medida: no hace falta decir que se corrigió. */
  plain: boolean;
}

export interface AmbiguousSize {
  from: string;
  /** Medidas del catálogo que puede ser (2–3, canónicas). La primera queda en el texto hasta que se elija. */
  options: string[];
}

export interface SizeResolution {
  /** El texto con cada zona reconocida cambiada por su medida canónica (y las demás escritas en limpio). */
  text: string;
  resolved: ResolvedSize[];
  ambiguous: AmbiguousSize[];
  /** Zonas con forma de medida (con R o aro .5) que no coinciden con nada del catálogo, ya escritas en limpio. */
  unmatched: string[];
  /**
   * El mismo texto con cada medida resuelta como `⟦n⟧` (n = índice en `marks`): para pasar el resto por otras lecturas
   * sin que vuelvan a tocar la medida ya resuelta ("6 12R20" no es "6.12R20").
   */
  marked: string;
  marks: string[];
}

/** La zona escrita en limpio para el cotizador: "275 80, AR 22" -> "275 80 R 22", "295 barra 80" -> "295/80". */
function cleanZone(zone: Zone): string {
  let s = zone.nums[0].raw;
  for (let k = 0; k < zone.gaps.length; k++) {
    const g = zone.gaps[k];
    const sepRaw = g === "R" ? " R " : g === "dash" ? "-" : g === "sep" ? " " : " ";
    s += sepRaw + zone.nums[k + 1].raw;
  }
  return s.replace(/\s+/g, " ");
}

const sizeLike = (zone: Zone) => zone.gaps.includes("R") || zone.nums.some((t) => /^(?:17|19|22|24)\.5$/.test(t.raw));

/** La lectura de siempre (dictation.ts normalizeSpokenSizes + findTyreSizes), inyectada para no depender en ciclo. */
export type PlainReader = (zoneText: string) => string[];

/**
 * Las medidas dictadas del texto, contra el catálogo (ver la cabecera). `catalogSizes` vacío o null = sin catálogo
 * (solo lo plausible). `plainRead` (opcional) dice qué medida daba la lectura de siempre, para marcar `plain`.
 */
export function resolveSpokenSizes(text: string, catalogSizes: Iterable<string> | null | undefined, plainRead?: PlainReader): SizeResolution {
  const cat = new Set(catalogSizes ?? []);
  const byCore = new Map<string, string[]>();
  for (const c of cat) {
    const k = sizeCore(c);
    byCore.set(k, [...(byCore.get(k) ?? []), c]);
  }
  const accept = (canonical: string): string[] => {
    if (!cat.size) return plausible(canonical) ? [canonical] : [];
    if (cat.has(canonical)) return [canonical];
    // la misma medida con LT/C en el catálogo ("195 R 15" -> 195R15C)
    return byCore.get(sizeCore(canonical)) ?? [];
  };
  const toks = tokenize(text ?? "");
  const zones = zonesOf(toks);
  const res: SizeResolution = { text: text ?? "", resolved: [], ambiguous: [], unmatched: [], marked: text ?? "", marks: [] };
  const edits: { start: number; end: number; to: string; mark?: boolean }[] = [];

  const solve = (zone: Zone, fromStart?: number): void => {
    const all = candidatesOf(zone, accept);
    // la cantidad pegada al ancho ("Cotiza 4235 por 75 r 17.5": "cuatro doscientos treinta y cinco" llegó junto): solo si
    // el número entero no da ninguna medida y su final sí (contra el catálogo); lo de delante queda como cantidad
    if (!all.length && cat.size && /^\d{4,5}$/.test(zone.nums[0].raw) && fromStart === undefined) {
      for (const keep of [3, 2]) {
        const head = zone.nums[0];
        const cut = head.raw.length - keep;
        if (cut < 1 || head.raw[cut] === "0") continue;
        const split: Tok = { kind: "num", raw: head.raw.slice(cut), start: head.start + cut, end: head.end };
        const z2: Zone = { ...zone, start: split.start, nums: [split, ...zone.nums.slice(1)] };
        if (!candidatesOf(z2, accept).length) continue;
        edits.push({ start: split.start, end: split.start, to: " " });
        solve(z2, head.start);
        return;
      }
    }
    if (!all.length) {
      if (sizeLike(zone)) {
        const clean = cleanZone(zone);
        res.unmatched.push(clean);
        edits.push({ start: zone.start, end: zone.end, to: clean });
      }
      return;
    }
    const score = (c: SizeCandidate) => c.used * 2 + (c.said ? 1 : 0);
    const best = Math.max(...all.map(score));
    const top = all.filter((c) => score(c) === best);
    // tramos distintos que no se pisan = medidas distintas ("12 R 22.5 11 R 22.5"); se resuelve el primero y el resto aparte
    const first = top.reduce((a, b) => (b.from < a.from ? b : a));
    const same = top.filter((c) => c.from === first.from && c.to === first.to);
    const options = [...new Set(same.map((c) => c.canonical))];
    const start = zone.nums[first.from].start;
    const end = zone.nums[first.to].end;
    const from = text.slice(first.from === 0 && fromStart !== undefined ? fromStart : start, end);
    if (options.length === 1) {
      const plain = plainRead ? plainRead(from).length === 1 && plainRead(from)[0] === options[0] : false;
      res.resolved.push({ from, to: options[0], plain });
    } else res.ambiguous.push({ from, options: options.slice(0, 3) });
    edits.push({ start, end, to: options[0], mark: true });
    // lo que queda a la derecha puede ser otra medida
    if (zone.nums.length - first.to - 1 >= 2) {
      const rest = zone.nums.slice(first.to + 1);
      solve({ start: rest[0].start, end: rest[rest.length - 1].end, nums: rest, gaps: zone.gaps.slice(first.to + 1) });
    }
  };
  for (const z of zones) solve(z);
  // de atrás hacia adelante; en la misma posición, el espacio que separa la cantidad va después (queda delante)
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - b.start - (a.end - a.start));
  let out = res.text;
  let marked = res.text;
  const marks: string[] = [];
  for (const e of ordered) {
    out = `${out.slice(0, e.start)}${e.to}${out.slice(e.end)}`;
    marked = `${marked.slice(0, e.start)}${e.mark ? `⟦${marks.push(e.to) - 1}⟧` : e.to}${marked.slice(e.end)}`;
  }
  res.text = out;
  res.marked = marked;
  res.marks = marks;
  return res;
}

/** Palabras que pueden acompañar una medida dictada sola ("la medida es 295 80 R 22.5", "perdón, sería 11 R 22.5"). */
const SIZE_ONLY_WORDS = new Set(
  "la el es era seria sería medida medidas perdon perdón digo mejor no si sí ok okey ya entonces son llanta llantas de aro rin r er erre ere ar por x barra slash sobre"
    .split(" ")
    .map(fold),
);

/** El mensaje es solo una medida dictada (cifras, R, separadores y palabras de relleno): se interpreta entero como medida. */
export function isSizeOnly(text: string): boolean {
  const t = text ?? "";
  if (!/\d/.test(t)) return false;
  return [...t.matchAll(/\p{L}+/gu)].every((m) => SIZE_ONLY_WORDS.has(fold(m[0])));
}
