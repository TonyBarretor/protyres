/**
 * Preguntas del pedido para Patricia (`oc`, bloque B5b): una por una, con respuesta corta (o por voz, ya transcrita) y
 * con el último valor usado con ese cliente como opción por defecto ("igual" / "ok" / Enter lo acepta).
 *
 * Puro: sin store ni WhatsApp. El comando (bot/commands/oc.ts) guarda el estado en el paso pendiente y la memoria del
 * cliente en company_order_profile.
 *
 * Orden: datos del cliente (los recordados en una sola confirmación; los que faltan, uno por uno) → fecha de entrega →
 * enllante → marcado → flete → plazo de crédito → pago al proveedor y recojo (solo con ítems de terceros) → observaciones.
 */
import { foldText } from "../store/shared";
import { parseSpanishDateTime } from "../bot/dates";
import { limaDateKey } from "../ui/time";
import type { PedidoCliente, PedidoEntrega } from "./pedido-xlsx";

/** Memoria del pedido por cliente (company_order_profile.data). Cadena vacía = "no tiene" (p. ej. sin agencia): no se vuelve a preguntar. */
export interface OrderProfile {
  direccionFiscal?: string;
  direccionEntrega?: string;
  contacto?: string;
  agencia?: string;
  agenciaContacto?: string;
  agenciaTelefono?: string;
  /** Últimas respuestas (texto como se muestra / se escribe en el Excel). */
  last?: {
    fechaEntrega?: string;
    enllante?: string;
    marcado?: string;
    flete?: string;
    valorFlete?: string;
    pagoProveedor?: string;
    recojo?: string;
    observaciones?: string;
  };
}

export type ClientField = "direccionFiscal" | "direccionEntrega" | "contacto" | "agencia";
export const CLIENT_FIELDS: ClientField[] = ["direccionFiscal", "direccionEntrega", "contacto", "agencia"];

export type OrderField = "cliente" | ClientField | "fechaEntrega" | "enllante" | "marcado" | "flete" | "plazoCredito" | "proveedor" | "observaciones";

/** Respuestas del vendedor en este pedido. */
export interface OrderAnswers {
  cliente: Partial<Pick<PedidoCliente, "direccionFiscal" | "direccionEntrega" | "contacto" | "agencia" | "agenciaContacto" | "agenciaTelefono">>;
  /** Campos del cliente ya resueltos (respondidos o confirmados). */
  clienteListo: ClientField[];
  clienteConfirmado?: boolean;
  /** yyyy-mm-dd o texto ("48 h post OC"). */
  fechaEntrega?: string;
  enllante?: "SI" | "NO";
  marcado?: "SI" | "NO";
  flete?: string;
  valorFlete?: string;
  /** null = sin dato. */
  plazoCreditoDias?: number | null;
  /** El vendedor escribió un plazo (no aceptó el ofrecido). */
  plazoEscrito?: boolean;
  pagoProveedor?: string;
  recojo?: string;
  observaciones?: string;
}

/** Lo que el comando sabe al empezar las preguntas. */
export interface QuestionContext {
  profile: OrderProfile;
  /** Hay ítems de terceros (productos de proveedor). */
  terceros: boolean;
  /** Plazo ofrecido por defecto (de la cotización o de la empresa) y de dónde sale. */
  plazo: { dias: number; fuente: string } | null;
  /** Sugerencias cuando el cliente no tiene memoria: dirección de la cotización, contacto del portal. */
  sugerencias: { direccionFiscal?: string; contacto?: string };
  /** Nombre corto del cliente ("ZBUSS"). */
  cliente: string;
}

export interface Question {
  field: OrderField;
  text: string;
  /** Valor que acepta "igual" / "ok". */
  def?: string;
}

const LABEL: Record<ClientField, string> = {
  direccionFiscal: "Dirección fiscal",
  direccionEntrega: "Dirección de entrega",
  contacto: "Persona de contacto",
  agencia: "Agencia",
};

const has = (v: string | undefined): v is string => typeof v === "string";

export function agenciaText(c: Pick<PedidoCliente, "agencia" | "agenciaContacto" | "agenciaTelefono">): string {
  if (!c.agencia?.trim()) return "ninguna";
  return [c.agencia.trim(), [c.agenciaContacto, c.agenciaTelefono].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

function profileValue(p: OrderProfile, f: ClientField): string | undefined {
  if (f === "agencia") return has(p.agencia) ? agenciaText(p) : undefined;
  return p[f];
}

/** Campos del cliente recordados (los que entran en la confirmación única). */
export function rememberedClientFields(p: OrderProfile): ClientField[] {
  return CLIENT_FIELDS.filter((f) => has(profileValue(p, f)));
}

const opt = (last: string | undefined, what = "la última vez") => (last ? ` (${what}: ${last} — responde *igual* o escribe otra)` : "");

/** La siguiente pregunta; null = ya está todo. */
export function nextOrderQuestion(a: OrderAnswers, q: QuestionContext): Question | null {
  const p = q.profile;
  const remembered = rememberedClientFields(p);
  if (remembered.length && !a.clienteConfirmado) {
    const lines = remembered.map((f) => `• ${LABEL[f]}: ${profileValue(p, f) || "—"}`);
    return {
      field: "cliente",
      text: `Datos de *${q.cliente}* de la última vez:\n${lines.join("\n")}\nResponde *igual* o escribe lo que cambia (p. ej. *entrega: Av. Los Álamos 123, Ate*).`,
      def: "igual",
    };
  }
  for (const f of CLIENT_FIELDS) {
    if (a.clienteListo.includes(f)) continue;
    if (f === "direccionFiscal") {
      const s = q.sugerencias.direccionFiscal;
      return { field: f, text: `🏢 Dirección fiscal de *${q.cliente}*?${opt(s, "de la cotización")}`, def: s };
    }
    if (f === "direccionEntrega") {
      const fiscal = a.cliente.direccionFiscal;
      return { field: f, text: `📍 Dirección de entrega?${fiscal ? " (responde *la misma* si es la fiscal)" : ""}`, def: fiscal };
    }
    if (f === "contacto") {
      const s = q.sugerencias.contacto;
      return { field: f, text: `👤 Persona de contacto para la entrega (nombre y celular)?${opt(s, "del portal")}`, def: s };
    }
    return { field: f, text: "🚛 Agencia de transporte y su contacto? (p. ej. *Andeskar, Luis Pérez 987 654 321*, o *ninguna*)" };
  }
  const last = p.last ?? {};
  if (a.fechaEntrega === undefined) {
    const def = last.fechaEntrega && !/^\d{4}-\d{2}-\d{2}$/.test(last.fechaEntrega) ? last.fechaEntrega : undefined; // una fecha exacta pasada no sirve de defecto
    return { field: "fechaEntrega", text: `📅 Fecha de entrega?${def ? opt(def) : " (p. ej. *20/11*, *viernes* o *48 h post OC*)"}`, def };
  }
  if (a.enllante === undefined) return siNoQuestion("enllante", "🛞 Servicio de enllante?", last.enllante);
  if (a.marcado === undefined) return siNoQuestion("marcado", "🏷️ Servicio de marcado?", last.marcado);
  if (a.flete === undefined) {
    const def = last.flete ? [last.flete, last.valorFlete].filter(Boolean).join(", ") : undefined;
    return { field: "flete", text: `🚚 Flete por cuenta de quién? (*cliente*, *360* o *agencia*, y el valor si hay: p. ej. *360, 20 soles x llanta*)${def ? `\n_La última vez: ${def} — responde *igual* o escribe otro._` : ""}`, def };
  }
  if (a.plazoCreditoDias === undefined) {
    const d = q.plazo;
    const shown = d ? (d.dias <= 0 ? "contado" : `${d.dias} días`) : undefined;
    return {
      field: "plazoCredito",
      text: d ? `💳 Plazo de crédito? (*${shown}* ${d.fuente} — responde *igual* o escribe otro, p. ej. *60* o *contado*)` : "💳 Plazo de crédito? (p. ej. *30*, *45 días* o *contado*)",
      def: d ? String(d.dias) : undefined,
    };
  }
  if (q.terceros && a.pagoProveedor === undefined) {
    const def = last.pagoProveedor || last.recojo ? [last.pagoProveedor, last.recojo].filter(Boolean).join(", ") : undefined;
    return { field: "proveedor", text: `🏭 Condiciones de pago del proveedor y dónde se recoge? (p. ej. *letras 90, almacén Steel*)${def ? `\n_La última vez: ${def} — responde *igual* o escribe otro._` : ""}`, def };
  }
  if (a.observaciones === undefined) {
    const def = last.observaciones || undefined;
    return { field: "observaciones", text: `📝 Observaciones? (*ninguna* si no hay)${def ? opt(def) : ""}`, def };
  }
  return null;
}

function siNoQuestion(field: "enllante" | "marcado", label: string, last: string | undefined): Question {
  return { field, text: `${label} (*sí* / *no*${last ? `; la última vez: ${last.toLowerCase()} — *igual*` : ""})`, def: last };
}

// ── respuestas ──

const DEFAULT_WORDS = new Set(["igual", "ok", "okey", "okay", "enter", "lo mismo", "el mismo", "la misma", "mismo", "misma", "igual que antes", "la de siempre", "el de siempre", "si igual", "ok igual", "dale", "correcto", "."]);
const YES = new Set(["si", "sí", "s", "yes", "con", "si va", "si lleva", "lleva", "con servicio", "claro"]);
const NO = new Set(["no", "n", "sin", "no va", "no lleva", "sin servicio", "ninguno"]);
const NONE = new Set(["ninguna", "ninguno", "no", "nada", "no hay", "sin observaciones", "sin agencia", "-", "na", "n/a"]);

const norm = (t: string) => foldText(t).replace(/[.!¡¿?]+$/g, "").replace(/\s+/g, " ").trim();

/** "igual" / "ok" / Enter (vacío): aceptar el valor ofrecido. */
export function isDefaultAnswer(text: string): boolean {
  const t = norm(text);
  return t === "" || DEFAULT_WORDS.has(t);
}

export function parseSiNo(text: string): "SI" | "NO" | null {
  const t = norm(text);
  if (YES.has(t) || /^s[ií]\b/.test(foldText(text).trim())) return "SI";
  if (NO.has(t) || /^no\b/.test(t)) return "NO";
  return null;
}

/** "contado" -> 0; "45", "45 días", "crédito 60 días" -> días; null si no se entiende. */
export function parsePlazo(text: string): number | null {
  const t = norm(text);
  if (/\bcontado\b/.test(t)) return 0;
  const m = t.match(/^(?:credito\s*(?:a\s*)?)?(\d{1,3})(?:\s*d[ií]as?)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 365 ? n : null;
}

/** "cliente" / "360, 20 soles x llanta" / "agencia 15 soles" -> quién paga y el valor. */
export function parseFlete(text: string): { flete: string; valorFlete?: string } {
  const raw = text.trim();
  const t = foldText(raw);
  const who: [RegExp, string][] = [
    [/^(?:por\s+cuenta\s+del?\s+|lo\s+paga\s+el\s+|paga\s+el\s+|del?\s+)?cliente\b/, "CLIENTE"],
    [/^(?:por\s+cuenta\s+de\s+|lo\s+pagamos\s+|paga\s+)?(?:360\s*tyres|360|nosotros|la\s+empresa|empresa)\b/, "360TYRES"],
    [/^(?:por\s+cuenta\s+de\s+(?:la\s+)?|la\s+)?agencia\b/, "AGENCIA"],
  ];
  for (const [re, flete] of who) {
    const m = t.match(re);
    if (m) {
      const rest = raw.slice(m[0].length).replace(/^[\s,;:.\-–]+/, "").replace(/^(?:valor|flete)\s*:?\s*/i, "").trim();
      return rest ? { flete, valorFlete: rest.toUpperCase() } : { flete };
    }
  }
  return { flete: raw.toUpperCase() };
}

/** "letras 90, almacén Steel" / "contado, recoge en Lurín" -> pago y recojo. */
export function parseProveedor(text: string): { pagoProveedor?: string; recojo?: string } {
  const raw = text.trim();
  const recojoRe = /(?:^|[,;]|\s)\s*(?:y\s+)?(?:se\s+)?(?:recoge(?:r)?|recojo|entrega)\s+(?:en\s+)?/i;
  const m = raw.match(recojoRe);
  let pago: string;
  let recojo: string;
  if (m && m.index !== undefined) {
    pago = raw.slice(0, m.index);
    recojo = raw.slice(m.index + m[0].length);
  } else {
    const i = raw.search(/[,;]/);
    pago = i >= 0 ? raw.slice(0, i) : raw;
    recojo = i >= 0 ? raw.slice(i + 1) : "";
  }
  const clean = (s: string) => s.replace(/^[\s,;:.\-–]+|[\s,;:.\-–]+$/g, "").trim().toUpperCase();
  const out: { pagoProveedor?: string; recojo?: string } = {};
  if (clean(pago)) out.pagoProveedor = clean(pago);
  if (clean(recojo)) out.recojo = clean(recojo);
  return out;
}

/** "Andeskar, Luis Pérez 987 654 321" -> agencia, contacto, teléfono; "ninguna" -> sin agencia. */
export function parseAgencia(text: string): Pick<PedidoCliente, "agencia" | "agenciaContacto" | "agenciaTelefono"> {
  const raw = text.trim();
  if (NONE.has(norm(raw))) return { agencia: "" };
  const phoneRe = /(?:\+?51[\s-]?)?9\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/;
  const phone = raw.match(phoneRe)?.[0];
  const noPhone = phone ? raw.replace(phone, " ") : raw;
  const parts = noPhone.split(/[,;]|\s+-\s+|\s+contacto:?\s+/i).map((s) => s.replace(/\b(?:cel(?:ular)?|telf?|tel[eé]fono)\.?:?\s*$/i, "").trim()).filter(Boolean);
  const agencia = (parts[0] ?? raw).replace(/^agencia\s+/i, "").trim();
  return { agencia, agenciaContacto: parts.slice(1).join(" ") || undefined, agenciaTelefono: phone?.replace(/[\s-]+/g, " ").trim() || undefined };
}

/** Fecha de entrega: un día reconocible y nada más -> yyyy-mm-dd; si no, el texto como está ("48 h post OC"). */
export function parseFechaEntrega(text: string, now: Date): string {
  const raw = text.trim();
  const m = parseSpanishDateTime(raw, now);
  if (m && !m.rest.replace(/^(?:el|para el|para)\s*/i, "").trim()) return limaDateKey(m.date);
  return raw;
}

/** Correcciones a los datos recordados: "entrega: Av. …", "fiscal: …", "contacto: …", "agencia: …" (una por línea o separadas por ;). */
export function parseClientCorrections(text: string): Partial<Record<ClientField, string>> | null {
  const out: Partial<Record<ClientField, string>> = {};
  const keys: [RegExp, ClientField][] = [
    [/^(?:direcci[oó]n\s+)?fiscal$/i, "direccionFiscal"],
    [/^(?:direcci[oó]n\s+(?:de\s+)?)?entrega$/i, "direccionEntrega"],
    [/^(?:persona\s+de\s+)?contacto$/i, "contacto"],
    [/^agencia$/i, "agencia"],
  ];
  for (const seg of text.split(/\n|;/)) {
    const m = seg.match(/^\s*([^:]{3,30}):\s*(.+)$/);
    if (!m) continue;
    const key = keys.find(([re]) => re.test(m[1].trim()))?.[1];
    if (key) out[key] = m[2].trim();
  }
  return Object.keys(out).length ? out : null;
}

export interface AnswerResult {
  answers: OrderAnswers;
  /** Respuesta que no se entendió: se responde esto y se repite la pregunta. */
  error?: string;
}

/** Aplica la respuesta a la pregunta `q`. */
export function applyOrderAnswer(a: OrderAnswers, q: Question, text: string, ctx: QuestionContext, now: Date): AnswerResult {
  const next: OrderAnswers = { ...a, cliente: { ...a.cliente }, clienteListo: [...a.clienteListo] };
  const useDefault = isDefaultAnswer(text) || (q.field !== "enllante" && q.field !== "marcado" && /^(?:si|sí)$/i.test(text.trim()) && q.def !== undefined);
  const raw = text.trim();
  const done = (f: ClientField) => {
    if (!next.clienteListo.includes(f)) next.clienteListo.push(f);
  };
  switch (q.field) {
    case "cliente": {
      const p = ctx.profile;
      const take = () => {
        for (const f of rememberedClientFields(p)) {
          if (f === "agencia") Object.assign(next.cliente, { agencia: p.agencia, agenciaContacto: p.agenciaContacto, agenciaTelefono: p.agenciaTelefono });
          else next.cliente[f] = p[f];
          done(f);
        }
      };
      if (useDefault) {
        take();
        next.clienteConfirmado = true;
        return { answers: next };
      }
      const fix = parseClientCorrections(raw);
      if (!fix) return { answers: a, error: "No entendí qué cambia. Escríbelo así: *entrega: Av. Los Álamos 123, Ate* (o *igual*)." };
      take();
      for (const [f, v] of Object.entries(fix) as [ClientField, string][]) {
        if (f === "agencia") Object.assign(next.cliente, { agencia: undefined, agenciaContacto: undefined, agenciaTelefono: undefined }, parseAgencia(v));
        else next.cliente[f] = v;
        done(f);
      }
      next.clienteConfirmado = true;
      return { answers: next };
    }
    case "direccionFiscal":
    case "direccionEntrega":
    case "contacto": {
      const v = useDefault ? q.def : raw;
      if (!v) return { answers: a, error: "Necesito ese dato para el pedido." };
      next.cliente[q.field] = v;
      done(q.field);
      return { answers: next };
    }
    case "agencia":
      Object.assign(next.cliente, parseAgencia(raw));
      done("agencia");
      return { answers: next };
    case "fechaEntrega": {
      if (useDefault && !q.def) return { answers: a, error: "No tengo una fecha anterior de este cliente." };
      next.fechaEntrega = useDefault ? q.def : parseFechaEntrega(raw, now);
      return { answers: next };
    }
    case "enllante":
    case "marcado": {
      const v = useDefault && q.def ? (q.def as "SI" | "NO") : parseSiNo(raw);
      if (!v) return { answers: a, error: "Responde *sí* o *no*." };
      next[q.field] = v;
      return { answers: next };
    }
    case "flete": {
      if (useDefault && !q.def) return { answers: a, error: "Dime quién paga el flete: *cliente*, *360* o *agencia*." };
      const f = parseFlete(useDefault ? q.def! : raw);
      next.flete = f.flete;
      next.valorFlete = f.valorFlete;
      return { answers: next };
    }
    case "plazoCredito": {
      if (useDefault) {
        if (q.def === undefined) return { answers: a, error: "Dime el plazo: *30*, *45 días* o *contado*." };
        next.plazoCreditoDias = Number(q.def);
        next.plazoEscrito = false;
        return { answers: next };
      }
      const d = parsePlazo(raw);
      if (d === null) return { answers: a, error: "No entendí el plazo. Escribe los días (*45*) o *contado*." };
      next.plazoCreditoDias = d;
      next.plazoEscrito = true;
      return { answers: next };
    }
    case "proveedor": {
      if (useDefault && !q.def) return { answers: a, error: "Dime las condiciones de pago del proveedor y dónde se recoge." };
      const pr = parseProveedor(useDefault ? q.def! : raw);
      next.pagoProveedor = pr.pagoProveedor ?? "";
      next.recojo = pr.recojo;
      return { answers: next };
    }
    case "observaciones": {
      if (useDefault && q.def) next.observaciones = q.def;
      else next.observaciones = NONE.has(norm(raw)) || isDefaultAnswer(raw) ? "" : raw;
      return { answers: next };
    }
  }
}

/** Respuestas -> bloque de entrega del Excel. */
export function entregaFromAnswers(a: OrderAnswers): PedidoEntrega {
  return {
    fecha: a.fechaEntrega || undefined,
    enllante: a.enllante,
    marcado: a.marcado,
    flete: a.flete,
    valorFlete: a.valorFlete,
    pagoProveedor: a.pagoProveedor || undefined,
    recojo: a.recojo,
  };
}

/** Memoria nueva del cliente: datos del cliente + últimas respuestas (fecha como se escribió o la fecha exacta). */
export function profileFromAnswers(prev: OrderProfile, a: OrderAnswers): OrderProfile {
  const c = a.cliente;
  const keep = <T>(v: T | undefined, old: T | undefined) => (v !== undefined ? v : old);
  return {
    direccionFiscal: keep(c.direccionFiscal, prev.direccionFiscal),
    direccionEntrega: keep(c.direccionEntrega, prev.direccionEntrega),
    contacto: keep(c.contacto, prev.contacto),
    agencia: keep(c.agencia, prev.agencia),
    agenciaContacto: c.agencia !== undefined ? c.agenciaContacto : prev.agenciaContacto,
    agenciaTelefono: c.agencia !== undefined ? c.agenciaTelefono : prev.agenciaTelefono,
    last: {
      ...prev.last,
      fechaEntrega: keep(a.fechaEntrega, prev.last?.fechaEntrega),
      enllante: keep(a.enllante, prev.last?.enllante),
      marcado: keep(a.marcado, prev.last?.marcado),
      flete: keep(a.flete, prev.last?.flete),
      valorFlete: a.flete !== undefined ? a.valorFlete : prev.last?.valorFlete,
      pagoProveedor: a.pagoProveedor !== undefined ? a.pagoProveedor : prev.last?.pagoProveedor,
      recojo: a.pagoProveedor !== undefined ? a.recojo : prev.last?.recojo,
      observaciones: keep(a.observaciones, prev.last?.observaciones),
    },
  };
}

/** Fecha de entrega para mostrar: "20/11/2026" o el texto. */
export function fechaEntregaLabel(v: string | undefined): string {
  if (!v) return "—";
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : v;
}
