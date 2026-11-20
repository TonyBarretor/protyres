/**
 * ventas-odoo, punto 8: al cotizar a un cliente al que ya se le vendió esa medida, el "Entendí" del vendedor del portal
 * suma UNA línea informativa ("Última venta a este cliente: … a US$ … el …"). Nada más cambia: mismas opciones y precios,
 * misma cotización, mismo PDF y mismo correo que para un número fuera del portal. Datos inventados.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ingestExcel } from "../ingest/tabular";
import { seedOdoo } from "../portal/sales/odoo-seed";
import { JsonPortalStore } from "../portal/store";
import type { UserRole } from "../portal/store/types";
import { SettingsSchema, type Settings } from "../settings";
import { JsonStore } from "../store/json-store";
import { FakeWhatsAppClient } from "./client";
import { BotHandler } from "./handler";
import type { InboundMessage } from "./webhook";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
  salespeople: { default: "51955344340", "51955344340": { name: "Vendedor de Prueba", title: "Key Account Manager", phone: "955 000 000", email: "vendedor@example.pe" } },
});

const PHONE = "51955344340";
const FIXED_NOW = new Date("2026-11-10T15:00:00.000Z");
const RUC = "20999000011";
const RAZON = "TRANSPORTES ANDES DEL PERU S.A.C.";
// el diseño conserva el "+" de "XZE2+" (classify.ts, corregido en la revisión del orquestador)
const REF = "Última venta a este cliente: Xze2+ a US$ 455 el 12/09/2026";

interface Recorded {
  kind: string;
  to: string;
  body?: string;
  fileName?: string;
  caption?: string;
  sha256?: string;
}

/** Corre el guion; `as` = rol del vendedor en el portal (null = número fuera del portal). Ventas: 11R22.5 a ese RUC. */
async function run(script: string[], as: UserRole | null, opts: { sold?: boolean } = {}): Promise<{ steps: Recorded[][]; emails: string[] }> {
  const store = JsonStore.memory();
  const portal = JsonPortalStore.memory();
  const user = as ? await portal.upsertUser({ nombre: "Vendedor de Prueba", whatsapp: PHONE, rol: as }) : await portal.upsertUser({ nombre: "Otro", whatsapp: "51900000123", rol: "admin" });
  await portal.upsertCompanies([{ ruc: RUC, razonSocial: RAZON, sector: "pasajeros", departamento: "LIMA", unidades: 12, llantasPiso: 72 }]);
  if (opts.sold !== false) {
    await seedOdoo(portal, [
      { fecha: "2026-09-12", documento: "F003-7001", ruc: RUC, razon: RAZON, descripcion: "[P0999] 11R22.5 MICHELIN XZE2+", cantidad: 4, precio: 455, costo: 380, margen: "16.48%" },
      { fecha: "2026-08-01", documento: "F003-7000", ruc: RUC, razon: RAZON, descripcion: "[P0998] 11R22.5 MICHELIN XZE2+", cantidad: 2, precio: 440, costo: 370, margen: "15.91%" },
    ], user);
  }
  const client = new FakeWhatsAppClient();
  const emails: string[] = [];
  const bot = new BotHandler({
    client,
    store,
    settings,
    portalStore: portal,
    sendEmail: async (quote, attachments, draft) => {
      emails.push(`${quote.number} -> ${draft.to} [${attachments.map((a) => a.filename).join(", ")}] ${draft.subject}\n${draft.body}`);
      return { sent: true, id: "ref" };
    },
  });
  const xls = await ingestExcel(fs.readFileSync(path.resolve(process.cwd(), "samples/proveedor-a-lista.xlsx")), { provider: "Llantas del Sur", sourceRef: "a.xlsx", priceDate: "2026-10-01" });
  await store.upsertRows(xls.rows);
  const steps: Recorded[][] = [];
  let n = 0;
  for (const body of script) {
    const before = client.sent.length;
    await bot.handle({ id: `wamid.sr.${++n}`, from: PHONE, timestamp: "1", type: "text", text: body, forwarded: false } as InboundMessage);
    steps.push(
      client.sent.slice(before).map((m) => {
        const r: Recorded = { kind: m.kind, to: m.to };
        if (m.body !== undefined) r.body = m.body;
        if (m.fileName !== undefined) r.fileName = m.fileName;
        if (m.caption !== undefined) r.caption = m.caption;
        if (m.file) r.sha256 = createHash("sha256").update(m.file).digest("hex");
        return r;
      }),
    );
  }
  return { steps, emails };
}

describe("cotizador: referencia de la última venta al cliente (ventas-odoo, punto 8)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of ["LLM_DISABLED", "PHOTOS_DISABLED", "RESEND_API_KEY", "EMAIL_REDIRECT_TO"]) saved[k] = process.env[k];
    process.env.LLM_DISABLED = "1";
    process.env.PHOTOS_DISABLED = "1";
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_REDIRECT_TO;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const SCRIPT = [`Michelin 11R22.5 XZE2+ x4 para Transportes Andes RUC ${RUC}, juan@andes.pe`, "ok", "enviar"];

  it("el vendedor del portal ve UNA línea más en el Entendí; opciones, precios, PDF y correo idénticos", async () => {
    const stranger = await run(SCRIPT, null);
    const frank = await run(SCRIPT, "vendedor");
    // 1. el mensaje de opciones: el mismo más la línea de referencia, antes de "Entendí:"
    const optS = stranger.steps[0][0].body!.split("\n");
    const optF = frank.steps[0][0].body!.split("\n");
    expect(optF.filter((l) => l !== REF)).toEqual(optS);
    expect(optF.filter((l) => l === REF)).toHaveLength(1);
    expect(optF.indexOf(REF)).toBeLessThan(optF.indexOf("Entendí:"));
    // 2. la cotización: mismos mensajes y el mismo PDF (byte a byte); el vendedor del portal recibe además el enlace
    const f1 = frank.steps[1].filter((m) => !(m.kind === "text" && m.body?.startsWith("🔗 ")));
    expect(f1.map((m) => ({ ...m, body: m.body?.replace(/\n⚠️ Crédito de .*$/, "") }))).toEqual(stranger.steps[1]);
    expect(frank.steps[1].some((m) => m.kind === "document" && m.fileName?.endsWith(".pdf"))).toBe(true);
    // 3. el correo al cliente: idéntico, sin la referencia
    expect(frank.emails).toEqual(stranger.emails);
    expect(frank.emails.join("\n")).not.toContain("Última venta");
    // la línea solo va al vendedor y solo en el Entendí
    const all = frank.steps.flat();
    expect(all.filter((m) => m.body?.includes("Última venta")).map((m) => m.to)).toEqual([PHONE]);
    expect(frank.steps.slice(1).flat().some((m) => m.body?.includes("Última venta"))).toBe(false);
  });

  it("supervisor y administrador también; un técnico no", async () => {
    for (const rol of ["supervisor", "admin"] as const) expect((await run(SCRIPT.slice(0, 1), rol)).steps[0][0].body).toContain(REF);
    expect((await run(SCRIPT.slice(0, 1), "tecnico")).steps[0][0].body).not.toContain("Última venta");
  });

  it("sin ventas de esa medida al cliente, nada cambia", async () => {
    const stranger = await run(SCRIPT.slice(0, 1), null, { sold: false });
    const frank = await run(SCRIPT.slice(0, 1), "vendedor", { sold: false });
    expect(frank.steps[0][0].body).toBe(stranger.steps[0][0].body);
    const otherSize = await run([`Michelin 295/80R22.5 x4 para Transportes Andes RUC ${RUC}`], "vendedor");
    expect(otherSize.steps[0][0].body).not.toContain("Última venta");
  });
});
