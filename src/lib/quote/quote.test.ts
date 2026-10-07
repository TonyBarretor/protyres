import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ingestExcel } from "../ingest/tabular";
import { ingestPdf } from "../ingest/pdf";
import { ingestWhatsAppText } from "../ingest/whatsapp-text";
import { resolveSourceOptions } from "../ingest/sources";
import type { PriceRow } from "../ingest/types";
import { SettingsSchema, type Settings } from "../settings";
import { JsonStore } from "../store/json-store";
import { buildQuote, formatQuoteNumber, itemFromCandidate, manualItem, displayTotal } from "./build";
import { buildEmailDraft, sendQuoteEmail } from "./email";
import { findCandidates, latestPerTyre, modelSimilarity, rankLine, textSimilarity } from "./match";
import { renderQuotePdf } from "./pdf";
import { convertCurrency, priceOwnItem, priceProviderItem, rowNetPrice, totals } from "./pricing";
import { parseRequestRegex } from "./request";

const samples = path.resolve(process.cwd(), "samples");
const clientdata = path.resolve(process.cwd(), "clientdata");
const hasClientData = fs.existsSync(clientdata) && fs.readdirSync(clientdata).length >= 4;

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396", address: "Lima", logoPath: "config/branding/logo.png", headerImagePath: "config/branding/header.png", footerImagePath: "config/branding/footer.png" },
  pricing: { currency: "USD", taxPct: 18, taxLabel: "IGV", own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, roundTo: 0.01, stalePriceDays: 30, exchangeRates: { PEN: 3.75 } },
  quote: { numberFormat: "{MES} {YYYY} - {NNN}", counterStart: 16, validityDays: 7, paymentType: "Factura crédito", paymentTerm: "30 días", deliveryTerm: "48 hrs post OC", exchangeRate: 3.4, notes: "Sujeto a stock.", brandOrigin: { Fenixway: "CHINA PREMIUM", Bridgestone: "JAPÓN" } },
  salespeople: { default: "51955344340", "51955344340": { name: "Frank Melek Rodríguez Mirano", title: "Key Account Manager", address: "San Borja - Lima", phone: "955 344 340", email: "frank.rodriguez@360tyres.pe" }, "51903162116": { name: "Jaime Luis Moncada Perales", title: "Asesor Comercial", address: "San Luis", phone: "903 162 116", email: "jaime.moncada@360tyres.pe" } },
});

beforeAll(() => {
  process.env.LLM_DISABLED = "1";
  delete process.env.RESEND_API_KEY;
});

async function loadClientData(): Promise<PriceRow[]> {
  const rows: PriceRow[] = [];
  for (const f of fs.readdirSync(clientdata)) {
    const buf = fs.readFileSync(path.join(clientdata, f));
    const o = resolveSourceOptions(f);
    const opts = { ...o, provider: o.provider ?? f, sourceRef: f };
    const res = /\.pdf$/i.test(f) ? await ingestPdf(buf, opts) : await ingestExcel(buf, opts);
    rows.push(...res.rows);
  }
  return rows;
}

describe("pricing", () => {
  it("own list: incl-tax list price -> net, discount capped", () => {
    const row = { cost: 413.33, currency: "USD", priceIncludesTax: true } as PriceRow;
    const net = rowNetPrice(row, settings.pricing)!;
    expect(net.net).toBe(350.28);
    expect(priceOwnItem(net.net, 10, 20, settings.pricing)).toEqual({ listNet: 350.28, discountPct: 10, clamped: false, unitNet: 315.25 });
    expect(priceOwnItem(net.net, 35, 20, settings.pricing)).toMatchObject({ discountPct: 20, clamped: true, unitNet: 280.22 });
    expect(priceOwnItem(net.net, undefined, 20, settings.pricing).discountPct).toBe(0);
  });
  it("provider: cost + margin; PEN converted", () => {
    expect(priceProviderItem(191.81, settings.pricing)).toBe(220.58);
    const pen = { cost: 1150, currency: "PEN", priceIncludesTax: true } as PriceRow;
    expect(rowNetPrice(pen, settings.pricing)).toEqual({ net: 259.89, converted: true, ok: true });
    expect(convertCurrency(300, "EUR", settings.pricing).ok).toBe(false);
  });
  it("totals", () => {
    expect(totals([{ quantity: 4, unitPrice: 315.25 }], settings.pricing)).toEqual({ subtotal: 1261, tax: 226.98, total: 1487.98 });
  });
});

describe("similarity", () => {
  it("models and free text", () => {
    expect(modelSimilarity("Valor 87", "VALOR 87")).toBe(1);
    expect(modelSimilarity("XZE2+", "XZE 2+")).toBe(1);
    expect(modelSimilarity("G377", "ADR778")).toBeLessThan(0.3);
    expect(textSimilarity("PARCHE RS-35 VIPAL", "PARCHE VIPAL RS-35 x 10")).toBeGreaterThan(0.6);
    expect(textSimilarity("PARCHE RS-35 VIPAL", "ARO 14 TOYOTA")).toBeLessThan(0.3);
  });
  it("latestPerTyre keeps the newest price", () => {
    const base = { provider: "P", kind: "provider", brand: "Michelin", model: "X", size: "11R22.5", sizeDisplay: "11R22.5", sizeRaw: "11R22.5", description: "", isTyre: true, priceIncludesTax: false, currency: "USD", stock: null, source: "whatsapp", sourceRef: "m" } as PriceRow;
    const rows = [
      { ...base, id: "1", cost: 400, priceDate: "2026-09-01" },
      { ...base, id: "2", cost: 410, priceDate: "2026-10-01" },
    ];
    expect(latestPerTyre(rows).map((r) => r.id)).toEqual(["2"]);
  });
});

describe("matching with synthetic samples", () => {
  it("brand filter, cheapest first, stale flag, provider pricing", async () => {
    const store = JsonStore.memory();
    const xls = await ingestExcel(fs.readFileSync(path.join(samples, "proveedor-a-lista.xlsx")), { provider: "Llantas del Sur", sourceRef: "a.xlsx", priceDate: "2026-09-01" });
    const wa = await ingestWhatsAppText(fs.readFileSync(path.join(samples, "whatsapp-03.txt"), "utf8"), { provider: "Proveedor WA", sourceRef: "wamid.3", priceDate: "2026-10-05" });
    await store.upsertRows([...xls.rows, ...wa.rows]);
    const req = parseRequestRegex("Michelin 11R22.5 XZE2+ x4 para Transportes ABC");
    const [lc] = await findCandidates(store, req, settings.pricing, { today: "2026-10-06" });
    expect(lc.candidates[0].row.brand).toBe("Michelin");
    expect(lc.candidates[0].row.model).toBe("XZE2+");
    expect(lc.candidates[0].unitNet).toBe(457.7); // 398 * 1.15
    expect(lc.candidates[0].stale).toBe(true);
    expect(lc.candidates[0].reasons.join(" ")).toContain("sin stock");
    const [any] = await findCandidates(store, parseRequestRegex("11R22.5 x2"), settings.pricing, { today: "2026-10-06" });
    expect(any.candidates[0].row.brand).toBe("Double Coin");
    expect(any.candidates.find((c) => c.row.provider === "Proveedor WA")?.converted).toBe(true);
    const [miss] = await findCandidates(store, parseRequestRegex("Pirelli 11R22.5"), settings.pricing);
    expect(miss.candidates[0].brandMismatch).toBe(true);
    const [none] = await findCandidates(store, parseRequestRegex("Michelin 13R22.5"), settings.pricing);
    expect(none.candidates).toEqual([]);
  });
});

describe.runIf(hasClientData)("matching with the client's real lists", () => {
  let rows: PriceRow[] = [];
  beforeAll(async () => {
    rows = await loadClientData();
  });

  it("own item with Odoo stock comes first, provider alternatives after", () => {
    const req = parseRequestRegex("Fenixway 295/80R22.5 Valor 87 x4 para Transportes ABC, juan@abc.com, dscto 10%");
    const c = rankLine(rows, req.lines[0], req, settings.pricing, { today: "2026-10-06" });
    expect(c[0].row.kind).toBe("own");
    expect(c[0].row.code).toBe("P0360");
    expect(c[0].available).toBe(34); // Odoo stock joined by code
    expect(c[0].listNet).toBe(413.33); // the own list is quoted without IGV (config/providers.json)
    expect(c[0].discountPct).toBe(10);
    expect(c[0].unitNet).toBe(372);
    expect(c.some((x) => x.row.kind === "provider")).toBe(false); // brand requested and found: only Fenixway
  });

  it("no brand: own stock first, then providers by price; max discount enforced", () => {
    const req = parseRequestRegex("295/80R22.5 x2 dscto 30%");
    const c = rankLine(rows, req.lines[0], req, settings.pricing, { today: "2026-10-06", limit: 8 });
    expect(c[0].row.kind).toBe("own");
    expect(c[0].discountPct).toBe(20);
    expect(c[0].reasons).toContain("descuento máximo 20%");
    const firstProvider = c.findIndex((x) => x.row.kind === "provider");
    expect(firstProvider).toBeGreaterThan(0);
    const providers = c.filter((x) => x.row.kind === "provider");
    expect(providers.every((x) => x.unitNet === Math.round(x.costNet! * 1.15 * 100) / 100)).toBe(true);
  });

  it("agricultural / industrial sizes only exist at providers", () => {
    const req = parseRequestRegex("LLANTA 12.5/80 X 18 - 12 PLY R4 UND 2");
    const c = rankLine(rows, req.lines[0], req, settings.pricing);
    expect(c.length).toBeGreaterThan(0);
    expect(c.every((x) => x.row.kind === "provider")).toBe(true);
    expect(c[0].row.size).toBe("12.5/80-18");
    const fork = rankLine(rows, parseRequestRegex("300 x R15 x2").lines[0], parseRequestRegex("300 x R15 x2"), settings.pricing);
    expect(fork.length).toBeGreaterThan(0);
  });

  it("free-text items match inventory descriptions", () => {
    const req = parseRequestRegex("2 aros 6.00x17.5 fierro");
    // "aros" is a non-tyre keyword but the line also has a size -> treated as a size line (rim size)
    const c = rankLine(rows, req.lines[0], req, settings.pricing);
    expect(req.lines[0].size?.canonical).toBe("6-17.5");
    expect(Array.isArray(c)).toBe(true);
    const patch = parseRequestRegex("PARCHE PARA LLANTA RS-35 VIPAL UND 25");
    expect(rankLine(rows, patch.lines[0], patch, settings.pricing)).toEqual([]); // nobody lists patches (yet)
  });
});

describe("quote build, PDF and email", () => {
  it("multi-line quote with an own item (discount), a provider item and a manual item", async () => {
    const store = JsonStore.memory();
    const xls = await ingestExcel(fs.readFileSync(path.join(samples, "proveedor-a-lista.xlsx")), { provider: "Llantas del Sur", sourceRef: "a.xlsx", priceDate: "2026-10-01" });
    const own = await ingestWhatsAppText("proveedor: Protyres\nFenixway Valor 87 295/80R22.5 a 413.33", { provider: "Protyres", sourceRef: "own", kind: "own", priceIncludesTax: true, maxDiscountPct: 20 });
    await store.upsertRows([...xls.rows, ...own.rows]);
    const req = parseRequestRegex("Fenixway 295/80R22.5 Valor 87 x4; Bridgestone 11R22.5 R268 x2; PARCHE RS-35 VIPAL x25 para Minera Los Andes S.A.C., compras@andes.pe dscto 10%");
    expect(req.lines.length).toBe(3);
    const lcs = await findCandidates(store, req, settings.pricing, { today: "2026-10-06" });
    expect(lcs[0].candidates[0].row.kind).toBe("own");
    expect(lcs[1].candidates[0].row.brand).toBe("Bridgestone");
    expect(lcs[2].candidates).toEqual([]);
    const items = [itemFromCandidate(lcs[0].candidates[0], 4, settings), itemFromCandidate(lcs[1].candidates[0], 2, settings), manualItem(req.lines[2], 3.5)];
    const number = formatQuoteNumber(settings.quote.numberFormat, await store.nextQuoteCounter(settings.quote.counterStart), "2026-10-06");
    expect(number).toBe("OCTUBRE 2026 - 016");
    const quote = buildQuote({ number, request: req, items, settings, today: "2026-10-06", requestedBy: "51903162116" });
    expect(quote.salesperson.name).toBe("Jaime Luis Moncada Perales");
    expect(quote.items[0].countryOfOrigin).toBe("CHINA PREMIUM");
    expect(quote.items[1].countryOfOrigin).toBe("JAPÓN");
    expect(quote.items[0]).toMatchObject({ origin: "own", discountPct: 10, unitPrice: 315.25, total: 1261 });
    expect(quote.items[1]).toMatchObject({ origin: "provider", unitPrice: 442.75 }); // 385 * 1.15
    expect(quote.items[2]).toMatchObject({ origin: "manual", unitPrice: 3.5, total: 87.5 });
    expect(quote.customer.company).toBe("Minera Los Andes S.A.C.");
    expect(quote.notes).toContain("Producto a pedido");
    expect(quote.total).toBe(Math.round((1261 + 885.5 + 87.5) * 1.18 * 100) / 100);

    const pdf = await renderQuotePdf(quote, settings);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    const outDir = path.resolve(process.cwd(), "out/test");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `q1.pdf`), pdf);

    const draft = buildEmailDraft(quote, settings);
    expect(draft.to).toBe("compras@andes.pe");
    expect(draft.subject).toContain("OCTUBRE 2026 - 016");
    expect(draft.body).toContain("dscto 10%");
    expect(draft.body).toContain("Jaime Luis Moncada Perales");
    const res = await sendQuoteEmail(quote, pdf, draft, { outDir });
    expect(res.sent).toBe(false);
    expect(res.dryRunPath && fs.existsSync(res.dryRunPath)).toBe(true);

    // "con IGV" presentation keeps the same totals; the printed total changes
    const withTax = buildQuote({ number: "OCTUBRE 2026 - 017", request: { ...req, showPricesWithTax: true, paymentType: "Letras BCP", attention: "Sr. Jose Muñoz" }, items, settings, today: "2026-10-06" });
    expect(withTax.pricesIncludeTax).toBe(true);
    expect(withTax.total).toBe(quote.total);
    expect(displayTotal(quote)).toBe(quote.subtotal);
    expect(displayTotal(withTax)).toBeCloseTo(quote.total, 1);
    expect(withTax.paymentType).toBe("Letras BCP");
    expect(withTax.customer.attention).toBe("Sr. Jose Muñoz");
    fs.writeFileSync(path.join(outDir, `q2.pdf`), await renderQuotePdf(withTax, settings));
  });
});
