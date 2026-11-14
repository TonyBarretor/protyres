/**
 * Registro de transcripciones de voz (corrida F, punto 9): cada nota de voz de cotización, con lo que el bot entendió
 * (medida, cantidad, marca, diseño, cliente, preguntas y correcciones) y cómo terminó (ok / pregunta / fallo). Se revisa
 * desde consola con `npm run voice:review` (nunca en pantalla del portal).
 *
 * Tabla propia `voice_transcripts` (PortalStore) y no `messages` (kind "transcript", que ya guarda el texto literal):
 * lo entendido es estructurado (jsonb), se filtra por resultado y es del portal (usuario), mientras que `messages` es el
 * registro crudo del cotizador. Un fallo del registro nunca corta la conversación.
 */
import { findBrandInText } from "../../tyre/brands";
import { findTyreSizes } from "../../tyre/spec";
import type { VoiceOutcome, VoiceUnderstood } from "../store/types";
import type { DictatedQuote } from "../voice/dictation";
import type { PortalContext } from "./registry";

/** Lo entendido de un pedido dictado (o solo lo indicado en `extra` si no hay pedido: respuesta "¿qué medida es?"). */
export function understoodOf(
  d: DictatedQuote | null,
  extra: { questions?: string[]; customer?: string; text?: string; sizes?: string[] } = {},
): VoiceUnderstood {
  const text = extra.text ?? d?.text ?? null;
  const lines = (text ?? "").split("\n").filter((l) => l && !/^(?:para\s|plazo:|margen\s|dscto\s|con\s+igv|sin\s+igv|cotizar$)/i.test(l));
  const sizes = extra.sizes ?? [...new Set(lines.flatMap((l) => findTyreSizes(l).map((s) => s.canonical)))];
  const quantities = lines.flatMap((l) => [...l.matchAll(/\bx(\d{1,4})\b/gi)].map((m) => parseInt(m[1], 10)));
  // marca y diseño: lo que queda de la primera línea de llanta sin la medida, la cantidad ni el precio
  let brand: string | null = null;
  let design: string | null = null;
  const first = lines[0];
  if (first) {
    let rest = first;
    for (const s of findTyreSizes(first).reverse()) rest = `${rest.slice(0, s.index)} ${rest.slice(s.index + s.length)}`;
    rest = rest.replace(/\bx\d{1,4}\b/gi, " ").replace(/\bprecio\s+\S+/gi, " ").replace(/\s+/g, " ").trim();
    const b = findBrandInText(rest);
    if (b) {
      brand = b.brand;
      rest = `${rest.slice(0, b.index)} ${rest.slice(b.index + b.alias.length)}`.replace(/\s+/g, " ").trim();
    }
    design = rest || null;
  }
  const customerLine = (text ?? "").split("\n").find((l) => /^para\s/i.test(l));
  return {
    sizes,
    quantities,
    brand,
    design,
    customer: extra.customer ?? (customerLine ? customerLine.replace(/^para\s+/i, "") : d?.customer || null),
    questions: extra.questions ?? [],
    fixes: d?.fixes ?? [],
    text,
  };
}

/** Guarda una transcripción con lo entendido. `voiced: false` (respuesta escrita a "¿qué medida es?") no se registra. */
export async function recordVoice(
  ctx: PortalContext,
  entry: { transcript: string; context: string; understood: VoiceUnderstood; outcome: VoiceOutcome; voiced?: boolean },
): Promise<void> {
  if (entry.voiced === false) return;
  try {
    await ctx.store.logVoiceTranscript({
      phone: ctx.from,
      userId: ctx.user?.id ?? null,
      context: entry.context,
      transcript: entry.transcript,
      understood: entry.understood,
      outcome: entry.outcome,
      createdAt: ctx.now,
    });
  } catch (err) {
    ctx.log(`portal: no pude registrar la transcripción de voz: ${(err as Error).message}`);
  }
}
