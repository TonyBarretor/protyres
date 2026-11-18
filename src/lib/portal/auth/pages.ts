/**
 * Páginas HTML de /portal/login (route handler: no pasa por el layout protegido de /portal). `page` es la mínima (la usa
 * la encuesta pública); `portalPage`, la del login con la identidad del portal.
 */
import { TOKEN_PAGE_REFERRER_POLICY } from "./constants";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** Página HTML mínima (también la usa la encuesta pública para sus 404/413/429). */
export function page(title: string, body: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title></head>
<body style="font-family: system-ui, sans-serif; margin: 2rem; max-width: 32rem">${body}</body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": TOKEN_PAGE_REFERRER_POLICY, ...extraHeaders } });
}

/**
 * Páginas de /portal/login con la identidad del portal (corrida F, punto 6): barra oscura con "360 Tyres" (acento
 * amarillo), tarjeta blanca, botón grande; se ve bien a 390 px y en modo oscuro. Sin fuentes externas ni scripts de
 * terceros (los colores son los de src/app/portal/portal.css). `script` = JS en línea opcional (solo la confirmación).
 */
export function portalPage(title: string, body: string, status = 200, opts: { extraHeaders?: Record<string, string>; script?: string } = {}): Response {
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#16181c">
<title>${esc(title)} · 360 Tyres</title>
<style>${PORTAL_PAGE_CSS}</style></head>
<body><header class="top"><span class="brand">360 <span>Tyres</span></span></header>
<main class="card">${body}</main>${opts.script ? `\n<script>${opts.script}</script>` : ""}</body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": TOKEN_PAGE_REFERRER_POLICY, ...(opts.extraHeaders ?? {}) } });
}

const PORTAL_PAGE_CSS = [
  ":root{--bg:#f4f5f7;--surface:#fff;--ink:#16181c;--muted:#5f6570;--line:#e2e4e9;--accent:#f5b400;--accent-ink:#16181c}",
  "@media (prefers-color-scheme:dark){:root{--bg:#0f1114;--surface:#1b1e23;--ink:#f1f2f4;--muted:#a3a8b1;--line:#2c3038}}",
  "*{box-sizing:border-box}",
  "body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;-webkit-text-size-adjust:100%}",
  ".top{background:#16181c;color:#fff;padding:.75rem 1rem}",
  ".brand{font-weight:700;font-size:1.1rem;letter-spacing:-.01em}.brand span{color:var(--accent)}",
  ".card{background:var(--surface);border:1px solid var(--line);border-radius:12px;margin:1.25rem auto;max-width:26rem;width:calc(100% - 2rem);padding:1.5rem 1.25rem}",
  "h1{font-size:1.35rem;line-height:1.25;margin:0 0 .5rem}",
  "p{margin:0 0 .75rem;color:var(--muted)}p b{color:var(--ink)}",
  ".btn{display:block;width:100%;min-height:3.25rem;margin:1rem 0 .75rem;border:0;border-radius:10px;background:var(--accent);color:var(--accent-ink);font:inherit;font-size:1.1rem;font-weight:700;cursor:pointer;-webkit-appearance:none;appearance:none}",
  ".btn:active{filter:brightness(.92)}",
  "a.btn{display:flex;align-items:center;justify-content:center;gap:.5rem;text-decoration:none;text-align:center;padding:0 1rem}",
  ".small{font-size:.85rem}",
].join("");

const ASK_AGAIN = "Escribe <b>portal</b> al bot de WhatsApp para pedir otro.";

/**
 * Hotfix login 2, punto 5: lo que necesitan las pantallas sin sesión. `chatUrl` = chat del bot con `portal` ya escrito
 * (wa.me; null si no está configurado el número); los plazos en texto ("24 horas", "30 días").
 */
export interface AccessHelp {
  chatUrl: string | null;
  linkText: string;
  sessionText: string;
}

const DEFAULT_HELP: AccessHelp = { chatUrl: null, linkText: "24 horas", sessionText: "30 días" };

/** Botón grande al chat del bot y la línea que lo explica (sin número configurado: la instrucción escrita). */
function askLinkBlock(help: AccessHelp): string {
  const terms = `<p class="small">El enlace sirve por ${esc(help.linkText)}. Después de entrar, tu teléfono queda con la sesión abierta por ${esc(help.sessionText)}.</p>`;
  if (!help.chatUrl) return `<p>Escribe <b>portal</b> al bot de WhatsApp y te responde con tu enlace para entrar.</p>${terms}`;
  return `<a class="btn" href="${esc(help.chatUrl)}" rel="noopener">Pedir enlace por WhatsApp</a>
<p>Se abre el chat del bot con la palabra <b>portal</b> ya escrita: envíala y el bot te responde con tu enlace.</p>${terms}`;
}

/** Sin sesión y sin enlace (también /portal sin sesión): la entrada con el botón para pedir el enlace. */
export function noSessionPage(help: AccessHelp = DEFAULT_HELP): Response {
  return portalPage("Entrar al portal", `<h1>Entra al portal</h1><p>Para entrar necesitas tu enlace personal del bot.</p>${askLinkBlock(help)}`);
}

/** Sin sesión y con un enlace que ya no sirve (vencido, anulado o mal copiado): la misma entrada con el botón. */
export function expiredLinkPage(help: AccessHelp = DEFAULT_HELP): Response {
  return portalPage("Enlace vencido", `<h1>Este enlace ya venció</h1><p>Pide uno nuevo: es un momento.</p>${askLinkBlock(help)}`, 401);
}

/** POST con cabecera Origin de otro sitio (posible CSRF de inicio de sesión). */
export function forbiddenOriginPage(): Response {
  return portalPage("Solicitud no permitida", `<h1>Solicitud no permitida</h1><p>Abre el enlace directamente desde WhatsApp. ${ASK_AGAIN}</p>`, 403);
}

/**
 * Falta configuración del servidor (p. ej. el secreto de sesión). El detalle técnico, con el nombre de la variable, va a la
 * consola del servidor; la pantalla solo dice que se contacte al administrador (corrida F, punto 3).
 */
export function configErrorPage(message: string): Response {
  console.error(`[portal] login sin configuración: ${message}`);
  return portalPage("Portal no configurado", `<h1>Portal no configurado</h1><p>El portal todavía no está listo para entrar. Contacta al administrador.</p>`, 503);
}

/**
 * Envío automático del formulario de confirmación: UNA sola vez, al terminar de cargar (un segundo envío crearía otra
 * sesión de más). Marca `via=auto` para el registro del servidor (así se ve en los
 * registros si el navegador de WhatsApp lo ejecutó o el usuario pulsó). Al volver atrás (página restaurada de la caché)
 * no se reenvía. Si el navegador no lo ejecuta, queda el botón.
 */
const AUTO_SUBMIT = [
  "(function(){var f=document.getElementById('f');if(!f)return;var s=document.getElementById('st');var done=false;",
  "function go(){if(done)return;done=true;try{f.elements.via.value='auto';if(s)s.textContent='Entrando…';HTMLFormElement.prototype.submit.call(f)}catch(e){if(s)s.textContent='Pulsa el botón para entrar.'}}",
  "f.addEventListener('submit',function(){done=true});",
  "window.addEventListener('pageshow',function(e){if(e.persisted){done=true;if(s)s.textContent='Pulsa el botón para entrar.'}});",
  "if(document.readyState==='complete')setTimeout(go,0);else window.addEventListener('load',function(){setTimeout(go,0)})})();",
].join("");

/**
 * Paso intermedio del GET: la sesión se crea solo con POST, para que la vista previa de WhatsApp, un visor de enlaces o
 * un antivirus que abra la URL no entre por el usuario. El formulario se envía solo (JS, ver AUTO_SUBMIT) y el botón
 * grande queda por si el navegador interno de WhatsApp no ejecuta el envío automático.
 */
/** `next`: pantalla a la que entra (ya validada con safeNextPath; null = el inicio). */
export function confirmLoginPage(token: string, next: string | null = null, help: AccessHelp = DEFAULT_HELP): Response {
  const nextField = next ? `<input type="hidden" name="next" value="${esc(next)}">` : "";
  return portalPage(
    "Entrar al portal",
    `<h1>Entrar al portal</h1>
<p>Tu enlace personal está listo. Pulsa el botón para entrar (el enlace sirve por ${esc(help.linkText)}).</p>
<form method="post" id="f"><input type="hidden" name="t" value="${esc(token)}">${nextField}<input type="hidden" name="via" value="boton"><button class="btn" type="submit">Entrar al portal</button></form>
<p class="small" id="st" aria-live="polite"></p>`,
    200,
    { script: AUTO_SUBMIT },
  );
}

/** Límite de intentos superado (corrida E, punto 5): 429 con Retry-After, y el botón para pedir un enlace nuevo. */
export function tooManyAttemptsPage(retryAfterSec: number, minutesText: string, help: AccessHelp = DEFAULT_HELP): Response {
  return portalPage(
    "Demasiados intentos",
    `<h1>Demasiados intentos</h1><p>Hubo muchos intentos con enlaces que ya no sirven. Espera unos ${esc(minutesText)}, o pide un enlace nuevo.</p>${askLinkBlock(help)}`,
    429,
    { extraHeaders: { "retry-after": String(retryAfterSec) } },
  );
}

/** Cuerpo de la petición mayor que el máximo. */
export function payloadTooLargePage(): Response {
  return portalPage("Solicitud demasiado grande", `<h1>Solicitud demasiado grande</h1><p>Abre el enlace directamente desde WhatsApp. ${ASK_AGAIN}</p>`, 413);
}
