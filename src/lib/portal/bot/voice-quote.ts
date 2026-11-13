/**
 * Cotización por voz (corrida D, punto 8). routePortal transcribe la nota de voz, aplica la precedencia del punto 7 a la
 * transcripción y, si es una cotización, llama aquí. No hay camino paralelo: lo dictado se normaliza al texto que el
 * cotizador ya entiende (voice/dictation.ts) y entra por ctx.requote() al MISMO BotHandler.handle(), con
 * `voiceTranscript` en el mensaje: mismas opciones, mismo "Entendí:", misma confirmación con *ok*. Lo único distinto en el
 * cotizador (state.voice) es que el PDF no se arma sin un *ok* escrito: elegir *1b* (que en texto arma el PDF) solo cambia
 * la opción y un contrato muestra el resumen y espera el *ok*.
 *
 *  - startVoiceQuote: responde `🎙 Escuché: <literal>` en una línea, normaliza, valida la medida contra el catálogo y pasa
 *    el texto al cotizador. Sin medida, o con una que no está en el catálogo, pregunta (botones con las candidatas, máx. 3)
 *    y espera en el paso `voice_size` (captureText: la respuesta es una medida). Nunca elige una medida.
 *  - voiceCorrection: con la cotización por voz a la vista (cotizador en `choose`), una nota de voz es una corrección:
 *    "no, eran doce" -> `cantidad 12`, "precio 259" -> `precio 259`, "cámbialo a Valor 99" -> `modelo Valor 99` (el
 *    cotizador elige esa opción). Un "ok" dictado no arma el PDF: se pide escribirlo.
 */
import { findTyreSizes } from "../../tyre/spec";
import { checkSizes, displaySize, normalizeDictation, normalizeSpoken, normalizeVoiceCorrection } from "../voice/dictation";
import { applyVocabulary } from "../voice/vocabulary";
import { askAgain } from "./pause";
import { registerPausable, registerPendingHandler, replyButtons, type PortalContext } from "./registry";
import { fetchVoice, logTranscript, sellerCompanies } from "./report";
import { matchSpokenName } from "../voice/fuzzy";
import { shortName } from "./companies";
import { explicitQuoteStart, strongTyreQuote } from "./router";
import { clearPending, setPending, type PendingStep } from "./state";

export const VOICE_SIZE = "voice_size";

/** Esperando la medida de una cotización por voz (no se dijo, o no está en el catálogo). */
export interface VoiceSizeStep extends PendingStep {
  kind: typeof VOICE_SIZE;
  /** El texto normalizado para el cotizador (sin la medida, o con la que no existe). */
  text: string;
  /** La medida dictada que no está en el catálogo (canónica); null si no se dijo ninguna. */
  bad: string | null;
  /** La transcripción literal (para el recordatorio y el mensaje al cotizador). */
  transcript: string;
  /** La respuesta es una medida: el paso se queda con el texto (router, regla 9). */
  captureText: true;
}

export const VOICE_OK_TYPED = "Por voz no armo el PDF: revisa el resumen y escribe *ok* para armarlo (o sigue corrigiendo).";
export const VOICE_CORRECTION_HELP = "Puedes decir, por ejemplo: «eran doce», «precio 259», «cámbialo a Valor 99», «margen 10» o «a 60 días»; o escribirlo.";
export const VOICE_QUOTE_FAILED = "No pude transcribir tu nota de voz. Escríbeme el cambio en texto, por favor.";

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
export const heardLine = (transcript: string) => `🎙 Escuché: ${oneLine(transcript)}`;

async function catalogOf(ctx: PortalContext) {
  if (!ctx.voiceCatalog) return null;
  try {
    return await ctx.voiceCatalog();
  } catch (err) {
    ctx.log(`portal: no pude leer el catálogo para la voz: ${(err as Error).message}`);
    return null;
  }
}

async function learned(ctx: PortalContext) {
  return (await ctx.store.listVocabulary().catch(() => [])).map((v) => ({ term: v.term, meaning: v.meaning }));
}

/** La transcripción con el vocabulario aprendido, números y medidas normalizados (para la precedencia del router). */
export async function spokenForRouting(ctx: PortalContext, transcript: string): Promise<string> {
  return normalizeSpoken(applyVocabulary(transcript, await learned(ctx)));
}

/** Nota de voz que es una cotización: `🎙 Escuché: …` y al cotizador (o la pregunta por la medida). */
export async function startVoiceQuote(ctx: PortalContext, transcript: string): Promise<void> {
  await logTranscript(ctx, transcript);
  await ctx.reply(heardLine(transcript));
  const catalog = await catalogOf(ctx);
  const d = normalizeDictation(applyVocabulary(transcript, await learned(ctx)), { designs: catalog?.designs, brands: catalog?.brands });
  const notes = d.fixes.length ? [`🔤 Corregí lo que oí: ${d.fixes.map((f) => `«${f.from}» → ${f.to}`).join(", ")}.`] : [];
  if (!d.customer) {
    if (notes.length) await ctx.reply(notes.join("\n"));
    return continueVoiceQuote(ctx, d.text, transcript);
  }
  // el cliente dictado contra las empresas del vendedor y los clientes de cotizaciones anteriores (nunca a ciegas)
  const known = await knownCustomers(ctx, catalog?.customers ?? []);
  const exact = known.find((k) => foldName(k.name) === foldName(d.customer));
  const m = exact ? null : matchSpokenName(d.customer, known);
  if (m?.kind === "clear" && m.best) {
    notes.push(`👤 Cliente: entendí «${d.customer}» → *${m.best.name}*`);
    await ctx.reply(notes.join("\n"));
    return continueVoiceQuote(ctx, withCustomer(d.text, d.customer, m.best.name), transcript);
  }
  if (m?.kind === "doubt") {
    if (notes.length) await ctx.reply(notes.join("\n"));
    const options = m.candidates.slice(0, 2).map((c) => c.name);
    const step: Omit<VoiceCustomerStep, "createdAt"> = { kind: VOICE_CUSTOMER, text: d.text, transcript, spoken: d.customer, options, captureText: true };
    await setPending(ctx.store, ctx.from, step, ctx.now);
    await replyButtons(ctx, customerQuestion(d.customer, options), customerButtons(d.customer, options));
    return;
  }
  if (!exact) notes.push(`⚠️ «${d.customer}» no está entre tus empresas ni los clientes conocidos: lo dejo tal cual. Si no es así, corrígelo (p. ej. *para ZBUSS*).`);
  if (notes.length) await ctx.reply(notes.join("\n"));
  await continueVoiceQuote(ctx, d.text, transcript);
}

// ── cliente dictado (prueba con Deepgram real, 2026-11-13: "ZBUSS" llegó como "Septa BUSS") ──

export const VOICE_CUSTOMER = "voice_customer";

/** Esperando que el vendedor elija el cliente dictado entre las parecidas (o lo deje tal cual). */
export interface VoiceCustomerStep extends PendingStep {
  kind: typeof VOICE_CUSTOMER;
  /** El texto normalizado para el cotizador, con el cliente como se dictó. */
  text: string;
  transcript: string;
  /** El cliente como se dictó. */
  spoken: string;
  /** Razones sociales candidatas (máx. 2: el tercer botón es "Dejar «…»"). */
  options: string[];
  captureText: true;
}

const foldName = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

async function knownCustomers(ctx: PortalContext, quoted: string[]): Promise<{ id: string; name: string }[]> {
  const mine = await sellerCompanies(ctx.store, ctx.user.id).catch(() => []);
  const out = new Map<string, { id: string; name: string }>();
  for (const c of mine) out.set(foldName(c.razonSocial), { id: `c${c.id}`, name: c.razonSocial });
  for (const q of quoted) if (!out.has(foldName(q))) out.set(foldName(q), { id: `q:${q}`, name: q });
  return [...out.values()];
}

/** Cambia la línea "para <dictado>" por "para <cliente>". */
export function withCustomer(text: string, spoken: string, name: string): string {
  return text
    .split("\n")
    .map((l) => (l === `para ${spoken}` ? `para ${name}` : l))
    .join("\n");
}

const clip20 = (s: string) => (s.length > 20 ? `${s.slice(0, 19).trimEnd()}…` : s);
const keepTitle = (spoken: string) => clip20(`Dejar «${spoken.length > 11 ? `${spoken.slice(0, 10).trimEnd()}…` : spoken}»`);
const customerQuestion = (spoken: string, options: string[]) =>
  `¿Para qué cliente es? Entendí «${spoken}», que se parece a ${options.map((o) => `*${o}*`).join(" y a ")}.`;
function customerButtons(spoken: string, options: string[]) {
  return [...options.map((o, i) => ({ id: `cliente ${i + 1}`, title: clip20(shortName(o)) })), { id: "cliente tal cual", title: keepTitle(spoken) }];
}

/** Respuesta a "¿para qué cliente es?": el botón (cliente N / tal cual), el número o el nombre de una de las opciones. */
registerPendingHandler(VOICE_CUSTOMER, async (ctx, step, rawText) => {
  const s = step as VoiceCustomerStep;
  const t = foldName(rawText).replace(/^cliente\s+/, "");
  let name: string | null = null;
  if (/^(?:tal cual|dejar(?:lo)?(?: asi| tal cual)?|ninguno|ninguna)$/.test(t)) name = s.spoken;
  else if (/^\d$/.test(t) && s.options[parseInt(t, 10) - 1]) name = s.options[parseInt(t, 10) - 1];
  else name = s.options.find((o) => foldName(o) === t || foldName(shortName(o)) === t) ?? null;
  if (!name) return false;
  await clearPending(ctx.store, ctx.from);
  await continueVoiceQuote(ctx, name === s.spoken ? s.text : withCustomer(s.text, s.spoken, name), s.transcript);
  return true;
});

registerPausable(VOICE_CUSTOMER, {
  async describe(_ctx, step) {
    const s = step as VoiceCustomerStep;
    return { companyId: null, label: `cotización por voz para «${s.spoken}»`, missing: "falta elegir el cliente" };
  },
  async resume(ctx, step, prefix) {
    const s = step as VoiceCustomerStep;
    await askAgain(ctx, step, prefix, customerQuestion(s.spoken, s.options), customerButtons(s.spoken, s.options));
  },
});

/** Valida las medidas del texto contra el catálogo: si están, al cotizador; si no, pregunta y espera en `voice_size`. */
async function continueVoiceQuote(ctx: PortalContext, text: string, transcript: string): Promise<void> {
  const sizes = findTyreSizes(text).map((s) => s.canonical);
  const ask = async (bad: string | null, body: string, candidates: string[] = []): Promise<void> => {
    const step: Omit<VoiceSizeStep, "createdAt"> = { kind: VOICE_SIZE, text, bad, transcript, captureText: true };
    await setPending(ctx.store, ctx.from, step, ctx.now);
    if (candidates.length) await replyButtons(ctx, body, candidates.map((c) => ({ id: c, title: displaySize(c) })));
    else await ctx.reply(body);
  };
  if (!sizes.length) return ask(null, "No entendí la medida. ¿Qué medida es? (p. ej. *295/80R22.5* o *11R22.5*; también puedes dictarla) — o *cancelar*.");
  const catalog = await catalogOf(ctx);
  const missing = checkSizes(sizes, catalog?.sizes ?? []);
  if (missing.length) {
    const m = missing[0];
    const which = `La medida *${displaySize(m.size)}* no está en el catálogo.`;
    if (m.candidates.length) return ask(m.size, `${which} ¿Cuál es? Elige una o escríbeme la correcta (o *cancelar*).`, m.candidates);
    return ask(m.size, `${which} Escríbeme o díctame la medida correcta (p. ej. *295/80R22.5*), o *cancelar*.`);
  }
  await ctx.requote(asRequest(text), { voice: transcript });
}

/**
 * Para el cotizador, una medida sola ("295/80R22.5", sin cantidad ni cliente) es un mensaje de precios de proveedor, no un
 * pedido; como lo dictado siempre es un pedido, se antepone la línea "cotizar" (el cotizador la salta al leer el pedido).
 */
export function asRequest(text: string): string {
  return /\bx\d{1,3}\b|^(?:para\s|plazo:|margen\s|dscto\s)/im.test(text) ? text : `cotizar\n${text}`;
}

/** El texto con la medida respondida: reemplaza la que no existía o la pone en la primera línea de llanta. */
export function withSize(text: string, bad: string | null, size: string): string {
  const lines = text.split("\n");
  if (bad) {
    const i = lines.findIndex((l) => findTyreSizes(l).some((s) => s.canonical === bad));
    if (i >= 0) {
      const s = findTyreSizes(lines[i]).find((x) => x.canonical === bad)!;
      const norm = lines[i];
      lines[i] = `${norm.slice(0, s.index)}${size}${norm.slice(s.index + s.length)}`;
      return lines.join("\n");
    }
  }
  const i = lines.findIndex((l) => !/^(?:para\s|plazo:|margen\s|dscto\s|con\s+igv|sin\s+igv)/i.test(l));
  if (i < 0) return [size, ...lines].join("\n");
  const m = lines[i].match(/\s+(?:x\d+|precio\s+\S+)/i);
  lines[i] = m ? `${lines[i].slice(0, m.index)} ${size}${lines[i].slice(m.index)}` : `${lines[i]} ${size}`;
  return lines.join("\n");
}

/** Respuesta a "¿qué medida es?" (escrita, dictada o el botón de una candidata). */
registerPendingHandler(VOICE_SIZE, async (ctx, step, rawText) => {
  const s = step as VoiceSizeStep;
  let answer = rawText.trim();
  if (ctx.msg.type === "audio" && ctx.msg.media) {
    const r = await fetchVoice(ctx, { id: ctx.msg.media.id, mimeType: ctx.msg.media.mimeType });
    if (!r.ok) {
      await ctx.reply(r.reply.replace(/el reporte/, "la medida"));
      return true; // la pregunta sigue
    }
    answer = r.text;
    await logTranscript(ctx, answer);
    await ctx.reply(heardLine(answer));
  }
  const spoken = await spokenForRouting(ctx, answer);
  // un pedido completo nuevo ("cotízame…", o medida con cantidad/marca/precio) no es la respuesta
  if (explicitQuoteStart(spoken) || strongTyreQuote(spoken)) return false;
  const sizes = findTyreSizes(spoken);
  if (!sizes.length) {
    await ctx.reply("No entendí la medida. Escríbela como *295/80R22.5* o *11R22.5*, o *cancelar*.");
    return true;
  }
  await clearPending(ctx.store, ctx.from);
  await continueVoiceQuote(ctx, withSize(s.text, s.bad, sizes[0].canonical), s.transcript);
  return true;
});

/** En pausa (punto 7): no se pierde si llega otra cosa; *Continuar* repite la pregunta. */
registerPausable(VOICE_SIZE, {
  async describe(_ctx, step) {
    const t = oneLine(String((step as VoiceSizeStep).transcript ?? ""));
    return { companyId: null, label: `cotización por voz «${t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t}»`, missing: "falta la medida" };
  },
  async resume(ctx, step, prefix) {
    const s = step as VoiceSizeStep;
    await askAgain(ctx, step, prefix, s.bad ? `La medida *${displaySize(s.bad)}* no está en el catálogo. ¿Cuál es? (p. ej. *295/80R22.5*)` : "¿Qué medida es? (p. ej. *295/80R22.5*)");
  },
});

/** Nota de voz con la cotización por voz a la vista (cotizador en `choose`): una corrección. */
export async function voiceCorrection(ctx: PortalContext, transcript: string): Promise<void> {
  await logTranscript(ctx, transcript);
  await ctx.reply(heardLine(transcript));
  const c = normalizeVoiceCorrection(applyVocabulary(transcript, await learned(ctx)));
  if (c.kind === "confirm") {
    await ctx.reply(VOICE_OK_TYPED);
    return;
  }
  if (c.kind === "text") {
    await ctx.requote(c.text, { voice: transcript });
    return;
  }
  // con medida: otro pedido (el cotizador pregunta si es un cambio, otra llanta o una cotización nueva)
  if (findTyreSizes(c.text).length) {
    const catalog = await catalogOf(ctx);
    const d = normalizeDictation(c.text, { designs: catalog?.designs, brands: catalog?.brands });
    await continueVoiceQuote(ctx, d.text, transcript);
    return;
  }
  await ctx.reply(`No entendí «${oneLine(transcript).slice(0, 80)}» como un cambio de la cotización. ${VOICE_CORRECTION_HELP}`);
}
