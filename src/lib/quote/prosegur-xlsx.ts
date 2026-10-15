/**
 * Prosegur's own quote format: the client's "Formato Proveedores" (GESTIÓN DE FLOTA CASH – COTIZACIÓN PROVEEDORES,
 * FCRP 31/07/2023) filled in from the quote. The template (config/templates/prosegur-cotizacion.xlsx) is loaded with
 * ExcelJS and only values are written, so its logo, boxes, merged cells, widths, fills, fonts and notes stay as they are.
 *
 *   E1  Nombre de Archivo: 151026-1830-AYACUCHO-PROFESSIONAL TYRES S.A.C.-451
 *   C5  supplier            G5  quote number (451)      K5  requester (solicitante)
 *   C6  supplier RUC        G6  unit (unidad atendida)  K6  quote date
 *   rows 19..29  Item · Ubicación · UB · Código · Sistema · Descripción · Cantidad · UM · Tipo · Moneda · P. Unitario · P. Total SIN IGV
 *   L30..L32     Sub Total / I.G.V. / Total (the template's formulas, with their values filled in)
 *
 * Prices are net of IGV (QuoteItem.unitPrice): the format's own totals add the IGV.
 */
import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import sharp from "sharp";
import type { CustomerProfile, Settings } from "../settings";
import { quoteSerial } from "./build";
import { cleanFileName, withExtension } from "./files";
import { r2 } from "./pricing";
import type { Quote, QuoteItem } from "./types";

export const PROSEGUR_MAX_ITEMS = 11;
const FIRST_ITEM_ROW = 19;
const ITEM_COLUMNS = "ABCDEFGHIJKL";
/** Service boxes (Reporte, Diagnóstico, dates and hours of the service, V.B., técnicos and DNI) stay blank. */
const SERVICE_CELLS = ["C8", "C9", "D11", "G11", "K11", "D12", "G12", "K12", "E14", "E15", "E16", "H14", "H15", "H16"];

export function prosegurTooManyItems(count: number): string {
  return `El formato de Prosegur tiene ${PROSEGUR_MAX_ITEMS} filas de ítems y esta cotización tiene ${count}. Quita ítems (*quitar ${count}*) o divídela en dos cotizaciones.`;
}

/** "151026-1830-AYACUCHO-PROFESSIONAL TYRES S.A.C.-451.xlsx" (the profile's pattern), or the name set with "archivo excel: …". */
export function prosegurFileName(quote: Quote, settings: Settings, profile: CustomerProfile): string {
  if (quote.files?.xlsxName) return withExtension(quote.files.xlsxName, ".xlsx");
  const [y, m, d] = quote.date.split("-");
  const serial = quoteSerial(quote.number, settings.quote.numberFormat);
  const name = (profile.excel?.fileName ?? "{DDMMYY}-{UB}-{UNIDAD}-{PROVEEDOR}-{N}")
    .replace("{DDMMYY}", `${d}${m}${y.slice(2)}`)
    .replace("{UB}", quote.ub ?? quote.items.find((i) => i.ub)?.ub ?? "")
    .replace("{UNIDAD}", (quote.unit ?? "").toUpperCase())
    .replace("{PROVEEDOR}", supplierName(settings, profile))
    .replace("{N}", serial !== undefined ? String(serial) : quote.number)
    .replace(/-{2,}/g, "-") // a missing part leaves no empty slot
    .replace(/^-+|-+$/g, "");
  return withExtension(cleanFileName(name), ".xlsx");
}

function supplierName(settings: Settings, profile: CustomerProfile): string {
  return profile.excel?.supplierName || settings.company.name.toUpperCase();
}

const isRim = (it: QuoteItem) => it.application === "ARO" || /^(?:llanta\s+)?aros?\b/i.test(it.description);

/** Sistema column: LLANTAS, AROS or ACCESORIOS. */
export function prosegurSystem(it: QuoteItem): string {
  return isRim(it) ? "AROS" : it.size ? "LLANTAS" : "ACCESORIOS";
}

/** Descripción column: "215/75R17.5 18PR FENIXWAY VALOR 99" (size, ply or load index, brand, model); other items: their description. */
export function prosegurDescription(it: QuoteItem): string {
  if (!it.size || isRim(it)) return it.description.toUpperCase();
  const size = `${it.sizeDisplay || it.size}${it.ply ? ` ${it.ply}PR` : it.loadIndex ? ` ${it.loadIndex}${it.speedIndex ?? ""}` : ""}`;
  return [size, it.brand, it.model].filter(Boolean).join(" ").replace(/\s+/g, " ").toUpperCase();
}

/** "1830" -> 1830 (a number, as the client types it); codes with a leading zero stay text. */
function numberIfNumeric(v: string | undefined): string | number | null {
  if (!v) return null;
  return /^[1-9]\d{0,14}$/.test(v) ? Number(v) : v;
}

export async function renderProsegurXlsx(quote: Quote, settings: Settings, profile: CustomerProfile): Promise<{ buffer: Buffer; fileName: string }> {
  const x = profile.excel;
  if (!x?.template) throw new Error(`El cliente ${profile.name} no tiene plantilla Excel (config/customers.json → excel.template).`);
  if (quote.items.length > PROSEGUR_MAX_ITEMS) throw new Error(prosegurTooManyItems(quote.items.length));
  const templatePath = path.isAbsolute(x.template) ? x.template : path.join(process.cwd(), x.template);
  if (!fs.existsSync(/* turbopackIgnore: true */ templatePath)) throw new Error(`No encuentro la plantilla de ${profile.name}: ${x.template}`);
  const template = fs.readFileSync(/* turbopackIgnore: true */ templatePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(template as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  await keepLogo(wb, ws, template);
  keepConditionalFormats(ws, template);

  const fileName = prosegurFileName(quote, settings, profile);
  const unit = (quote.unit ?? "").toUpperCase();
  const serial = quoteSerial(quote.number, settings.quote.numberFormat);
  const [y, m, d] = quote.date.split("-").map(Number);

  ws.getCell("E1").value = `Nombre de Archivo: ${fileName.replace(/\.xlsx$/i, "")}`;
  ws.getCell("C5").value = supplierName(settings, profile);
  ws.getCell("C6").value = numberIfNumeric((x.supplierRuc || settings.company.taxId).replace(/\D/g, ""));
  ws.getCell("G5").value = serial ?? quote.number;
  ws.getCell("G6").value = unit || null;
  ws.getCell("K5").value = (quote.requester ?? "").toUpperCase() || null;
  ws.getCell("K6").value = new Date(Date.UTC(y, m - 1, d)); // replaces =TODAY(); the cell keeps its date format
  for (const a of SERVICE_CELLS) ws.getCell(a).value = null;

  let subtotal = 0;
  for (let i = 0; i < PROSEGUR_MAX_ITEMS; i++) {
    const r = FIRST_ITEM_ROW + i;
    for (const col of ITEM_COLUMNS) ws.getCell(`${col}${r}`).value = null; // row 19 holds the template's sample item
    const it = quote.items[i];
    if (!it) continue;
    const total = r2(it.unitPrice * it.quantity);
    subtotal = r2(subtotal + total);
    const values: [string, ExcelJS.CellValue][] = [
      ["A", i + 1],
      ["B", unit || null],
      ["C", numberIfNumeric(it.ub ?? quote.ub)],
      ["E", prosegurSystem(it)],
      ["F", prosegurDescription(it)],
      ["G", it.quantity],
      ["H", "UNI"],
      ["I", "REPUESTO"],
      ["J", quote.currency],
      ["K", it.unitPrice], // net of IGV
      ["L", { formula: `+K${r}*G${r}`, result: total }],
    ];
    for (const [col, v] of values) ws.getCell(`${col}${r}`).value = v;
  }

  // the template's totals formulas stay; their values are filled in for viewers that do not recalculate (WhatsApp, phones)
  const igv = r2(subtotal * 0.18);
  setFormulaResult(ws.getCell("L30"), "SUM(L19:L29)", subtotal);
  setFormulaResult(ws.getCell("L31"), "SUM(L30*18/100)", igv);
  setFormulaResult(ws.getCell("L32"), "SUM(L30:L31)", r2(subtotal + igv));
  wb.calcProperties.fullCalcOnLoad = true;

  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), fileName };
}

function setFormulaResult(cell: ExcelJS.Cell, fallback: string, result: number): void {
  const v = cell.value as ExcelJS.CellFormulaValue | null;
  cell.value = { formula: v && typeof v === "object" && "formula" in v && v.formula ? v.formula : fallback, result };
}

// ---------- template fidelity: what ExcelJS does not carry over by itself ----------

/** One entry of a .xlsx (zip) file, read from its central directory. */
export function readZipEntry(zip: Buffer, name: string): Buffer | null {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && p + 46 <= zip.length; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    if (zip.subarray(p + 46, p + 46 + nameLen).toString("utf8") === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/**
 * The Prosegur logo is anchored at A1 with a crop (<a:srcRect>) and a thin outline (<a:ln>) that ExcelJS drops when it
 * writes the picture back; the same crop and outline are applied to the image bytes so the logo looks as in the template.
 * If ExcelJS lost the picture altogether, the template's image is put back at A1.
 */
async function keepLogo(wb: ExcelJS.Workbook, ws: ExcelJS.Worksheet, template: Buffer): Promise<void> {
  const images = ws.getImages();
  if (images.length === 0) {
    const png = readZipEntry(template, "xl/media/image1.png");
    if (!png) return;
    const id = wb.addImage({ buffer: png as unknown as ExcelJS.Buffer, extension: "png" });
    ws.addImage(id, { tl: { col: 0, row: 0 }, ext: { width: 470, height: 154 } });
    return;
  }
  const drawing = readZipEntry(template, "xl/drawings/drawing1.xml")?.toString("utf8");
  const media = wb.getImage(Number(images[0].imageId)) as unknown as { buffer?: Buffer } | undefined;
  if (!drawing || !media?.buffer) return;
  media.buffer = await applyDrawingLook(Buffer.from(media.buffer), drawing);
}

/** Crop (srcRect, in 1/1000 %) and outline (a:ln width in EMU, relative to the picture's width) baked into the image. */
async function applyDrawingLook(image: Buffer, drawingXml: string): Promise<Buffer> {
  const src = drawingXml.match(/<a:srcRect\b([^>]*)\/?>/)?.[1] ?? "";
  const frac = (k: string) => Math.max(0, Number(src.match(new RegExp(`\\b${k}="(-?\\d+)"`))?.[1] ?? 0)) / 100000;
  const meta = await sharp(image).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) return image;
  const left = Math.round(W * frac("l"));
  const top = Math.round(H * frac("t"));
  const width = W - left - Math.round(W * frac("r"));
  const height = H - top - Math.round(H * frac("b"));
  let img = sharp(image);
  if ((left || top || width < W || height < H) && width > 0 && height > 0) img = img.extract({ left, top, width, height });
  const line = drawingXml.match(/<a:ln\b[^>]*\bw="(\d+)"[^>]*>([\s\S]*?)<\/a:ln>/);
  const boxWidth = Number(drawingXml.match(/<a:xfrm>[\s\S]*?<a:ext cx="(\d+)"/)?.[1] ?? 0);
  if (line && /<a:solidFill>/.test(line[2]) && boxWidth > 0) {
    const px = Math.max(1, Math.round((Number(line[1]) / boxWidth) * (width > 0 ? width : W)));
    img = img.extend({ top: px, bottom: px, left: px, right: px, background: { r: 0, g: 0, b: 0, alpha: 1 } });
  }
  return img.png().toBuffer();
}

/**
 * The template flags a "/" in Descripción (and in A18) in red with "containsText" rules. ExcelJS writes them without
 * their text/operator (LibreOffice then ignores them) and turns <i val="0"/> into italics; the rules are written as the
 * equivalent formula rules, without italics, so every viewer shows them as the template does.
 */
function keepConditionalFormats(ws: ExcelJS.Worksheet, template: Buffer): void {
  const cfs = (ws as unknown as { conditionalFormattings?: { rules: Record<string, unknown>[] }[] }).conditionalFormattings ?? [];
  const styles = readZipEntry(template, "xl/styles.xml")?.toString("utf8") ?? "";
  const dxfs = styles.match(/<dxfs\b[\s\S]*?<\/dxfs>/)?.[0] ?? "";
  const notItalic = /<i val="0"\/>/.test(dxfs) && !/<i\/>|<i val="1"\/>/.test(dxfs);
  for (const cf of cfs) {
    for (const rule of cf.rules) {
      if (rule.type === "containsText" && Array.isArray(rule.formulae) && rule.formulae.length) {
        rule.type = "expression";
        delete rule.operator;
      }
      const font = (rule.style as { font?: { italic?: boolean } } | undefined)?.font;
      if (notItalic && font?.italic) font.italic = false;
    }
  }
}
