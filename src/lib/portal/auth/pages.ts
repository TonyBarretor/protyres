/**
 * Páginas HTML mínimas de /portal/login (route handler: no pasa por el layout protegido de /portal).
 */

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title></head>
<body style="font-family: system-ui, sans-serif; margin: 2rem; max-width: 32rem">${body}</body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

const ASK_AGAIN = "Escribe <b>portal</b> al bot de WhatsApp para pedir otro.";

/** Sin token: pantalla pública "Sin sesión". */
export function noSessionPage(): Response {
  return page("Portal 360 Tyres", `<h1>Portal 360 Tyres</h1><p>No has iniciado sesión. Escribe <b>portal</b> al bot de WhatsApp y te mandará un enlace para entrar (válido 15 minutos, un solo uso).</p>`);
}

export function expiredLinkPage(): Response {
  return page("Enlace vencido", `<h1>Enlace vencido o ya usado</h1><p>${ASK_AGAIN}</p>`, 401);
}

export function configErrorPage(message: string): Response {
  return page("Portal no configurado", `<h1>Portal no configurado</h1><p>${esc(message)}</p>`, 503);
}

/**
 * Paso intermedio del GET: el token se consume solo con POST, para que un visor de enlaces o un antivirus que abra la URL
 * no lo gaste. El formulario se envía solo (JS) y hay botón por si el JS está apagado.
 */
export function confirmLoginPage(token: string): Response {
  return page(
    "Entrando al portal…",
    `<h1>Portal 360 Tyres</h1>
<form method="post" id="f"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Entrar al portal</button></form>
<script>document.getElementById("f").submit()</script>`,
  );
}
