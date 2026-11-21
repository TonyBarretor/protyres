/**
 * Golden ampliado (revisión B): el vendedor registrado en el portal frente a un número que no lo está, con una empresa del
 * portal que tiene RUC y plazo de crédito (companies.credit_terms_days). No toca el golden previo (quote-golden.test.ts).
 *
 *  1. Pedido con el RUC de esa empresa: las líneas de ítems y precios del cotizador son idénticas; las únicas diferencias
 *     son las del plazo (la nota "📒 plazo 45 días …" y el plazo en el borrador del correo / PDF) y el mensaje de enlace
 *     "🔗 Cotización … enlazada …" (fijados abajo).
 *  2. Adjuntos (lista de precios reenviada y `foto …`): respuestas idénticas.
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
const FIXED_NOW = new Date("2026-11-10T15:00:00.000Z");
/** Empresa inventada. */
const RUC = "20999000011";
const RAZON = "TRANSPORTES ANDES DEL PERU S.A.C.";

const PLAZO_NOTE = `📒 plazo 45 días (condiciones de *${RAZON}* en el portal)`;
/**
 * Mensaje del portal tras enlazar (no es del cotizador). Desde C4 lleva en una segunda línea el aviso de crédito: la
 * empresa no tiene fila de crédito, así que cuenta como "sin evaluar". Los mensajes del cotizador no cambian.
 * Corrida J: la empresa no tenía dueño, así que enlazar se la asigna al vendedor ("Quedó asignada a ti.").
 */
const LINK_MSG = `🔗 Cotización *0001* enlazada a *${RAZON}* en el portal (Prospecto). Quedó asignada a ti.\n⚠️ Crédito de *TRANSPORTES ANDES DEL PERU*: sin evaluar. Antes de dar plazo, evalúalo en la ficha del portal.`;

interface Recorded {
  kind: string;
  body?: string;
  fileName?: string;
  caption?: string;
  mimeType?: string;
  sha256?: string;
}

function record(sent: FakeWhatsAppClient["sent"]): Recorded[] {
  return sent.map((m) => {
    const r: Recorded = { kind: m.kind };
    if (m.body !== undefined) r.body = m.body;
    if (m.fileName !== undefined) r.fileName = m.fileName;
    if (m.caption !== undefined) r.caption = m.caption;
    if (m.mimeType !== undefined) r.mimeType = m.mimeType;
    if (m.file) r.sha256 = createHash("sha256").update(m.file).digest("hex");
    return r;
  });
}

async function run(script: (InboundMessage | string)[], registered: boolean): Promise<Recorded[][]> {
  const store = JsonStore.memory();
  const portal = JsonPortalStore.memory();
  if (registered) await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: PHONE, rol: "vendedor" });
  const r = await portal.upsertCompanies([{ ruc: RUC, razonSocial: RAZON, sector: "pasajeros", departamento: "LIMA", unidades: 12, llantasPiso: 72 }]);
  await portal.updateCompany(r.ids[RUC], { creditTermsDays: 45 });
  const client = new FakeWhatsAppClient();
  client.media.set("lista-xlsx", { data: fs.readFileSync(path.resolve(process.cwd(), "samples/proveedor-a-lista.xlsx")), mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileName: "lista.xlsx" });
  client.media.set("foto-1", { data: Buffer.from("jpeg-falso"), mimeType: "image/jpeg" });
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
  for (const m of script) {
    const before = client.sent.length;
    const beforeEmails = emails.length;
    const msg: InboundMessage = typeof m === "string" ? { id: `wamid.pu.${++n}`, from: PHONE, timestamp: "1", type: "text", text: m, forwarded: false } : { ...m, id: `wamid.pu.${++n}` };
    await bot.handle(msg);
    const step = record(client.sent.slice(before));
    for (const e of emails.slice(beforeEmails)) step.push({ kind: "email", body: e });
    out.push(step);
  }
  return out;
}

describe("cotizador: vendedor del portal frente a un número no registrado", () => {
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

  it("pedido con el RUC de una empresa con plazo: mismos ítems y precios; solo cambian el plazo y el enlace", async () => {
    const script = [`Michelin 11R22.5 XZE2+ x4 para Transportes Andes RUC ${RUC}, juan@andes.pe`, "ok", "enviar"];
    const stranger = await run(script, false);
    const frank = await run(script, true);
    expect(frank).toHaveLength(stranger.length);

    // 1. opciones: las mismas (ítems, opciones, precios); el resumen de lo entendido lleva "plazo: 45 días" y se suma la nota
    const [optS] = stranger[0];
    const [optF] = frank[0];
    expect(stranger[0]).toHaveLength(1);
    expect(frank[0]).toHaveLength(1);
    const optLinesS = optS.body!.split("\n");
    const optLinesF = optF.body!.split("\n").filter((l) => l !== PLAZO_NOTE);
    expect(optF.body!.split("\n")).toContain(PLAZO_NOTE);
    expect(optLinesF).toHaveLength(optLinesS.length);
    expect(optLinesF.map((l, i) => [optLinesS[i], l]).filter(([x, y]) => x !== y)).toEqual([
      ["Michelin 11R22.5 XZE2+ x4 · Transportes Andes RUC 20999000011 · juan@andes.pe", "Michelin 11R22.5 XZE2+ x4 · Transportes Andes RUC 20999000011 · juan@andes.pe · plazo: 45 días"],
    ]);

    // 2. cotización: mismos mensajes (ítems, precios, totales); el plazo sale en el resumen y el PDF; al final, el enlace
    const s1 = stranger[1];
    const f1 = frank[1];
    expect(f1.at(-1)).toEqual({ kind: "text", body: LINK_MSG });
    const f1q = f1.slice(0, -1);
    expect(f1q.map((m) => [m.kind, m.fileName, m.caption, m.mimeType])).toEqual(s1.map((m) => [m.kind, m.fileName, m.caption, m.mimeType]));
    const linesS = s1.filter((m) => m.kind === "text").flatMap((m) => m.body!.split("\n"));
    const allF = f1q.filter((m) => m.kind === "text").flatMap((m) => m.body!.split("\n"));
    // el correo suma el párrafo "Pago: 45 días" (y su línea en blanco); el resto se compara línea a línea
    const extra = allF.indexOf("Pago: 45 días");
    expect(extra).toBeGreaterThan(0);
    expect(allF[extra + 1]).toBe("");
    const linesF = allF.filter((_, i) => i !== extra && i !== extra + 1);
    expect(linesF).toHaveLength(linesS.length);
    const changed = linesF.map((l, i) => [linesS[i], l]).filter(([a, b]) => a !== b);
    // solo las líneas del plazo; las de ítems y precios son idénticas
    expect(changed).toEqual([
      ["Validez: 7 días", "Forma de pago: 45 días · Validez: 7 días"],
      ["Total US$ 1,830.80 (sin IGV) · Fotos 0/1", "Pago 45 días · Total US$ 1,830.80 (sin IGV) · Fotos 0/1"],
      [
        "📋 Pago: — · Plazo: — · Entrega: — · Validez: 7 días _(cambia con *pago: letras*, *plazo: 45 días*, *entrega: inmediata*)_",
        "📋 Pago: — · Plazo: 45 días · Entrega: — · Validez: 7 días _(cambia con *pago: letras*, *plazo: 45 días*, *entrega: inmediata*)_",
      ],
    ]);
    expect(linesF.filter((l) => /US\$|×| x /.test(l)).map((l) => l.replace(/^Pago 45 días · /, ""))).toEqual(linesS.filter((l) => /US\$|×| x /.test(l)));

    // 3. enviar: mismo correo y mismas respuestas
    expect(frank[2]).toEqual(stranger[2]);
  });

  it("adjuntos (lista de precios reenviada, foto …): respuestas idénticas", async () => {
    const doc: InboundMessage = { id: "", from: PHONE, timestamp: "1", type: "document", text: undefined, forwarded: true, media: { id: "lista-xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileName: "lista.xlsx" } };
    const foto: InboundMessage = { id: "", from: PHONE, timestamp: "1", type: "image", text: "foto Michelin XZE2+", forwarded: false, media: { id: "foto-1", mimeType: "image/jpeg", caption: "foto Michelin XZE2+" } };
    const listaConLeyenda: InboundMessage = { ...doc, forwarded: false, text: "lista Llantas del Sur", media: { ...doc.media!, caption: "lista Llantas del Sur" } };
    const script = [doc, "Llantas del Sur", foto, listaConLeyenda, "Llantas del Sur"];
    const stranger = await run(script, false);
    const frank = await run(script, true);
    expect(frank).toEqual(stranger);
    expect(frank.flat().length).toBeGreaterThan(0);
  });
});
