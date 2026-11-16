/**
 * Varias llantas en una nota de voz (corrida H, punto 5) y cotización de un cliente con contrato por voz (punto 6).
 * Puro: lo usa voice/dictation.ts (normalizeDictation) y, para las correcciones, bot/voice-quote.ts y la OC.
 *
 *  - unglueNumbers: Deepgram pega números de dos cosas distintas (prueba con 60 audios reales, 2026-11-16):
 *      "en 235, 75 r 17.54 valor 89"   -> "… 17.5 4 valor 89"   (aro + cantidad de la llanta siguiente)
 *      "valor 99295, 80 r 22.5"        -> "valor 99 295, 80 …"  (diseño del catálogo + ancho de la medida)
 *    Solo se separa cuando el resultado es un aro de camión (17.5, 19.5, 22.5, 24.5) seguido de palabra, o un diseño que
 *    existe en el catálogo seguido de un ancho plausible: nunca se adivina un número.
 *  - markUbs: la UB (unidad blindada de Prosegur, siempre 4 dígitos) dicha de cualquier forma: "UB 1231", "u be mil
 *    doscientos treinta y uno" (ya en cifras), "unidad 1231", "unidad blindada 1231", "UB uno dos tres uno" (1 2 3 1),
 *    "UB 12 31", "1.231". Con un cliente que pide UB (perfil con `ub` obligatorio) también lo que Deepgram hace con "u be"
 *    ("v grande 1231", "v 1231", "U 1231", "un 2005"), "para la 1231" y un número suelto de 4 cifras en la línea.
 *    Cada UB queda apartada (¤n¤) con su valor; si no tiene 4 cifras se marca como inválida (se pregunta).
 *  - groupItems: el pedido (medidas ya apartadas como §n§, UBs como ¤n¤, sin cliente ni condiciones) -> una línea por
 *    llanta. Separa por comas, puntos, "y", "más", "también", "además", "otra", "luego", y dentro de un trozo antes de
 *    cada cantidad que empieza otra llanta ("… §0§ 12 Flama 89 …"). Lo que no es llanta por sí solo se une a la que
 *    corresponde: "8," y "1231," delante de "valor 99" (van con la siguiente), "en §0§ a 198" detrás de "Westlake CM 958"
 *    (con la anterior), "77" detrás de "4 Flama" (el número del diseño). La línea sin medida hereda la de la anterior y lo
 *    dice. Lo que no puede separar con seguridad (dos medidas en una llanta, un número que no sabe de quién es, la primera
 *    llanta sin medida cuando otras sí la tienen) va en `doubts`: quien llama muestra lo entendido y pregunta.
 *  - parseVoiceEdit: con una cotización (o un pedido) a la vista, las correcciones dirigidas y lo que se agrega:
 *      "el segundo eran diez" / "El 2º eran 10."    -> { kind: "quantity", line: 2, value: 10 }  ("cantidad 2 10")
 *      "quita el tercero" / "Elemena el 2º."         -> { kind: "remove", line: 3 }               ("quitar 3")
 *      "al primero ponle precio 259"                 -> { kind: "price", line: 1, value: 259 }    ("precio 1 259")
 *      "agrega / añade / súmale / también …"         -> { kind: "add", text: "…" }                ("agregar …")
 *    El verbo se compara por parecido (fuzzy.ts): "Elemena" = "elimina". "ponle N" sin unidad: N < 100 es cantidad y
 *    N ≥ 100 es precio (las llantas que se cotizan valen más de US$ 100 y nadie pide 100 en una línea por voz).
 */
import { fold } from "../../tyre/brands";
import { jaroWinkler } from "./fuzzy";

// ── números pegados ──

/** "17.54 valor" -> "17.5 4 valor": un aro .5 de camión con la cantidad de la llanta siguiente pegada. */
const GLUED_RIM = /(?<![\d.,])(1[79]|2[24])[.,]5(\d{1,2})(?=\s*,?\s+\p{L})(?!\s*,?\s+(?:d[oó]lares|soles|usd|d[ií]as|por)(?![\p{L}]))/gu;

/** Separa los números que Deepgram pegó (ver la cabecera). `designs`: diseños del catálogo ("Valor 99"). */
export function unglueNumbers(text: string, designs: { model: string }[] = []): string {
  let t = (text ?? "").replace(GLUED_RIM, "$1.5 $2");
  if (designs.length) {
    const models = new Set(designs.map((d) => fold(d.model)));
    // "valor 99295, 80" -> "valor 99 295, 80": el diseño existe y lo que sobra es un ancho seguido del perfil
    t = t.replace(/(?<![\p{L}\d])(\p{L}[\p{L}-]*)\s+(\d{2,3})(\d{3})(?=\s*[,/]?\s*\d{2}(?!\d))/gu, (all, word: string, model: string, width: string) => {
      const w = parseInt(width, 10);
      return models.has(fold(`${word} ${model}`)) && w >= 125 && w <= 445 ? `${word} ${model} ${width}` : all;
    });
  }
  return t;
}

// ── UB ──

/**
 * "para la 1 2 2 0 1", "UB 1 2 3 1": las cifras de una UB dictadas una por una se juntan ANTES de leer las medidas (si no,
 * "1 2 2 0 1" se lee como la medida 12.00R20). Solo cifras sueltas (3 o más) tras "para la" o una forma de "UB".
 */
export function joinUbDigits(text: string): string {
  return (text ?? "").replace(/(?<![\p{L}\d])((?:para\s+(?:la|el)|u\.?\s?b\.?|u\s+be|ube|unidad(?:\s+blindada)?|v(?:\s+grande)?|u)\s+)((?:\d\s+){2,5}\d)(?![\d.,]?\d|\s+\d)/giu, (_, head: string, digits: string) => `${head}${digits.replace(/\s+/g, "")}`);
}

export interface UbMark {
  /** Las cifras oídas, juntas ("1231"; "181" o "12201" si no son 4). */
  value: string;
  /** Lo que se dijo ("para la v grande 1231"). */
  from: string;
  /** Tiene 4 cifras. */
  valid: boolean;
}

/** Las cifras de una UB: "1231", "1.231", "12 31", "1 2 3 1" (grupos de 1–2 cifras se juntan; uno de 3 o más va solo). */
function ubDigits(raw: string): string {
  const s = raw.trim();
  if (/^\d{1,3}[.,]\d{3}$/.test(s)) return s.replace(/[.,]/, "");
  const groups = s.split(/\s+/).filter(Boolean);
  if (groups[0].length >= 3) return groups[0];
  let out = "";
  for (const g of groups) {
    if (g.length > 2) break;
    out += g;
  }
  return out;
}

const UB_DIGITS = String.raw`(\d{1,3}[.,]\d{3}(?!\d|[.,]\d)|\d{3,6}(?!\d|[.,]\d)|\d{1,2}(?:\s+\d{1,2}(?!\d|[.,]\d))+)`;
/** Formas claras: UB, U.B., u be, ube, uve be, unidad (blindada) seguida de cifras. */
const UB_STRONG = new RegExp(String.raw`(?:\bpara\s+)?(?:\b(?:la|el)\s+)?(?<![\p{L}\d])(?:u\.?\s?b\.?|u\s+be|ube|uve\s+be|unidad(?:\s+blindada)?)(?![\p{L}\d])\s*(?:n[uú]mero\s+|:\s*)?${UB_DIGITS}`, "giu");
/** Lo que Deepgram hace con "u be" (solo con un cliente que pide UB): "v grande", "v", "u", "uv", "uvni", "un". */
const UB_WEAK = new RegExp(String.raw`(?:\bpara\s+)?(?:\b(?:la|el)\s+)?(?<![\p{L}\d])(?:v\s+grande|uve|uvni|uv|v|u|un|ve)(?![\p{L}\d])\s+${UB_DIGITS}`, "giu");
/** "para la 1231", "para la 1 2 3 1" (solo con un cliente que pide UB). */
const UB_FOR = new RegExp(String.raw`\bpara\s+(?:la|el)\s+${UB_DIGITS}`, "giu");
/** Un número suelto de 4 cifras (no precio): la UB de la línea (solo con un cliente que pide UB). */
const UB_BARE = /(?<!\b(?:a|al|precio|de|en)\s|\$\s?)(?<![\d.,/§¤\p{L}])(\d{4})(?!\d|[.,]\d|[/§¤])(?!\s*(?:d[oó]lares|soles|usd))/giu;

/**
 * Aparta las UBs del texto (¤n¤). `level`: 0 = solo las formas claras ("UB 1231", "unidad 1231"); 1 = también las formas
 * oídas de "u be" ("v grande 1231", "U 181") y "para la 1231" (un "agrega …" en una cotización abierta); 2 = además un
 * número suelto de 4 cifras (el cliente pide UB en cada línea). Las medidas tienen que estar ya apartadas (§n§).
 */
export function markUbs(text: string, level: 0 | 1 | 2): { text: string; ubs: UbMark[] } {
  const ubs: UbMark[] = [];
  const mark = (minDigits: number) => (all: string, raw: string) => {
    const value = ubDigits(raw);
    if (value.length < minDigits) return all;
    ubs.push({ value, from: all.trim(), valid: value.length === 4 });
    return ` ¤${ubs.length - 1}¤ `;
  };
  let t = text.replace(UB_STRONG, mark(1));
  if (level >= 1) {
    t = t.replace(UB_WEAK, mark(3));
    t = t.replace(UB_FOR, mark(3));
  }
  if (level >= 2) t = t.replace(UB_BARE, mark(4));
  return { text: t, ubs };
}

// ── llantas ──

/** Precio dictado (mismo criterio que dictation.ts). */
export const PRICE_RE = /(?:\b(?:a|en|precio(?:\s+de)?|a\s+precio\s+de|al\s+precio\s+de)\s+)(?:us\$|\$|s\/\.?|usd)?\s*(\d{2,6}(?:\.\d{1,2})?)(?:\s*(?:d[oó]lares|soles|usd))?(?![\d./§%]|\s*(?:d[ií]as|%|por\s*ciento))/i;
/** Palabras que no describen la llanta. */
const NOT_DESC = /(?<![\p{L}\d])(?:en|de|del|la|las|el|los|medida|llantas?|neum[aá]ticos?|unidades|unidad|unid|und|aro|para|con|a|al|precio|d[oó]lares|soles|usd|y|x|cada|una?|otras?|otros?|son|eran|que|sean?)(?![\p{L}\d])/giu;
const QTY_UNIT = String.raw`(?:llantas?|neum[aá]ticos?|unidades|unid|und)`;
/** Separadores entre llantas (los números en palabras ya son cifras: "noventa y nueve" ya no tiene "y"). */
const SEPARATORS = /\s*(?:[,;:]|\.(?=\s|$)|(?<![\p{L}])(?:y|m[aá]s|tambi[eé]n|adem[aá]s|otr[ao]s?|luego|despu[eé]s)(?![\p{L}]))\s*/giu;
/** Antes de una cantidad que empieza otra llanta: lo que no es (precio, diseño "Valor 99", "x 4"). */
const NOT_QTY_BEFORE = new Set(["a", "al", "precio", "en", "x", "por", "us", "usd", "de", "del"]);

interface Tok {
  s: string;
  at: number;
  kind: "size" | "ub" | "num" | "word" | "other";
}

function tokens(t: string): Tok[] {
  const out: Tok[] = [];
  for (const m of t.matchAll(/§\d+§|¤\d+¤|\d+(?:\.\d+)?|\p{L}[\p{L}\p{N}]*|\S/gu)) {
    const s = m[0];
    out.push({ s, at: m.index!, kind: s.startsWith("§") ? "size" : s.startsWith("¤") ? "ub" : /^\d/.test(s) ? "num" : /^\p{L}/u.test(s) ? "word" : "other" });
  }
  return out;
}

/** ¿El número en la posición i es la cantidad de una llanta que empieza ahí? ("§0§ 12 Flama", "¤0¤ 4 valor"). */
function startsItem(toks: Tok[], i: number): boolean {
  const t = toks[i];
  if (t.kind !== "num" || !/^\d{1,3}$/.test(t.s) || parseInt(t.s, 10) === 0) return false;
  const prev = toks[i - 1];
  // "Valor 99", "CM 958" (el número del diseño), "a 254" (precio), "x 4"
  if (prev && prev.kind === "word" && (NOT_QTY_BEFORE.has(fold(prev.s)) || !/^y$/i.test(prev.s))) return false;
  if (prev && prev.kind === "other" && /[$%]/.test(prev.s)) return false;
  const next = toks[i + 1];
  if (!next) return false;
  if (next.kind === "size") return true;
  return next.kind === "word" && !/^(?:d[ií]as|por|%|d[oó]lares|soles|usd)$/i.test(next.s);
}

interface Features {
  sizes: number;
  ubs: number;
  price: boolean;
  /** Empieza con una cantidad ("4 …", "8 llantas"). */
  qtyLead: boolean;
  /** Tiene palabras que describen la llanta (marca, diseño). */
  desc: boolean;
  /** Solo cifras sueltas (sin medida, UB, precio ni descripción): "4", "77". */
  bareNumber: boolean;
}

/** ¿La palabra es una marca o un diseño del catálogo? (para no tomar ruido como llanta: "un llegado 1231"). */
export type KnownWord = (foldedWord: string) => boolean;

function features(c: string, known?: KnownWord): Features {
  const sizes = (c.match(/§\d+§/g) ?? []).length;
  const ubs = (c.match(/¤\d+¤/g) ?? []).length;
  const price = PRICE_RE.test(c);
  const rest = c.replace(PRICE_RE, " ").replace(/§\d+§|¤\d+¤/g, " ");
  const qtyLead = new RegExp(String.raw`^\s*(?:x\s*)?\d{1,3}(?![\d.])(?:\s*${QTY_UNIT})?(?:\s|$)`, "iu").test(c);
  const words = rest.replace(NOT_DESC, " ").replace(/\d+(?:\.\d+)?/g, " ");
  // con una UB, palabras sueltas que no son del catálogo son ruido de la transcripción ("un llegado 1231")
  const desc = /\p{L}/u.test(words) && !(ubs && !sizes && known && !fold(words).split(" ").some((w) => w && known(w)));
  const bareNumber = !sizes && !ubs && !price && !desc && /\d/.test(rest);
  return { sizes, ubs, price, qtyLead, desc, bareNumber };
}

/** ¿Alguna palabra del trozo es una marca o un diseño del catálogo? */
function knownIn(c: string, known: KnownWord): boolean {
  return fold(c.replace(/§\d+§|¤\d+¤/g, " ")).split(" ").some((w) => w && known(w));
}

/** Un trozo con varias llantas sin separador ("… §0§ 12 Flama 89 en §1§"): se corta antes de cada cantidad que empieza otra. */
function splitInside(c: string, known?: KnownWord): string[] {
  const toks = tokens(c);
  const cuts: number[] = [];
  let from = 0;
  for (let i = 1; i < toks.length; i++) {
    if (!startsItem(toks, i)) continue;
    const before = c.slice(from, toks[i].at);
    const f = features(before, known);
    // la llanta de antes ya está completa (tiene medida o UB), o tiene descripción y lo que sigue también
    const after = features(c.slice(toks[i].at), known);
    if (f.sizes || f.ubs || (f.desc && after.desc && (f.qtyLead || f.price))) {
      cuts.push(toks[i].at);
      from = toks[i].at;
    }
  }
  if (!cuts.length) return [c];
  const out: string[] = [];
  let last = 0;
  for (const k of cuts) {
    out.push(c.slice(last, k));
    last = k;
  }
  out.push(c.slice(last));
  return out.map((s) => s.trim()).filter(Boolean);
}

export interface ItemGroup {
  /** El texto de la llanta con sus marcas (§n§, ¤n¤). */
  text: string;
}

export interface Grouping {
  groups: string[];
  /** Lo que no se pudo poner en una llanta con seguridad. */
  doubts: string[];
}

/** Las llantas del pedido, una por grupo (ver la cabecera). */
export function groupItems(t: string, known?: KnownWord): Grouping {
  const doubts: string[] = [];
  const chunks = t
    .split(SEPARATORS)
    .map((s) => s.trim())
    .filter((s) => s && /[\p{L}\d§¤]/u.test(s))
    .flatMap((c) => splitInside(c, known));
  interface Cur {
    parts: string[];
    f: Features;
  }
  const items: Cur[] = [];
  let pending: string[] = [];
  const merge = (a: Features, b: Features): Features => ({
    sizes: a.sizes + b.sizes,
    ubs: a.ubs + b.ubs,
    price: a.price || b.price,
    qtyLead: a.qtyLead || b.qtyLead,
    desc: a.desc || b.desc,
    bareNumber: false,
  });
  const cur = () => items[items.length - 1];
  const hasQty = (x: Cur) => x.f.qtyLead;
  for (const c of chunks) {
    const f = features(c, known);
    const last = cur();
    if (!f.desc && !f.sizes && !f.qtyLead && f.price && !f.ubs) {
      // "…, a 254": el precio va con la llanta de antes
      if (last) {
        last.parts.push(c);
        last.f = merge(last.f, f);
      } else pending.push(c);
      continue;
    }
    if (!f.desc && !f.sizes && !f.qtyLead && f.ubs && !f.bareNumber) {
      // la UB sola: con la llanta de antes si aún no tiene; si ya tiene, es de la siguiente ("1231, 4, valor 99")
      if (last && !last.f.ubs && !pending.length) {
        last.parts.push(c);
        last.f = merge(last.f, f);
      } else pending.push(c);
      continue;
    }
    if (f.desc && !f.sizes && !f.qtyLead && !f.price && !f.ubs && known && !knownIn(c, known)) {
      // palabras sin nada de llanta ("visité Transportes Gamma, necesitan 8 …", "sin IPV"): van con la llanta siguiente
      // (o con la última), como cualquier texto que el cotizador lee junto a la llanta; no son otra llanta
      pending.push(c);
      continue;
    }
    if (f.bareNumber || (f.qtyLead && !f.desc && !f.sizes)) {
      // un número solo: el del diseño ("4 Flama, 77") si la llanta de antes termina en palabra sin número; si no, la
      // cantidad de la siguiente ("8, valor 99")
      const n = c.trim();
      if (last && !pending.length && /^\d{1,3}$/.test(n) && last.f.desc && hasQty(last) && !last.f.sizes && /\p{L}$/u.test(last.parts.join(" ").replace(/[\s,.]+$/, ""))) {
        last.parts.push(n);
        continue;
      }
      pending.push(c);
      continue;
    }
    if (!f.desc && f.sizes && !f.qtyLead && last && !last.f.sizes && !pending.length) {
      // "Westlake CM 958, en §0§ a 198": la medida (y su precio) es de la llanta de antes
      last.parts.push(c);
      last.f = merge(last.f, f);
      continue;
    }
    if (!f.desc && f.sizes && !f.qtyLead && !pending.length && last?.f.sizes) {
      // "8 Valor 99 en §0§ y §1§": ¿otra llanta sin cantidad ni modelo, o una segunda medida? no se adivina
      doubts.push(`«${c.trim()}» no dice cantidad ni modelo: no sé si es otra llanta`);
    }
    const pf = pending.reduce((a, p) => merge(a, features(p, known)), features(""));
    items.push({ parts: [...pending, c], f: merge(pf, f) });
    pending = [];
  }
  if (pending.length) {
    const last = cur();
    const pf = pending.reduce((a, p) => merge(a, features(p, known)), features(""));
    if (last && !(pf.qtyLead && hasQty(last)) && !(pf.ubs && last.f.ubs) && !(pf.sizes && last.f.sizes)) {
      last.parts.push(...pending);
      last.f = merge(last.f, pf);
    } else if (!last) items.push({ parts: pending, f: pf });
    else doubts.push(`no sé a qué llanta va «${pending.join(", ")}»`);
  }
  return { groups: items.map((x) => x.parts.join(" ").replace(/\s+/g, " ").trim()), doubts };
}

// ── correcciones dirigidas ──

export type VoiceEdit =
  | { kind: "quantity"; line: number; value: number }
  | { kind: "price"; line: number; value: number }
  | { kind: "remove"; line: number }
  | { kind: "add"; text: string };

const ORDINALS: Record<string, number> = {
  primero: 1, primera: 1, primer: 1, segundo: 2, segunda: 2, tercero: 3, tercera: 3, tercer: 3, cuarto: 4, cuarta: 4, quinto: 5, quinta: 5,
  sexto: 6, sexta: 6, septimo: 7, septima: 7, setimo: 7, setima: 7, octavo: 8, octava: 8, noveno: 9, novena: 9, decimo: 10, decima: 10,
};
const NUM_WORDS: Record<string, number> = { uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };

/** "segundo", "2º", "2do", "la línea 2", "el ítem dos", "el número 2", "el último" (-1) -> número de línea (1…), o null. */
function ordinalOf(phrase: string): number | null {
  const f = fold(phrase).replace(/\b(?:el|la|al|del|a|de)\b/g, " ").replace(/\b(?:item|linea|llanta|numero|fila|renglon|producto)\b/g, " ").trim();
  if (!f) return null;
  if (/^(?:ultim[oa])$/.test(f)) return -1;
  if (ORDINALS[f] !== undefined) return ORDINALS[f];
  const m = f.match(/^(\d{1,2})\s*(?:o|a|ro|ra|do|da|to|ta|mo|ma|vo|va|no|na)?$/);
  if (m) return parseInt(m[1], 10);
  if (NUM_WORDS[f] !== undefined) return NUM_WORDS[f];
  return null;
}

/** El verbo dicho se parece a uno de estos (Deepgram: "Elemena" = "elimina"). */
function verbLike(word: string, verbs: string[]): boolean {
  const w = fold(word);
  return verbs.some((v) => w === v || (w.length >= 5 && w[0] === v[0] && jaroWinkler(w, v) >= 0.84));
}

const REMOVE_VERBS = ["quita", "quitale", "quitame", "quitar", "elimina", "eliminale", "eliminar", "saca", "sacale", "sacar", "borra", "borrale", "borrar", "retira", "retirar"];
const ADD_HEAD = /^(?:y\s+)?(?:agr[eé]ga(?:le|me)?|agregar|agrega|añ[aá]de(?:le|me)?|anade(?:le|me)?|añadir|s[uú]ma(?:le|me)?|sumar|pon(?:le|me)?\s+tambi[eé]n|tambi[eé]n|adem[aá]s|otra\s+(?:llanta|l[ií]nea)\s*:?|y\s+otr[ao]s?)\b[\s,:]*/i;
const ORD = String.raw`(?:(?:el|la|al|a\s+la|del|de\s+la)\s+)?(?:(?:[ií]tem|l[ií]nea|llanta|n[uú]mero|fila)\s+)?(\d{1,2}\s*(?:º|°|o|a|ro|ra|do|da|to|ta)?|primer[oa]?|segund[oa]|tercer[oa]?|cuart[oa]|quint[oa]|sext[oa]|s[eé]p?tim[oa]|octav[oa]|noven[oa]|d[eé]cim[oa]|[uú]ltim[oa]|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)(?:\s+(?:[ií]tem|l[ií]nea|llanta))?`;

/**
 * Una corrección dirigida o un "agrega …" dictado (la transcripción con los números ya en cifras: normalizeSpoken).
 * null si no es ninguna de esas formas.
 */
export function parseVoiceEdit(spoken: string): VoiceEdit | null {
  const t = (spoken ?? "")
    .replace(/[¡!¿?]+/g, " ")
    .replace(/[.,;]+\s*$/g, "")
    .replace(/^(?:no|perd[oó]n|disculpa|corrijo|correcci[oó]n|oye|mira)\b[,.\s]*/i, "")
    .replace(/(\d)\s*[º°]/g, "$1º")
    .trim();
  if (!t) return null;
  const add = t.match(ADD_HEAD);
  if (add && t.slice(add[0].length).trim()) {
    const rest = t.slice(add[0].length).trim();
    // "también el segundo eran diez" no es agregar
    if (!new RegExp(String.raw`^${ORD}\s+(?:eran|son|que\s+sea)`, "i").test(rest)) return { kind: "add", text: rest };
  }
  let m: RegExpMatchArray | null;
  const line = (raw: string) => ordinalOf(raw.replace(/º/g, ""));
  // quitar: "quita el tercero", "elimina el 2º", "el tercero quítalo", "sin el segundo"
  if ((m = t.match(new RegExp(String.raw`^(\p{L}+)\s+${ORD}$`, "iu"))) && verbLike(m[1], REMOVE_VERBS)) {
    const n = line(m[2]);
    if (n !== null) return { kind: "remove", line: n };
  }
  if ((m = t.match(new RegExp(String.raw`^${ORD}\s*,?\s*(\p{L}+)$`, "iu"))) && verbLike(m[2].replace(/(?:lo|la|los|las)$/i, ""), REMOVE_VERBS)) {
    const n = line(m[1]);
    if (n !== null) return { kind: "remove", line: n };
  }
  // cantidad: "el segundo eran diez", "el 3º que sea 12", "la 1º son 6 llantas", "al primero ponle 8 llantas"
  const QTY_VERB = String.raw`(?:eran|son|ser[ií]an|que\s+sean?|sean|pon(?:le|me)?|c[aá]mbia(?:le|lo|la)?\s+a|cantidad(?:\s+de)?|van|lleva)`;
  if ((m = t.match(new RegExp(String.raw`^(?:y\s+)?(?:en\s+)?${ORD}\s*,?\s*${QTY_VERB}\s*(?:cantidad\s+)?(\d{1,3})\s*(llantas?|unidades|unid|und)?$`, "iu")))) {
    const n = line(m[1]);
    const v = parseInt(m[2], 10);
    if (n !== null && v > 0 && (m[3] || !/pon/i.test(t) || v < 100)) return { kind: "quantity", line: n, value: v };
    if (n !== null && v >= 100) return { kind: "price", line: n, value: v };
  }
  if ((m = t.match(new RegExp(String.raw`^${ORD}\s*,?\s*(\d{1,3})\s*(?:llantas?|unidades|unid|und)$`, "iu")))) {
    const n = line(m[1]);
    if (n !== null && parseInt(m[2], 10) > 0) return { kind: "quantity", line: n, value: parseInt(m[2], 10) };
  }
  // precio: "al primero ponle precio 259", "al 2º ponle 270 dólares", "el segundo a 270", "precio del tercero 250"
  const PRICE_VERB = String.raw`(?:pon(?:le|me)?|c[aá]mbia(?:le|lo|la)?|dale|que\s+sea|va|es)?\s*(?:a\s+)?(?:(?:el\s+)?precio\s*(?:de|a|es)?\s*)?`;
  if ((m = t.match(new RegExp(String.raw`^(?:y\s+)?${ORD}\s*,?\s*${PRICE_VERB}(?:us\$|\$)?\s*(\d{2,6}(?:\.\d{1,2})?)\s*(d[oó]lares|soles|usd)?$`, "iu")))) {
    const n = line(m[1]);
    const v = parseFloat(m[2]);
    const said = /precio|d[oó]lares|soles|usd|\$|\ba\s+\d/i.test(t);
    if (n !== null && (said || v >= 100)) return { kind: "price", line: n, value: v };
  }
  if ((m = t.match(new RegExp(String.raw`^(?:el\s+)?precio\s+(?:de|del)\s+${ORD}\s*(?:es|a|en)?\s*(?:us\$|\$)?\s*(\d{2,6}(?:\.\d{1,2})?)\s*(?:d[oó]lares|soles|usd)?$`, "iu")))) {
    const n = line(m[1]);
    if (n !== null) return { kind: "price", line: n, value: parseFloat(m[2]) };
  }
  return null;
}

/** La línea de la corrección (1…; -1 = la última) contra cuántas hay: el índice (0…) o null si no existe. */
export function editIndex(line: number, count: number): number | null {
  const i = line === -1 ? count - 1 : line - 1;
  return i >= 0 && i < count ? i : null;
}
