/**
 * Corrida H, punto 6: contraste entre documentos antes de armar el pedido. Compara lo que se va a pedir (los ítems
 * escritos, o las líneas de la OC si llegó como Excel) con la cotización enlazada: producto, cantidad total por
 * producto, precio y lista de UB. Puro.
 *
 * Caso real: en el Excel con formato Prosegur de la cotización 471 la tercera línea dice UB 1811, mientras que el PDF y
 * los nombres de archivo dicen 1911 -> "UB 1811 está en la OC pero no en la cotización; UB 1911 está en la cotización
 * pero no en la OC".
 */
import type ExcelJS from "exceljs";
import { r2 } from "../../quote/pricing";
import { fold } from "../../tyre/brands";

export interface CheckLine {
  /** "215/75R17.5 18PR FENIXWAY VALOR 99" */
  producto: string;
  cantidad: number;
  /** Precio unitario sin IGV (el de la cotización). */
  precio?: number;
  ub?: string;
}

const key = (p: string) => fold(p).replace(/\s+/g, " ").trim();

/** Diferencias legibles (vacío = coinciden). `a` = lo que se va a pedir (OC), `b` = la cotización. */
export function crossCheck(a: CheckLine[], b: CheckLine[], labels = { a: "la OC", b: "la cotización" }): string[] {
  const out: string[] = [];
  const group = (ls: CheckLine[]) => {
    const m = new Map<string, { producto: string; cantidad: number; precios: Set<number> }>();
    for (const l of ls) {
      const k = key(l.producto);
      const g = m.get(k) ?? { producto: l.producto.toUpperCase(), cantidad: 0, precios: new Set<number>() };
      g.cantidad += l.cantidad;
      if (l.precio != null) g.precios.add(r2(l.precio));
      m.set(k, g);
    }
    return m;
  };
  const ga = group(a);
  const gb = group(b);
  for (const [k, x] of ga) {
    const y = gb.get(k);
    if (!y) {
      out.push(`*${x.producto}* (${x.cantidad}) está en ${labels.a} pero no en ${labels.b}.`);
      continue;
    }
    if (x.cantidad !== y.cantidad) out.push(`*${x.producto}*: ${x.cantidad} en ${labels.a} y ${y.cantidad} en ${labels.b}.`);
    const pa = [...x.precios].sort((p, q) => p - q);
    const pb = [...y.precios].sort((p, q) => p - q);
    if (pa.length && pb.length && pa.join() !== pb.join()) out.push(`*${x.producto}*: precio ${pa.join(" / ")} en ${labels.a} y ${pb.join(" / ")} en ${labels.b}.`);
  }
  for (const [k, y] of gb) if (!ga.has(k)) out.push(`*${y.producto}* (${y.cantidad}) está en ${labels.b} pero no en ${labels.a}.`);
  const ubs = (ls: CheckLine[]) => [...new Set(ls.map((l) => l.ub?.trim()).filter((u): u is string => !!u))];
  const ua = ubs(a);
  const ub = ubs(b);
  if (ua.length && ub.length) {
    const onlyA = ua.filter((u) => !ub.includes(u));
    const onlyB = ub.filter((u) => !ua.includes(u));
    if (onlyA.length) out.push(`UB ${onlyA.join(", ")} está en ${labels.a} pero no en ${labels.b}.`);
    if (onlyB.length) out.push(`UB ${onlyB.join(", ")} está en ${labels.b} pero no en ${labels.a}.`);
    // misma UB con otro producto o cantidad
    for (const u of ua.filter((x) => ub.includes(x))) {
      const la = a.filter((l) => l.ub?.trim() === u).map((l) => `${l.cantidad} ${key(l.producto)}`).sort().join("; ");
      const lb = b.filter((l) => l.ub?.trim() === u).map((l) => `${l.cantidad} ${key(l.producto)}`).sort().join("; ");
      if (la !== lb) out.push(`UB ${u}: lo de ${labels.a} no es lo de ${labels.b}.`);
    }
  }
  return out;
}

const cellText = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ("result" in v) return String(v.result ?? "");
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return String(v.text);
  }
  return String(v);
};

/**
 * Líneas de una OC / cotización en Excel con columnas UB · Descripción · Cantidad · P. Unitario (el formato de Prosegur
 * "GESTIÓN DE FLOTA CASH – COTIZACIÓN PROVEEDORES" y parecidos): la fila de encabezados se busca por sus textos. [] si
 * la hoja no tiene esa forma.
 */
export function linesFromSheet(ws: ExcelJS.Worksheet): CheckLine[] {
  for (let r = 1; r <= Math.min(ws.rowCount, 60); r++) {
    const cols: Partial<Record<"ub" | "desc" | "qty" | "price", number>> = {};
    ws.getRow(r).eachCell((c, col) => {
      const t = fold(cellText(c.value));
      if (/^ub$|^unidad blindada$/.test(t)) cols.ub ??= col;
      else if (/^descripcion/.test(t)) cols.desc ??= col;
      else if (/^cantidad$|^cant$/.test(t)) cols.qty ??= col;
      else if (/^p unitario|^precio unit/.test(t)) cols.price ??= col;
    });
    if (cols.desc === undefined || cols.qty === undefined) continue;
    const out: CheckLine[] = [];
    for (let i = r + 1; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);
      const producto = cellText(row.getCell(cols.desc).value).trim();
      const cantidad = Number(cellText(row.getCell(cols.qty).value));
      if (!producto || !(cantidad > 0)) {
        if (!producto) continue;
        break;
      }
      const precio = cols.price !== undefined ? Number(cellText(row.getCell(cols.price).value)) : NaN;
      const ub = cols.ub !== undefined ? cellText(row.getCell(cols.ub).value).trim() : "";
      out.push({ producto, cantidad, ...(Number.isFinite(precio) && precio > 0 ? { precio } : {}), ...(ub ? { ub } : {}) });
    }
    return out;
  }
  return [];
}
