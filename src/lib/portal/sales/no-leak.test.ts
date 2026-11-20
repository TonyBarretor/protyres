/**
 * ventas-odoo, punto 8: costo, proveedor y margen de las ventas de Odoo son internos. Con ventas cargadas que llevan
 * valores inconfundibles (costo 777.77, proveedor "PROVEEDOR SECRETO SAC", margen "42.42%"), nada de eso aparece en lo que
 * ve el cliente: el PDF y el correo de la cotización (y la cotización guardada), la pre-propuesta (PDF y datos) y la
 * encuesta (correo, texto para reenviar y lo que abre la página del enlace). La referencia "Última venta a este cliente"
 * (interna) va solo en el mensaje al vendedor del portal. Datos inventados.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { extractText, getDocumentProxy } from "unpdf";
import { ingestExcel } from "../../ingest/tabular";
import { SettingsSchema, __setSettingsForTests, type Settings } from "../../settings";
import { JsonStore } from "../../store/json-store";
import { FakeWhatsAppClient } from "../../whatsapp/client";
import { BotHandler } from "../../whatsapp/handler";
import type { InboundMessage } from "../../whatsapp/webhook";
import { generatePrepropuesta } from "../prepropuesta";
import { JsonPortalStore } from "../store";
import type { FleetVehicleInput, PortalUser } from "../store/types";
import type { SurveyEmailInput, SurveyEmailSender } from "../survey/email";
import { runSurveyInvites } from "../survey/invite";
import { openSurvey } from "../survey/service";
import { lastTyreSales, saleLineText } from "./history";
import type { OdooFixtureLine } from "./odoo-fixture";
import { seedOdoo } from "./odoo-seed";

const PHONE = "51955344340";
const NOW = new Date("2026-11-10T15:00:00.000Z");
const RUC = "20999000011";
const RAZON = "TRANSPORTES ANDES DEL PERU S.A.C.";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396", logoPath: "config/branding/logo.png", footerImagePath: "config/branding/footer.png" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
  salespeople: { default: PHONE, [PHONE]: { name: "Vendedor de Prueba", title: "Key Account Manager", phone: "955 000 000", email: "vendedor@example.pe", address: "Av. Inventada 123 - Lima" } },
});

/** Valores internos inconfundibles: ninguno puede salir en un documento del cliente. */
const SECRET_LINES: OdooFixtureLine[] = [
  // venta reciente (dispara la encuesta: 7 días antes de NOW) y la que da la referencia al cotizar 11R22.5
  { fecha: "2026-11-03", documento: "F003-8001", ruc: RUC, razon: RAZON, descripcion: "[P0999] 11R22.5 MICHELIN XZE2+", cantidad: 4, precio: 455, costo: 777.77, proveedor: "PROVEEDOR SECRETO SAC", margen: "42.42%" },
  { fecha: "2026-10-01", documento: "F003-8000", ruc: RUC, razon: RAZON, descripcion: "[P0759] 295/80R22.5 18PR FENIXWAY VALOR 89", cantidad: 8, precio: 255, costo: 777.77, proveedor: "PROVEEDOR SECRETO SAC", margen: "42.42%" },
];
/** Lo que no debe aparecer (costo en dólares y en soles con tc 3.5, proveedor, margen) ni la referencia interna. */
const FORBIDDEN = [/777[.,]77/, /2[,.]?722[.,]2/, /PROVEEDOR SECRETO/i, /42[.,]42/, /Última venta/i];

function expectClean(what: string, text: string): void {
  for (const re of FORBIDDEN) expect(re.test(text), `${what} contiene ${re}`).toBe(false);
}

async function pdfPlain(pdf: Buffer): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const { text } = await extractText(doc, { mergePages: true });
  return String(text).replace(/\s+/g, " ");
}

function vehicle(companyId: number, i: number): FleetVehicleInput {
  return { companyId, placa: `NL-${100 + i}`, marca: i % 2 ? "VOLVO" : "SCANIA", clase: "OMNIBUS", anio: 2015 + (i % 5), ejes: 2, llantas: 6, llantasFuente: "20241231", pesoBruto: 18000, chasis: null, departamento: "LIMA", origen: "pasajeros", medidaProbable: "295/80R22.5", confianza: "media" };
}

let portal: JsonPortalStore;
let frank: PortalUser;
let companyId: number;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ["LLM_DISABLED", "PHOTOS_DISABLED", "RESEND_API_KEY", "EMAIL_REDIRECT_TO"]) saved[k] = process.env[k];
  process.env.LLM_DISABLED = "1";
  process.env.PHOTOS_DISABLED = "1";
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_REDIRECT_TO;
  __setSettingsForTests(settings);
  portal = JsonPortalStore.memory();
  frank = await portal.upsertUser({ nombre: "Vendedor de Prueba", whatsapp: PHONE, rol: "vendedor" });
  const r = await portal.upsertCompanies([{ ruc: RUC, razonSocial: RAZON, sector: "pasajeros", departamento: "LIMA", unidades: 12, llantasPiso: 72 }]);
  companyId = r.ids[RUC];
  await portal.upsertFleet(Array.from({ length: 12 }, (_, i) => vehicle(companyId, i)));
  await portal.updateCompany(companyId, { ownerUserId: frank.id, esCliente: true });
  await portal.addContact({ companyId, nombre: "Rosa Pérez", cargo: "jefa de flota", email: "rosa@andes.example.pe", createdBy: frank.id });
  await seedOdoo(portal, SECRET_LINES, frank);
});

afterAll(() => {
  __setSettingsForTests(null);
  vi.useRealTimers();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("costo, proveedor y margen nunca salen al cliente (ventas-odoo, punto 8)", () => {
  it("los datos sembrados sí están (y el vendedor los ve en el bot): la prueba no pasa por vacía", async () => {
    const [s] = await lastTyreSales(portal, RUC, { medida: "11R22.5" });
    expect(s.detalle).toMatchObject({ costoUnitarioUsd: 777.77, proveedor: "PROVEEDOR SECRETO SAC", margen: "42.42%" });
    expect(saleLineText(s)).toContain("costo US$ 777.77 · margen 42.42%");
  });

  it("cotización: el Entendí del vendedor lleva la referencia; PDF, correo y cotización guardada, nada interno", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const store = JsonStore.memory();
      const xls = await ingestExcel(fs.readFileSync(path.resolve(process.cwd(), "samples/proveedor-a-lista.xlsx")), { provider: "Llantas del Sur", sourceRef: "a.xlsx", priceDate: "2026-10-01" });
      await store.upsertRows(xls.rows);
      const client = new FakeWhatsAppClient();
      const emails: string[] = [];
      const bot = new BotHandler({
        client,
        store,
        settings,
        portalStore: portal,
        sendEmail: async (quote, attachments, draft) => {
          emails.push(`${draft.to}\n${draft.subject}\n${draft.body}\n${attachments.map((a) => a.filename).join(", ")}`);
          for (const a of attachments) if (/\.pdf$/i.test(a.filename)) emails.push(await pdfPlain(a.content as Buffer));
          return { sent: true, id: "noleak" };
        },
      });
      let n = 0;
      for (const body of [`Michelin 11R22.5 XZE2+ x4 para Transportes Andes RUC ${RUC}, juan@andes.pe`, "ok", "enviar"]) {
        await bot.handle({ id: `wamid.nl.${++n}`, from: PHONE, timestamp: "1", type: "text", text: body, forwarded: false } as InboundMessage);
      }
      // la referencia (interna) solo en el mensaje al vendedor
      const withRef = client.sent.filter((m) => m.body?.includes("Última venta a este cliente"));
      expect(withRef).toHaveLength(1);
      expect(withRef[0].to).toBe(PHONE);
      expect(withRef[0].body).toContain("Entendí:");
      // ni el vendedor recibe costo/proveedor/margen de Odoo en los mensajes del cotizador
      for (const m of client.sent) if (m.body) expect(/777[.,]77|PROVEEDOR SECRETO|42[.,]42/i.test(m.body)).toBe(false);
      const pdfs = client.sent.filter((m) => m.kind === "document" && m.file && /\.pdf$/i.test(m.fileName ?? ""));
      expect(pdfs.length).toBeGreaterThan(0);
      for (const p of pdfs) {
        const text = await pdfPlain(p.file!);
        expect(text).toContain("XZE2");
        expectClean(`PDF ${p.fileName}`, text);
      }
      expect(emails.length).toBeGreaterThan(0);
      expectClean("correo de la cotización", emails.join("\n"));
      expectClean("cotización guardada", JSON.stringify(await store.listQuotes()));
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("pre-propuesta: ni el PDF ni sus datos llevan costo, proveedor ni margen", async () => {
    const gen = await generatePrepropuesta(portal, companyId, frank, NOW);
    const text = await pdfPlain(gen.pdf);
    expect(text).toContain("TRANSPORTES ANDES DEL PERU");
    expectClean("PDF de la pre-propuesta", text);
    expectClean("datos de la pre-propuesta", JSON.stringify(gen.data));
  }, 30_000);

  it("encuesta: correo, texto para reenviar y lo que abre el enlace, sin nada interno", async () => {
    const mails: SurveyEmailInput[] = [];
    const sendEmail: SurveyEmailSender = async (m) => (mails.push(m), { sent: true, to: m.to });
    const client = new FakeWhatsAppClient();
    const env = { PORTAL_BASE_URL: "https://portal.example.pe", SURVEY_AUTO: "1", RESEND_API_KEY: "re_test", EMAIL_FROM: "Encuestas <encuestas@example.pe>" };
    const r = await runSurveyInvites({ store: portal, client, now: NOW, env, config: { afterSaleDays: 7, windowDays: 7, cooldownMonths: 6, expiresDays: 30 }, sendEmail });
    expect(r.correos).toBe(1);
    expect(mails).toHaveLength(1);
    expectClean("correo de la encuesta", `${mails[0].subject}\n${mails[0].text}\n${mails[0].html}`);
    expectClean("WhatsApp de la encuesta", client.texts().join("\n"));
    const token = /\/encuesta\/([A-Za-z0-9_-]{43})/.exec(mails[0].text)![1];
    const open = await openSurvey(portal, token, NOW);
    expect(open.status).toBe("abierta");
    expectClean("página de la encuesta", JSON.stringify(open));
  });
});
