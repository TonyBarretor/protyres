/**
 * Modelo en el cotizador (corrida E, punto 4): contexto por mensaje y registro de diferencias del modo sombra.
 *
 * QUOTE_LLM_MODE (llm/client.ts quoteLlmMode, por defecto "shadow"):
 *  - off: solo reglas, cero llamadas.
 *  - shadow: el vendedor recibe EXACTAMENTE lo de off (reglas). parseRequest anota en el contexto del mensaje
 *    (`QuoteLlmScope.pending`) la última lectura; DESPUÉS de responder (BotHandler.handle) se llama al modelo con ese
 *    texto (propósito cotizador_sombra, sin avisos al usuario), se aplica la misma validación que en "on" y se guarda la
 *    diferencia por campo (tabla quote_shadow). Una llamada sombra por mensaje como máximo. Fuera de un mensaje (CLI)
 *    no hay contexto: shadow = off.
 *  - on: el modelo refina lo de las reglas, siempre validado (request.ts mergeModelRequest).
 *
 * El contexto también lleva el catálogo (`catalog`: filas de precios por medida) para validar medida, marca y diseño.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { PriceRow } from "../ingest/types";
import type { QuoteRequest } from "./types";

/** Vista compacta de un pedido (lo que se compara y se guarda). */
export interface ShadowLine {
  medida?: string;
  marca?: string;
  diseno?: string;
  cantidad: number;
  precio?: number;
  posicion?: string;
  descripcion?: string;
}
export interface ShadowView {
  items: ShadowLine[];
  cliente?: string;
  contacto?: string;
  correo?: string;
  descuento?: number;
  margen?: number;
  igv?: boolean;
  atencion?: string;
  direccion?: string;
  pago?: string;
  plazo?: string;
  entrega?: string;
  validez?: number;
  unidad?: string;
  ub?: string;
  solicitante?: string;
  notas?: string;
}

/** Una diferencia: campo, ítem (1-based, si es de un ítem) y los dos valores como texto. */
export interface ShadowDiff {
  field: string;
  item?: number;
  rules: string;
  model: string;
}

/** Fila de quote_shadow. `text` es dato de cliente: solo va a la base, nunca a git ni a los logs. */
export interface QuoteShadowEntry {
  phone: string;
  text: string;
  rules: ShadowView;
  /** Lo que habría salido en "on" (ya validado); null si el modelo no respondió algo válido. */
  model: ShadowView | null;
  diffs: ShadowDiff[];
  /** Validaciones que descartaron algo del modelo ("marca inventada: Xyz"…). */
  rejected: string[];
  /** Sin respuesta válida: "invalido", el error de la API, el tope… */
  modelError?: string;
  at?: Date;
}

export interface QuoteShadowRow extends QuoteShadowEntry {
  id: number;
  at: Date;
}

export interface QuoteShadowSink {
  logQuoteShadow(entry: QuoteShadowEntry): Promise<void>;
}

export interface QuoteLlmScope {
  phone: string;
  /** Filas de precios de estas medidas (canónicas): para validar lo que propone el modelo contra el catálogo. */
  catalog?: (canonicals: string[]) => Promise<PriceRow[]>;
  sink?: QuoteShadowSink;
  log?: (msg: string) => void;
  /** shadow: la última lectura de pedido del mensaje (se compara después de responder). */
  pending?: { text: string; base: QuoteRequest };
}

const als = new AsyncLocalStorage<QuoteLlmScope>();

export function runWithQuoteScope<T>(scope: QuoteLlmScope, fn: () => Promise<T>): Promise<T> {
  return als.run(scope, fn);
}

export function currentQuoteScope(): QuoteLlmScope | undefined {
  return als.getStore();
}

const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as T;

export function shadowView(r: QuoteRequest): ShadowView {
  return clean({
    items: r.lines.map((l) =>
      clean({
        medida: l.size?.canonical,
        marca: l.brand,
        diseno: l.model,
        cantidad: l.quantity,
        precio: l.unitPrice,
        posicion: l.position,
        descripcion: l.size ? undefined : (l.text ?? l.raw),
      }),
    ),
    cliente: r.customerCompany,
    contacto: r.customerName,
    correo: r.customerEmail,
    descuento: r.discountPct,
    margen: r.marginPct,
    igv: r.showPricesWithTax,
    atencion: r.attention,
    direccion: r.address,
    pago: r.paymentType,
    plazo: r.paymentTerm,
    entrega: r.deliveryTerm,
    validez: r.validityDays,
    unidad: r.unit,
    ub: r.ub,
    solicitante: r.requester,
    notas: r.notes,
  });
}

const show = (v: unknown): string => (v === undefined || v === null ? "—" : String(v));
const same = (a: unknown, b: unknown): boolean => {
  if (typeof a === "string" && typeof b === "string") return a.trim().toLowerCase() === b.trim().toLowerCase();
  return a === b;
};

/** Diferencias por campo entre lo de las reglas y lo del modelo (validado). */
export function diffViews(rules: ShadowView, model: ShadowView): ShadowDiff[] {
  const out: ShadowDiff[] = [];
  if (rules.items.length !== model.items.length) out.push({ field: "items", rules: String(rules.items.length), model: String(model.items.length) });
  const n = Math.min(rules.items.length, model.items.length);
  for (let i = 0; i < n; i++) {
    const a = rules.items[i];
    const b = model.items[i];
    for (const k of ["medida", "marca", "diseno", "cantidad", "precio", "posicion", "descripcion"] as const) {
      if (!same(a[k], b[k])) out.push({ field: k, item: i + 1, rules: show(a[k]), model: show(b[k]) });
    }
  }
  const keys = new Set([...Object.keys(rules), ...Object.keys(model)].filter((k) => k !== "items"));
  for (const k of keys) {
    const a = rules[k as keyof ShadowView];
    const b = model[k as keyof ShadowView];
    if (!same(a, b)) out.push({ field: k, rules: show(a), model: show(b) });
  }
  return out;
}

// ── resumen para decidir cuándo pasar a "on" (npm run quote:shadow-report) ──

export interface ShadowSummary {
  total: number;
  /** El modelo respondió algo válido. */
  withModel: number;
  /** Con al menos una diferencia de campo con las reglas. */
  differing: number;
  /** Sin respuesta válida, por motivo ("invalido", el error…). */
  errors: { reason: string; count: number }[];
  /** Diferencias por campo (casos con ese campo distinto), de más a menos. */
  byField: { field: string; cases: number }[];
  /** Validaciones que descartaron algo del modelo, por tipo (la primera palabra: marca, medida, cantidad…). */
  byRejection: { kind: string; count: number }[];
}

export function summarizeShadow(rows: QuoteShadowEntry[]): ShadowSummary {
  const fields = new Map<string, number>();
  const rejections = new Map<string, number>();
  const errors = new Map<string, number>();
  let withModel = 0;
  let differing = 0;
  for (const r of rows) {
    if (r.model) withModel++;
    else errors.set(r.modelError ?? "?", (errors.get(r.modelError ?? "?") ?? 0) + 1);
    if (r.diffs.length) differing++;
    for (const f of new Set(r.diffs.map((d) => d.field))) fields.set(f, (fields.get(f) ?? 0) + 1);
    for (const x of r.rejected) {
      const kind = x.split(/[\s:«(]/)[0] || x;
      rejections.set(kind, (rejections.get(kind) ?? 0) + 1);
    }
  }
  const sorted = <K extends string>(m: Map<string, number>, key: K) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => ({ [key]: k, n }) as { [P in K]: string } & { n: number });
  return {
    total: rows.length,
    withModel,
    differing,
    errors: sorted(errors, "reason").map((e) => ({ reason: e.reason, count: e.n })),
    byField: sorted(fields, "field").map((e) => ({ field: e.field, cases: e.n })),
    byRejection: sorted(rejections, "kind").map((e) => ({ kind: e.kind, count: e.n })),
  };
}
