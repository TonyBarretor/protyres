/**
 * Referencias del cliente por línea (corrida J, punto 1): lo que el cliente escribe junto a cada llanta para saber a qué
 * va. Hoy son dos y NO se mezclan:
 *  - UB (Prosegur, perfil con `ub` obligatorio): código de la unidad blindada, 3–5 cifras ("UB 1830").
 *  - PLACA (cualquier cliente, opcional): placa peruana del vehículo, 6 caracteres con guion ("ABC-123", "A1B-234").
 *
 * Es el mismo mecanismo para las dos (un dato opcional por línea que sale junto a la medida, en el PDF, en el "Entendí",
 * en el correo y en el pedido): aquí está lo común para no repetirlo en cada sitio. El orden es el de siempre: la placa y
 * luego la UB ("215/75R17.5 18PR PLACA ABC-123 UB 1830"); la UB del ítem solo se muestra cuando no es la de toda la
 * cotización (`quoteUb`), salvo en el PDF, que siempre la imprime (la del ítem o la de la cotización).
 */

export type LineRefKey = "plate" | "ub";

export interface LineRef {
  key: LineRefKey;
  /** Etiqueta del PDF ("PLACA", "UB"). */
  label: string;
  /** Como se escribe en el chat y en el correo ("placa ABC-123", "UB 1830"). */
  chat: string;
  value: string;
}

const LABEL: Record<LineRefKey, { label: string; chat: string }> = {
  plate: { label: "PLACA", chat: "placa" },
  ub: { label: "UB", chat: "UB" },
};

/**
 * Las referencias de una línea, en orden (placa, UB). `ub`: "own" = solo la UB propia del ítem distinta de la de la
 * cotización (chat, correo); "effective" = la del ítem o, si no tiene, la de la cotización (PDF).
 */
export function lineRefs(it: { plate?: string; ub?: string }, quoteUb?: string, ub: "own" | "effective" = "own"): LineRef[] {
  const out: LineRef[] = [];
  if (it.plate) out.push({ key: "plate", ...LABEL.plate, value: it.plate });
  const u = ub === "effective" ? (it.ub ?? quoteUb) : it.ub && it.ub !== quoteUb ? it.ub : undefined;
  if (u) out.push({ key: "ub", ...LABEL.ub, value: u });
  return out;
}

/** "PLACA ABC-123 UB 1830" (PDF). */
export function lineRefsLabel(refs: LineRef[]): string {
  return refs.map((r) => `${r.label} ${r.value}`).join(" ");
}

/** "placa ABC-123 UB 1830" (chat, correo). */
export function lineRefsChat(refs: LineRef[]): string {
  return refs.map((r) => `${r.chat} ${r.value}`).join(" ");
}

// ── placa ──

/**
 * Placa peruana normalizada ("abc123", "ABC 123", "a1b-234" -> "ABC-123", "A1B-234"), o undefined si no tiene la forma:
 * 3 caracteres (el primero letra; los otros, letra o cifra) y 3 cifras. Es la forma de las placas del padrón
 * (fleet_vehicles, sin guion) con el guion con que se escriben.
 */
export function normalizePlate(raw: string | undefined | null): string | undefined {
  const t = (raw ?? "").trim().toUpperCase().replace(/\./g, "").replace(/\s*-\s*|\s+/g, "-");
  // un guion o espacio solo entre los 3 primeros y las 3 cifras ("AB-1234", la forma antigua, no es esta placa)
  if (/-/.test(t) && !/^[A-Z0-9]{3}-\d{3}$/.test(t)) return undefined;
  const s = t.replace(/-/g, "");
  return /^[A-Z][A-Z0-9]{2}\d{3}$/.test(s) ? `${s.slice(0, 3)}-${s.slice(3)}` : undefined;
}

/** La placa como la guarda el padrón (fleet_vehicles.placa: sin guion ni espacios, mayúsculas). */
export function plateKey(plate: string): string {
  return plate.toUpperCase().replace(/[\s-]/g, "");
}

/** "placa", "plc", "placa:" y "plc." al empezar una referencia de placa. */
export const PLATE_WORD = String.raw`(?:placa|plc\.?)`;

export type PlateCommand =
  /** "placa 2 ABC-123" / "plc 2 ABC123": pone o cambia la placa del ítem 2; "placa ABC-123" (line null): el único ítem. */
  | { kind: "set"; line: number | null; plate: string }
  /** "sin placa 2" (line null: "sin placa", el único ítem o, al preguntar, seguir sin placas). */
  | { kind: "clear"; line: number | null }
  /** "placa 2 AB12": no tiene forma de placa: se pregunta. */
  | { kind: "invalid"; line: number | null; heard: string };

/**
 * Los comandos de placa sobre la cotización a la vista. Null si el texto no es uno ("placa" a secas tampoco). El número
 * del ítem va antes de la placa ("placa 2 ABC-123"); "placa ABC-123" es para una cotización de un solo ítem.
 */
export function parsePlateCommand(text: string): PlateCommand | null {
  const t = text.trim();
  const clear = t.match(new RegExp(String.raw`^sin\s+${PLATE_WORD}(?:\s+(?:(?:al|el|del|en el)\s+)?(?:[ií]tem\s+)?(\d{1,2}))?\s*[.!]?$`, "i"));
  if (clear) return { kind: "clear", line: clear[1] ? parseInt(clear[1], 10) : null };
  const m = t.match(new RegExp(String.raw`^${PLATE_WORD}\s*:?\s*(?:(?:al|el|del|en el)\s+)?(?:[ií]tem\s+)?(?:(\d{1,2})(?=\s+\S)\s*:?\s*)?(\S(?:.*\S)?)\s*$`, "i"));
  if (!m) return null;
  const line = m[1] ? parseInt(m[1], 10) : null;
  const plate = normalizePlate(m[2]);
  return plate ? { kind: "set", line, plate } : { kind: "invalid", line, heard: m[2].slice(0, 20) };
}

/** Respuesta a una placa que no tiene la forma de una placa peruana. */
export function invalidPlateReply(heard: string, line: number | null): string {
  return `«${heard}» no parece una placa (6 caracteres, como *ABC-123*). Escríbela así: *placa ${line ?? 1} ABC-123* (o *sin placa${line ? ` ${line}` : ""}*).`;
}
