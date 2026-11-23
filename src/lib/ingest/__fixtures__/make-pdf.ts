/**
 * PDF mínimo para pruebas: textos sueltos en posiciones fijas (Helvetica, una página A4). Sirve para armar un reporte de
 * stock inventado con las columnas donde las pone el de Odoo (las X importan: el lector asigna cada número a su almacén
 * por la columna del encabezado). Nada de datos reales: el PDF real queda fuera de git.
 */
export interface PdfText {
  x: number;
  y: number;
  text: string;
  size?: number;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** Latin-1 para los acentos (WinAnsiEncoding). */
function latin1(s: string): string {
  return Buffer.from(s, "latin1").toString("latin1");
}

export function makePdf(texts: PdfText[]): Buffer {
  const content = texts.map((t) => `BT /F1 ${t.size ?? 6} Tf ${t.x.toFixed(1)} ${t.y.toFixed(1)} Td (${esc(latin1(t.text))}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.32 841.92] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Columnas del reporte de stock de Odoo con almacenes (X de inicio de cada encabezado, como en el real). */
export const STOCK_COLUMNS = { codigo: 52.1, medida: 83.5, marca: 227.3, modelo: 272.7, sanLuis: 336.9, callao: 402.4, reserva: 457.9 };

export interface StockFixtureRow {
  codigo: string;
  medida: string;
  marca?: string;
  modelo?: string;
  sanLuis?: number;
  callao?: number;
  reserva?: number;
}

/** Reporte de stock inventado con el diseño del de Odoo: encabezado de 7 columnas y números alineados bajo su almacén. */
export function makeStockPdf(rows: StockFixtureRow[]): Buffer {
  const c = STOCK_COLUMNS;
  const texts: PdfText[] = [
    { x: c.codigo, y: 781.5, text: "CÓDIGO" },
    { x: c.medida, y: 781.5, text: "MEDIDA" },
    { x: c.marca, y: 781.5, text: "MARCA" },
    { x: c.modelo, y: 781.5, text: "MODELO" },
    { x: c.sanLuis, y: 781.5, text: "DISPON. ALMACEN SAN LUIS" },
    { x: c.callao, y: 781.5, text: "DISPON. ALMACEN CALLAO" },
    { x: c.reserva, y: 781.5, text: "RESERVA" },
  ];
  // los números van centrados bajo su encabezado (como en el real: 361,5 bajo SAN LUIS, 424,8 bajo CALLAO)
  const num = (n: number, start: number, headerWidth: number) => start + headerWidth / 2 - String(n).length * 1.7;
  rows.forEach((r, i) => {
    const y = 774.1 - i * 7.5;
    texts.push({ x: c.codigo, y, text: r.codigo }, { x: c.medida, y, text: r.medida });
    if (r.marca) texts.push({ x: c.marca, y, text: r.marca });
    if (r.modelo) texts.push({ x: c.modelo, y, text: r.modelo });
    if (r.sanLuis !== undefined) texts.push({ x: num(r.sanLuis, c.sanLuis, 52.3), y, text: String(r.sanLuis) });
    if (r.callao !== undefined) texts.push({ x: num(r.callao, c.callao, 50), y, text: String(r.callao) });
    if (r.reserva !== undefined) texts.push({ x: num(r.reserva, c.reserva, 16.9), y, text: String(r.reserva) });
  });
  return makePdf(texts);
}
