/**
 * Corrida K — textos de Match Venta en lenguaje del vendedor: desglose en una línea, insignia "Ya te compró esta medida",
 * motivo de una visita, "podría llevar ~N", estado de la empresa (Cliente / Prospecto / Tuya / Sin dueño).
 */
import type { MatchPurchase, MatchTipo } from "../store/types";

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** "marzo" (mismo año que `now`) o "marzo de 2025". */
export function monthText(iso: string, now: Date = new Date()): string {
  const [y, m] = iso.split("-").map(Number);
  const nowY = Number(now.toLocaleString("en-CA", { timeZone: "America/Lima", year: "numeric" }));
  return y === nowY ? MESES[m - 1] : `${MESES[m - 1]} de ${y}`;
}

const int = (n: number) => Math.round(n).toLocaleString("es-PE");

export function historialText(compro: boolean, cliente: boolean): string {
  return compro ? "ya te compró esta medida" : cliente ? "cliente de otras medidas" : "aún no es cliente";
}

/** "92% de su flota usa 12R22.5 · 368 llantas en piso · aún no es cliente" (siempre una línea). */
export function desgloseLine(o: { tipo: MatchTipo; medida: string; share: number; llantas: number; minLlantas: number; historial: string; aplicacion?: string }): string {
  const parts: string[] = [];
  if (o.tipo === "migracion") parts.push(`${Math.round(o.share * 100)}% de su flota usa ${o.medida} (podría migrar)`);
  else if (o.share > 0) parts.push(`${Math.round(o.share * 100)}% de su flota usa ${o.medida}`);
  else parts.push(`su flota no muestra ${o.medida}`);
  if (o.llantas > 0) parts.push(o.llantas < o.minLlantas ? `${int(o.llantas)} llantas en piso (pocas)` : `${int(o.llantas)} llantas en piso`);
  parts.push(o.historial);
  if (o.aplicacion) parts.push(o.aplicacion);
  return parts.join(" · ");
}

function money(n: number, moneda: MatchPurchase["moneda"]): string {
  const v = n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return moneda === "USD" ? `US$ ${v}` : moneda === "PEN" ? `S/ ${v}` : v;
}

/**
 * Insignia "Ya te compró esta medida": "Ya te compró 40 · última: marzo (12) · US$ 245,00 · margen 18,5% · ya le tocaría
 * reponer (compra cada ~60 días)".
 */
export function purchaseText(c: MatchPurchase, now: Date = new Date()): string {
  const parts = [`Ya te compró ${int(c.cantidad)}${c.mismoProducto ? " (este mismo producto)" : ""}`, `última: ${monthText(c.ultimaFecha, now)} (${int(c.ultimaCantidad)})`];
  if (c.precioUnitario !== null) parts.push(`a ${money(c.precioUnitario, c.moneda)}`);
  if (c.margenPct !== null) parts.push(`margen ${c.margenPct.toLocaleString("es-PE")}%`);
  if (c.reponer) parts.push(c.ritmoDias ? `ya le tocaría reponer (compra cada ~${c.ritmoDias} días)` : "ya le tocaría reponer");
  return parts.join(" · ");
}

/** "podría llevar ~24" */
export function podriaLlevarText(n: number | null): string {
  return n && n > 0 ? `podría llevar ~${int(n)}` : "";
}

/** Motivo de la visita: "ofrecer 295/80R22.5 Fenixway Flama 66: ya te compró 40 en marzo". */
export function visitReason(productLabel: string, compra: MatchPurchase | undefined, desglose: string | undefined, now: Date = new Date()): string {
  if (compra) return `ofrecer ${productLabel}: ya te compró ${int(compra.cantidad)} en ${monthText(compra.ultimaFecha, now)}`;
  const first = desglose?.split(" · ")[0];
  return first ? `ofrecer ${productLabel}: ${first}` : `ofrecer ${productLabel}`;
}

export type MatchEstado = "Cliente" | "Prospecto" | "Tuya" | "Sin dueño";

/** Etiqueta de estado de la tarjeta (para quien la mira). */
export function estadoLabel(r: { ownerUserId: number | null; esCliente: boolean; yaCompro?: boolean }, viewerId: number): MatchEstado {
  if (r.ownerUserId !== null && r.ownerUserId === viewerId) return "Tuya";
  if (r.esCliente || r.yaCompro) return "Cliente";
  if (r.ownerUserId === null) return "Sin dueño";
  return "Prospecto";
}
