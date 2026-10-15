/**
 * Sample Prosegur quote: the 360° PDF and the filled "Formato Proveedores" Excel, plus a PNG of the Excel rendered by
 * LibreOffice to check that the template survived (logo, boxes, merged cells, totals).
 *
 *   npx tsx --tsconfig tsconfig.cli.json scripts/prosegur-sample.ts [outDir]      (default ./out)
 *
 * Writes ejemplo-prosegur.xlsx, ejemplo-prosegur-360.pdf and ejemplo-prosegur.png (needs soffice + pdftoppm for the PNG).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { loadSettings } from "../src/lib/settings";
import { buildQuote, formatQuoteNumber, manualItem } from "../src/lib/quote/build";
import { renderQuotePdf } from "../src/lib/quote/pdf";
import { profileDefaultLines, profileId } from "../src/lib/quote/profiles";
import { renderProsegurXlsx } from "../src/lib/quote/prosegur-xlsx";
import { parseRequestRegex } from "../src/lib/quote/request";

process.env.LLM_DISABLED = "1";

async function main() {
  const outDir = path.resolve(process.argv[2] ?? "out");
  fs.mkdirSync(outDir, { recursive: true });
  const settings = loadSettings();
  const profile = settings.customers.find((p) => p.format === "prosegur");
  if (!profile) throw new Error("config/customers.json no tiene el perfil de Prosegur");

  // what the salesman types (prices as he would set them with "precio 1 …")
  let text = `215/75R17.5 18PR FENIXWAY VALOR 99 MIXT x2 UB 1830
215/75R17.5 18PR FENIXWAY VALOR 89 POST x2 UB 1830
unidad: Ayacucho
solicitante: Johann Castañeda
atención: Sr. Johann Castañeda
dirección: Ayacucho`;
  text = `${text}\n${profileDefaultLines(profile, parseRequestRegex(text)).join("\n")}`;
  const req = parseRequestRegex(text);
  const prices = [123.17, 126.5];
  const items = req.lines.map((l, i) => manualItem(l, prices[i], undefined, settings));
  const today = new Date().toISOString().slice(0, 10);
  const quote = buildQuote({ number: formatQuoteNumber(settings.quote.numberFormat, 451, today), request: req, items, settings, today, requestedBy: "51955344340", customerProfile: profileId(profile) });

  const xlsx = await renderProsegurXlsx(quote, settings, profile);
  const xlsxPath = path.join(outDir, "ejemplo-prosegur.xlsx");
  fs.writeFileSync(xlsxPath, xlsx.buffer);
  const pdfPath = path.join(outDir, "ejemplo-prosegur-360.pdf");
  fs.writeFileSync(pdfPath, await renderQuotePdf(quote, settings, { photos: false }));
  console.log(`Cotización ${quote.number} · Excel "${xlsx.fileName}"\n  ${xlsxPath}\n  ${pdfPath}`);

  // Excel -> PDF (LibreOffice) -> PNG, to look at the round trip. The template prints at 35 % on an A4 page, so the
  // page is rendered at 300 dpi and the blank paper around the sheet is trimmed (at 110 dpi the text is unreadable).
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prosegur-"));
    execFileSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", tmp, xlsxPath], { stdio: "ignore", timeout: 120_000 });
    execFileSync("pdftoppm", ["-r", "300", "-png", "-f", "1", "-l", "1", "-singlefile", path.join(tmp, "ejemplo-prosegur.pdf"), path.join(tmp, "page")]);
    const pngPath = path.join(outDir, "ejemplo-prosegur.png");
    await sharp(path.join(tmp, "page.png")).trim({ background: "#ffffff", threshold: 20 }).extend({ top: 30, bottom: 30, left: 30, right: 30, background: "#ffffff" }).png().toFile(pngPath);
    console.log(`  ${pngPath}`);
  } catch (err) {
    console.log(`  (sin PNG: hace falta soffice y pdftoppm — ${(err as Error).message})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
