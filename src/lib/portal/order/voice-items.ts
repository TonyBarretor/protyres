/**
 * Ítems de una OC dictados por voz (corrida H, punto 5). Puro: lo usa bot/commands/oc.ts.
 *
 *  - orderItemsFromVoice: la nota de voz con varias llantas -> el texto de ítems que ya entiende parseOrderItems (una llanta
 *    por línea, "precio N" para el precio dicho), con la misma separación que la cotización por voz (voice/dictation.ts,
 *    voice/items.ts): números pegados, medida heredada de la línea anterior, UB. Si no se pudo separar con seguridad, no
 *    se arma nada: `ask` trae lo entendido y la pregunta.
 *  - applyOrderEdit: con los ítems del pedido ya armados (fase de preguntas), "el segundo eran diez", "quita el tercero" y
 *    "al primero ponle precio 259" cambian esa línea; lo agregado ("agrega …") lo arma quien llama con orderItemsFromVoice.
 *    El precio dicho es sin IGV, como "precio 254" en el cotizador y "a 254" en los ítems escritos.
 */
import { displaySize, normalizeDictation, type DictationCatalog } from "../voice/dictation";
import { editIndex, type VoiceEdit } from "../voice/items";
import { pedidoDescription, type PedidoItem } from "./pedido-xlsx";

export type VoiceOrderItems = { ok: true; text: string; notes: string[] } | { ok: false; ask: string };

/** La transcripción con los ítems de la OC -> el texto de ítems (ver la cabecera). */
export function orderItemsFromVoice(transcript: string, catalog: DictationCatalog = {}): VoiceOrderItems {
  const d = normalizeDictation(transcript, { ...catalog, ubLevel: 1 });
  const items = d.items;
  if (!items.length) return { ok: false, ask: "No entendí ninguna llanta en tu nota de voz. Díctala de nuevo (p. ej. «ocho Flama 77 en 315 80 22.5 a 254») o escríbela." };
  if (d.doubts.length) {
    const lines = items.map((l, i) => `${i + 1}. ${l}`).join("\n");
    return { ok: false, ask: `Entendí estas llantas:\n${lines}\n\n⚠️ No estoy seguro de cómo separarlas: ${d.doubts.join("; ")}.\nDíctalas de nuevo separando cada llanta, o escríbelas una por línea.` };
  }
  const notes: string[] = [];
  if (d.fixes.length) notes.push(`🔤 Corregí lo que oí: ${d.fixes.map((f) => `«${f.from}» → ${f.to}`).join(", ")}.`);
  if (d.inherited.length) notes.push(`📏 ${d.inherited.map((x) => `La línea ${x.item + 1}`).join(", ")} no dice medida: uso ${[...new Set(d.inherited.map((x) => displaySize(x.size)))].join(" / ")}, la de la línea anterior.`);
  return { ok: true, text: items.join("\n"), notes };
}

/** Una corrección dirigida sobre los ítems del pedido: los ítems cambiados y qué se hizo, o el error. */
export function applyOrderEdit(items: PedidoItem[], edit: Exclude<VoiceEdit, { kind: "add" }>): { ok: true; items: PedidoItem[]; said: string } | { ok: false; error: string } {
  const i = editIndex(edit.line, items.length);
  if (i === null) return { ok: false, error: `No existe la línea ${edit.line === -1 ? "última" : edit.line}; hay ${items.length}.` };
  const out = items.map((it) => ({ ...it }));
  const it = out[i];
  const name = `${it.cantidad} × ${pedidoDescription(it)}`;
  if (edit.kind === "remove") {
    if (out.length === 1) return { ok: false, error: "Es la única línea del pedido: no la quito. Si el pedido cambió, escribe *cancelar* y empieza de nuevo." };
    out.splice(i, 1);
    return { ok: true, items: out, said: `Quité la línea ${i + 1} (${name}).` };
  }
  if (edit.kind === "quantity") {
    it.cantidad = edit.value;
    return { ok: true, items: out, said: `Línea ${i + 1}: ${edit.value} × ${pedidoDescription(it)}.` };
  }
  it.precioUnitarioSinIgv = edit.value;
  delete it.precioUnitarioConIgv;
  return { ok: true, items: out, said: `Línea ${i + 1} (${name}): precio ${edit.value} sin IGV.` };
}
