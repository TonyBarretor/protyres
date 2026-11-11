/**
 * Red de seguridad del cotizador: una conversación de cotización pasa por BotHandler.handle() y TODO lo que el bot envía
 * (textos, documentos con nombre/leyenda/tipo y huella del contenido, correos) se compara con un snapshot guardado en
 * __golden__/quotes.json, generado con el código ANTERIOR al enganche del portal (fase B).
 *
 * El snapshot no se regenera: si este test falla, el cambio alteró el cotizador. (Solo para crearlo la primera vez:
 * GOLDEN_WRITE=1 npx vitest run src/lib/whatsapp/quote-golden.test.ts)
 *
 * Dos corridas:
 *  - "noUser": número que no está en `users` del portal, guion completo (incluye texto libre que hoy va al cotizador).
 *  - "portalUser": el mismo número registrado como vendedor del portal, solo mensajes de cotización: deben dar
 *    exactamente lo mismo (el portal no se mete en una cotización).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ingestExcel } from "../ingest/tabular";
import { JsonPortalStore } from "../portal/store";
import { SettingsSchema, type Settings } from "../settings";
import { JsonStore } from "../store/json-store";
import { FakeWhatsAppClient } from "./client";
import { BotHandler } from "./handler";
import type { InboundMessage } from "./webhook";

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
  salespeople: { default: "51955344340", "51955344340": { name: "Frank Melek Rodríguez Mirano", title: "Key Account Manager", phone: "955 344 340", email: "frank.rodriguez@360tyres.pe" } },
});

const PHONE = "51955344340";
const FIXED_NOW = new Date("2026-11-10T15:00:00.000Z"); // martes 10:00 en Lima
const GOLDEN = path.resolve(process.cwd(), "src/lib/whatsapp/__golden__/quotes.json");

/** Mensajes de cotización (de handler.test.ts): ok, 1b, sí en review_quote, enviar, cancelar, memoria del cliente. */
const QUOTE_SCRIPT = [
  "Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com",
  "ok",
  "precio 480",
  "sí",
  "295/80R22.5 x2 para Transportes ABC, juan@abc.com",
  "1b",
  "cancelar",
  "Michelin 11R22.5 XZE2+ x2, juan@abc.com",
  "ok",
  "enviar",
  "295/80R22.5 x2 cliente Pedro",
  "2",
  "pedro@mail.com",
  "cancelar",
];

/** Texto libre que hoy va al cotizador (para un número que no es del portal debe seguir igual). */
const FREE_TEXT_SCRIPT = ["Visité Transportes ABC, necesitan 295/80R22.5 x4", "cancelar", "llamé a Juan de Transportes ABC, dice que mañana confirma", "hola"];

interface Recorded {
  kind: string;
  body?: string;
  fileName?: string;
  caption?: string;
  mimeType?: string;
  link?: string;
  sha256?: string;
}

interface Golden {
  noUser: Recorded[][];
  portalUser: Recorded[][];
}

function record(sent: FakeWhatsAppClient["sent"]): Recorded[] {
  return sent.map((m) => {
    const r: Recorded = { kind: m.kind };
    if (m.body !== undefined) r.body = m.body;
    if (m.fileName !== undefined) r.fileName = m.fileName;
    if (m.caption !== undefined) r.caption = m.caption;
    if (m.mimeType !== undefined) r.mimeType = m.mimeType;
    if (m.link !== undefined) r.link = m.link;
    if (m.file) r.sha256 = createHash("sha256").update(m.file).digest("hex");
    return r;
  });
}

async function run(script: string[], registerPortalUser: boolean): Promise<Recorded[][]> {
  const store = JsonStore.memory();
  const portal = JsonPortalStore.memory();
  if (registerPortalUser) await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: PHONE, rol: "vendedor" });
  const client = new FakeWhatsAppClient();
  const emails: string[] = [];
  const bot = new BotHandler({
    client,
    store,
    settings,
    portalStore: portal,
    sendEmail: async (quote, attachments, draft) => {
      emails.push(`${quote.number} -> ${draft.to} [${attachments.map((a) => a.filename).join(", ")}] ${draft.subject}`);
      return { sent: true, id: "golden" };
    },
  });
  const xls = await ingestExcel(fs.readFileSync(path.resolve(process.cwd(), "samples/proveedor-a-lista.xlsx")), { provider: "Llantas del Sur", sourceRef: "a.xlsx", priceDate: "2026-10-01" });
  await store.upsertRows(xls.rows);
  const out: Recorded[][] = [];
  let n = 0;
  for (const body of script) {
    const before = client.sent.length;
    const beforeEmails = emails.length;
    const msg: InboundMessage = { id: `wamid.golden.${++n}`, from: PHONE, timestamp: "1", type: "text", text: body, forwarded: false };
    await bot.handle(msg);
    const step = record(client.sent.slice(before));
    for (const e of emails.slice(beforeEmails)) step.push({ kind: "email", body: e });
    out.push(step);
  }
  return out;
}

describe("cotizador: salidas idénticas al snapshot previo al portal", () => {
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

  it("número fuera del portal y vendedor del portal: mismas respuestas que antes", async () => {
    const actual: Golden = {
      noUser: await run([...QUOTE_SCRIPT, ...FREE_TEXT_SCRIPT], false),
      portalUser: await run(QUOTE_SCRIPT, true),
    };
    if (process.env.GOLDEN_WRITE === "1" && !fs.existsSync(GOLDEN)) {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, JSON.stringify({ script: { quotes: QUOTE_SCRIPT, freeText: FREE_TEXT_SCRIPT }, ...actual }, null, 2) + "\n");
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8")) as Golden & { script: unknown };
    expect(golden.script).toEqual({ quotes: QUOTE_SCRIPT, freeText: FREE_TEXT_SCRIPT });
    expect(actual.noUser).toEqual(golden.noUser);
    expect(actual.portalUser).toEqual(golden.portalUser);
  });

  it("el guion produce documentos (la comparación cubre PDFs y correos)", async () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8")) as Golden;
    const all = golden.noUser.flat();
    expect(all.some((m) => m.kind === "document" && m.fileName?.endsWith(".pdf"))).toBe(true);
    expect(all.some((m) => m.kind === "email")).toBe(true);
  });
});
