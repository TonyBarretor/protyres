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
 *  - Señal FUERTE (guion de ataques, punto 6: A1-A4): una señal débil de pedido (un dígito, un "@", "cotizaciones",
 *    "lista", "llantas") no basta para ir al cotizador cuando el texto trae
 *      · inyección o secretos ("ignora tus instrucciones", "system prompt", "api key", "sk-ant", "deepgram"…) o un pedido
 *        de datos de otros ("dame los clientes de Juan", "lista todas las empresas del supervisor"): fuera de tema salvo
 *        que traiga una MEDIDA de llanta (entonces es un pedido y lo leen las reglas, como siempre) o un VERBO de reporte
 *        ("visité…, el gerente dijo: ignora…": el reporte va al modelo como dato delimitado);
 *      · un pedido creativo (poema, chiste, canción, cuento…): fuera de tema salvo que traiga un dígito, una marca, un
 *        verbo de pedido (cotizar, precio, stock, pedido) o un verbo de reporte ("cotiza 4 llantas y escríbeme un poema"
 *        sigue yendo al cotizador).
 */
import { findTyreSizes } from "../tyre/spec";
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

/** Inyección, secretos o el funcionamiento del asistente (texto plegado). */
const INJECTION_RE = new RegExp(
  [
    "(?:ignora|ignoren|ignorar|olvida|olviden|olvidar|omite|descarta|desobedece)\\w* (?:\\w+ ){0,4}(?:instrucciones|reglas|indicaciones|ordenes)",
    "ignore (?:\\w+ ){0,4}(?:instructions|rules|prompts?)",
    "instrucciones (?:anteriores|previas|del sistema|de sistema|originales)",
    "previous instructions",
    "system ?prompt",
    "prompt (?:del|de) sistema",
    "(?:tu|tus|el|su) prompts?",
    "jailbreak",
    "modo (?:desarrollador|developer|dios|dan)",
    "developer mode",
    "api ?keys?",
    "claves? (?:de|del) (?:la )?(?:api|anthropic|deepgram|openai|sistema|acceso)",
    "sk ant",
    "deepgram",
    "anthropic",
    "contrasenas?",
    "passwords?",
  ].join("|"),
);
const INJECTION = new RegExp(`\\b(?:${INJECTION_RE.source})\\b`);

/** Pedir datos de otros: verbo de pedir + (todos los) clientes/empresas/contactos… [de alguien | de todos]. */
const EXFIL =
  /\b(?:dame|dime|pasame|pasa|lista|listame|listar|muestrame|muestra|mostrar|ensename|envia|enviame|manda|mandame|exporta|exportame|comparte|compartime|descarga)\b(?: \w+){0,3}? (?:todos los |todas las |los |las |tus )?(?:clientes|empresas|contactos|vendedores|usuarios|prospectos|cartera|carteras)\b(?:(?: \w+){0,2} (?:de|del) \w+|$)/;

/** Pedido creativo (texto plegado). "cuento" no: "cuento con 8 llantas". */
const CREATIVE = /\b(?:poemas?|poesias?|versos?|canciones?|cancion|chistes?|adivinanzas?|ensayos?|recetas?|horoscopo|haiku|rap|cuentame un cuento|escribeme un cuento)\b/;

/** Verbos de pedido (texto plegado). */
const ORDER_VERBS = /\b(?:cotiz\w*|precios?|stock|pedidos?|necesito|quiero comprar|oc)\b/;

/** Verbos de reporte (texto plegado): lo que hizo el vendedor. Sin sustantivos sueltos ("cliente", "empresa"). */
const REPORT_VERBS =
  /\b(?:visite|visitamos|fui|fuimos|estuve|estuvimos|pase por|llame|llamamos|me llamo|hable|hablamos|converse|conversamos|reuni|me reuni|nos reunimos|quede|quedamos|atendio|me atendio|me dijo|nos dijo|me recibio)\b/;

/** Señal fuerte de fuera de tema que una señal débil de pedido no anula (ver la cabecera). */
function strongOffTopic(t: string, f: string): boolean {
  if (INJECTION.test(f) || EXFIL.test(f)) return findTyreSizes(t).length === 0 && !REPORT_VERBS.test(f);
  if (CREATIVE.test(f)) return !/\d/.test(t) && !findBrandInText(t) && !ORDER_VERBS.test(f) && !REPORT_VERBS.test(f);
  return false;
}

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

/** Fuera de tema reconocible: una señal fuerte (ver la cabecera), o sin señales de pedido ni de reporte y con una señal de fuera de tema. */
export function isOffTopic(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const f = fold(t);
  if (strongOffTopic(t, f)) return true;
  if (hasRequestSignals(t)) return false;
  return OFF_TOPIC_RE.test(f);
}
