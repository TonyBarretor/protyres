/**
 * Fuera de tema (corrida E, punto 3), decidido con reglas ANTES de cualquier llamada al modelo.
 *
 * Regla (conservadora: ante la duda, el bot sigue como siempre):
 *  - `hasRequestSignals(texto)`: el texto trae algo con lo que el cotizador o el reporte pueden trabajar: un dígito
 *    (medida, cantidad, x4, UB, precio, RUC, fecha), un correo, una marca conocida, una palabra de producto o de pedido
 *    (llanta, neumático, aro, cámara, parche, válvula, cotizar, precio, stock, pedido, orden, proveedor, medida…), o un
 *    verbo / palabra de reporte (visité, llamé, gerente, reunión… las del router del portal).
 *    Sin ninguna de esas señales el modelo no puede sacar un ítem (un ítem necesita medida o descripción de producto):
 *    parseRequest no lo llama y la respuesta es la de las reglas de siempre ("No encontré ninguna medida…").
 *  - `isOffTopic(texto)`: SIN señales de pedido y CON una señal reconocible de fuera de tema (poema, chiste, traducir,
 *    capital de…, "ignora tus instrucciones", prompt, clave/contraseña, datos de otro vendedor, ¿quién eres?, ChatGPT…).
 *    Entonces UNA línea fija (OFF_TOPIC_REPLY) sin llamar al modelo, en el cotizador (handler) y en el portal (el router
 *    no lo manda a reporte; una nota de voz transcrita recibe la misma línea).
 */
import { findBrandInText, fold } from "../tyre/brands";

export const OFF_TOPIC_REPLY = "Solo te ayudo con *cotizaciones de llantas* y *reportes de clientes* (visitas, llamadas). Escribe *ayuda* para ver cómo.";

/** Palabras de producto o de pedido (sobre el texto plegado: minúsculas, sin tildes ni signos). */
const PRODUCT_WORDS =
  /\b(?:llantas?|neumaticos?|aros?|camaras?|parches?|valvulas?|protector(?:es)?|enllante|cotiz\w*|precios?|stock|pedidos?|orden(?:es)?|oc|proveedor(?:es)?|medidas?|lista|listas|ofertas?|unidades|und|juegos?|traccion|direccional|mixtas?|delanteras?|posterior(?:es)?|ply|lonas)\b/;

/** Verbos y palabras de reporte (las del router del portal, en texto plegado). */
const REPORT_WORDS =
  /\b(?:visite|visitamos|visita|visitas|fui|fuimos|estuve|pase por|llame|llamamos|llamo|llamada|llamadas|hable|hablamos|converse|reuni|reunion|reunimos|atendio|recibio|dijo|dice|comenta|comento|quede|quedamos|gerente|jefe|jefa|encargad[oa]|logistica|mantenimiento|flota|interesad[oa]s?|seguimiento|propuesta|presentacion|cita|confirma|confirmara|contesto|contesta|cliente|clientes|empresa)\b/;

/** Señales de fuera de tema reconocibles (texto plegado). */
const OFF_TOPIC_WORDS = new RegExp(
  [
    "poemas?",
    "poesias?",
    "versos?",
    "canciones?",
    "cancion",
    "chistes?",
    "cuentos?",
    "adivinanzas?",
    "traduc\\w*",
    "translate",
    "capital de",
    "presidente de",
    "ignora\\w*",
    "ignore",
    "olvida (?:tus|las|todas|lo)",
    "instrucciones",
    "instructions",
    "prompt",
    "system",
    "jailbreak",
    "modo desarrollador",
    "actua como",
    "finge",
    "claves?",
    "contrasenas?",
    "password",
    "api ?key",
    "tokens?",
    "secretos?",
    "datos de (?:otros?|otras?|los demas|las demas)",
    "otros? vendedor(?:es)?",
    "chatgpt",
    "openai",
    "anthropic",
    "claude",
    "inteligencia artificial",
    "eres (?:un|una) (?:bot|ia|robot|modelo|asistente)",
    "quien eres",
    "que modelo",
    "recetas?",
    "clima",
    "horoscopo",
    "futbol",
    "ensayo",
    "redacta\\w*",
    "escribeme",
    "programa en",
    "python",
    "javascript",
  ].join("|"),
);
const OFF_TOPIC_RE = new RegExp(`\\b(?:${OFF_TOPIC_WORDS.source})\\b`);

/**
 * ¿Puede el texto traer un ítem de pedido? Un dígito, un correo, una marca conocida o una palabra de producto/pedido.
 * Sin eso, parseRequest no llama al modelo (no hay ítem que leer): responden las reglas, como siempre.
 */
export function mayHaveItems(text: string): boolean {
  const t = text ?? "";
  if (/\d/.test(t) || /@/.test(t)) return true;
  if (findBrandInText(t)) return true;
  return PRODUCT_WORDS.test(fold(t));
}

/** ¿Trae el texto algo de pedido o de reporte? (ver la cabecera) */
export function hasRequestSignals(text: string): boolean {
  return mayHaveItems(text) || REPORT_WORDS.test(fold(text ?? ""));
}

/** Fuera de tema reconocible: sin señales de pedido ni de reporte y con una señal de fuera de tema. */
export function isOffTopic(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t || hasRequestSignals(t)) return false;
  return OFF_TOPIC_RE.test(fold(t));
}
