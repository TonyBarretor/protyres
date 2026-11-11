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
 *  6. Audio de un usuario del portal -> report (el bloque de voz lo transcribe); de otro número -> passthrough.
 *     Otros adjuntos -> passthrough (salvo comando con adjunto, p. ej. `oc` con la orden de compra).
 *  7. idle, usuario del portal: señales fuertes de cotización (medida, "x4", correo, dscto, margen, "cotizar"...) sin
 *     verbos de reporte -> quote; con verbos de reporte ("visité", "llamé", "me reuní"...) -> ambiguous, salvo que la única
 *     señal sea la palabra "cotización" ("quedamos en mandarle la cotización") -> report. Sin señales
 *     fuertes de cotización: verbos de reporte -> report; palabras de reporte débiles (gerente, interesados, empresa
 *     conocida...) -> report, o ambiguous si además hay señales débiles de pedido (para, cliente, necesito, una marca).
 *     Cualquier otro caso -> passthrough.
 *  8. Quien no es usuario del portal nunca recibe report/ambiguous: quote o passthrough (el cotizador decide).
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
  /** Paso pendiente del portal (null/undefined = ninguno). */
  pendingPortalStep?: { kind: string } | string | null;
  forwarded?: boolean;
  /** El texto nombra una empresa del padrón (lo calcula quien llama, solo si hace falta). */
  mentionsKnownCompany?: boolean;
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
  const folded = fold(raw);
  for (const c of COMMANDS) {
    if (!c.re.test(folded)) continue;
    if (opts.withMedia && !c.acceptsMedia) return null;
    const head = RAW_HEAD[c.name].exec(raw);
    const args = head ? raw.slice(head[0].length).trim() : raw.replace(/^\S+\s*/, "");
    if (/^:/.test(args)) return null; // "empresa: ACME", "contacto: Juan" -> campo del cotizador
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
    if (!input.isPortalUser) return "passthrough";
    return pending ? "portal_flow" : "report";
  }
  if (input.hasMedia) return "passthrough";
  if (!text) return "passthrough";
  if (isCancel(text)) return "passthrough";
  if (step !== "idle") return "passthrough";

  const sig = textSignals(text, input.isPortalUser && !!input.mentionsKnownCompany);
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
