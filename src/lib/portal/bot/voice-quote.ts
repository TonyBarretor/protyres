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
 *  - voiceInQuote: con una cotización a la vista (cotizador en `choose`, `review_quote`, `need_email`), una nota de voz es una corrección:
 *    "no, eran doce" -> `cantidad 12`, "precio 259" -> `precio 259`, "cámbialo a Valor 99" -> `modelo Valor 99` (el
 *    cotizador elige esa opción). Un "ok" dictado no arma el PDF: se pide escribirlo.
 */
import { fold } from "../../tyre/brands";
import { findTyreSizes } from "../../tyre/spec";
import { checkSizes, dictatedProfileQuote, displaySize, fixQuoteVerb, normalizeDictation, normalizeSpoken, normalizeVoiceCorrection, spokenToDigits, type DictatedQuote, type DictationCatalog } from "../voice/dictation";
import { applyOps, draftFromText, draftToText, llmDraftOps, opsToCommands, validateOps, type DraftOp } from "../voice/draft-edit";
import type { VoiceCatalog } from "../voice/catalog";
import { llmAvailable } from "../../llm/client";
import { isOffTopic, OFF_TOPIC_REPLY } from "../../guard/off-topic";
import { UsageCapExceeded } from "../../guard/usage";
import { loadSettings } from "../../settings";
import { isSizeOnly, resolveSpokenSizes, type AmbiguousSize } from "../voice/sizes";
import { joinUbDigits, parseVoiceEdit, type VoiceEdit } from "../voice/items";
import { recordVoice, understoodOf } from "./voice-log";
import { applyVocabulary } from "../voice/vocabulary";
import { askAgain } from "./pause";
import { registerPausable, registerPendingHandler, replyButtons, type PortalContext } from "./registry";
import { fetchVoice, logTranscript, sellerCompanies } from "./report";
import { matchSpokenName } from "../voice/fuzzy";
import { shortName } from "./companies";
import { explicitQuoteStart, routeIntent, strongTyreQuote } from "./router";
import { clearPending, setPending, type IntentChoiceStep, type PendingStep } from "./state";

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
  /** Medidas del catálogo entre las que se pregunta (lo dictado podía ser varias; corrida F, punto 9). */
  options?: string[];
  /** Lo dictado que podía ser varias medidas. */
  spokenSize?: string;
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

/** Lo del catálogo que usa el dictado (marcas, diseños, medidas, lonas y, si se pide, los clientes con perfil). */
function dictCatalog(c: VoiceCatalog | null, extra: Partial<DictationCatalog> = {}, withProfiles = false): DictationCatalog {
  return { designs: c?.designs, brands: c?.brands, sizes: c?.sizes, plies: c?.plies, ...(withProfiles ? { profiles: c?.profiles } : {}), ...extra };
}

async function learned(ctx: PortalContext) {
  return (await ctx.store.listVocabulary().catch(() => [])).map((v) => ({ term: v.term, meaning: v.meaning }));
}

/** La transcripción con el vocabulario aprendido, números y medidas normalizados (para la precedencia del router). */
export async function spokenForRouting(ctx: PortalContext, transcript: string): Promise<string> {
  // "Cotita 8, valor 99 …" (cotiza mal oído; pasada real 2026-11-16) se enruta como "Cotiza …"
  return normalizeSpoken(fixQuoteVerb(applyVocabulary(transcript, await learned(ctx))));
}

/** La nota empieza con un cliente con contrato y trae llantas ("Prosegur Juliaca: cuatro Valor 99 unidad 1231…"): cotización. */
export async function isProfileVoiceQuote(ctx: PortalContext, transcript: string): Promise<boolean> {
  const catalog = await catalogOf(ctx);
  if (!catalog?.profiles?.length) return false;
  return dictatedProfileQuote(applyVocabulary(transcript, await learned(ctx)), dictCatalog(catalog, {}, true));
}

/** Nota de voz que es una cotización: `🎙 Escuché: …` y al cotizador (o la pregunta por la medida). */
export async function startVoiceQuote(ctx: PortalContext, transcript: string): Promise<void> {
  await logTranscript(ctx, transcript);
  await ctx.reply(heardLine(transcript));
  const catalog = await catalogOf(ctx);
  const d = normalizeDictation(applyVocabulary(transcript, await learned(ctx)), dictCatalog(catalog, {}, true));
  const notes = d.fixes.length ? [`🔤 Corregí lo que oí: ${d.fixes.map((f) => `«${f.from}» → ${f.to}`).join(", ")}.`] : [];
  if (d.profile) notes.push(profileNote(d.profile));
  if (d.inherited.length) notes.push(inheritedNote(d.inherited));
  notes.push(...dictationNotes(d));
  const extra: SizeExtra = { choices: d.sizeChoices, unheard: d.unheardSizes, dictated: d, raw: !!d.profile };
  const flow: SplitFlow = {
    text: d.text,
    transcript,
    customer: d.customer,
    profile: !!d.profile,
    ubIssues: d.ubIssues,
    offset: d.profile ? 1 : 0,
    sizeChoices: d.sizeChoices,
    unheard: d.unheardSizes,
    ...(d.brandAsCustomer ? { askCustomer: d.brandAsCustomer } : {}),
  };
  // varias llantas que no se pudieron separar con seguridad: lo entendido y la pregunta (nunca se mezclan ni se descartan)
  if (d.doubts.length) {
    if (notes.length) await ctx.reply(notes.join("\n"));
    const step: Omit<VoiceSplitStep, "createdAt"> = { kind: VOICE_SPLIT, captureText: true, ...flow, doubts: d.doubts };
    await setPending(ctx.store, ctx.from, step, ctx.now);
    await replyButtons(ctx, splitQuestion({ text: flow.text, offset: flow.offset, doubts: d.doubts }), SPLIT_BUTTONS);
    await recordVoice(ctx, { transcript, context: "cotizacion", understood: understoodOf(d, { questions: d.doubts }), outcome: "pregunta" });
    return;
  }
  if (notes.length) await ctx.reply(notes.join("\n"));
  // corrida I: se juntó en una llanta algo que podía ser otra: se asume UNA y se pregunta (botones)
  if (d.single) {
    const step: Omit<VoiceOneStep, "createdAt"> = { kind: VOICE_ONE, captureText: true, ...flow, why: d.single.why, alt: d.single.alt };
    await setPending(ctx.store, ctx.from, step, ctx.now);
    await replyButtons(ctx, oneQuestion({ text: flow.text, offset: flow.offset, why: d.single.why }), ONE_BUTTONS);
    await recordVoice(ctx, { transcript, context: "cotizacion", understood: understoodOf(d, { questions: [`¿una o varias? ${d.single.why.join("; ")}`] }), outcome: "pregunta" });
    return;
  }
  return afterSplit(ctx, flow, extra);
}

/** Corrida I: avisos de lo dictado (moneda, IGV sin decir, lonas que no existen, precio dictado con IGV). */
function quoteSettings(): { currency: string; taxPct: number; taxLabel: string } {
  try {
    const p = loadSettings().pricing;
    return { currency: p.currency, taxPct: p.taxPct, taxLabel: p.taxLabel };
  } catch {
    return { currency: "USD", taxPct: 18, taxLabel: "IGV" };
  }
}

const CURRENCY_NAME: Record<string, string> = { PEN: "soles", USD: "dólares" };

export function dictationNotes(d: DictatedQuote, settings = quoteSettings()): string[] {
  const notes: string[] = [];
  if (d.currency && d.currency !== settings.currency.toUpperCase()) {
    notes.push(`💱 Dijiste *${CURRENCY_NAME[d.currency] ?? d.currency}*, pero la cotización va en *${CURRENCY_NAME[settings.currency.toUpperCase()] ?? settings.currency}*: dejé el número tal cual. Si no es así, corrígelo (p. ej. *precio 1 75*).`);
  }
  if (d.taxMention) notes.push(`🧾 Dijiste «${d.taxMention}» sin decir si el precio lo incluye: uso lo de siempre. Si no, escribe *con igv* o *sin igv*.`);
  for (const p of d.plyIssues) {
    notes.push(`🛞 *${p.ply}PR* no está en el catálogo para ${displaySize(p.size)} (hay ${p.available.map((x) => `${x}PR`).join(", ")}): cotizo sin lonas en la línea ${p.item + 1}.`);
  }
  // "precio 298, incluido impuestos": en el cotizador "precio 298" es sin IGV y "con igv" lo muestra con IGV encima
  if (/^con\s+igv$/im.test(d.text)) {
    const priced = d.items.map((l, i) => ({ i, m: l.match(/\bprecio\s+(\d+(?:\.\d+)?)/i) })).filter((x) => x.m);
    if (priced.length) {
      const f = 1 + settings.taxPct / 100;
      const ex = priced[0];
      const net = Math.round((parseFloat(ex.m![1]) / f) * 100) / 100;
      notes.push(`🧾 Ojo: el precio dictado va *sin ${settings.taxLabel}* (como *precio ${ex.m![1]}* escrito) y la cotización lo muestra con ${settings.taxLabel} encima. Si ${ex.m![1]} ya incluye ${settings.taxLabel}, escribe *precio ${ex.i + 1} ${net}*.`);
    }
  }
  return notes;
}

/** Lo dictado ya separado en llantas: falta la UB de alguna línea, el cliente contra los conocidos, y al cotizador. */
interface SplitFlow {
  text: string;
  transcript: string;
  /** El cliente como se dictó ("" si no se dijo o es un cliente con perfil, que va en la cabecera). */
  customer: string;
  /** La primera línea del texto es la cabecera de un cliente con perfil ("prosegur Juliaca"). */
  profile: boolean;
  /** Líneas de llanta (índice desde 0) con la UB mal oída o sin UB cuando el cliente la pide. */
  ubIssues: { item: number; heard?: string }[];
  /** Cuántas líneas hay antes de la primera llanta (la cabecera). */
  offset: number;
  sizeChoices?: AmbiguousSize[];
  unheard?: string[];
  /** Corrida I: lo dicho como "cliente …" era esta marca del catálogo: se pregunta el cliente antes de cotizar. */
  askCustomer?: string;
}

async function afterSplit(ctx: PortalContext, flow: SplitFlow, extra: SizeExtra = {}): Promise<void> {
  if (flow.ubIssues.length) return askUb(ctx, flow);
  if (flow.askCustomer && !flow.customer && !flow.profile) return askCustomerName(ctx, flow);
  if (!flow.customer || flow.profile) return continueVoiceQuote(ctx, flow.text, flow.transcript, { ...extra, choices: flow.sizeChoices, unheard: flow.unheard, raw: flow.profile });
  const catalog = await catalogOf(ctx);
  const notes: string[] = [];
  // el cliente dictado contra las empresas del vendedor y los clientes de cotizaciones anteriores (nunca a ciegas)
  const known = await knownCustomers(ctx, catalog?.customers ?? []);
  const exact = known.find((k) => foldName(k.name) === foldName(flow.customer));
  const m = exact ? null : matchSpokenName(flow.customer, known);
  if (m?.kind === "clear" && m.best) {
    await ctx.reply(`👤 Cliente: entendí «${flow.customer}» → *${m.best.name}*`);
    return continueVoiceQuote(ctx, withCustomer(flow.text, flow.customer, m.best.name), flow.transcript, { ...extra, choices: flow.sizeChoices, unheard: flow.unheard, customer: m.best.name });
  }
  if (m?.kind === "doubt") {
    const options = m.candidates.slice(0, 2).map((c) => c.name);
    const step: Omit<VoiceCustomerStep, "createdAt"> = { kind: VOICE_CUSTOMER, text: flow.text, transcript: flow.transcript, spoken: flow.customer, options, captureText: true, sizeChoices: flow.sizeChoices, unheard: flow.unheard };
    await setPending(ctx.store, ctx.from, step, ctx.now);
    await replyButtons(ctx, customerQuestion(flow.customer, options), customerButtons(flow.customer, options));
    await recordVoice(ctx, { transcript: flow.transcript, context: extra.context ?? "cotizacion", understood: extra.dictated ? understoodOf(extra.dictated, { questions: [`cliente: ${options.join(" / ")}`] }) : understoodOf(null, { questions: [`cliente: ${options.join(" / ")}`], text: flow.text }), outcome: "pregunta" });
    return;
  }
  if (!exact) notes.push(`⚠️ «${flow.customer}» no está entre tus empresas ni los clientes conocidos: lo dejo tal cual. Si no es así, corrígelo (p. ej. *para ZBUSS*).`);
  if (notes.length) await ctx.reply(notes.join("\n"));
  await continueVoiceQuote(ctx, flow.text, flow.transcript, { ...extra, choices: flow.sizeChoices, unheard: flow.unheard });
}

/** "👤 Entendí: cliente *Prosegur* · sucursal *Juliaca* (va como dirección) (entendí «Prosegul Juliaca») · precios de contrato…". */
function profileNote(p: NonNullable<DictatedQuote["profile"]>): string {
  const said = `${p.name}${p.branch ? ` ${p.branch}` : ""}`;
  const heard = foldName(p.heard) !== foldName(said) ? ` (entendí «${p.heard}»)` : "";
  return p.branch
    ? `👤 Entendí: cliente *${p.name}* · sucursal *${p.branch}* (va como dirección)${heard} · precios de contrato; abajo cada línea con su UB.`
    : `👤 Entendí: cliente *${p.name}*${heard} · ⚠️ no entendí la sucursal: escríbela como *unidad: Juliaca* · precios de contrato; abajo cada línea con su UB.`;
}

/** "📏 Las líneas 2 y 3 no dicen medida: uso 215/75R17.5, la de la línea anterior." */
function inheritedNote(inherited: { item: number; size: string }[]): string {
  const n = inherited.map((x) => x.item + 1);
  const which = n.length === 1 ? `La línea ${n[0]} no dice medida` : `Las líneas ${n.slice(0, -1).join(", ")} y ${n[n.length - 1]} no dicen medida`;
  const sizes = [...new Set(inherited.map((x) => displaySize(x.size)))];
  return `📏 ${which}: uso ${sizes.join(" / ")}, la de la línea anterior.`;
}

// ── varias llantas que no se pudieron separar (corrida H, punto 5) ──

export const VOICE_SPLIT = "voice_split";

/** Esperando que el vendedor confirme cómo se separaron las llantas dictadas (o lo dicte / escriba de nuevo). */
export interface VoiceSplitStep extends PendingStep, SplitFlow {
  kind: typeof VOICE_SPLIT;
  doubts: string[];
  captureText: true;
}

const SPLIT_BUTTONS = [
  { id: "sí", title: "Sí, así está bien" },
  { id: "no", title: "No, lo repito" },
];

function itemLinesOf(text: string, offset: number): string[] {
  return text
    .split("\n")
    .slice(offset)
    .filter((l) => !/^(?:para\s|plazo:|margen\s|dscto\s|con\s+igv|sin\s+igv)/i.test(l));
}

function splitQuestion(s: Pick<VoiceSplitStep, "text" | "offset" | "doubts">): string {
  const lines = itemLinesOf(s.text, s.offset).map((l, i) => `${i + 1}. ${l}`);
  return `Entendí estas llantas:\n${lines.join("\n")}\n\n⚠️ No estoy seguro de cómo separarlas: ${s.doubts.join("; ")}.\n¿Está bien así? Si no, díctalo de nuevo separando cada llanta (p. ej. «ocho Valor 99 en 295 80 22.5, y doce Flama 89 en 11 R 22.5») o escríbelo, una llanta por línea.`;
}

registerPendingHandler(VOICE_SPLIT, async (ctx, step, rawText) => {
  const s = step as VoiceSplitStep;
  // otra nota de voz: el pedido dictado de nuevo, o (corrida I) una corrección libre del borrador
  if (ctx.msg.type === "audio") return freeEditInDraft(ctx, s, rawText);
  const t = foldName(rawText);
  if (/^(?:si|sí|ok|dale|correcto|asi esta bien|si asi esta bien|esta bien|listo)$/.test(t)) {
    await clearPending(ctx.store, ctx.from);
    await afterSplit(ctx, s, { context: "seguimiento" });
    return true;
  }
  if (/^(?:no|no lo repito|no esta bien)$/.test(t)) {
    await clearPending(ctx.store, ctx.from);
    await ctx.reply("Listo, no lo cotizo. Díctalo de nuevo separando cada llanta, o escríbelo (una llanta por línea).");
    return true;
  }
  // lo escribió de nuevo (va al cotizador como un pedido escrito) o es una corrección libre ("únelas, es una sola")
  return freeEditInDraft(ctx, s, rawText);
});

registerPausable(VOICE_SPLIT, {
  async describe(_ctx, step) {
    const t = oneLine(String((step as VoiceSplitStep).transcript ?? ""));
    return { companyId: null, label: `cotización por voz «${t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t}»`, missing: "falta confirmar las llantas" };
  },
  async resume(ctx, step, prefix) {
    await askAgain(ctx, step, prefix, splitQuestion(step as VoiceSplitStep), SPLIT_BUTTONS);
  },
});

// ── ¿una sola llanta o varias? (corrida I) ──

export const VOICE_ONE = "voice_one";

/** Se juntó en UNA llanta algo que podía ser otra: esperando "Es una sola llanta" o "Son varias". */
export interface VoiceOneStep extends PendingStep, SplitFlow {
  kind: typeof VOICE_ONE;
  captureText: true;
  /** Por qué se duda ("dos productos («Flama 77»)"). */
  why: string[];
  /** El texto separando en cada pausa ("" si eso no da más llantas). */
  alt: string;
}

export const ONE_BUTTONS = [
  { id: "una sola", title: "Es una sola llanta" },
  { id: "son varias", title: "Son varias" },
];

function oneQuestion(s: Pick<VoiceOneStep, "text" | "offset" | "why">): string {
  const lines = itemLinesOf(s.text, s.offset).map((l, i) => `${i + 1}. ${l}`);
  return `Entendí *una sola llanta*:\n${lines.join("\n")}\n\n⚠️ Lo dictado tiene ${s.why.join("; ")}. ¿Es una sola llanta o son varias? (También puedes decirme el cambio, p. ej. «son dos: la Flama 77 es otra llanta».)`;
}

registerPendingHandler(VOICE_ONE, async (ctx, step, rawText) => {
  const s = step as VoiceOneStep;
  if (ctx.msg.type !== "audio") {
    const t = foldName(rawText);
    if (/^(?:una sola(?: llanta)?|es una sola(?: llanta)?|una|si|ok|correcto)$/.test(t)) {
      await clearPending(ctx.store, ctx.from);
      await afterSplit(ctx, flowOf(s), { context: "seguimiento" });
      return true;
    }
    if (/^(?:son varias|varias|no)$/.test(t)) {
      await clearPending(ctx.store, ctx.from);
      if (!s.alt) {
        await ctx.reply("Listo. Díctalas de nuevo separando cada llanta con «y» (p. ej. «ocho Valor 99 en 295 80 22.5, y cuatro Flama 77 en 275 80 22.5») o escríbelas, una por línea.");
        return true;
      }
      // la lectura separando en cada pausa, para confirmar (o corregir)
      const split: Omit<VoiceSplitStep, "createdAt"> = { ...flowOf(s), kind: VOICE_SPLIT, captureText: true, text: s.alt, ubIssues: [], doubts: ["las separé en cada pausa (coma o punto)"] };
      await setPending(ctx.store, ctx.from, split, ctx.now);
      await replyButtons(ctx, splitQuestion({ text: s.alt, offset: s.offset, doubts: ["las separé en cada pausa (coma o punto)"] }), SPLIT_BUTTONS);
      return true;
    }
  }
  return freeEditInDraft(ctx, s, rawText);
});

registerPausable(VOICE_ONE, {
  async describe(_ctx, step) {
    const t = oneLine(String((step as VoiceOneStep).transcript ?? ""));
    return { companyId: null, label: `cotización por voz «${t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t}»`, missing: "falta confirmar si es una sola llanta" };
  },
  async resume(ctx, step, prefix) {
    await askAgain(ctx, step, prefix, oneQuestion(step as VoiceOneStep), ONE_BUTTONS);
  },
});

/** Lo de un paso que es el pedido dictado (sin lo propio del paso). */
function flowOf(s: SplitFlow): SplitFlow {
  return {
    text: s.text,
    transcript: s.transcript,
    customer: s.customer,
    profile: s.profile,
    ubIssues: s.ubIssues,
    offset: s.offset,
    ...(s.sizeChoices ? { sizeChoices: s.sizeChoices } : {}),
    ...(s.unheard ? { unheard: s.unheard } : {}),
    ...(s.askCustomer ? { askCustomer: s.askCustomer } : {}),
  };
}

// ── el cliente, cuando se dijo una marca como cliente (corrida I) ──

export const VOICE_CUSTOMER_NAME = "voice_customer_name";

export interface VoiceCustomerNameStep extends PendingStep, SplitFlow {
  kind: typeof VOICE_CUSTOMER_NAME;
  captureText: true;
}

const CUSTOMER_NAME_BUTTONS = [{ id: "sin cliente", title: "Sin cliente" }];
const customerNameQuestion = (brand: string) =>
  `👤 «${brand}» es una marca del catálogo: la tomé como la marca de la llanta. ¿Para qué cliente es la cotización? Escríbelo o díctalo (p. ej. *ZBUSS*), o *sin cliente*.`;

async function askCustomerName(ctx: PortalContext, flow: SplitFlow): Promise<void> {
  const step: Omit<VoiceCustomerNameStep, "createdAt"> = { kind: VOICE_CUSTOMER_NAME, captureText: true, ...flow };
  await setPending(ctx.store, ctx.from, step, ctx.now);
  await replyButtons(ctx, customerNameQuestion(flow.askCustomer ?? ""), CUSTOMER_NAME_BUTTONS);
  await recordVoice(ctx, { transcript: flow.transcript, context: "cotizacion", understood: understoodOf(null, { questions: [`cliente («${flow.askCustomer}» es marca)`], text: flow.text }), outcome: "pregunta" });
}

registerPendingHandler(VOICE_CUSTOMER_NAME, async (ctx, step, rawText) => {
  const s = step as VoiceCustomerNameStep;
  let answer = rawText.trim();
  if (ctx.msg.type === "audio" && ctx.msg.media) {
    const r = await fetchVoice(ctx, { id: ctx.msg.media.id, mimeType: ctx.msg.media.mimeType });
    if (!r.ok) {
      await ctx.reply(r.reply.replace(/el reporte/, "el cliente"));
      return true;
    }
    answer = r.text;
    if (await looksLikeOrder(ctx, answer)) return false; // otro pedido dictado
    await logTranscript(ctx, answer);
    await ctx.reply(heardLine(answer));
  } else if (await looksLikeOrder(ctx, answer)) return false;
  const name = oneLine(answer.replace(/[.!?¡¿]+$/g, "").replace(/^(?:(?:es\s+)?(?:para|el\s+cliente\s+es|cliente|la\s+empresa)\s*:?\s*)+/i, "")).slice(0, 80);
  const flow: SplitFlow = { ...flowOf(s), askCustomer: undefined };
  await clearPending(ctx.store, ctx.from);
  if (!name || /^(?:sin cliente|ninguno|no se|no sé|despues|después)$/.test(foldName(name))) {
    await afterSplit(ctx, flow, { context: "seguimiento" });
    return true;
  }
  const d = draftFromText(flow.text, flow.offset);
  d.customer = name;
  await afterSplit(ctx, { ...flow, text: draftToText(d), customer: name }, { context: "seguimiento" });
  return true;
});

registerPausable(VOICE_CUSTOMER_NAME, {
  async describe(_ctx, step) {
    const t = oneLine(String((step as VoiceCustomerNameStep).transcript ?? ""));
    return { companyId: null, label: `cotización por voz «${t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t}»`, missing: "falta el cliente" };
  },
  async resume(ctx, step, prefix) {
    await askAgain(ctx, step, prefix, customerNameQuestion((step as VoiceCustomerNameStep).askCustomer ?? ""), CUSTOMER_NAME_BUTTONS);
  },
});

// ── correcciones libres sobre el borrador (corrida I, punto 6) ──

export const VOICE_FREE_EDIT = "voice_free_edit";

/** El borrador corregido por una corrección libre, esperando "Sí" para seguir (o "No" para volver al de antes). */
export interface VoiceFreeEditStep extends PendingStep, SplitFlow {
  kind: typeof VOICE_FREE_EDIT;
  captureText: true;
  /** El paso de antes de la corrección (para "No"). */
  previous: PendingStep;
  /** Lo hecho y lo descartado, en palabras. */
  summary: string;
}

const FREE_EDIT_BUTTONS = [
  { id: "sí", title: "Sí, así" },
  { id: "no", title: "No" },
];
export const FREE_EDIT_NOT_UNDERSTOOD = "No entendí un cambio que pueda hacer en el borrador.";
export const FREE_EDIT_UNAVAILABLE = "No pude leer esa corrección ahora.";
export const FREE_EDIT_HELP = "Responde con los botones, dime el cambio de otra forma (p. ej. «únelas, es una sola llanta», «la segunda es 11R22.5», «quita la tercera») o escríbelo, una llanta por línea.";

/** VOICE_FREE_EDITS=off apaga las correcciones libres (se lee en cada mensaje). */
export function freeEditsOn(env: Record<string, string | undefined>): boolean {
  const v = (env.VOICE_FREE_EDITS ?? "").trim().toLowerCase();
  return v !== "off" && v !== "0" && v !== "false";
}

/** ¿Es un pedido completo nuevo (no una corrección)? */
async function looksLikeOrder(ctx: PortalContext, text: string): Promise<boolean> {
  const sp = await spokenForRouting(ctx, text);
  return explicitQuoteStart(sp) || strongTyreQuote(sp);
}

function freeEditQuestion(s: Pick<VoiceFreeEditStep, "text" | "offset" | "summary">): string {
  const lines = s.text.split("\n").slice(s.offset);
  const items = itemLinesOf(s.text, s.offset).map((l, i) => `${i + 1}. ${l}`);
  const rest = lines.filter((l) => /^(?:para\s|plazo:|margen\s|dscto\s|con\s+igv|sin\s+igv)/i.test(l));
  return `✏️ ${s.summary}\nQueda así:\n${items.join("\n")}${rest.length ? `\n${rest.join("\n")}` : ""}\n\n¿Lo dejo así?`;
}

/**
 * Un mensaje que no es respuesta a la pregunta del borrador (VOICE_SPLIT, VOICE_ONE, VOICE_FREE_EDIT): un pedido nuevo
 * (false: lo toma el router, como antes), fuera de tema (la línea fija, sin modelo) o una corrección libre: el modelo la
 * traduce a operaciones cerradas, se validan, se aplican al borrador y se muestra para confirmar. Sin modelo (o apagado)
 * el mensaje sigue como antes (false).
 */
async function freeEditInDraft(ctx: PortalContext, s: SplitFlow & PendingStep, rawText: string): Promise<boolean> {
  let message = rawText.trim();
  const voiced = ctx.msg.type === "audio";
  if (!freeEditsOn(ctx.env) || !llmAvailable()) return false;
  if (voiced && ctx.msg.media) {
    const r = await fetchVoice(ctx, { id: ctx.msg.media.id, mimeType: ctx.msg.media.mimeType });
    if (!r.ok) return false; // el router responde lo de siempre (la transcripción queda en caché)
    message = r.text;
  }
  if (!message || (await looksLikeOrder(ctx, message))) return false;
  if (voiced) {
    await logTranscript(ctx, message);
    await ctx.reply(heardLine(message));
  }
  // fuera de tema: la línea fija, sin modelo (corrida E); el borrador sigue esperando
  if (isOffTopic(message)) {
    await ctx.reply(OFF_TOPIC_REPLY);
    return true;
  }
  const draft = draftFromText(s.text, s.offset);
  const catalog = await catalogOf(ctx);
  const brands = catalog?.brands ?? [];
  let res: Awaited<ReturnType<typeof llmDraftOps>> = null;
  try {
    res = await llmDraftOps(message, draft);
  } catch (err) {
    if (!(err instanceof UsageCapExceeded)) ctx.log(`portal: corrección libre: ${(err as Error).message}`);
  }
  const record = (outcome: "ok" | "pregunta" | "fallo", text: string) =>
    recordVoice(ctx, { transcript: message, context: "correccion_libre", voiced, understood: understoodOf(null, { questions: outcome === "ok" ? [] : [text], text }), outcome });
  if (!res) {
    await ctx.reply(`${FREE_EDIT_UNAVAILABLE} ${FREE_EDIT_HELP}`);
    await record("fallo", "sin modelo");
    return true;
  }
  const v = res.isCorrection ? validateOps(res.raw, { message, lineCount: draft.items.length, brands }) : { ops: [] as DraftOp[], rejected: [] as string[] };
  if (!v.ops.length) {
    await ctx.reply(`${FREE_EDIT_NOT_UNDERSTOOD}${v.rejected.length ? ` (${v.rejected.join("; ")})` : ""} ${FREE_EDIT_HELP}`);
    await record("fallo", v.rejected.join("; ") || "no es una corrección");
    return true;
  }
  const a = applyOps(draft, v.ops, brands);
  if (!a.done.length) {
    await ctx.reply(`No pude hacer ese cambio: ${[...a.failed, ...v.rejected].join("; ")}. ${FREE_EDIT_HELP}`);
    await record("fallo", a.failed.join("; "));
    return true;
  }
  const text = draftToText(a.draft);
  // la UB de cada línea otra vez (las líneas pueden haber cambiado), solo si el pedido las traía
  const hadUb = /\bub\s+\d{4}\b/i.test(s.text) || s.ubIssues.length > 0;
  const ubIssues = hadUb ? a.draft.items.map((l, i) => (/\bub\s+\d{4}\b/i.test(l) ? null : { item: i })).filter((x): x is { item: number } => !!x) : [];
  const customerOp = v.ops.some((o) => o.op === "customer");
  const flow: SplitFlow = { ...flowOf(s), text, customer: a.draft.customer, ubIssues, ...(customerOp ? { askCustomer: undefined } : {}) };
  const skipped = [...a.failed, ...v.rejected];
  const summary = `${a.done.join("; ")}.${skipped.length ? ` ⚠️ No hice: ${skipped.join("; ")}.` : ""}`;
  const previous = (s as PendingStep).kind === VOICE_FREE_EDIT ? (s as unknown as VoiceFreeEditStep).previous : (s as PendingStep);
  const step: Omit<VoiceFreeEditStep, "createdAt"> = { kind: VOICE_FREE_EDIT, captureText: true, ...flow, previous, summary };
  await setPending(ctx.store, ctx.from, step, ctx.now);
  await replyButtons(ctx, freeEditQuestion({ text, offset: flow.offset, summary }), FREE_EDIT_BUTTONS);
  await record("pregunta", `corrección libre: ${a.done.join("; ")}`);
  return true;
}

registerPendingHandler(VOICE_FREE_EDIT, async (ctx, step, rawText) => {
  const s = step as VoiceFreeEditStep;
  if (ctx.msg.type !== "audio") {
    const t = foldName(rawText);
    if (/^(?:si|sí|si asi|si, asi|ok|dale|correcto|asi esta bien|esta bien|listo)$/.test(t)) {
      await clearPending(ctx.store, ctx.from);
      await afterSplit(ctx, flowOf(s), { context: "seguimiento" });
      return true;
    }
    if (/^(?:no|no asi no|deshacer)$/.test(t)) {
      // vuelve el borrador de antes, con su pregunta
      const prev = s.previous as PendingStep & SplitFlow & { kind: string };
      await setPending(ctx.store, ctx.from, prev, ctx.now);
      const q = prev.kind === VOICE_ONE ? oneQuestion(prev as VoiceOneStep) : splitQuestion(prev as VoiceSplitStep);
      await replyButtons(ctx, `Listo, lo dejo como estaba.\n\n${q}`, prev.kind === VOICE_ONE ? ONE_BUTTONS : SPLIT_BUTTONS);
      return true;
    }
  }
  // otra corrección sobre el borrador ya corregido
  return freeEditInDraft(ctx, s, rawText);
});

registerPausable(VOICE_FREE_EDIT, {
  async describe(_ctx, step) {
    const t = oneLine(String((step as VoiceFreeEditStep).transcript ?? ""));
    return { companyId: null, label: `cotización por voz «${t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t}»`, missing: "falta confirmar la corrección" };
  },
  async resume(ctx, step, prefix) {
    await askAgain(ctx, step, prefix, freeEditQuestion(step as VoiceFreeEditStep), FREE_EDIT_BUTTONS);
  },
});

// ── UB de cada línea (corrida H, punto 6: siempre 4 cifras) ──

export const VOICE_UB = "voice_ub";

/** Esperando la UB de una línea (no se dijo, o lo oído no tiene 4 cifras). */
export interface VoiceUbStep extends PendingStep, SplitFlow {
  kind: typeof VOICE_UB;
  captureText: true;
}

function ubQuestion(s: SplitFlow): string {
  const issue = s.ubIssues[0];
  const line = itemLinesOf(s.text, s.offset)[issue.item] ?? "";
  const what = `la línea ${issue.item + 1} (${line})`;
  const head = issue.heard ? `Entendí la UB «${issue.heard}» en ${what}, pero una UB tiene 4 cifras.` : `Falta la UB de ${what}.`;
  return `${head} ¿Cuál es? Escríbela o díctala (p. ej. *1812*), o *sin ub* para seguir sin ella.`;
}

async function askUb(ctx: PortalContext, flow: SplitFlow): Promise<void> {
  const step: Omit<VoiceUbStep, "createdAt"> = { kind: VOICE_UB, captureText: true, ...flow };
  await setPending(ctx.store, ctx.from, step, ctx.now);
  await ctx.reply(ubQuestion(flow));
  await recordVoice(ctx, { transcript: flow.transcript, context: "cotizacion", understood: understoodOf(null, { questions: [`ub de la línea ${flow.ubIssues[0].item + 1}`], text: flow.text }), outcome: "pregunta" });
}

/** El texto con la UB puesta en la línea de llanta `item` (cambia la que tenía). */
export function withUb(text: string, offset: number, item: number, ub: string | null): string {
  const lines = text.split("\n");
  const at = offset + item;
  if (!lines[at]) return text;
  const base = lines[at].replace(/\s+ub\s+\d+\b/i, "");
  lines[at] = ub ? `${base} ub ${ub}` : base;
  return lines.join("\n");
}

registerPendingHandler(VOICE_UB, async (ctx, step, rawText) => {
  const s = step as VoiceUbStep;
  let answer = rawText.trim();
  if (ctx.msg.type === "audio" && ctx.msg.media) {
    const r = await fetchVoice(ctx, { id: ctx.msg.media.id, mimeType: ctx.msg.media.mimeType });
    if (!r.ok) {
      await ctx.reply(r.reply.replace(/el reporte/, "la UB"));
      return true;
    }
    answer = r.text;
    await logTranscript(ctx, answer);
    await ctx.reply(heardLine(answer));
  }
  const f = foldName(answer);
  let ub: string | null = null;
  if (!/^(?:sin ub|sin|ninguna|no tiene|no se|no sé)$/.test(f)) {
    const digits = spokenToDigits(joinUbDigits(answer)).replace(/^\s*(?:la\s+)?(?:u\.?\s?b\.?|u\s+be|ube|unidad(?:\s+blindada)?)\s*:?\s*/i, "");
    const only = digits.replace(/[^\d]/g, "");
    if (!/^[\d\s.,]+[.]?$/.test(digits.trim()) || !only) {
      if (ctx.msg.type !== "audio" && (explicitQuoteStart(answer) || findTyreSizes(answer).length)) return false; // otro pedido
      await ctx.reply(`No entendí «${oneLine(answer).slice(0, 40)}» como una UB. ${ubQuestion(s)}`);
      return true;
    }
    if (only.length !== 4) {
      await ctx.reply(`«${only}» no tiene 4 cifras. ${ubQuestion(s)}`);
      return true;
    }
    ub = only;
  }
  const flow: SplitFlow = { ...s, text: withUb(s.text, s.offset, s.ubIssues[0].item, ub), ubIssues: s.ubIssues.slice(1) };
  await recordVoice(ctx, { transcript: answer, context: "ub", voiced: ctx.msg.type === "audio", understood: understoodOf(null, { questions: [], text: ub ? `ub ${ub}` : "sin ub" }), outcome: "ok" });
  await clearPending(ctx.store, ctx.from);
  await afterSplit(ctx, flow, { context: "seguimiento" });
  return true;
});

registerPausable(VOICE_UB, {
  async describe(_ctx, step) {
    const t = oneLine(String((step as VoiceUbStep).transcript ?? ""));
    return { companyId: null, label: `cotización por voz «${t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t}»`, missing: "falta una UB" };
  },
  async resume(ctx, step, prefix) {
    await askAgain(ctx, step, prefix, ubQuestion(step as VoiceUbStep));
  },
});

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
  /** Medidas dictadas que podían ser varias (se preguntan después del cliente). */
  sizeChoices?: AmbiguousSize[];
  unheard?: string[];
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
  await continueVoiceQuote(ctx, name === s.spoken ? s.text : withCustomer(s.text, s.spoken, name), s.transcript, { choices: s.sizeChoices, unheard: s.unheard, context: "seguimiento" });
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

/** Lo que la lectura de la medida dictada dejó pendiente (corrida F, punto 9) y lo entendido, para el registro. */
interface SizeExtra {
  /** Medidas dictadas que pueden ser varias del catálogo: se pregunta con botones. */
  choices?: AmbiguousSize[];
  /** Zonas con forma de medida que no coinciden con ninguna del catálogo (para decir qué se oyó). */
  unheard?: string[];
  /** El pedido dictado (para el registro de transcripciones). */
  dictated?: DictatedQuote;
  /** El cliente ya resuelto contra las empresas conocidas. */
  customer?: string;
  /** El contexto del registro ("cotizacion", "medida", "correccion"); por defecto "cotizacion". */
  context?: string;
  /** El texto empieza con la cabecera de un cliente con perfil ("prosegur Juliaca"): va al cotizador tal cual. */
  raw?: boolean;
}

const sizeChoiceQuestion = (spoken: string, options: string[]) =>
  `Entendí la medida «${spoken}», que puede ser ${options.map((o) => `*${displaySize(o)}*`).join(" o ")}. ¿Cuál es? (o *cancelar*)`;
const sizeButtons = (options: string[]) => options.map((c) => ({ id: c, title: displaySize(c).slice(0, 20) }));

/** Valida las medidas del texto contra el catálogo: si están, al cotizador; si no, pregunta y espera en `voice_size`. */
async function continueVoiceQuote(ctx: PortalContext, text: string, transcript: string, extra: SizeExtra = {}): Promise<void> {
  const sizes = findTyreSizes(text).map((s) => s.canonical);
  const understood = (questions: string[]) => (extra.dictated ? understoodOf(extra.dictated, { questions, customer: extra.customer, text }) : understoodOf(null, { questions, text }));
  const record = (outcome: "ok" | "pregunta" | "fallo", questions: string[] = []) =>
    recordVoice(ctx, { transcript, context: extra.context ?? "cotizacion", understood: understood(questions), outcome });
  const ask = async (bad: string | null, body: string, candidates: string[] = [], choice?: AmbiguousSize): Promise<void> => {
    const step: Omit<VoiceSizeStep, "createdAt"> = { kind: VOICE_SIZE, text, bad, transcript, captureText: true, ...(choice ? { options: choice.options, spokenSize: choice.from } : {}) };
    await setPending(ctx.store, ctx.from, step, ctx.now);
    if (candidates.length) await replyButtons(ctx, body, sizeButtons(candidates));
    else await ctx.reply(body);
  };
  // lo dictado podía ser varias medidas del catálogo: se pregunta (en el texto va la primera opción, que se cambia)
  const choice = extra.choices?.find((c) => sizes.includes(c.options[0]));
  if (choice) {
    await record("pregunta", [`medida «${choice.from}»: ${choice.options.join(" / ")}`]);
    return ask(choice.options[0], sizeChoiceQuestion(choice.from, choice.options), choice.options, choice);
  }
  // un cliente con contrato (cabecera "prosegur Juliaca") no necesita medida: el contrato la trae
  if (!sizes.length && !extra.raw) {
    const heard = extra.unheard?.[0];
    await record("fallo", [heard ? `medida no reconocida «${heard}»` : "sin medida"]);
    const head = heard ? `No encontré la medida «${heard}» en el catálogo.` : "No entendí la medida.";
    return ask(null, `${head} ¿Qué medida es? (p. ej. *295/80R22.5* o *11R22.5*; también puedes dictarla) — o *cancelar*.`);
  }
  const catalog = await catalogOf(ctx);
  const missing = checkSizes(sizes, catalog?.sizes ?? []);
  if (missing.length) {
    const m = missing[0];
    await record("pregunta", [`medida ${m.size} no está en el catálogo${m.candidates.length ? `: ${m.candidates.join(" / ")}` : ""}`]);
    const which = `La medida *${displaySize(m.size)}* no está en el catálogo.`;
    if (m.candidates.length) return ask(m.size, `${which} ¿Cuál es? Elige una o escríbeme la correcta (o *cancelar*).`, m.candidates);
    return ask(m.size, `${which} Escríbeme o díctame la medida correcta (p. ej. *295/80R22.5*), o *cancelar*.`);
  }
  await record("ok");
  await ctx.requote(extra.raw ? text : asRequest(text), { voice: transcript });
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
  const voiced = ctx.msg.type === "audio";
  const catalog = await catalogOf(ctx);
  const fixedAnswer = applyVocabulary(answer, await learned(ctx));
  // el bot pidió solo la medida: si la respuesta es solo una medida (cifras, R, separadores), se lee entera como medida
  // contra el catálogo ("2 9 5 80 R 22.5." -> 295/80R22.5; corrida F, punto 9). Una medida escrita bien formada, tal cual.
  const written = findTyreSizes(fixedAnswer);
  const digits = spokenToDigits(fixedAnswer);
  if (isSizeOnly(digits) && !(written.length === 1 && written[0].constructionExplicit && (!catalog?.sizes.length || catalog.sizes.includes(written[0].canonical)))) {
    const r = resolveSpokenSizes(digits, catalog?.sizes ?? null);
    const amb = r.ambiguous[0];
    if (amb && !r.resolved.length) {
      await recordVoice(ctx, { transcript: answer, context: "medida", voiced, understood: understoodOf(null, { questions: [`medida «${amb.from}»: ${amb.options.join(" / ")}`] }), outcome: "pregunta" });
      const step: Omit<VoiceSizeStep, "createdAt"> = { ...s, options: amb.options, spokenSize: amb.from };
      await setPending(ctx.store, ctx.from, step, ctx.now);
      await replyButtons(ctx, sizeChoiceQuestion(amb.from, amb.options), sizeButtons(amb.options));
      return true;
    }
    if (r.resolved.length === 1 && !r.ambiguous.length) {
      const got = r.resolved[0];
      await recordVoice(ctx, { transcript: answer, context: "medida", voiced, understood: understoodOf(null, { sizes: [got.to] }), outcome: "ok" });
      if (!got.plain && got.from.replace(/\s+/g, "") !== got.to) await ctx.reply(`🔤 Corregí lo que oí: «${got.from}» → ${displaySize(got.to)}.`);
      await clearPending(ctx.store, ctx.from);
      await continueVoiceQuote(ctx, withSize(s.text, s.bad, got.to), s.transcript, { context: "seguimiento" });
      return true;
    }
  }
  const spoken = await spokenForRouting(ctx, answer);
  // un pedido completo nuevo ("cotízame…", o medida con cantidad/marca/precio) no es la respuesta
  if (explicitQuoteStart(spoken) || strongTyreQuote(spoken)) return false;
  const sizes = findTyreSizes(spoken);
  if (!sizes.length) {
    await recordVoice(ctx, { transcript: answer, context: "medida", voiced, understood: understoodOf(null, { questions: ["medida no reconocida"] }), outcome: "fallo" });
    await ctx.reply(`No entendí la medida${isSizeOnly(digits) ? ` «${oneLine(answer).replace(/[.\s]+$/, "")}»` : ""}. Escríbela como *295/80R22.5* o *11R22.5*, o *cancelar*.`);
    return true;
  }
  await recordVoice(ctx, { transcript: answer, context: "medida", voiced, understood: understoodOf(null, { sizes: [sizes[0].canonical] }), outcome: "ok" });
  await clearPending(ctx.store, ctx.from);
  await continueVoiceQuote(ctx, withSize(s.text, s.bad, sizes[0].canonical), s.transcript, { context: "seguimiento" });
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
    if (s.options?.length) return askAgain(ctx, step, prefix, sizeChoiceQuestion(s.spokenSize ?? "", s.options), sizeButtons(s.options));
    await askAgain(ctx, step, prefix, s.bad ? `La medida *${displaySize(s.bad)}* no está en el catálogo. ¿Cuál es? (p. ej. *295/80R22.5*)` : "¿Qué medida es? (p. ej. *295/80R22.5*)");
  },
});

/** El cotizador espera los datos del formato del cliente (Prosegur: solicitante) antes de mostrar la cotización. */
const NEED_FIELDS = "need_fields";
/** El cotizador preguntó si el pedido nuevo es un cambio, otra llanta para agregar o una cotización nueva. */
const CONFIRM_NEW = "confirm_new";
export const VOICE_EDIT_AFTER_EMAIL = "La cotización ya está armada y espero el correo del cliente: escríbelo (o *cancelar*); luego corrige con *cantidad 2 10* o *precio 1 259*.";
export const VOICE_EDIT_AFTER_CONFIRM_NEW = "Antes dime qué hago con el pedido anterior: *cambiar*, *agregar* o *nueva* (o *cancelar*); luego dicta la corrección, p. ej. «el segundo eran diez».";
export const VOICE_EDIT_AFTER_FIELDS = "Primero completa lo que falta (o responde *ok* para seguir sin eso); luego dicta la corrección, p. ej. «el segundo eran diez».";

/** Pasos del cotizador con una cotización a la vista: una nota de voz es una corrección ("eran doce", "precio 259"). */
const CORRECTION_STEPS = new Set(["choose", "review_quote", "need_email"]);

export const VOICE_CONFIRM_TYPED = "Por voz no confirmo ni envío la cotización: si está bien, escribe *ok* (o dicta el cambio que quieras).";
export const VOICE_PAUSED_IN_QUOTE =
  "Tienes una cotización abierta, así que no la mezclo con esta nota: la dejé en pausa. Termina la cotización (*ok*) o escribe *cancelar*, y luego toca *Continuar* para retomarla.";

/** "envíala", "ok mándala", "sí, envíasela": por voz nunca se envía. */
const SEND_WORDS = /^(?:(?:ok|okey|si|dale|listo|ya)\s+)*(?:envia|enviala|envialo|enviasela|enviaselo|enviar|enviarla|manda|mandala|mandalo|mandasela|mandar)\b/;

/** Lo que hizo voiceInQuote; `pause` = la nota que quien llama deja en pausa (paso "¿cotización o reporte?" con voz). */
export interface VoiceInQuoteResult {
  what: string;
  pause?: Omit<IntentChoiceStep, "createdAt">;
}

/**
 * Nota de voz con el cotizador a mitad de un flujo (corrida F, punto 4; antes recibía "no leo audios"). Ya transcrita:
 *  - con una cotización a la vista (`choose`, `review_quote`, `need_email`): una corrección ("eran doce" -> `cantidad 12`,
 *    "cámbialo a Valor 99" -> `modelo Valor 99`, "precio 259"), o un pedido con medida (el cotizador pregunta si es un
 *    cambio u otra cotización);
 *  - en una pregunta del cotizador (aplicación, campos del perfil, proveedor de una lista, "¿nueva o cambio?"): la
 *    respuesta dictada, como si se escribiera;
 *  - un "ok"/"sí" dictado nunca confirma ni envía: se pide escribirlo;
 *  - lo que suena a reporte (o no se entiende como nada de lo anterior y tiene señales de reporte) queda en pausa como
 *    "¿cotización o reporte?" con la transcripción: no se mezcla con la cotización ni se pierde.
 */
export async function voiceInQuote(ctx: PortalContext, transcript: string, quoteStep: string): Promise<VoiceInQuoteResult> {
  await logTranscript(ctx, transcript);
  await ctx.reply(heardLine(transcript));
  const fixed = applyVocabulary(transcript, await learned(ctx));
  const c = normalizeVoiceCorrection(fixed);
  if (c.kind === "confirm" || SEND_WORDS.test(fold(transcript))) {
    await ctx.reply(quoteStep === "choose" ? VOICE_OK_TYPED : VOICE_CONFIRM_TYPED);
    return { what: "confirmación dictada" };
  }
  const spoken = normalizeSpoken(fixed);
  // corrida H, punto 5: correcciones dirigidas ("el segundo eran diez", "quita el tercero", "al primero ponle precio 259") y
  // "agrega / añade / súmale / también …" con la cotización a la vista: el comando escrito equivalente
  const edit = CORRECTION_STEPS.has(quoteStep) || quoteStep === NEED_FIELDS || quoteStep === CONFIRM_NEW ? parseVoiceEdit(spokenToDigits(fixed)) : null;
  if (edit && quoteStep === CONFIRM_NEW) {
    // el cotizador preguntó "¿cambio, agregar o nueva?" por un pedido anterior: "súmale …" es agregar (a la abierta); una
    // corrección dirigida espera a que se responda esa pregunta (si no, se queda repitiéndola; pasada real 2026-11-16)
    if (edit.kind !== "add") {
      await ctx.reply(VOICE_EDIT_AFTER_CONFIRM_NEW);
      return { what: "corrección por voz en espera de cambio/agregar/nueva" };
    }
    const written = await editCommand(ctx, edit, transcript);
    if (written) await ctx.requote(written, { voice: transcript });
    return { what: "agregar por voz" };
  }
  if (edit && edit.kind !== "add" && quoteStep === "need_email") {
    // la cotización ya está armada y el cotizador espera el correo (pasada real 2026-11-16: "El 2º eran 10." no hacía nada)
    await ctx.reply(VOICE_EDIT_AFTER_EMAIL);
    return { what: "corrección por voz en espera del correo" };
  }
  if (edit && quoteStep === NEED_FIELDS) {
    // faltan datos del formato del cliente (solicitante…): las llantas se agregan como líneas; las correcciones, después
    if (edit.kind !== "add") {
      await ctx.reply(VOICE_EDIT_AFTER_FIELDS);
      return { what: "corrección por voz en espera de datos" };
    }
    const written = await editCommand(ctx, edit, transcript);
    if (written) await ctx.requote(written.replace(/^agregar\s+/, ""), { voice: transcript });
    return { what: "agregar por voz" };
  }
  if (edit) {
    const written = await editCommand(ctx, edit, transcript);
    if (written) {
      await ctx.requote(written, { voice: transcript });
      return { what: edit.kind === "add" ? "agregar por voz" : "corrección por voz" };
    }
    return { what: "corrección por voz sin aplicar" };
  }
  const asIdle = routeIntent({ text: spoken, state: "idle", isPortalUser: true, pendingPortalStep: null, mentionsKnownCompany: false, now: ctx.now });
  const reportish = asIdle.intent === "report" || asIdle.intent === "ambiguous";
  const correction = CORRECTION_STEPS.has(quoteStep);
  if (correction && c.kind === "text") {
    await ctx.requote(c.text, { voice: transcript });
    return { what: "corrección por voz" };
  }
  // con medida: otro pedido (el cotizador pregunta si es un cambio, otra llanta o una cotización nueva)
  if (correction && !reportish && findTyreSizes(c.text).length) {
    const catalog = await catalogOf(ctx);
    const d = normalizeDictation(c.text, dictCatalog(catalog));
    await continueVoiceQuote(ctx, d.text, transcript, { choices: d.sizeChoices, unheard: d.unheardSizes, dictated: d, context: "correccion" });
    return { what: "pedido por voz" };
  }
  // la respuesta a una pregunta del cotizador (aplicación, campos, proveedor, perfil esperando el pedido)
  if (!correction && !reportish && spoken.trim()) {
    // con medida es un pedido: lo dictado normalizado ("a 280" -> "precio 280"; pasada real 2026-11-16: el cotizador leyó
    // "Valor 99 en 12R22.5 a 280" como 280 llantas)
    if (findTyreSizes(spoken).length) {
      const catalog = await catalogOf(ctx);
      const d = normalizeDictation(fixed, dictCatalog(catalog, { ubLevel: 1 }));
      if (d.items.length) {
        await ctx.requote(d.text, { voice: transcript });
        return { what: "pedido por voz" };
      }
    }
    await ctx.requote(spoken, { voice: transcript });
    return { what: "respuesta por voz" };
  }
  // corrida I: con la cotización a la vista, lo que no encaja en las formas conocidas va al modelo SOLO para traducirlo a
  // los comandos de corrección (cantidad, quitar, precio dicho, IGV, plazo, modelo); el cotizador la vuelve a mostrar
  // y por voz nunca arma el PDF sin un *ok* escrito
  if (correction && !reportish && freeEditsOn(ctx.env) && llmAvailable()) return freeEditInQuote(ctx, transcript);
  if (reportish) {
    await ctx.reply(VOICE_PAUSED_IN_QUOTE);
    return { what: "en pausa", pause: { kind: "intent_choice", text: transcript, occurredAt: ctx.now.toISOString(), voice: true } };
  }
  await ctx.reply(`No entendí «${oneLine(transcript).slice(0, 80)}» como un cambio de la cotización. ${VOICE_CORRECTION_HELP}`);
  return { what: "no entendida" };
}

/** Corrección libre con una cotización ya armada: los comandos escritos que tiene; el resto se explica. */
async function freeEditInQuote(ctx: PortalContext, transcript: string): Promise<VoiceInQuoteResult> {
  if (isOffTopic(transcript)) {
    await ctx.reply(OFF_TOPIC_REPLY);
    return { what: "fuera de tema" };
  }
  const catalog = await catalogOf(ctx);
  let res: Awaited<ReturnType<typeof llmDraftOps>> = null;
  try {
    res = await llmDraftOps(transcript, { header: [], items: [], customer: "", terms: [] });
  } catch (err) {
    if (!(err instanceof UsageCapExceeded)) ctx.log(`portal: corrección libre: ${(err as Error).message}`);
  }
  const v = res?.isCorrection ? validateOps(res.raw, { message: transcript, lineCount: MAX_QUOTE_LINES, brands: catalog?.brands ?? [] }) : { ops: [] as DraftOp[], rejected: [] as string[] };
  const { commands, unsupported } = opsToCommands(v.ops);
  const record = (outcome: "ok" | "fallo", text: string) => recordVoice(ctx, { transcript, context: "correccion_libre", understood: understoodOf(null, { questions: outcome === "ok" ? [] : [text], text }), outcome });
  const cannot = unsupported.length ? " Sobre una cotización ya armada no puedo unir líneas ni cambiar marca, medida o cliente: escribe *cancelar* y díctala de nuevo." : "";
  if (!commands.length) {
    await ctx.reply(`No entendí «${oneLine(transcript).slice(0, 80)}» como un cambio de la cotización.${cannot}${v.rejected.length ? ` (${v.rejected.join("; ")})` : ""} ${VOICE_CORRECTION_HELP}`);
    await record("fallo", [...v.rejected, ...unsupported.map((o) => o.op)].join("; ") || "no es una corrección");
    return { what: "no entendida" };
  }
  await ctx.reply(`✏️ Entendí: ${commands.map((c) => `*${c}*`).join(", ")}.${cannot}${v.rejected.length ? ` ⚠️ No hice: ${v.rejected.join("; ")}.` : ""}`);
  await record("ok", commands.join(" · "));
  for (const c of commands) await ctx.requote(c, { voice: transcript });
  return { what: "corrección libre por voz" };
}

/** Líneas que puede nombrar una corrección sobre una cotización armada (el cotizador dice si la línea no existe). */
const MAX_QUOTE_LINES = 30;

/**
 * La corrección dirigida o lo agregado por voz como el comando escrito del cotizador ("cantidad 2 10", "quitar 3",
 * "precio 1 259", "agregar Fenixway Flama 77 275/80R22.5 x4"). null si no se puede (ya se respondió por qué).
 */
async function editCommand(ctx: PortalContext, edit: VoiceEdit, transcript: string): Promise<string | null> {
  if (edit.kind === "add") {
    const catalog = await catalogOf(ctx);
    const d = normalizeDictation(applyVocabulary(edit.text, await learned(ctx)), dictCatalog(catalog, { ubLevel: 1 }));
    if (!d.items.length || d.doubts.length) {
      const lines = d.items.map((l, i) => `${i + 1}. ${l}`).join("\n");
      await ctx.reply(`No pude separar con seguridad lo que quieres agregar${lines ? `:\n${lines}` : ""}${d.doubts.length ? `\n⚠️ ${d.doubts.join("; ")}.` : ""}\nDíctalo de nuevo (p. ej. «agrega cuatro Flama 77 en 275 80 22.5») o escríbelo: *agregar 275/80R22.5 Flama 77 x4*.`);
      await recordVoice(ctx, { transcript, context: "correccion", understood: understoodOf(d, { questions: d.doubts }), outcome: "pregunta" });
      return null;
    }
    if (d.inherited.length) await ctx.reply(inheritedNote(d.inherited));
    await recordVoice(ctx, { transcript, context: "correccion", understood: understoodOf(d, { text: `agregar ${d.items.join("\n")}` }), outcome: "ok" });
    return `agregar ${d.items.join("\n")}`;
  }
  if (edit.line === -1) {
    await ctx.reply("¿Qué línea es? Dímelo con su número (p. ej. «el tercero eran diez») o escríbelo: *cantidad 3 10*.");
    return null;
  }
  const written = edit.kind === "quantity" ? `cantidad ${edit.line} ${edit.value}` : edit.kind === "price" ? `precio ${edit.line} ${edit.value}` : `quitar ${edit.line}`;
  await recordVoice(ctx, { transcript, context: "correccion", understood: understoodOf(null, { text: written }), outcome: "ok" });
  return written;
}
