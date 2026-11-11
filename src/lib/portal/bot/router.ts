/**
 * Router de intenciones del bot (puro, sin store): decide si un mensaje es del portal o sigue al cotizador.
 *
 * Reglas (conservadoras: ante la duda, el cotizador sigue como siempre):
 *  1. Mensaje reenviado -> passthrough (pedido o lista de un tercero: lo maneja el cotizador).
 *  2. Comando explícito del portal al inicio (`portal`, `empresa …`, `asignarme …`, `contacto …`, `hoy`, `ayuda portal`,
 *     `cita …`, `oc …`, `avance`, `prepropuesta …`, `aprende X = Y`) -> portal_command, en cualquier paso del cotizador.
 *     Un número que no está en `users` solo entra con `portal` (que le dice que no está registrado).
 *  3. `cancelar` (y sinónimos) -> passthrough: el cotizador cancela; quien llama limpia además el paso del portal.
 *  4. Cotizador a mitad de un flujo (step distinto de idle) -> passthrough (sí/ok/1b/enviar... siguen yendo al cotizador).
 *  5. Paso pendiente del portal (cotizador en idle) -> portal_flow, salvo que el texto sea un comando del cotizador o
 *     un pedido de verdad (medida de llanta, o señales de pedido en más de 3 palabras): entonces el cotizador y quien llama
 *     descarta el paso pendiente. Respuestas cortas ("2", "sí", "cotización", "reporte") son del portal.
 *  6. Audio de un usuario del portal con el cotizador en idle -> report (el bloque de voz lo transcribe), o portal_flow si
 *     hay un paso pendiente (que acepta voz); con el cotizador a mitad de un flujo -> passthrough (el cotizador responde
 *     como siempre: un "sí" posterior no puede confirmar un borrador que el vendedor no vio). De otro número -> passthrough.
 *     Otros adjuntos -> passthrough (salvo comando con adjunto, p. ej. `oc` con la orden de compra, o un paso con
 *     `acceptsMedia` dentro de su `mediaUntil` y sin leyenda de otra cosa: ver mediaAccepted).
 *  7. idle, usuario del portal: señales fuertes de cotización (medida, "x4", correo, dscto, margen, "cotizar"...) sin
 *     verbos de reporte -> quote; con verbos de reporte ("visité", "llamé", "me reuní"...) -> ambiguous, salvo que la única
 *     señal sea la palabra "cotización" ("quedamos en mandarle la cotización") -> report. Sin señales
 *     fuertes de cotización: verbos de reporte -> report; palabras de reporte débiles (gerente, interesados, empresa
 *     conocida...) -> report, o ambiguous si además hay señales débiles de pedido (para, cliente, necesito, una marca).
 *     Cualquier otro caso -> passthrough.
 *  8. Quien no es usuario del portal nunca recibe report/ambiguous: quote o passthrough (el cotizador decide).
 *  9. Un paso pendiente con `captureText: true` (los ítems de `oc`) se queda con todo texto en idle, aunque tenga forma
 *     de pedido ("8 x Fenixway 315/80R22.5 a 254" son los ítems de la OC), salvo los comandos del cotizador (`ayuda`,
 *     `proveedores`...). Con `keepText: true` (las demás preguntas de `oc`) se queda con todo texto salvo esos comandos y
 *     los textos con medida de llanta (un pedido nuevo). Con `acceptsMedia: true`, un adjunto (ver regla 6).
 *
 * Un comando del portal es de UNA sola línea, sin medida de llanta y sin forma de campo del cotizador (`empresa: X`,
 * `contacto de: Juan`): "Empresa Transportes ABC\n295/80R22.5 x4" es un pedido.
 */
import { looksLikePriceMessage } from "../../ingest/whatsapp-text";
import { findBrandInText, fold } from "../../tyre/brands";
import { findTyreSizes } from "../../tyre/spec";

export type Intent = "portal_command" | "portal_flow" | "quote" | "report" | "ambiguous" | "passthrough";

/** Paso del cotizador (ConversationState.step) o "profile": perfil elegido esperando el pedido (prosegur…). */
export type QuoteStep = string;

export interface ClassifyInput {
  text: string;
  hasMedia?: boolean;
  /** InboundMessage.type: "text", "audio", "image", "document", "video"... */
  mediaType?: string;
  /** Estado del cotizador: basta el paso. */
  state: { step: QuoteStep } | QuoteStep;
  isPortalUser: boolean;
  /** Paso pendiente del portal (null/undefined = ninguno). `captureText` / `acceptsMedia`: ver regla 9. */
  pendingPortalStep?: { kind: string; captureText?: unknown; keepText?: unknown; acceptsMedia?: unknown; mediaUntil?: unknown } | string | null;
  forwarded?: boolean;
  /** El texto nombra una empresa del padrón (lo calcula quien llama, solo si hace falta). */
  mentionsKnownCompany?: boolean;
  /** Hora del mensaje (para `mediaUntil` del paso pendiente); por defecto ahora. */
  now?: Date;
}

// ── comandos explícitos del portal ──

export type PortalCommandName = "portal" | "ayuda_portal" | "hoy" | "empresa" | "asignarme" | "contacto" | "cita" | "oc" | "avance" | "prepropuesta" | "aprende" | "enlazar" | "reenviada";

interface CommandSpec {
  name: PortalCommandName;
  /** Sobre el texto plegado (fold: minúsculas, sin tildes ni signos). */
  re: RegExp;
  /** Con adjunto (leyenda del documento / imagen). */
  acceptsMedia?: boolean;
}

const COMMANDS: CommandSpec[] = [
  { name: "portal", re: /^portal$/ },
  { name: "ayuda_portal", re: /^(?:ayuda|help|comandos)\s+portal$|^portal\s+(?:ayuda|help|comandos)$/ },
  { name: "hoy", re: /^hoy$/ },
  { name: "empresa", re: /^empresa\s+\S/ },
  { name: "asignarme", re: /^(?:asignarme|asigname|asignar)\s+\S/ },
  { name: "contacto", re: /^contacto\s+\S/ },
  { name: "cita", re: /^cita\s+\S/ },
  { name: "oc", re: /^oc(?:\s+\S|$)/, acceptsMedia: true },
  { name: "avance", re: /^avance(?:\s+\S.*)?$/ },
  { name: "prepropuesta", re: /^pre\s?propuesta(?:\s+\S|$)/ },
  { name: "aprende", re: /^aprende\s+\S/ },
  { name: "enlazar", re: /^enlazar(?:\s+\S.*)?$/ },
  { name: "reenviada", re: /^reenviad[ao](?:\s+\S.*)?$/ },
];

/** La palabra del comando en el texto original ("Empresa", "asignarme", "pre-propuesta"...). */
const RAW_HEAD: Record<PortalCommandName, RegExp> = {
  portal: /^portal\b/i,
  ayuda_portal: /^(?:ayuda|help|comandos)\s+portal\b|^portal\s+(?:ayuda|help|comandos)\b/i,
  hoy: /^hoy\b/i,
  empresa: /^empresa\b/i,
  asignarme: /^(?:asignarme|asígnarme|asignar|asígname|asigname)\b/i,
  contacto: /^contacto\b/i,
  cita: /^cita\b/i,
  oc: /^oc\b/i,
  avance: /^avance\b/i,
  prepropuesta: /^pre[\s-]?propuesta\b/i,
  aprende: /^aprende\b/i,
  enlazar: /^enlazar\b/i,
  reenviada: /^reenviad[ao]\b/i,
};

/** Lo que sigue a la palabra del comando cuando la línea es un campo del cotizador: ": …" o " de: …" (a/al/de/del). */
const FIELD_TAIL = /^(?:(?:a|al|de|del)\s*)?:/i;

export interface ParsedPortalCommand {
  name: PortalCommandName;
  /** Lo que sigue a la palabra del comando, tal como se escribió (sin espacios en los extremos). */
  args: string;
}

/**
 * Comando explícito del portal al inicio del mensaje, sin importar mayúsculas ni tildes. `empresa: X` (con dos puntos)
 * NO es comando: es una línea de campo del cotizador. `aprende` exige "X = Y".
 */
export function parsePortalCommand(text: string, opts: { withMedia?: boolean } = {}): ParsedPortalCommand | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  // una sola línea y sin medida de llanta: "Empresa Transportes ABC\n295/80R22.5 x4" u "OC 4500123 ABC 295/80R22.5 x8" son pedidos
  if (/[\r\n]/.test(raw) || findTyreSizes(raw).length > 0) return null;
  const folded = fold(raw);
  for (const c of COMMANDS) {
    if (!c.re.test(folded)) continue;
    if (opts.withMedia && !c.acceptsMedia) return null;
    const head = RAW_HEAD[c.name].exec(raw);
    const args = head ? raw.slice(head[0].length).trim() : raw.replace(/^\S+\s*/, "");
    // "empresa: ACME", "contacto: Juan", "contacto de: Juan" -> campo del cotizador (como su TERM_LINE: "clave:" o "clave de:")
    if (FIELD_TAIL.test(args)) return null;
    if (c.name === "aprende" && !/\S\s*=\s*\S/.test(args)) return null;
    return { name: c.name, args };
  }
  return null;
}

// ── señales ──

const CANCEL = new Set(["cancelar", "cancel", "salir", "reset"]);

export function isCancel(text: string): boolean {
  return CANCEL.has(fold(text ?? ""));
}

/**
 * Comandos del cotizador que, con un paso del portal pendiente, igual van al cotizador (y descartan el paso).
 * No incluye sí/no/ok/listo: con un paso pendiente del portal (confirmar un reporte) son respuestas al portal.
 */
const QUOTER_ESCAPE = /^(?:ayuda|help|hola|menu|inicio|proveedores|listas|cotizaciones|contratos?|fotos?|precios?|stock|reenviar|reenvia|historial|proveedor|numero|nro|nombre|archivo|archivos|agregar|agrega|anadir|anade|enviar|send|correo|email|dscto|descuento|margen)\b/;

export function isQuoterCommand(text: string): boolean {
  return QUOTER_ESCAPE.test(fold(text ?? ""));
}

/** Señales fuertes de pedido: las del parser de cotizaciones (copia de `looksLikeRequest` del handler, sin las débiles). */
const STRONG_QUOTE_RE = /\bx\s*\d{1,3}\b|\b\d{1,3}\s*(?:unidades|und|unds|unid|llantas|neumaticos|neumáticos)\b|@|\bdscto\b|\bdescuento\b|\bmargen\b|\b(?:cotiza|cotizar|cotizame|cotízame|cotización|cotizacion|me cotizas)\b|\bu\.?\s?b\.?\s*:?\s*\d{3,5}\b|\b(?:unidad|solicitante|atenci[oó]n|atn|direcci[oó]n|pago|plazo|entrega|validez|empresa)\s*:/i;

/** Palabras de pedido que también aparecen en un reporte ("para", "cliente", "necesito", una marca). */
const WEAK_QUOTE_RE = /(?<![\p{L}\d])(?:para|cliente|necesito|necesitan|pide|piden|quiere|quieren|requiere|requieren|und)(?![\p{L}\d])/iu;

/** Verbos de reporte: algo que pasó con un cliente. Bordes con \p{L} (con \b, "visité" no termina en borde de palabra). */
const STRONG_REPORT_RE =
  /(?<![\p{L}\d])(?:visit[eé]|visitamos|visita\s+(?:a|al|en|de)|fui\s+(?:a|al|donde)|fuimos\s+(?:a|al)|estuve\s+(?:en|con)|pas[eé]\s+por|llam[eé]|llamamos|me\s+llam[oó]|nos\s+llam[oó]|llamada\s+(?:a|al|con|de)|habl[eé]\s+con|hablamos\s+con|convers[eé]\s+con|me\s+reun[ií]|nos\s+reunimos|reuni[oó]n\s+con|me\s+atendi[oó]|nos\s+atendi[oó]|me\s+recibi[oó]|me\s+dijo|nos\s+dijo|me\s+coment[oó]|qued[eé]\s+en|quedamos\s+en)(?![\p{L}\d])/iu;

/** Palabras de reporte débiles: personas y resultados de una gestión. */
const WEAK_REPORT_RE =
  /(?<![\p{L}\d])(?:gerente|jefe|jefa|encargad[oa]|log[ií]stica|mantenimiento|flota|interesad[oa]s?|seguimiento|propuesta|presentaci[oó]n|reuni[oó]n|visita|llamada|cita|dijo|dice|comenta|coment[oó]|confirma|confirmar[aá]|volver\s+a\s+llamar|no\s+contest[oó]|no\s+contesta)(?![\p{L}\d])/iu;

export interface Signals {
  strongQuote: boolean;
  weakQuote: boolean;
  strongReport: boolean;
  weakReport: boolean;
}

export function textSignals(text: string, mentionsKnownCompany = false): Signals {
  const t = text ?? "";
  const strongQuote = findTyreSizes(t).length > 0 || STRONG_QUOTE_RE.test(t) || looksLikePriceMessage(t);
  const weakQuote = WEAK_QUOTE_RE.test(t) || !!findBrandInText(t);
  const strongReport = STRONG_REPORT_RE.test(t);
  const weakReport = WEAK_REPORT_RE.test(t) || mentionsKnownCompany;
  return { strongQuote, weakQuote, strongReport, weakReport };
}

const QUOTE_WORD_RE = /\b(?:cotiza|cotizar|cotizame|cotízame|cotización|cotizacion|me cotizas)\b/gi;

/** La única señal fuerte de pedido es la palabra "cotización"/"cotizar". */
export function quoteWordOnly(text: string): boolean {
  const t = text ?? "";
  if (!QUOTE_WORD_RE.test(t)) return false;
  QUOTE_WORD_RE.lastIndex = 0;
  const rest = t.replace(QUOTE_WORD_RE, " ");
  return findTyreSizes(t).length === 0 && !STRONG_QUOTE_RE.test(rest) && !looksLikePriceMessage(t);
}

/** Forma clara de cotización (para decidir si un mensaje deja un paso pendiente del portal). */
export function looksLikeQuote(text: string): boolean {
  return textSignals(text).strongQuote;
}

const stepOf = (s: ClassifyInput["state"]): string => (typeof s === "string" ? s : s?.step) || "idle";
const pendingOf = (p: ClassifyInput["pendingPortalStep"]): string | null => (!p ? null : typeof p === "string" ? p : p.kind || null);
const pendingFlag = (p: ClassifyInput["pendingPortalStep"], flag: "captureText" | "keepText" | "acceptsMedia"): boolean => !!p && typeof p === "object" && p[flag] === true;

/** Leyenda de un adjunto que es la OC (o ninguna): "oc", "o/c", "orden de compra". Otra leyenda ("foto …", "lista …") es de otra cosa. */
const OC_CAPTION_RE = /^(?:$|(?:la\s+|el\s+)?(?:oc|o\/c|orden(?:\s+de\s+compra)?|pdf|adjunto)\b)/;

/**
 * ¿El paso pendiente se queda con este adjunto? Solo si acepta adjuntos, dentro de su `mediaUntil` (si lo tiene) y sin
 * leyenda de otra cosa: una lista de precios o una `foto …` siguen al cotizador.
 */
export function mediaAccepted(p: ClassifyInput["pendingPortalStep"], caption: string, now: Date = new Date()): boolean {
  if (!p || typeof p !== "object" || p.acceptsMedia !== true) return false;
  if (p.mediaUntil !== undefined) {
    const until = Date.parse(String(p.mediaUntil));
    if (!Number.isFinite(until) || now.getTime() > until) return false;
  }
  return OC_CAPTION_RE.test(fold(caption ?? ""));
}

export function classifyIntent(input: ClassifyInput): Intent {
  const text = (input.text ?? "").trim();
  const step = stepOf(input.state);
  const pending = input.isPortalUser ? pendingOf(input.pendingPortalStep) : null;
  const isAudio = input.mediaType === "audio" || input.mediaType === "voice";

  if (input.forwarded) return "passthrough";

  // comandos explícitos (con adjunto, solo los que lo aceptan)
  const cmd = parsePortalCommand(text, { withMedia: !!input.hasMedia && !isAudio });
  if (cmd && !isAudio) {
    if (!input.isPortalUser && cmd.name !== "portal") return "passthrough";
    return "portal_command";
  }

  if (isAudio) {
    // con el cotizador a mitad de un flujo (revisando una cotización) la nota de voz es suya: el "sí" siguiente también
    if (!input.isPortalUser || step !== "idle") return "passthrough";
    return pending ? "portal_flow" : "report";
  }
  if (input.hasMedia) return pending && step === "idle" && mediaAccepted(input.pendingPortalStep, text, input.now) ? "portal_flow" : "passthrough";
  if (!text) return "passthrough";
  if (isCancel(text)) return "passthrough";
  if (step !== "idle") return "passthrough";

  const sig = textSignals(text, input.isPortalUser && !!input.mentionsKnownCompany);
  if (pending && pendingFlag(input.pendingPortalStep, "captureText")) {
    // los ítems de una OC tienen forma de pedido; los comandos del cotizador (ayuda, proveedores...) no son ítems
    return isQuoterCommand(text) ? (sig.strongQuote ? "quote" : "passthrough") : "portal_flow";
  }
  if (pending && pendingFlag(input.pendingPortalStep, "keepText")) {
    // una respuesta del pedido se queda aunque tenga "entrega: …" o "x llanta"; una medida de llanta es un pedido nuevo
    if (isQuoterCommand(text) || findTyreSizes(text).length > 0) return sig.strongQuote ? "quote" : "passthrough";
    return "portal_flow";
  }
  if (pending) {
    // respuestas cortas ("2", "sí", "cotización", "reporte") son del portal; un pedido de verdad o un comando del cotizador no
    const quoteShaped = findTyreSizes(text).length > 0 || (sig.strongQuote && fold(text).split(" ").length > 3);
    if (isQuoterCommand(text) || quoteShaped) return sig.strongQuote ? "quote" : "passthrough";
    return "portal_flow";
  }
  if (!input.isPortalUser) return sig.strongQuote ? "quote" : "passthrough";
  if (isQuoterCommand(text)) return "passthrough";

  // "visité X, quedamos en mandarle la cotización": la palabra sola (sin medida, cantidad, correo ni precio) con un verbo
  // de reporte es un reporte, no un pedido
  if (sig.strongQuote && sig.strongReport && quoteWordOnly(text)) return "report";
  if (sig.strongQuote) return sig.strongReport ? "ambiguous" : "quote";
  if (sig.strongReport) return "report";
  if (sig.weakReport) return sig.weakQuote ? "ambiguous" : "report";
  return "passthrough";
}
