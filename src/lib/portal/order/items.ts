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
 */
import { buildQuote, itemFromCandidate, manualItem } from "../../quote/build";
import { findCandidates } from "../../quote/match";
import { describeLine, parseRequestRegex } from "../../quote/request";
import type { Quote, QuoteItem } from "../../quote/types";
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

export type OrderItemsResult =
  | { ok: true; items: PedidoItem[]; quoteItems: QuoteItem[]; currency: string; taxPct: number }
  | { ok: false; error: string };

export const ORDER_ITEMS_EXAMPLE = "*8 x Fenixway Flama 77 315/80R22.5 a 254*";

export async function parseOrderItems(text: string, deps: { priceStore: PriceStore; settings: Settings; today?: string }): Promise<OrderItemsResult> {
  const req = parseRequestRegex(normalizeOrderItemsText(text));
  const lines = req.lines;
  if (!lines.length) return { ok: false, error: `No encontré ítems en tu mensaje. Escríbelos con el formato de cotización, uno por línea:\n${ORDER_ITEMS_EXAMPLE}` };
  if (lines.length > PEDIDO_MAX_ITEMS) return { ok: false, error: `El formato de pedido tiene ${PEDIDO_MAX_ITEMS} filas de ítems y escribiste ${lines.length}. Divide la OC en dos pedidos y mándame primero hasta ${PEDIDO_MAX_ITEMS} ítems.` };
  const lcs = await findCandidates(deps.priceStore, req, deps.settings.pricing, { limit: 5 });
  const items: QuoteItem[] = [];
  const unpriced: string[] = [];
  for (const lc of lcs) {
    const line = lc.line;
    const exact = lc.candidates.find((c) => !c.brandMismatch && !c.relaxedSize && (!line.model || c.modelScore >= 0.6));
    if (exact) items.push(itemFromCandidate(exact, line.quantity, deps.settings, line.unitPrice, line));
    else if (line.unitPrice !== undefined) items.push(manualItem(line, line.unitPrice, undefined, deps.settings));
    else unpriced.push(describeLine(line));
  }
  if (unpriced.length) {
    return { ok: false, error: `No hay precio en las listas para ${unpriced.map((d) => `«${d}»`).join(", ")}. Escribe los ítems de nuevo con su precio (p. ej. ${ORDER_ITEMS_EXAMPLE}).` };
  }
  const quote: Quote = buildQuote({ number: "OC", request: req, items, settings: deps.settings, today: deps.today });
  return { ok: true, items: pedidoFromQuote(quote).items, quoteItems: items, currency: quote.currency, taxPct: quote.taxPct };
}
