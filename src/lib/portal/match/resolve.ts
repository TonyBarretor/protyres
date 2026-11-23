/**
 * Corrida K — encontrar un producto del stock propio por lo que escribe o dicta el vendedor: código ("P0428"), medida +
 * modelo ("295 flama 66") o voz ("doce r veintidós y medio valor noventa y nueve"). Aparte de products.ts porque usa la
 * comparación aproximada de la voz (voice/fuzzy.ts), que el cálculo por lotes y las páginas no deben arrastrar.
 */
import { matchCode } from "../store/shared";
import { fold } from "../../tyre/brands";
import { findTyreSizes } from "../../tyre/spec";
import { jaroWinkler, phoneticKey } from "../voice/fuzzy";
import type { MatchStockProduct } from "./stock";

// ── encontrar un producto por código o por medida + modelo ──

export type ProductMatch = { kind: "one"; product: MatchStockProduct } | { kind: "many"; products: MatchStockProduct[] } | { kind: "none" };

const NUM_WORDS: Record<string, string> = {
  uno: "1", dos: "2", tres: "3", cuatro: "4", cinco: "5", seis: "6", siete: "7", ocho: "8", nueve: "9", diez: "10", once: "11", doce: "12",
  trece: "13", catorce: "14", quince: "15", dieciseis: "16", diecisiete: "17", dieciocho: "18", diecinueve: "19", veinte: "20",
  treinta: "30", cuarenta: "40", cincuenta: "50", sesenta: "60", setenta: "70", ochenta: "80", noventa: "90",
};

/** Números dichos en palabras ("noventa y nueve" -> "99", "setenta y siete" -> "77", "doce" -> "12"). */
export function spokenNumbers(text: string): string {
  // sin tildes y en minúsculas, conservando "." y "/" de las medidas ("12R22.5", "295/80")
  let t = ` ${text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9./]+/g, " ")} `;
  t = t.replace(/\b(treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa) y (uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\b/g, (_m, a: string, b: string) => String(Number(NUM_WORDS[a]) + Number(NUM_WORDS[b])));
  t = t.replace(/\bveinti(uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\b/g, (_m, b: string) => String(20 + Number(NUM_WORDS[b])));
  t = t.replace(/\b([a-z]+)\b/g, (w) => NUM_WORDS[w] ?? w);
  // "22 y medio" -> "22.5", "17 y medio" -> "17.5"
  t = t.replace(/\b(\d{2}) y medio\b/g, "$1.5");
  return t.replace(/\s+/g, " ").trim();
}

const STOP = new Set(["de", "la", "el", "los", "las", "y", "con", "prioridad", "quitar", "producto", "llanta", "llantas", "medida", "modelo", "match", "r", "pr"]);

function wordScore(word: string, target: string[]): number {
  if (/\d/.test(word)) return target.includes(word) ? 1 : 0; // los números se exigen iguales ("66" no es "77")
  const k = phoneticKey(word);
  let best = 0;
  for (const t of target) {
    if (/\d/.test(t)) continue;
    if (t === word || t.startsWith(word)) return 1;
    best = Math.max(best, jaroWinkler(k, phoneticKey(t)));
  }
  return best >= 0.88 ? best : 0;
}

/**
 * Producto por código ("P0428", "p 0428") o por medida + palabras del modelo/marca ("295 flama 66", "315 aonaite",
 * "12R22.5 valor 99"). La medida puede venir completa o solo con el ancho ("295", "12"). Por voz los números en palabras
 * se convierten. Los números del modelo deben coincidir.
 */
export function resolveProduct(query: string, products: MatchStockProduct[]): ProductMatch {
  const raw = query.trim();
  if (!raw) return { kind: "none" };
  const codeHit = /\b([A-Za-z]{1,4})\s*-?\s*(\d{2,6}[A-Za-z]?)\b/.exec(raw);
  if (codeHit) {
    const code = matchCode(codeHit[1] + codeHit[2]);
    const p = products.find((x) => x.code === code);
    if (p) return { kind: "one", product: p };
  }
  const text = spokenNumbers(raw);
  const size = findTyreSizes(text)[0];
  let rest = size ? text.slice(0, size.index) + " " + text.slice(size.index + size.length) : text;
  let pool = products;
  if (size) pool = pool.filter((p) => p.size === size.canonical);
  else {
    // solo el ancho: "295 flama 66" -> 295/…; "12 valor 99" -> 12R…
    const w = /(?:^|\s)(\d{2,3})(?=\s|$)/.exec(rest);
    if (w) {
      const byWidth = pool.filter((p) => p.size.startsWith(`${w[1]}/`) || p.size.startsWith(`${w[1]}R`));
      if (byWidth.length) {
        pool = byWidth;
        rest = rest.replace(w[0], " ");
      }
    }
  }
  // sin medida reconocible: solo por modelo/marca, entre todos
  const words = rest
    .replace(/[^a-z0-9/ ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
  if (!words.length) return pool.length === 1 ? { kind: "one", product: pool[0] } : pool.length && pool !== products ? { kind: "many", products: pool } : { kind: "none" };
  const scored = pool
    .map((p) => {
      const target = fold(`${p.brand} ${p.model} ${p.description}`).replace(/[^a-z0-9/ ]/g, " ").split(/\s+/).filter(Boolean);
      const scores = words.map((w) => wordScore(w, target));
      return { p, ok: scores.every((s) => s > 0), score: scores.reduce((a, b) => a + b, 0) };
    })
    .filter((x) => x.ok)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { kind: "none" };
  const top = scored.filter((x) => x.score >= scored[0].score - 1e-9);
  return top.length === 1 ? { kind: "one", product: top[0].p } : { kind: "many", products: top.map((x) => x.p) };
}
