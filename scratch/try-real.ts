import fs from "node:fs";
import path from "node:path";
import { ingestExcel } from "../src/lib/ingest/tabular";
import { ingestPdf } from "../src/lib/ingest/pdf";
import { resolveSourceOptions } from "../src/lib/ingest/sources";
process.env.LLM_DISABLED = "1";
const dir = path.resolve("clientdata");
for (const f of fs.readdirSync(dir)) {
  const buf = fs.readFileSync(path.join(dir, f));
  const o = resolveSourceOptions(f);
  const opts = { ...o, provider: o.provider ?? "?", sourceRef: f } as any;
  const t0 = Date.now();
  const res = /\.pdf$/i.test(f) ? await ingestPdf(buf, opts) : await ingestExcel(buf, opts);
  console.log(`\n=== ${f} -> provider=${opts.provider} kind=${opts.kind} method=${res.stats.method} seen=${res.stats.rowsSeen} parsed=${res.stats.rowsParsed} (${Date.now() - t0} ms)`);
  if (res.meta) console.log("meta:", res.meta);
  for (const w of res.warnings.slice(0, 5)) console.log("  !", w);
  const show = res.rows.slice(0, 6).concat(res.rows.slice(-3));
  for (const r of show) console.log(`  ${r.code ?? "-"} | ${r.brand} | ${r.model} | ${r.sizeDisplay || "(no size)"} | ${r.loadIndex ?? ""}${r.speedIndex ?? ""} ${r.ply ? r.ply + "PR" : ""} ${r.position ?? ""} | cost=${r.cost} ${r.currency} tax=${r.priceIncludesTax} | stock=${r.stock} | ${r.description.slice(0, 50)}`);
  const noSize = res.rows.filter((r) => !r.isTyre).length;
  const noBrand = res.rows.filter((r) => r.isTyre && !r.brand).length;
  console.log(`  non-tyre rows: ${noSize}, tyre rows without brand: ${noBrand}`);
}
