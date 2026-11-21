/**
 * Corrida F, punto 3: ninguna pantalla del portal ni respuesta del bot muestra comandos de terminal (`npm run …`) ni
 * nombres de variables de entorno. Dos partes:
 *
 *  1. Escaneo estático acotado de lo que se VE: en las pantallas (src/app/**) el texto JSX y las cadenas; en el bot
 *     (handler, portal/bot, guard, quote, ingest, llm) las cadenas. Cómo se distingue lo visible de los registros: se quitan
 *     los comentarios y se ignoran las líneas de registro (`console.*`, `log(`, `this.log(`, `ctx.log(`, `.warn(`) y los
 *     accesos al entorno (`process.env.X`, `env.X`, `env["X"]`); una cadena que es SOLO un nombre de variable
 *     ("ADMIN_NUMBERS", en una lista de claves) es un dato, no un texto. Los errores que se lanzan (`throw new Error`)
 *     cuentan como visibles, salvo los que se listan aquí (ERROR_ALLOWED) con la razón: van al registro y al usuario le
 *     llega otro texto.
 *  2. Casos dinámicos de los avisos conocidos, ejecutando el bot con el store JSON (voz apagada, sin clave de voz, tope de
 *     voz y el aviso al administrador, portal sin configurar, un error de la base que nombra una migración) y mirando lo
 *     que se envió.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsSchema, type Settings } from "../settings";
import { JsonStore } from "../store/json-store";
import { FakeWhatsAppClient } from "../whatsapp/client";
import { BotHandler } from "../whatsapp/handler";
import type { InboundMessage } from "../whatsapp/webhook";
import { JsonPortalStore } from "../portal/store";
import { configureReportBot } from "../portal/bot/report";
import { CONFIG_ERROR_TEXT, hasTechText, TECH_TEXT_RE, TEMP_ERROR_TEXT, userErrorText } from "./user-text";

const ROOT = path.resolve(__dirname, "../../..");

function files(dir: string, exts: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__golden__" || name === "node_modules") continue;
      out.push(...files(p, exts));
    } else if (exts.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Mensajes de error que nunca se muestran tal cual (archivo relativo + inicio del mensaje) y por qué: se lanzan, van al
 * registro y al usuario le llega otro texto.
 */
const ERROR_ALLOWED: { file: string; starts: string; why: string }[] = [
  { file: "src/lib/bot.ts", starts: "WHATSAPP_TOKEN", why: "arranque del webhook sin credenciales: va al registro de Vercel" },
  { file: "src/lib/portal/bot/report.ts", starts: "WhatsApp no configurado", why: "la descarga falla, se registra y se responde VOICE_DOWNLOAD_FAILED" },
  { file: "src/lib/portal/voice/deepgram.ts", starts: "La transcripción de voz no está configurada", why: "VoiceNotConfigured: se responde VOICE_OFF" },
  { file: "src/lib/portal/auth/tokens.ts", starts: "Falta PORTAL_SESSION_SECRET", why: "PortalAuthConfigError: la pantalla y el chat dicen 'contacta al administrador' (configErrorPage, noConfigReply)" },
  { file: "src/lib/portal/auth/tokens.ts", starts: "PORTAL_SESSION_SECRET es demasiado corto", why: "PortalAuthConfigError: la pantalla y el chat dicen 'contacta al administrador' (configErrorPage, noConfigReply)" },
  { file: "src/lib/store/pg-store.ts", starts: "falta la tabla", why: "error de la base: el handler lo muestra con userErrorText" },
  { file: "src/lib/drive/sync.ts", starts: "Google Drive not configured", why: "API interna /api/ingest/refresh (JSON para el cron), no es una pantalla" },
  // corrida J: por qué no sale la invitación de calendario; va al registro y a la actividad, al vendedor le llega
  // "el correo del bot no está configurado" (inviteLines en commands/cita.ts)
  { file: "src/lib/portal/calendar/mail.ts", starts: "falta RESEND_API_KEY", why: "motivo de calendarEmailStatus: registro y actividad, no el chat" },
  { file: "src/lib/portal/calendar/mail.ts", starts: "falta EMAIL_FROM", why: "motivo de calendarEmailStatus: registro y actividad, no el chat" },
  { file: "src/lib/portal/calendar/mail.ts", starts: "EMAIL_FROM", why: "motivo de calendarEmailStatus: registro y actividad, no el chat" },
];
/** Archivos que no son de cara al usuario (CLI, rutas internas que devuelven JSON a tareas programadas). */
const NOT_VISIBLE = [/^src\/cli\//, /^src\/app\/api\/cron\//, /^src\/lib\/portal\/store\/migrate-guard\.ts$/, /^src\/lib\/whatsapp\/webhook\.ts$/, /^src\/lib\/portal\/survey\/invite\.ts$/];

const LOG_LINE = /console\.|(?:^|[^\w])log\(|\.log\(|\.warn\(|\.error\(/;

/** Las cadenas y el texto JSX de una línea de código (sin comentarios). */
function visibleBits(line: string, tsx: boolean): string[] {
  const clean = line.replace(/process\.env\.[A-Z0-9_]+|\benv\.[A-Z0-9_]+|\benv\[["'][A-Z0-9_]+["']\]/g, "");
  const out: string[] = [];
  for (const m of clean.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) out.push((m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " "));
  if (tsx) for (const m of clean.matchAll(/>([^<>{}]+)</g)) out.push(m[1]);
  // una cadena que es solo un nombre de variable es una clave (dato), no texto
  return out.filter((s) => !/^[A-Z][A-Z0-9_]*$/.test(s.trim()));
}

function stripComments(src: string): string {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function scan(rel: string[]): string[] {
  const hits: string[] = [];
  for (const file of rel) {
    const relPath = path.relative(ROOT, file).split(path.sep).join("/");
    if (NOT_VISIBLE.some((r) => r.test(relPath))) continue;
    const src = stripComments(readFileSync(file, "utf8"));
    src.split("\n").forEach((line, i) => {
      if (LOG_LINE.test(line) || /^\s*import\s/.test(line)) return;
      for (const bit of visibleBits(line, file.endsWith(".tsx"))) {
        if (!TECH_TEXT_RE.test(bit)) continue;
        if (ERROR_ALLOWED.some((a) => a.file === relPath && bit.trimStart().startsWith(a.starts))) continue;
        hits.push(`${relPath}:${i + 1}: ${bit.trim().slice(0, 120)}`);
      }
    });
  }
  return hits;
}

describe("textos visibles sin comandos ni variables (escaneo)", () => {
  it("el patrón reconoce comandos y variables, y deja pasar textos normales", () => {
    for (const t of ["Se borran con npm run portal:clear-demo", "falta DEEPGRAM_API_KEY", "PORTAL_ADMIN_NUMBER", "SURVEY_AUTO apagado", "corre npx tsx algo"]) expect(hasTechText(t), t).toBe(true);
    for (const t of ["Cotización COT-0012 lista", "295/80R22.5 x8 a US$ 254", "*Reporte de visita* — ZBUSS", "Contacta al administrador", "IGV 18%"]) expect(hasTechText(t), t).toBe(false);
    expect(userErrorText("falta la tabla contract_prices: corre npm run db:migrate")).toBe("falta configurar algo en el servidor (contacta al administrador)");
    expect(userErrorText("base caída")).toBe("base caída");
  });

  it("un error técnico que no es de configuración dice 'problema temporal', no 'falta configurar' (corrida H, 16/11)", () => {
    // lo que vio el vendedor con asignarme: el error de la lib postgres parecía un nombre de variable
    const tx = Object.assign(new Error("UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1"), { code: "UNSAFE_TRANSACTION" });
    expect(userErrorText(tx)).toBe(TEMP_ERROR_TEXT);
    expect(userErrorText(tx.message)).toBe(TEMP_ERROR_TEXT);
    // errores de la base o de la red, aunque no tengan forma de variable
    const pg = Object.assign(new Error('null value in column "price_date" of relation "prices" violates not-null constraint'), { name: "PostgresError", code: "23502" });
    expect(userErrorText(pg)).toBe(TEMP_ERROR_TEXT);
    expect(userErrorText(Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:6543"), { code: "ETIMEDOUT" }))).toBe(TEMP_ERROR_TEXT);
    expect(userErrorText(new Error("write CONNECTION_CLOSED aws-0.pooler.supabase.com:6543"))).toBe(TEMP_ERROR_TEXT);
    // falta de verdad algo: variable o migración
    expect(userErrorText(new Error("WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set"))).toBe(CONFIG_ERROR_TEXT);
    expect(userErrorText(Object.assign(new Error('relation "contract_prices" does not exist'), { name: "PostgresError", code: "42P01" }))).toBe(CONFIG_ERROR_TEXT);
    expect(userErrorText(new Error("falta la tabla contract_prices: corre npm run db:migrate"))).toBe(CONFIG_ERROR_TEXT);
    // un mensaje pensado para el usuario sigue tal cual
    expect(userErrorText(new Error("No encontré la empresa ZBUSS"))).toBe("No encontré la empresa ZBUSS");
  });

  it("pantallas del portal y de la encuesta (src/app)", () => {
    expect(scan(files(path.join(ROOT, "src/app"), /\.tsx?$/))).toEqual([]);
  });

  it("respuestas del bot (handler, portal, guard, cotizador, ingesta, modelo)", () => {
    const dirs = ["src/lib/portal", "src/lib/guard", "src/lib/quote", "src/lib/ingest", "src/lib/llm"].map((d) => path.join(ROOT, d));
    const list = [...dirs.flatMap((d) => files(d, /\.tsx?$/)), path.join(ROOT, "src/lib/whatsapp/handler.ts"), path.join(ROOT, "src/lib/bot.ts")];
    expect(scan(list)).toEqual([]);
  });
});

// ── casos dinámicos ──

const settings: Settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
  salespeople: { "51900000001": { name: "Frank Rodríguez" } },
});
const FRANK = "51900000001";
const ADMIN = "51900000077";
const KEYS = ["LLM_DISABLED", "PHOTOS_DISABLED", "PORTAL_SESSION_SECRET", "PORTAL_BASE_URL", "DEEPGRAM_API_KEY", "VOICE_DISABLED", "PORTAL_ADMIN_NUMBER"];
let seq = 0;
let client: FakeWhatsAppClient;
let prices: JsonStore;
let portal: JsonPortalStore;
const saved: Record<string, string | undefined> = {};

const text = (body: string): InboundMessage => ({ id: `wamid.u${++seq}`, from: FRANK, timestamp: "1", type: "text", text: body, forwarded: false });
function audio(): InboundMessage {
  const id = `aud-u${++seq}`;
  client.media.set(id, { data: Buffer.from("OggS-fake"), mimeType: "audio/ogg" });
  return { id: `wamid.u${seq}`, from: FRANK, timestamp: "1", type: "audio", forwarded: false, media: { id, mimeType: "audio/ogg" } };
}
const sentTexts = () => client.sent.map((m) => m.body ?? "").filter(Boolean);

beforeEach(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  process.env.LLM_DISABLED = "1";
  process.env.PHOTOS_DISABLED = "1";
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  process.env.PORTAL_BASE_URL = "https://portal.example.pe";
  client = new FakeWhatsAppClient();
  prices = JsonStore.memory();
  portal = JsonPortalStore.memory();
  await portal.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  const deepgramFetch = (async () => new Response(JSON.stringify({ metadata: { duration: 3 }, results: { channels: [{ alternatives: [{ transcript: "visité zbuss", confidence: 0.9 }] }] } }), { status: 200 })) as typeof fetch;
  configureReportBot({ llm: null, deepgramFetch, downloadMedia: (id) => client.downloadMedia(id), logMessage: (e) => prices.logMessage(e) });
});

afterEach(() => {
  configureReportBot(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const bot = (store: JsonStore = prices) => new BotHandler({ client, store, settings, portalStore: portal });

describe("textos visibles sin comandos ni variables (casos que provocan los avisos)", () => {
  it("voz sin clave, voz apagada y tope de voz (y el aviso al administrador)", async () => {
    await bot().handle(audio()); // sin clave de Deepgram
    process.env.DEEPGRAM_API_KEY = "dg-test";
    process.env.VOICE_DISABLED = "1";
    await bot().handle(audio());
    delete process.env.VOICE_DISABLED;
    process.env.PORTAL_ADMIN_NUMBER = ADMIN;
    await prices.recordUsage({ phone: FRANK, purpose: "voz", model: "nova-3", audioSeconds: 3 * 3600, costUsd: 0, at: new Date() });
    await bot().handle(audio());
    const all = sentTexts();
    expect(all.some((t) => /voz/i.test(t))).toBe(true);
    expect(client.sent.some((m) => m.to === ADMIN && /Tope de consumo/.test(m.body ?? ""))).toBe(true);
    expect(all.filter(hasTechText)).toEqual([]);
  });

  it("portal sin configurar: el chat no nombra la variable", async () => {
    delete process.env.PORTAL_SESSION_SECRET;
    await bot().handle(text("portal"));
    expect(sentTexts().at(-1)).toContain("contacta al administrador");
    expect(sentTexts().filter(hasTechText)).toEqual([]);
  });

  it("un error de la base que nombra la migración no llega tal cual al chat", async () => {
    const broken = new Proxy(prices, {
      get(target, prop) {
        if (prop === "listQuotes") return async () => Promise.reject(new Error("falta la tabla contract_prices: corre npm run db:migrate"));
        return Reflect.get(target, prop);
      },
    });
    await bot(broken).handle(text("cotizaciones"));
    expect(sentTexts().at(-1)).toContain("Ocurrió un error");
    expect(sentTexts().filter(hasTechText)).toEqual([]);
  });
});
