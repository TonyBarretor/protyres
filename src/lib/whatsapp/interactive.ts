/**
 * Mensajes interactivos de WhatsApp Cloud API (botones de respuesta y listas): límites, validación, caída a texto y el
 * prefijo de los ids del portal.
 *
 * Límites (documentación de Meta, verificados 2026-11-12):
 *  - Botones (`interactive.type = "button"`): máx. 3; `reply.title` ≤ 20 caracteres y únicos; `reply.id` ≤ 256;
 *    body ≤ 1024; footer ≤ 60.
 *  - Listas (`interactive.type = "list"`): hasta 10 secciones y 10 filas EN TOTAL; texto del botón que abre la lista ≤ 20;
 *    título de sección ≤ 24; título de fila ≤ 24; descripción de fila ≤ 72; id de fila ≤ 200; body ≤ 4096; header y
 *    footer ≤ 60.
 * Los títulos, descripciones, header y footer largos se recortan (con «…»); lo que no se puede recortar sin cambiar el
 * sentido (body largo, demasiados botones o filas, ids largos, títulos repetidos) hace que el mensaje vaya como TEXTO.
 *
 * Principio: el id de cada botón / fila es un texto que el bot YA entiende escrito a mano (`asignarme 20602221505`, `sí`,
 * `corregir`, `enlazar`, el número de una opción de la lista), con el prefijo PORTAL_ID_PREFIX delante. Al llegar la
 * respuesta (webhook.ts) el texto que procesa el bot es ese id sin el prefijo: pulsar el botón y escribir su equivalente
 * dan exactamente lo mismo, y la caída a texto ("Responde *sí* o *corregir*") funciona igual.
 */

/** Prefijo de los ids de botones y filas del portal: `pt:` + el texto equivalente (p. ej. `pt:asignarme 20602221505`). */
export const PORTAL_ID_PREFIX = "pt:";

export const BUTTONS_MAX = 3;
export const BUTTON_TITLE_MAX = 20;
export const BUTTON_ID_MAX = 256;
export const BUTTON_BODY_MAX = 1024;
export const LIST_ROWS_MAX = 10;
export const LIST_SECTIONS_MAX = 10;
export const LIST_BUTTON_MAX = 20;
export const LIST_SECTION_TITLE_MAX = 24;
export const LIST_ROW_TITLE_MAX = 24;
export const LIST_ROW_DESCRIPTION_MAX = 72;
export const LIST_ROW_ID_MAX = 200;
export const LIST_BODY_MAX = 4096;
export const HEADER_MAX = 60;
export const FOOTER_MAX = 60;

/** Botón de respuesta. `id`: el texto equivalente que entiende el bot (sin prefijo al armarlo; ver portalButtons). */
export interface ReplyButton {
  id: string;
  title: string;
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export interface ListSection {
  title?: string;
  rows: ListRow[];
}

export type InteractiveMessage =
  | { type: "button"; body: string; header?: string; footer?: string; buttons: ReplyButton[] }
  | { type: "list"; body: string; header?: string; footer?: string; button: string; sections: ListSection[] };

const clip = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/**
 * El mensaje listo para la API (títulos recortados a los límites) o null si no se puede mandar como interactivo:
 * body vacío o largo, sin opciones o con demasiadas, ids vacíos o largos, títulos repetidos.
 */
export function prepareInteractive(m: InteractiveMessage): InteractiveMessage | null {
  const body = m.body.trim();
  if (!body) return null;
  const header = m.header ? clip(m.header, HEADER_MAX) : undefined;
  const footer = m.footer ? clip(m.footer, FOOTER_MAX) : undefined;
  if (m.type === "button") {
    if (body.length > BUTTON_BODY_MAX || m.buttons.length === 0 || m.buttons.length > BUTTONS_MAX) return null;
    const buttons = m.buttons.map((b) => ({ id: b.id, title: clip(b.title, BUTTON_TITLE_MAX) }));
    if (buttons.some((b) => !b.id || b.id.length > BUTTON_ID_MAX || !b.title)) return null;
    if (new Set(buttons.map((b) => fold(b.title))).size !== buttons.length) return null;
    return { type: "button", body, header, footer, buttons };
  }
  const rows = m.sections.flatMap((s) => s.rows);
  if (body.length > LIST_BODY_MAX || rows.length === 0 || rows.length > LIST_ROWS_MAX || m.sections.length > LIST_SECTIONS_MAX) return null;
  const sections = m.sections.map((s) => ({
    ...(s.title ? { title: clip(s.title, LIST_SECTION_TITLE_MAX) } : {}),
    rows: s.rows.map((r) => ({ id: r.id, title: clip(r.title, LIST_ROW_TITLE_MAX), ...(r.description ? { description: clip(r.description, LIST_ROW_DESCRIPTION_MAX) } : {}) })),
  }));
  const all = sections.flatMap((s) => s.rows);
  if (all.some((r) => !r.id || r.id.length > LIST_ROW_ID_MAX || !r.title)) return null;
  if (new Set(all.map((r) => r.id)).size !== all.length) return null;
  // con varias secciones, Meta exige el título de cada una
  if (sections.length > 1 && sections.some((s) => !("title" in s))) return null;
  const button = clip(m.button, LIST_BUTTON_MAX);
  if (!button) return null;
  return { type: "list", body, header, footer, button, sections };
}

/** El texto equivalente de un id (sin el prefijo del portal). */
export function stripPortalPrefix(id: string): string {
  return id.startsWith(PORTAL_ID_PREFIX) ? id.slice(PORTAL_ID_PREFIX.length) : id;
}

export function isPortalId(id: string | undefined | null): boolean {
  return !!id && id.startsWith(PORTAL_ID_PREFIX);
}

/** Botones del portal: el id es el texto equivalente, aquí se le pone el prefijo. */
export function portalButtons(buttons: ReplyButton[]): ReplyButton[] {
  return buttons.map((b) => ({ id: `${PORTAL_ID_PREFIX}${b.id}`, title: b.title }));
}

export function portalRows(rows: ListRow[]): ListRow[] {
  return rows.map((r) => ({ ...r, id: `${PORTAL_ID_PREFIX}${r.id}` }));
}

/** "*a*", "*a* o *b*", "*a*, *b* o *c*". */
function orList(items: string[]): string {
  const q = items.map((s) => `*${s}*`);
  return q.length <= 1 ? (q[0] ?? "") : `${q.slice(0, -1).join(", ")} o ${q[q.length - 1]}`;
}

/**
 * El mismo mensaje en texto (sin canal interactivo o si el envío falla): body + "Responde *sí* o *corregir*." con los
 * textos equivalentes (ids sin prefijo), o la lista numerada con "Responde con el número." cuando los ids son números.
 */
export function interactiveAsText(m: InteractiveMessage): string {
  if (m.type === "button") return `${m.body}\n\nResponde ${orList(m.buttons.map((b) => stripPortalPrefix(b.id)))}.`;
  const rows = m.sections.flatMap((s) => s.rows);
  const numbered = rows.every((r, i) => stripPortalPrefix(r.id) === String(i + 1));
  const lines = rows.map((r, i) => (numbered ? `*${i + 1}.* ${r.title}${r.description ? ` · ${r.description}` : ""}` : `• *${stripPortalPrefix(r.id)}* — ${r.title}${r.description ? ` · ${r.description}` : ""}`));
  return `${m.body}\n${lines.join("\n")}\n${numbered ? "Responde con el número." : "Responde con una de las opciones."}`;
}

/** Resumen de una línea de las opciones (registro en `messages`, simulador): "[Sí, guardar] [Corregir]" / "[1. ZBUSS] [2. …]". */
export function optionsLine(m: InteractiveMessage): string {
  if (m.type === "button") return m.buttons.map((b) => `[${b.title}]`).join(" ");
  return `[${m.button}] ${m.sections
    .flatMap((s) => s.rows)
    .map((r) => `[${stripPortalPrefix(r.id)}. ${r.title}]`)
    .join(" ")}`;
}

/**
 * Manda el interactivo si se puede (canal con `send`, mensaje dentro de los límites) y si no, o si el envío falla, el
 * texto `fallback` (por defecto interactiveAsText). Nunca se pierde el mensaje: un fallo del texto sí se propaga.
 */
export async function deliverInteractive(
  m: InteractiveMessage,
  ch: { send?: (m: InteractiveMessage) => Promise<void>; sendText: (body: string) => Promise<void>; log?: (msg: string) => void },
  fallback?: string,
): Promise<"interactive" | "text"> {
  const ready = ch.send ? prepareInteractive(m) : null;
  if (ready && ch.send) {
    try {
      await ch.send(ready);
      return "interactive";
    } catch (err) {
      ch.log?.(`whatsapp: el mensaje interactivo falló, va como texto: ${(err as Error).message}`);
    }
  } else if (ch.send) ch.log?.("whatsapp: mensaje interactivo fuera de los límites, va como texto");
  await ch.sendText(fallback ?? interactiveAsText(m));
  return "text";
}

/** Cuerpo `interactive` del payload de la Graph API. */
export function graphInteractive(m: InteractiveMessage): Record<string, unknown> {
  const common = {
    ...(m.header ? { header: { type: "text", text: m.header } } : {}),
    body: { text: m.body },
    ...(m.footer ? { footer: { text: m.footer } } : {}),
  };
  if (m.type === "button") return { type: "button", ...common, action: { buttons: m.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) } };
  return { type: "list", ...common, action: { button: m.button, sections: m.sections } };
}
