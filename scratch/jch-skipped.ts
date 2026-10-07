import fs from "node:fs";
import { loadExcel } from "../src/lib/ingest/tabular";
import { findTyreSizes } from "../src/lib/tyre/spec";
import { parseMoney, plausiblePrice } from "../src/lib/ingest/util";
const sheets = await loadExcel(fs.readFileSync("clientdata/SourceProviderJch 06-10.xlsx"));
const rows = sheets[0].rows.slice(4);
let noSize = 0, noPrice = 0; const samples: string[] = [];
for (const r of rows) {
  const desc = r[2] ?? ""; if (!desc) continue;
  const sizes = findTyreSizes(desc);
  const money = parseMoney(r[5]);
  if (sizes.length === 0) { noSize++; if (samples.length < 25) samples.push("NOSIZE  " + desc.slice(0, 90)); }
  else if (!money || !plausiblePrice(money.value)) { noPrice++; if (samples.length < 40 && noPrice < 8) samples.push(`NOPRICE ${r[5]} ${desc.slice(0, 70)}`); }
}
console.log({ total: rows.length, noSize, noPrice });
console.log(samples.join("\n"));
