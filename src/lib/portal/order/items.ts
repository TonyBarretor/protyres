/**
 * Ítems de una OC que llegó sin cotización previa, escritos "con el formato de cotización"
 * ("8 x Fenixway Flama 77 315/80R22.5 a 254"). Reutiliza el cotizador sin cambiarlo: su parser de pedidos por REGLAS
 * (parseRequestRegex; corrida E: el texto de una OC es dato de terceros y el pedido en firme cambia datos —ítems, precios,
 * Excel del pedido— sin pasar por las opciones del cotizador, así que nunca va al modelo), sus candidatos de las listas (findCandidates) y su armado de ítems
 * (itemFromCandidate / manualItem, buildQuote). El precio escrito manda (como "precio 254" en el cotizador: sin IGV, en la
 * moneda de cotización); sin precio, el de la lista propia o el del proveedor con el margen, igual que el cotizador.
 *
 * Diferencia a propósito con el cotizador: para un pedido en firme no se acepta un candidato "parecido" (otra marca,
 * medida relajada o modelo distinto). Con precio escrito queda como ítem manual con lo que escribió el vendedor; sin
 * precio, se pide.
 *
 * Corrida F, punto 7: el modelo pedido tiene que ser ESE modelo (exactModel: parecido ≥ 0,9 y los mismos números; antes
 * bastaba 0,6 y "Flama 77" en 295/80R22.5 quedó como Flama 89 sin avisar). Si en esa medida hay otros modelos, no se
 * sustituye: el resultado trae `choices` (las opciones más cercanas, con precio) y quien llama pregunta; la respuesta
 * vuelve en `picks` (id de la fila elegida, o "manual" = tal como lo escribió, solo con precio escrito).
 */
import { buildQuote, itemFromCandidate, manualItem } from "../../quote/build";
import { findCandidates } from "../../quote/match";
import { describeLine, parseRequestRegex } from "../../quote/request";
import type { Candidate, Quote, QuoteItem } from "../../quote/types";
import type { Settings } from "../../settings";
import type { PriceStore } from "../../store/types";
import { PEDIDO_MAX_ITEMS, pedidoFromQuote, type PedidoItem } from "./pedido-xlsx";

/** "… a 254" / "… a US$ 254.50" al final de un ítem = "precio 254" del cotizador (que no lee "a 254" por ambiguo). */
export function normalizeOrderItemsText(text: string): string {
  return text
    .split(/\n/)
    .map((line) =>
      line.replace(/(\s)(?:a|@)\s*(?:US\$|U\$S|\$|S\/\.?)?\s*(\d{1,6}(?:[.,]\d{1,2})?)(?=\s*(?:c\/u|cada\s+una|c\/una|usd|soles)?\s*(?:[,;]|$))/gi, "$1precio $2"),
    )
    .join("\n");
}

/** Una opción para un modelo que no existe en la medida pedida: la fila de la lista y su precio por unidad con IGV. */
export interface ModelOption {
  id: string;
  label: string;
  /** El modelo solo ("Flama 89"): título del botón (≤ 20 caracteres). */
  short: string;
  unitWithTax: number;
}

/** Ítem de la OC cuyo modelo no existe en esa medida: lo pedido y las opciones más cercanas (máx. MODEL_OPTIONS). */
export interface ModelChoice {
  /** Índice de la línea en el texto de los ítems. */
  line: number;
  /** Lo pedido, legible ("8 × Fenixway Flama 77 295/80R22.5"). */
  asked: string;
  /** El modelo pedido ("Flama 77"). */
  model: string;
  options: ModelOption[];
  /** Hay precio escrito: se puede dejar tal como se escribió (ítem manual). */
  canKeep: boolean;
}

export const MODEL_OPTIONS = 3;

export type OrderItemsResult =
  | { ok: true; items: PedidoItem[]; quoteItems: QuoteItem[]; currency: string; taxPct: number }
  | { ok: false; error: string; choices?: undefined }
  | { ok: false; error: string; choices: ModelChoice[]; currency: string };

const numbersOf = (s: string) => (s.match(/\d+/g) ?? []).map((n) => String(Number(n)));

/**
 * ¿La fila es el modelo pedido? Parecido ≥ 0,9 (igual, o uno contiene al otro: "Flama" en "FLAMA 77") y cada número del
 * modelo pedido está en el de la fila ("77" no es "89"; "7" tampoco es "77").
 */
export function exactModel(asked: string, rowModel: string, score: number): boolean {
  if (score < 0.9) return false;
  const have = new Set(numbersOf(rowModel));
  return numbersOf(asked).every((n) => have.has(n));
}

const optionLabel = (c: Candidate) => [c.row.brand, c.row.model || c.row.description, c.row.ply ? `${c.row.ply}PR` : ""].filter(Boolean).join(" ");

export const ORDER_ITEMS_EXAMPLE = "*8 x Fenixway Flama 77 315/80R22.5 a 254*";

export async function parseOrderItems(text: string, deps: { priceStore: PriceStore; settings: Settings; today?: string; picks?: Record<number, string> }): Promise<OrderItemsResult> {
  const req = parseRequestRegex(normalizeOrderItemsText(text));
  const lines = req.lines;
  if (!lines.length) return { ok: false, error: `No encontré ítems en tu mensaje. Escríbelos con el formato de cotización, uno por línea:\n${ORDER_ITEMS_EXAMPLE}` };
  if (lines.length > PEDIDO_MAX_ITEMS) return { ok: false, error: `El formato de pedido tiene ${PEDIDO_MAX_ITEMS} filas de ítems y escribiste ${lines.length}. Divide la OC en dos pedidos y mándame primero hasta ${PEDIDO_MAX_ITEMS} ítems.` };
  const lcs = await findCandidates(deps.priceStore, req, deps.settings.pricing, { limit: 5 });
  const items: QuoteItem[] = [];
  const unpriced: string[] = [];
  const choices: ModelChoice[] = [];
  lcs.forEach((lc, i) => {
    const line = lc.line;
    const pick = deps.picks?.[i];
    const picked = pick && pick !== "manual" ? lc.candidates.find((c) => c.row.id === pick) : undefined;
    const exact = picked ?? lc.candidates.find((c) => !c.brandMismatch && !c.relaxedSize && (!line.model || exactModel(line.model, c.row.model || c.row.description, c.modelScore)));
    if (exact) return void items.push(itemFromCandidate(exact, line.quantity, deps.settings, line.unitPrice, line));
    // el modelo pedido no está en esa medida pero hay otros (de la marca pedida, si se dijo): se pregunta (nunca se
    // sustituye en silencio)
    const near = line.model && pick !== "manual" ? lc.candidates.filter((c) => !c.relaxedSize && (!line.brand || !c.brandMismatch)) : [];
    if (near.length) {
      const sorted = [...near].sort((a, b) => b.modelScore - a.modelScore || a.unitWithTax - b.unitWithTax);
      const canKeep = line.unitPrice !== undefined;
      const options = sorted.slice(0, canKeep ? MODEL_OPTIONS - 1 : MODEL_OPTIONS).map((c) => ({ id: c.row.id, label: optionLabel(c), short: c.row.model || c.row.description, unitWithTax: c.unitWithTax }));
      const asked = `${line.quantity} × ${[line.brand, line.model, line.size?.display].filter(Boolean).join(" ")}`;
      return void choices.push({ line: i, asked, model: line.model!, options, canKeep });
    }
    if (line.unitPrice !== undefined) items.push(manualItem(line, line.unitPrice, undefined, deps.settings));
    else unpriced.push(describeLine(line));
  });
  if (choices.length && !unpriced.length) {
    const list = choices.map((c) => `«${c.asked}»`).join(", ");
    return { ok: false, error: `No tengo ese modelo en esa medida: ${list}.`, choices, currency: deps.settings.pricing.currency };
  }
  if (unpriced.length) {
    return { ok: false, error: `No hay precio en las listas para ${unpriced.map((d) => `«${d}»`).join(", ")}. Escribe los ítems de nuevo con su precio (p. ej. ${ORDER_ITEMS_EXAMPLE}).` };
  }
  const quote: Quote = buildQuote({ number: "OC", request: req, items, settings: deps.settings, today: deps.today });
  return { ok: true, items: pedidoFromQuote(quote).items, quoteItems: items, currency: quote.currency, taxPct: quote.taxPct };
}
