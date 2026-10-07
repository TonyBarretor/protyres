/**
 * Quote from the command line (same engine the WhatsApp bot uses).
 *
 *   npm run quote -- "Fenixway 295/80R22.5 Valor 87 x4 para Transportes ABC, juan@abc.com, dscto 10%"
 *   npm run quote -- "11R22.5 x2" --pick 1b                 (line 1, option b)
 *   npm run quote -- --file pedido.txt --pick "1a 3b" --price "2=4.50" --remove 4
 *   npm run quote -- "..." --send                            (send the email; dry-run file without RESEND_API_KEY)
 *   npm run quote -- "..." --list                            (only show options)
 *
 * Writes out/<number>.pdf and out/<number>.email.txt
 */
import "./env";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadSettings } from "../lib/settings";
import { getStore } from "../lib/store";
import { buildQuote, displayTotal, formatQuoteNumber, itemFromCandidate, manualItem } from "../lib/quote/build";
import { buildEmailDraft, safeName, sendQuoteEmail } from "../lib/quote/email";
import { findCandidates } from "../lib/quote/match";
import { renderQuotePdf } from "../lib/quote/pdf";
import { fmtMoney } from "../lib/quote/pricing";
import { describeLine, describeRequest, parseRequest } from "../lib/quote/request";
import type { QuoteItem } from "../lib/quote/types";
import { fmtTable } from "./env";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: "string" },
    pick: { type: "string", default: "" },
    price: { type: "string", multiple: true, default: [] },
    remove: { type: "string", multiple: true, default: [] },
    send: { type: "boolean", default: false },
    out: { type: "string" },
    list: { type: "boolean", default: false },
    salesperson: { type: "string" },
  },
});

const LETTERS = "abcdefghij";

async function main() {
  const text = values.file ? fs.readFileSync(values.file, "utf8") : positionals.join(" ").trim();
  if (!text) throw new Error('indica el pedido, p.ej.: npm run quote -- "Fenixway 295/80R22.5 Valor 87 x4 para Transportes ABC, juan@abc.com"');
  const settings = loadSettings();
  const store = await getStore();
  const cur = settings.pricing.currency;

  const req = await parseRequest(text);
  console.log(`\nEntendido (${req.parsedBy}):\n${describeRequest(req)}`);
  if (req.lines.length === 0) throw new Error("no encontré medidas ni productos en el pedido");

  const lcs = await findCandidates(store, req, settings.pricing);
  const picks = new Map<number, number>();
  for (const m of values.pick.matchAll(/(\d{1,2})\s*([a-j])?/gi)) picks.set(parseInt(m[1], 10) - 1, m[2] ? LETTERS.indexOf(m[2].toLowerCase()) : 0);
  const prices = new Map<number, number>();
  for (const p of values.price) {
    const m = p.match(/^(\d{1,2})\s*=\s*([\d.,]+)$/);
    if (m) prices.set(parseInt(m[1], 10) - 1, parseFloat(m[2].replace(",", ".")));
  }
  const removed = new Set(values.remove.map((r) => parseInt(r, 10) - 1));

  const items: QuoteItem[] = [];
  const missing: number[] = [];
  lcs.forEach((lc, i) => {
    console.log(`\n${i + 1}. ${describeLine(lc.line)}${removed.has(i) ? "  (quitado)" : ""}`);
    if (lc.candidates.length === 0) console.log("   sin precio en las listas" + (prices.has(i) ? ` → precio manual ${fmtMoney(prices.get(i)!, cur)}` : ""));
    else
      console.log(
        fmtTable(
          lc.candidates.map((c, j) => ({
            op: LETTERS[j],
            origen: c.row.kind === "own" ? "STOCK" : c.row.provider,
            cod: c.row.code ?? "",
            marca: c.row.brand,
            modelo: c.row.model,
            medida: c.row.sizeDisplay,
            pr: c.row.ply ?? "",
            pos: c.row.position ?? "",
            disp: c.available ?? "?",
            lista: c.listNet !== undefined ? fmtMoney(c.listNet, cur) : "",
            dscto: c.discountPct ? `${c.discountPct}%` : "",
            costo: c.costNet !== undefined ? fmtMoney(c.costNet, cur) : "",
            venta: fmtMoney(c.unitNet, cur),
            notas: c.reasons.join("; "),
          })),
        ),
      );
    if (values.list || removed.has(i)) return;
    const idx = picks.get(i) ?? 0;
    const cand = lc.candidates[idx];
    if (cand) items.push(itemFromCandidate(cand, lc.line.quantity, settings, prices.get(i)));
    else if (prices.has(i)) items.push(manualItem(lc.line, prices.get(i)!, undefined, settings));
    else missing.push(i + 1);
  });
  if (values.list) {
    await store.close();
    return;
  }
  if (missing.length) {
    console.log(`\nFalta precio en el ítem ${missing.join(", ")}: usa --price "${missing[0]}=123.45" o --remove ${missing[0]}`);
    await store.close();
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const number = formatQuoteNumber(settings.quote.numberFormat, await store.nextQuoteCounter(settings.quote.counterStart), today);
  const quote = buildQuote({ number, request: req, items, settings, requestedBy: values.salesperson, today });
  const draft = buildEmailDraft(quote, settings);
  quote.emailDraft = draft;

  const outDir = values.out ?? path.resolve(process.cwd(), "out");
  fs.mkdirSync(outDir, { recursive: true });
  const pdf = await renderQuotePdf(quote, settings);
  const pdfPath = path.join(outDir, `${safeName(quote.number)}.pdf`);
  fs.writeFileSync(pdfPath, pdf);
  quote.pdfPath = pdfPath;
  fs.writeFileSync(path.join(outDir, `${safeName(quote.number)}.email.txt`), `To: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}\n`);

  console.log(`\nCotización ${quote.number} (${quote.pricesIncludeTax ? "precios con IGV" : "precios sin IGV"}) · asesor: ${quote.salesperson.name}`);
  for (const it of quote.items) console.log(`  ${it.quantity} x ${it.description} @ ${fmtMoney(it.unitPrice, cur)}${it.discountPct ? ` (dscto ${it.discountPct}%)` : ""} = ${fmtMoney(it.total, cur)}  [${it.origin === "own" ? "stock" : it.origin === "provider" ? it.provider : "manual"}]`);
  console.log(`  subtotal ${fmtMoney(quote.subtotal, cur)}  ${quote.taxLabel} ${fmtMoney(quote.tax, cur)}  total ${fmtMoney(quote.total, cur)}  (impreso: ${fmtMoney(displayTotal(quote), cur)} ${quote.pricesIncludeTax ? "inc." : "sin"} ${quote.taxLabel})`);
  console.log(`  PDF: ${pdfPath}`);
  console.log(`  Email para: ${draft.to || "(sin correo en el pedido)"} · asunto: ${draft.subject}`);

  if (values.send) {
    const res = await sendQuoteEmail(quote, pdf, draft, { outDir });
    if (res.sent) {
      quote.status = "sent";
      quote.sentAt = new Date().toISOString();
      console.log(`  Enviado ✔ (id ${res.id})`);
    } else if (res.dryRunPath) console.log(`  Sin RESEND_API_KEY: correo simulado en ${res.dryRunPath}`);
    else console.log(`  No enviado: ${res.error}`);
  }
  await store.saveQuote(quote);
  await store.close();
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
