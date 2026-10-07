/**
 * Load a price list / stock export into the store.
 *
 *   npm run ingest -- "clientdata/STOCK PROTYRES 05102026 From Odoo.pdf"        (source recognised by name: config/providers.json)
 *   npm run ingest -- clientdata/SourceOwnProviderListaPrecios.pdf
 *   npm run ingest -- "clientdata/SourceProviderJch 06-10.xlsx"
 *   npm run ingest -- lista.pdf --provider "Importadora Norte" --date 2026-10-06
 *   npm run ingest -- mensaje.txt --provider "Proveedor WA"                     (a WhatsApp message saved as text)
 *   npm run ingest -- --text "Michelin X Multi Z 295/80R22.5 a 410" --provider "Proveedor WA"
 *   npm run ingest -- clientdata/*                                             (several files)
 *
 * Options: --provider  --kind own|stock|provider  --date yyyy-mm-dd  --currency USD|PEN  --tax (prices include IGV)
 *          --max-discount 20  --method auto|llm|heuristic  --no-replace  --dry (do not save)  --show (print rows)
 */
import "./env";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ingestCsv, ingestExcel } from "../lib/ingest/tabular";
import { ingestPdf } from "../lib/ingest/pdf";
import { ingestWhatsAppText } from "../lib/ingest/whatsapp-text";
import { resolveSourceOptions } from "../lib/ingest/sources";
import type { IngestOptions, IngestResult, RowKind } from "../lib/ingest/types";
import { getStore } from "../lib/store";
import { fmtTable } from "./env";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: "string", short: "p" },
    kind: { type: "string" },
    date: { type: "string" },
    currency: { type: "string" },
    tax: { type: "boolean" },
    "max-discount": { type: "string" },
    method: { type: "string" },
    text: { type: "string" },
    replace: { type: "boolean", default: true },
    dry: { type: "boolean", default: false },
    show: { type: "boolean", default: false },
  },
});

function optionsFor(fileName: string): IngestOptions {
  const cfg = resolveSourceOptions(fileName, values.provider);
  const provider = values.provider ?? cfg.provider;
  if (!provider) throw new Error(`no sé de qué proveedor es "${fileName}": usa --provider o añade una regla en config/providers.json`);
  return {
    ...cfg,
    provider,
    sourceRef: fileName,
    kind: (values.kind as RowKind | undefined) ?? cfg.kind,
    priceDate: values.date ?? cfg.priceDate,
    defaultCurrency: values.currency ?? cfg.defaultCurrency,
    priceIncludesTax: values.tax ?? cfg.priceIncludesTax,
    maxDiscountPct: values["max-discount"] ? parseFloat(values["max-discount"]) : cfg.maxDiscountPct,
  };
}

async function ingestOne(file: string | null): Promise<{ result: IngestResult; opts: IngestOptions }> {
  const method = (values.method as "auto" | "llm" | "heuristic" | undefined) ?? "auto";
  if (!file) {
    const opts = optionsFor(`cli-${Date.now()}`);
    return { result: await ingestWhatsAppText(values.text!, { ...opts, method }), opts };
  }
  const buf = fs.readFileSync(file);
  const opts = optionsFor(path.basename(file));
  const ext = path.extname(file).toLowerCase();
  let result: IngestResult;
  if ([".xlsx", ".xlsm", ".xls", ".html", ".htm"].includes(ext)) result = await ingestExcel(buf, opts);
  else if (ext === ".csv") result = ingestCsv(buf.toString("utf8"), opts);
  else if (ext === ".pdf") result = await ingestPdf(buf, { ...opts, method });
  else result = await ingestWhatsAppText(buf.toString("utf8"), { ...opts, method });
  return { result, opts };
}

async function main() {
  const targets: (string | null)[] = values.text ? [null] : positionals;
  if (targets.length === 0) throw new Error("indica uno o más archivos (.xlsx, .xls, .csv, .pdf, .txt) o --text");
  const store = values.dry ? null : await getStore();
  for (const file of targets) {
    let ingested: { result: IngestResult; opts: IngestOptions };
    try {
      ingested = await ingestOne(file);
    } catch (err) {
      console.log(`\n${file ?? "--text"}: omitido (${(err as Error).message})`);
      continue;
    }
    const { result, opts } = ingested;
    const r = result.stats;
    console.log(`\n${r.provider} · ${r.sourceRef} · ${opts.kind ?? "provider"} · método: ${r.method}`);
    console.log(`filas vistas: ${r.rowsSeen}  parseadas: ${r.rowsParsed}  omitidas: ${r.rowsSkipped}${result.meta ? `  · ${JSON.stringify(result.meta)}` : ""}`);
    for (const w of result.warnings.slice(0, 10)) console.log(`  ! ${w}`);
    if (result.warnings.length > 10) console.log(`  ! … y ${result.warnings.length - 10} avisos más`);
    if (values.show || result.rows.length <= 15) {
      console.log();
      console.log(
        fmtTable(
          result.rows.slice(0, values.show ? 400 : 15).map((x) => ({
            cod: x.code ?? "",
            marca: x.brand,
            modelo: x.model,
            medida: x.sizeDisplay || "(sin medida)",
            indice: x.loadIndex ? `${x.loadIndex}${x.speedIndex ?? ""}` : "",
            pr: x.ply ?? "",
            pos: x.position ?? "",
            precio: x.cost ?? "",
            mon: x.currency,
            igv: x.priceIncludesTax ? "inc" : "",
            stock: x.stock ?? "",
            fecha: x.priceDate,
          })),
        ),
      );
    }
    if (store) {
      const { inserted, removed } = await store.upsertRows(result.rows, values.replace ? { replace: { provider: opts.provider, sourceRef: opts.sourceRef.split("#")[0], kind: opts.kind } } : undefined);
      console.log(`guardado: ${inserted} filas (${removed} anteriores del mismo archivo reemplazadas)`);
    } else console.log("(--dry: no se guardó nada)");
  }
  await store?.close();
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
