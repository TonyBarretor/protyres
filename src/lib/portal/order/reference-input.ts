/**
 * Datos de entrada del pedido sacados del propio pedido de referencia del vendedor (data/referencia-360tyres, fuera de
 * git) y de las líneas de la cotización en formato Prosegur: así las pruebas de comparación no copian datos del cliente
 * al repo. Solo lo usan las pruebas y el CLI de ejemplos (corrida H, punto 3).
 */
import type ExcelJS from "exceljs";
import type { PedidoData, PedidoItem } from "./pedido-xlsx";

const str = (ws: ExcelJS.Worksheet, a: string): string => {
  const v = ws.getCell(a).value;
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object" && "result" in v) {
    const r = (v as { result?: unknown }).result;
    return r instanceof Date ? r.toISOString().slice(0, 10) : String(r ?? "");
  }
  return String(v);
};
const after = (s: string, prefix: RegExp) => s.replace(prefix, "").trim();

/** Una línea de la cotización en formato Prosegur (filas 19..29: UB, descripción, cantidad, precio sin IGV). */
export interface ProsegurLine {
  ub: string;
  descripcion: string;
  cantidad: number;
  precio: number;
  sucursal: string;
}

export function prosegurLines(ws: ExcelJS.Worksheet): ProsegurLine[] {
  const out: ProsegurLine[] = [];
  for (let r = 19; r <= 29; r++) {
    const desc = str(ws, `F${r}`);
    if (!desc) continue;
    out.push({ ub: str(ws, `C${r}`), descripcion: desc, cantidad: Number(str(ws, `G${r}`)), precio: Number(str(ws, `K${r}`)), sucursal: str(ws, `B${r}`) });
  }
  return out;
}

/**
 * El pedido de la referencia como datos: cabecera de la hoja; ítems = las líneas de la cotización (sin agrupar, con su
 * UB), con medida / marca / modelo de los bloques de la referencia y `ubFix` para corregir una UB (la 1811 -> 1911).
 */
export function pedidoFromReference(ref: ExcelJS.Worksheet, lines: ProsegurLine[], ubFix: Record<string, string> = {}): PedidoData {
  const products: { desc: string; medida: string; marca: string; modelo: string }[] = [];
  for (let top = 28; str(ref, `C${top}`).startsWith("SOBRE EL DETALLE"); top += 13) {
    const medida = str(ref, `G${top + 5}`);
    const marca = str(ref, `G${top + 6}`);
    const modelo = str(ref, `G${top + 7}`);
    products.push({ desc: `${medida} ${marca} ${modelo}`.toUpperCase(), medida, marca, modelo });
  }
  const items: PedidoItem[] = lines.map((l) => {
    const p = products.find((x) => x.desc === l.descripcion.toUpperCase());
    if (!p) throw new Error(`Producto sin bloque en la referencia: ${l.descripcion}`);
    return { cantidad: l.cantidad, medida: p.medida, marca: p.marca, modelo: p.modelo, precioUnitarioSinIgv: l.precio, igvPct: 18, ubs: [ubFix[l.ub] ?? l.ub], sucursal: l.sucursal };
  });
  return {
    fecha: str(ref, "G4"),
    atc: str(ref, "G5"),
    cliente: {
      razonSocial: str(ref, "G6"),
      ruc: str(ref, "G7"),
      direccionFiscal: str(ref, "G8"),
      direccionEntrega: str(ref, "G9"),
      contacto: str(ref, "G14"),
    },
    plazoCredito: str(ref, "G11"),
    items,
    entrega: { fecha: str(ref, "G10"), enllante: str(ref, "G12"), marcado: str(ref, "G13"), flete: str(ref, "G15"), valorFlete: after(str(ref, "J15"), /^VALOR FLETE:\s*/i) },
    observaciones: after(str(ref, "C27"), /^Observaciones:\s*/i),
    observacionesTerceros: after(str(ref, "C39"), /^Observaciones:\s*/i),
  };
}
