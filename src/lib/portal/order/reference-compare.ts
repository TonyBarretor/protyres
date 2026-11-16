/**
 * Comparación celda por celda de dos hojas "Formato de Pedido" (corrida H, punto 3): valores, fórmulas, estilos (fuente,
 * borde, relleno, alineación, formato numérico), celdas combinadas y alto de filas. La usan las pruebas contra el pedido
 * real del vendedor (data/referencia-360tyres, fuera de git) y contra la plantilla, con 1, 2 y 3 bloques.
 */
import ExcelJS from "exceljs";

export interface CellDiff {
  /** "G29" o "fila 30" (alto) o "merge C41:J41". */
  where: string;
  what: "valor" | "estilo" | "merge" | "alto";
  ours: string;
  ref: string;
}

const norm = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date) return `fecha:${v.toISOString().slice(0, 10)}`;
  if (typeof v === "object") {
    if ("formula" in v || "sharedFormula" in v) {
      const r = (v as { result?: unknown }).result;
      const res = typeof r === "number" ? String(Math.round(r * 100) / 100) : r instanceof Date ? r.toISOString().slice(0, 10) : String(r ?? "");
      return `=${String((v as { formula?: string }).formula ?? "").replace(/^\+/, "")} → ${res}`;
    }
    if ("richText" in v) return v.richText.map((t) => t.text).join("").trimEnd();
    return JSON.stringify(v);
  }
  return String(v).trimEnd();
};

const styleOf = (c: ExcelJS.Cell): string => {
  const s = c.style ?? {};
  const color = (x: unknown) => (x && typeof x === "object" && "argb" in x ? (x as { argb?: string }).argb : x && typeof x === "object" && "theme" in x ? `t${(x as { theme: number }).theme}` : "");
  const b = s.border ?? {};
  const side = (k: keyof ExcelJS.Borders) => {
    const x = (b as Partial<ExcelJS.Borders>)[k];
    return x?.style ? `${k[0]}:${x.style}` : "";
  };
  const f = s.font ?? {};
  const fill = s.fill && "pattern" in s.fill && s.fill.pattern !== "none" ? `${s.fill.pattern}:${color((s.fill as ExcelJS.FillPattern).fgColor)}` : "";
  return [
    `font:${f.name ?? ""}/${f.size ?? ""}${f.bold ? "/b" : ""}${f.italic ? "/i" : ""}/${color(f.color)}`,
    `border:${["left", "right", "top", "bottom"].map((k) => side(k as keyof ExcelJS.Borders)).filter(Boolean).join(",")}`,
    `fill:${fill}`,
    `align:${s.alignment?.horizontal ?? ""}/${s.alignment?.vertical ?? ""}${s.alignment?.wrapText ? "/wrap" : ""}`,
    `fmt:${s.numFmt ?? ""}`,
  ].join(" ");
};

type Merge = { top: number; left: number; bottom: number; right: number };
const mergesOf = (ws: ExcelJS.Worksheet): Merge[] => Object.values((ws as unknown as { _merges: Record<string, { model: Merge }> })._merges).map((m) => m.model);
const col = (n: number) => String.fromCharCode(64 + n);
const mergeName = (m: Merge) => `${col(m.left)}${m.top}:${col(m.right)}${m.bottom}`;

/**
 * Diferencias entre `ours` (filas oursTop..) y `ref` (filas refTop..refBottom), columnas C..K. `ourOffset` = filas que
 * nuestra hoja está desplazada respecto de la referencia en ese tramo (0 = misma fila).
 */
export function compareSheets(ours: ExcelJS.Worksheet, ref: ExcelJS.Worksheet, refTop: number, refBottom: number, ourOffset = 0, opts: { heights?: boolean } = {}): CellDiff[] {
  const out: CellDiff[] = [];
  for (let r = refTop; r <= refBottom; r++) {
    const or = r + ourOffset;
    if (opts.heights) {
      const a = ours.getRow(or).height;
      const b = ref.getRow(r).height;
      if ((a ?? 15) !== (b ?? 15)) out.push({ where: `fila ${or}`, what: "alto", ours: String(a ?? "—"), ref: String(b ?? "—") });
    }
    for (let c = 3; c <= 11; c++) {
      const a = ours.getRow(or).getCell(c);
      const b = ref.getRow(r).getCell(c);
      const slaveA = a.isMerged && a.master !== a;
      const slaveB = b.isMerged && b.master !== b;
      const va = slaveA ? "" : norm(a.formula ? ({ formula: a.formula, result: a.result } as ExcelJS.CellValue) : a.value);
      const vb = slaveB ? "" : norm(b.formula ? ({ formula: b.formula, result: b.result } as ExcelJS.CellValue) : b.value);
      if (va !== vb) out.push({ where: `${col(c)}${or}`, what: "valor", ours: va, ref: vb });
      const sa = styleOf(a);
      const sb = styleOf(b);
      if (sa !== sb) out.push({ where: `${col(c)}${or}`, what: "estilo", ours: sa, ref: sb });
    }
  }
  const inRange = (m: Merge, top: number, bottom: number) => m.top >= top && m.bottom <= bottom;
  const oursM = new Set(mergesOf(ours).filter((m) => inRange(m, refTop + ourOffset, refBottom + ourOffset)).map((m) => mergeName({ ...m, top: m.top - ourOffset, bottom: m.bottom - ourOffset })));
  const refM = new Set(mergesOf(ref).filter((m) => inRange(m, refTop, refBottom)).map(mergeName));
  for (const m of oursM) if (!refM.has(m)) out.push({ where: `merge ${m}`, what: "merge", ours: "sí", ref: "no" });
  for (const m of refM) if (!oursM.has(m)) out.push({ where: `merge ${m}`, what: "merge", ours: "no", ref: "sí" });
  return out;
}

export async function loadPedidoSheet(buffer: Buffer | ArrayBuffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as ArrayBuffer);
  return wb.getWorksheet("Formato de Pedido") ?? wb.worksheets[0];
}
