/**
 * Router de intenciones del bot (puro, sin store): decide si un mensaje es del portal o sigue al cotizador.
 *
 * Reglas (conservadoras: ante la duda, el cotizador sigue como siempre):
 *  1. Mensaje reenviado -> passthrough (pedido o lista de un tercero: lo maneja el cotizador).
 *  2. Comando explícito del portal al inicio (`portal`, `empresa …`, `asignarme …`, `contacto …`, `hoy`, `ayuda portal`,
 *     `cita …`, `oc …`, `avance`, `prepropuesta …`, `aprende X = Y`, `mejores`, `ultima venta …`, `cliente final …`,
 *     `nueva empresa …`) -> portal_command, en
 *     cualquier paso del cotizador.
 *     Un número que no está en `users` solo entra con `portal` (que le dice que no está registrado).
 *  3. `cancelar` (y sinónimos) -> passthrough: el cotizador cancela; quien llama limpia además el paso del portal.
 *  4. Cotizador a mitad de un flujo (step distinto de idle) -> passthrough (sí/ok/1b/enviar... siguen yendo al cotizador).
 *  5. Paso pendiente del portal (cotizador en idle) -> portal_flow, salvo que el texto sea un comando del cotizador o
 *     un pedido de verdad (medida de llanta, o señales de pedido en más de 3 palabras): entonces el cotizador y quien llama
 *     descarta el paso pendiente. Respuestas cortas ("2", "sí", "cotización", "reporte") son del portal.
 *  6. Audio de un usuario del portal con el cotizador en idle -> report (el bloque de voz lo transcribe), o portal_flow si
 *     hay un paso pendiente (que acepta voz); con el cotizador a mitad de un flujo -> passthrough aquí, pero routePortal
 *     la atiende antes (corrida F, punto 4: nunca "no leo audios"): corrección de la cotización a la vista, respuesta a la
 *     pregunta del cotizador o, si suena a reporte, en pausa (un "sí" posterior no confirma un borrador que el vendedor no
 *     vio: no se arma ninguno). De otro número -> passthrough.
 *     Otros adjuntos -> passthrough (salvo comando con adjunto, p. ej. `oc` con la orden de compra, o un paso con
 *     `acceptsMedia` dentro de su `mediaUntil` y sin leyenda de otra cosa: ver mediaAccepted).
 *  7. idle, usuario del portal: señales fuertes de cotización (medida, "x4", correo, dscto, margen, "cotizar"...) sin
 *     verbos de reporte -> quote; con verbos de reporte ("visité", "llamé", "me reuní"...) -> ambiguous, salvo que la única
 *     señal sea la palabra "cotización" ("quedamos en mandarle la cotización") -> report. Sin señales
 *     fuertes de cotización: verbos de reporte -> report; palabras de reporte débiles (gerente, interesados, empresa
 *     conocida...) -> report, o ambiguous si además hay señales débiles de pedido (para, cliente, necesito, una marca).
 *     Cualquier otro caso -> passthrough.
 *  8. Quien no es usuario del portal nunca recibe report/ambiguous: quote o passthrough (el cotizador decide).
 *  7b. idle sin paso pendiente y fuera de tema reconocible (guard/off-topic.ts: sin señales de pedido ni de reporte y con
 *     una señal de fuera de tema: poema, traducir, "ignora tus instrucciones"…) -> passthrough (regla fuera_de_tema): el
 *     cotizador responde una línea fija sin modelo. Una nota de voz con esa transcripción recibe la misma línea.
 *  9. Un paso pendiente con `captureText: true` (los ítems de `oc`) se queda con todo texto en idle, aunque tenga forma
 *     de pedido ("8 x Fenixway 315/80R22.5 a 254" son los ítems de la OC), salvo los comandos del cotizador (`ayuda`,
 *     `proveedores`...). Con `keepText: true` (las demás preguntas de `oc`) se queda con todo texto salvo esos comandos y
 *     los textos con medida de llanta (un pedido nuevo). Con `acceptsMedia: true`, un adjunto (ver regla 6).
 *
 * Un comando del portal es de UNA sola línea, sin medida de llanta y sin forma de campo del cotizador (`empresa: X`,
 * `contacto de: Juan`): "Empresa Transportes ABC\n295/80R22.5 x4" es un pedido. Excepción: `ultima venta <empresa> [medida]`
 * lleva la medida como argumento (ventas-odoo: "ultima venta ancro 295/80R22.5" no es un pedido).
 *
 * Precedencia con un proceso en curso (corrida D, punto 7; usuario del portal, cotizador en idle, paso pendiente vigente).
 * Lo que no es respuesta NO descarta el proceso: pasa a pausa (bot/pause.ts) y se recuerda al final de la respuesta.
 * Antes de todo siguen valiendo las reglas 1-4 y 6 de arriba (reenviado, comando del portal, cancelar, cotizador a mitad
 * de flujo, audio/adjuntos) y los comandos del cotizador (`ayuda`, `proveedores`...), que van al cotizador. Luego:
 *  P1. Palabra explícita al inicio (`cotizar`, `cotiza`, `cotízame`, `cotización`, `me cotizas` seguidos de algo; también
 *      la transcripción de una nota de voz "cotízame…") -> quote, siempre (incluso en la fase de ítems de `oc`).
 *  P2. Señal fuerte: medida de llanta (295/80R22.5, 11R22.5, 215/75R17.5) junto con cantidad, marca o precio -> quote.
 *      Excepción: la fase de ítems de `oc` (captureText): ahí los ítems tienen justo esa forma y son la respuesta.
 *  P3. El paso acaba de preguntar y el mensaje encaja como respuesta (fecha, sí/no, nombre, dirección...) -> portal_flow,
 *      aunque tenga números. Encajar lo decide el manejador del paso: si devuelve false, ver P5.
 *  P4. Encaja en ambas o la señal es débil: una medida sola ("295/80R22.5", "11R22.5") o señales de pedido sin medida en
 *      más de 3 palabras (salvo en las preguntas del pedido, keepText, donde "entrega: …" es respuesta) -> route_choice:
 *      se pregunta con dos botones, *Cotización nueva* y *Es mi respuesta* (títulos ≤ 20 caracteres de WhatsApp).
 *  P5. El manejador no lo entendió como respuesta: se clasifica sin el paso; si es reporte, cotización o ambiguo, el
 *      proceso pasa a pausa y sigue eso; si no, se dice que no se entendió y se ofrecen las mismas dos opciones. Nunca se
 *      descarta el mensaje.
 * routeIntent() devuelve también la regla (`rule`) que decidió; routePortal la registra en `messages` (route_rule).
 *
 * Notas de voz (corrida D, punto 8; en routePortal, con DEEPGRAM_API_KEY): con el cotizador en idle se transcriben UNA vez
 * y estas mismas reglas se aplican a la transcripción (números y medidas dictados ya normalizados): una cotización (P1, P2
 * o señales fuertes sin verbos de reporte) va al cotizador por bot/voice-quote.ts; P4 con un paso en curso pregunta con los
 * dos botones; lo demás sigue la regla 6 (reporte sin paso, también lo ambiguo; respuesta con paso; comando dictado) con
 * esa transcripción. Con el cotizador en `choose` de una cotización pedida por voz, la nota de voz es una corrección
 * (regla "voz"); a mitad de cualquier otro flujo sigue al cotizador, como siempre.
 */
import { looksLikePriceMessage } from "../../ingest/whatsapp-text";
import { findBrandInText, fold } from "../../tyre/brands";
import { findTyreSizes } from "../../tyre/spec";
import { isOffTopic } from "../../guard/off-topic";

export type Intent = "portal_command" | "portal_flow" | "quote" | "report" | "ambiguous" | "passthrough" | "route_choice";

/**
 * Regla que decidió el enrutamiento (columna messages.route_rule): las P1-P5 de la cabecera y las de siempre.
 * "reanudar" (continuar/descartar/guardar un proceso en pausa) y "5_no_entendido" los pone routePortal.
 */
export type RouteRule =
  | "reenviado"
  | "comando"
  | "cancelar"
  | "cotizador_en_flujo"
  | "adjunto"
  | "audio"
  | "cotizador_comando"
  | "1_palabra"
  | "2_medida"
  | "3_respuesta"
  | "4_ambiguo"
  | "5_no_entendido"
  | "reanudar"
  | "boton"
  | "voz"
  | "cotizacion"
  | "reporte"
  | "ambiguo"
  | "fuera_de_tema"
  | "cotizador";

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

export type PortalCommandName = "portal" | "cerrar_portal" | "ayuda_portal" | "hoy" | "empresa" | "asignarme" | "contacto" | "cita" | "oc" | "avance" | "prepropuesta" | "aprende" | "enlazar" | "reenviada" | "estado" | "mejores" | "anular" | "descuentos" | "ultima_venta" | "cliente_final" | "nueva_empresa" | "match" | "prioridad" | "quitar_prioridad" | "avance_match" | "direccion";

interface CommandSpec {
  name: PortalCommandName;
  /** Sobre el texto plegado (fold: minúsculas, sin tildes ni signos). */
  re: RegExp;
  /** Con adjunto (leyenda del documento / imagen). */
  acceptsMedia?: boolean;
  /** La medida de llanta es parte de los argumentos (`ultima venta ancro 295/80R22.5`): no lo vuelve un pedido. */
  allowsSize?: boolean;
  /** Con cantidad ("x4", "8 llantas") es un pedido, no el comando (`match 295/80R22.5 x4`). */
  noQty?: boolean;
}

/**
 * `mejores` (corrida G): la frase completa y nada más, para que un reporte o un pedido que dice "mejores" no lo active
 * ("les ofrecí nuestras mejores llantas"). Escrito o dictado: "mejores", "mis mejores flotas", "¿cuáles son mis mejores
 * flotas?", "¿qué flotas me convienen?".
 */
const MEJORES_RE =
  /^(?:(?:dame|muestrame|ver)\s+)?(?:(?:mis|las)\s+)?mejores(?:\s+(?:flotas|empresas))?(?:\s+para\s+(?:mi|trabajar|llamar))?$|^(?:cuales|que)\s+son\s+(?:mis|las)\s+mejores(?:\s+(?:flotas|empresas))?(?:\s+para\s+(?:mi|trabajar|llamar))?$|^(?:que|cuales)\s+(?:flotas|empresas)\s+me\s+convienen(?:\s+mas)?$/;

/** "nueva empresa …", "crear empresa …", "agregar empresa …", "registrar empresa …"; "empresa nueva" solo (sin más). */
const NUEVA_EMPRESA_RE = /^(?:(?:nueva|crear(?:\s+una)?(?:\s+nueva)?|agregar(?:\s+una)?(?:\s+nueva)?|registrar(?:\s+una)?(?:\s+nueva)?)\s+empresa(?:\s+nueva)?(?:\s+\S.*)?|empresa\s+nueva)$/;

/**
 * Corrida K, Match Venta: `match`, `match 295/80R22.5`, `match P0433`, "match venta"; escrito o dictado "¿a quién le vendo mi
 * stock?", "a quién le puedo ofrecer las Flama 66", "¿qué tengo que vender?". Siempre al inicio del mensaje: un reporte
 * ("visité ZBUSS…") nunca empieza así.
 */
const MATCH_RE =
  /^(?:match|mach|mash)(?:\s+\S.*)?$|^(?:y\s+)?(?:a\s+)?quien(?:es)?\s+(?:les?\s+)?(?:puedo\s+|podria\s+)?(?:vendo|vender|ofrezco|ofresco|ofrecer|ofrecerle|venderle)\s+\S.*$|^que\s+(?:tengo\s+que|debo|me\s+toca)\s+vender(?:\s+hoy)?$/;

/** `prioridad P0428`, `prioridad 295 flama 66`; dictado "ponle prioridad a la Flama 66", "marca como prioridad la P0428". */
const PRIORIDAD_RE = /^(?:(?:marcar|marca|marcale|poner|pon|ponle|dar|dale)\s+(?:como\s+|en\s+)?(?:la\s+)?)?prioridad\s+\S.*$/;

/** `quitar prioridad P0428`; dictado "quítale la prioridad a la Flama 77", "saca de prioridad la P0428". */
const QUITAR_PRIORIDAD_RE = /^(?:quitar|quita|quitale|quitarle|sacar|saca|sacale|desmarcar|desmarca)\s+(?:la\s+|de\s+)?prioridad\s+\S.*$/;

/**
 * Corrida L: `direccion ZBUSS`, "dirección de ZBUSS", "¿dónde queda ZBUSS?", "cómo llego a ZBUSS". No se roba una respuesta
 * del pedido ni una dirección escrita: "dirección de entrega …", "dirección fiscal …" y "dirección Av. …" no son el
 * comando ("Dirección: …" tampoco: es un campo del cotizador, FIELD_TAIL).
 */
const DIRECCION_RE =
  /^(?:(?:la\s+)?direccion(?:es)?(?:\s+(?:de|del))?(?:\s+(?:la\s+)?empresa)?\s+(?!(?:fiscal|entrega|de\s+entrega|envio|de\s+envio|despacho|de\s+despacho|operacion|de\s+operacion|av|avenida|jr|jiron|calle|ca|cal|psje|pasaje|pj|mz|manzana|carretera|car|km|prol|prolongacion|urb|lt|lote)\b)\S.*|(?:donde|adonde)\s+(?:queda|quedan|se\s+ubica|esta\s+ubicad[ao])\s+\S.*|como\s+llego\s+(?:a|al|donde)\s+\S.*|ubicacion\s+de(?:l)?\s+\S.*)$/;

const COMMANDS: CommandSpec[] = [
  { name: "portal", re: /^portal$/ },
  // hotfix login 2: cierra las sesiones del portal en todos los teléfonos y anula los enlaces (teléfono perdido, enlace
  // reenviado por error)
  { name: "cerrar_portal", re: /^(?:cerrar|cierra|cierrame)\s+(?:(?:la\s+|mi\s+)?sesion\s+(?:del?\s+|en\s+el\s+)?)?portal$/ },
  { name: "ayuda_portal", re: /^(?:ayuda|help|comandos)\s+portal$|^portal\s+(?:ayuda|help|comandos)$/ },
  { name: "hoy", re: /^hoy$/ },
  // corrida J: alta de una empresa que no está en el padrón (con los datos detrás o sin ellos); antes que `empresa`
  { name: "nueva_empresa", re: NUEVA_EMPRESA_RE },
  { name: "empresa", re: /^empresa\s+\S/ },
  { name: "asignarme", re: /^(?:asignarme|asigname|asignar)\s+\S/ },
  { name: "contacto", re: /^contacto\s+\S/ },
  { name: "cita", re: /^cita\s+\S/ },
  { name: "oc", re: /^oc(?:\s+\S|$)/, acceptsMedia: true },
  // corrida K: antes que `avance` (que se queda con todo lo que empieza así)
  { name: "avance_match", re: /^(?:avance|como\s+voy)\s+(?:de\s+|del\s+|con\s+(?:el\s+)?)?match(?:\s+venta)?$/ },
  { name: "avance", re: /^avance(?:\s+\S.*)?$/ },
  { name: "prepropuesta", re: /^pre\s?propuesta(?:\s+\S|$)/ },
  { name: "aprende", re: /^aprende\s+\S/ },
  { name: "enlazar", re: /^enlazar(?:\s+\S.*)?$/ },
  { name: "reenviada", re: /^reenviad[ao](?:\s+\S.*)?$/ },
  { name: "estado", re: /^estado\s+\S/ },
  { name: "mejores", re: MEJORES_RE },
  // corrida H: anular un pedido generado (devuelve su stock) y ver los descuentos de stock activos (supervisor / admin)
  { name: "anular", re: /^anular\s+(?:la\s+)?(?:oc|o\/c|pedido|orden(?:\s+de\s+compra)?)\s+\S/ },
  { name: "descuentos", re: /^descuentos(?:\s+(?:de\s+)?stock)?$|^stock\s+(?:descontado|comprometido)$/ },
  // ventas-odoo: últimas ventas a un cliente (con medida o sin ella) y cliente final de una factura de leasing
  { name: "ultima_venta", re: /^ultimas?\s+ventas?(?:\s+\S.*)?$/, allowsSize: true },
  { name: "cliente_final", re: /^cliente\s+final(?:\s+\S.*)?$/ },
  // corrida K: Match Venta (la medida o el producto son el argumento; con cantidad es un pedido)
  { name: "match", re: MATCH_RE, allowsSize: true, noQty: true },
  { name: "quitar_prioridad", re: QUITAR_PRIORIDAD_RE, allowsSize: true, noQty: true },
  { name: "prioridad", re: PRIORIDAD_RE, allowsSize: true, noQty: true },
  // corrida L: dirección fiscal (SUNAT) / de operación y locales anexos
  { name: "direccion", re: DIRECCION_RE },
];

/** La palabra del comando en el texto original ("Empresa", "asignarme", "pre-propuesta"...). */
const RAW_HEAD: Record<PortalCommandName, RegExp> = {
  portal: /^portal\b/i,
  // la frase entera es el comando: no lleva argumentos
  cerrar_portal: /^[\s\S]*$/,
  ayuda_portal: /^(?:ayuda|help|comandos)\s+portal\b|^portal\s+(?:ayuda|help|comandos)\b/i,
  hoy: /^hoy\b/i,
  nueva_empresa: /^(?:(?:nueva|crear(?:\s+una)?(?:\s+nueva)?|agregar(?:\s+una)?(?:\s+nueva)?|registrar(?:\s+una)?(?:\s+nueva)?)\s+empresa(?:\s+nueva)?|empresa\s+nueva)(?![\p{L}\d])[\s,.:;-]*/iu,
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
  estado: /^estado\b/i,
  // la frase entera es el comando: no lleva argumentos
  mejores: /^[\s\S]*$/,
  anular: /^anular\b/i,
  descuentos: /^[\s\S]*$/,
  ultima_venta: /^[úu]ltimas?\s+ventas?(?![\p{L}\d])/iu,
  cliente_final: /^cliente\s+final(?![\p{L}\d])/iu,
  // lo que sigue a la frase es el producto ("stock", "las flama 66", "P0433", "295/80R22.5")
  match:
    /^[¿¡\s]*(?:(?:match|mach|mash)(?:\s+venta)?(?![\p{L}\d])|(?:y\s+)?(?:a\s+)?qui[eé]n(?:es)?\s+(?:les?\s+)?(?:puedo\s+|podr[ií]a\s+)?(?:vendo|vender|ofrezco|ofresco|ofrecer|ofrecerle|venderle)(?![\p{L}\d])|qu[eé]\s+(?:tengo\s+que|debo|me\s+toca)\s+vender(?![\p{L}\d]))/iu,
  prioridad: /^[¿¡\s]*(?:(?:marcar|marca|m[aá]rcale|poner|pon|p[oó]nle|dar|d[aá]le)\s+(?:como\s+|en\s+)?(?:la\s+)?)?prioridad(?![\p{L}\d])/iu,
  quitar_prioridad: /^[¿¡\s]*(?:quitar|quita|qu[ií]tale|quitarle|sacar|saca|s[aá]cale|desmarcar|desmarca)\s+(?:la\s+|de\s+)?prioridad(?![\p{L}\d])/iu,
  avance_match: /^[\s\S]*$/,
  direccion:
    /^[¿¡\s]*(?:(?:la\s+)?direcci[oó]n(?:es)?(?:\s+(?:de|del))?(?:\s+(?:la\s+)?empresa)?|(?:d[oó]nde|ad[oó]nde)\s+(?:queda|quedan|se\s+ubica|est[aá]\s+ubicad[ao])|c[oó]mo\s+llego\s+(?:a|al|donde)|ubicaci[oó]n\s+del?)(?![\p{L}\d])/iu,
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
  // (salvo los comandos que llevan la medida como argumento: `ultima venta ancro 295/80R22.5`)
  if (/[\r\n]/.test(raw)) return null;
  const hasSize = findTyreSizes(raw).length > 0;
  const folded = fold(raw);
  for (const c of COMMANDS) {
    if (hasSize && !c.allowsSize) continue;
    if (!c.re.test(folded)) continue;
    if (c.noQty && QTY_RE.test(raw)) continue;
    if (opts.withMedia && !c.acceptsMedia) return null;
    const head = RAW_HEAD[c.name].exec(raw);
    const args = head ? raw.slice(head[0].length).trim() : raw.replace(/^\S+\s*/, "");
    // "empresa: ACME", "contacto: Juan", "contacto de: Juan" -> campo del cotizador (como su TERM_LINE: "clave:" o "clave de:")
    // (`nueva empresa: …` sí es el comando: RAW_HEAD ya se comió los dos puntos)
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

/** P1: palabra explícita de cotización al inicio, seguida de algo ("cotízame 4 llantas…", "cotización para ZBUSS"). */
const EXPLICIT_QUOTE_START = /^(?:cotizar|cotiza|cotizame|cotizacion|me\s+cotizas?)\s+\S/;

export function explicitQuoteStart(text: string): boolean {
  return EXPLICIT_QUOTE_START.test(fold((text ?? "").replace(/^[\s¿¡]+/, "")));
}

/** Cantidad o precio junto a la medida (P2): "x4", "8 llantas", "4 x", "a 254", "precio 254", "S/ 900", "US$ 300". */
const QTY_RE = /\bx\s*\d{1,3}\b|\b\d{1,3}\s*(?:x|unidades|und|unds|unid|llantas|neumaticos|neumáticos)\b/i;
const PRICE_RE = /\bprecio\s*:?\s*\d|\b(?:a|en)\s+(?:us\$|s\/\.?|\$)?\s*\d{2,6}(?:[.,]\d+)?\b|us\$\s*\d|s\/\.?\s*\d|\$\s*\d/i;

/** P2: medida de llanta junto con cantidad, marca o precio. */
export function strongTyreQuote(text: string): boolean {
  const t = text ?? "";
  const sizes = findTyreSizes(t);
  if (!sizes.length) return false;
  return QTY_RE.test(t) || PRICE_RE.test(t) || !!findBrandInText(t);
}

export interface RouteDecision {
  intent: Intent;
  rule: RouteRule;
}

export function classifyIntent(input: ClassifyInput): Intent {
  return routeIntent(input).intent;
}

/** classifyIntent con la regla que decidió (ver la cabecera). */
export function routeIntent(input: ClassifyInput): RouteDecision {
  const text = (input.text ?? "").trim();
  const step = stepOf(input.state);
  const pending = input.isPortalUser ? pendingOf(input.pendingPortalStep) : null;
  const isAudio = input.mediaType === "audio" || input.mediaType === "voice";

  const r = (intent: Intent, rule: RouteRule): RouteDecision => ({ intent, rule });
  if (input.forwarded) return r("passthrough", "reenviado");

  // comandos explícitos (con adjunto, solo los que lo aceptan)
  const cmd = parsePortalCommand(text, { withMedia: !!input.hasMedia && !isAudio });
  if (cmd && !isAudio) {
    if (!input.isPortalUser && cmd.name !== "portal") return r("passthrough", "cotizador");
    return r("portal_command", "comando");
  }

  if (isAudio) {
    // con el cotizador a mitad de un flujo (revisando una cotización) la nota de voz es suya: el "sí" siguiente también
    if (!input.isPortalUser || step !== "idle") return r("passthrough", step !== "idle" ? "cotizador_en_flujo" : "cotizador");
    return r(pending ? "portal_flow" : "report", "audio");
  }
  if (input.hasMedia) return pending && step === "idle" && mediaAccepted(input.pendingPortalStep, text, input.now) ? r("portal_flow", "adjunto") : r("passthrough", "adjunto");
  if (!text) return r("passthrough", "cotizador");
  if (isCancel(text)) return r("passthrough", "cancelar");
  if (step !== "idle") return r("passthrough", "cotizador_en_flujo");

  const sig = textSignals(text, input.isPortalUser && !!input.mentionsKnownCompany);
  const toQuoter = () => r(sig.strongQuote ? "quote" : "passthrough", "cotizador_comando");
  if (pending && pendingFlag(input.pendingPortalStep, "captureText")) {
    // los ítems de una OC tienen forma de pedido (P2 no aplica); los comandos del cotizador (ayuda, proveedores...) no son ítems
    if (isQuoterCommand(text)) return toQuoter();
    if (explicitQuoteStart(text)) return r("quote", "1_palabra");
    return r("portal_flow", "3_respuesta");
  }
  if (pending) {
    if (isQuoterCommand(text)) return toQuoter();
    if (explicitQuoteStart(text)) return r("quote", "1_palabra");
    if (strongTyreQuote(text)) return r("quote", "2_medida");
    // una medida sola: puede ser la respuesta (la pregunta era del producto) o un pedido nuevo -> se pregunta
    if (findTyreSizes(text).length > 0) return r("route_choice", "4_ambiguo");
    // una respuesta del pedido (keepText) se queda aunque tenga "entrega: …" o "x llanta"
    if (pendingFlag(input.pendingPortalStep, "keepText")) return r("portal_flow", "3_respuesta");
    // respuestas cortas ("2", "sí", "cotización", "reporte") son del portal; señales de pedido en un texto largo, se pregunta
    if (sig.strongQuote && fold(text).split(" ").length > 3) return r("route_choice", "4_ambiguo");
    return r("portal_flow", "3_respuesta");
  }
  if (!input.isPortalUser) return r(sig.strongQuote ? "quote" : "passthrough", "cotizador");
  if (isQuoterCommand(text)) return r("passthrough", "cotizador_comando");
  if (explicitQuoteStart(text)) return r("quote", "1_palabra");
  // fuera de tema reconocible (guard/off-topic.ts): nunca a reporte (no hay nada que extraer con el modelo); el cotizador
  // responde con una línea fija, sin modelo
  if (isOffTopic(text)) return r("passthrough", "fuera_de_tema");

  // "visité X, quedamos en mandarle la cotización": la palabra sola (sin medida, cantidad, correo ni precio) con un verbo
  // de reporte es un reporte, no un pedido
  if (sig.strongQuote && sig.strongReport && quoteWordOnly(text)) return r("report", "reporte");
  if (sig.strongQuote) return sig.strongReport ? r("ambiguous", "ambiguo") : r("quote", strongTyreQuote(text) ? "2_medida" : "cotizacion");
  if (sig.strongReport) return r("report", "reporte");
  if (sig.weakReport) return sig.weakQuote ? r("ambiguous", "ambiguo") : r("report", "reporte");
  return r("passthrough", "cotizador");
}
