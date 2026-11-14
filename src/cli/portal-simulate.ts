/**
 * Simulador de punta a punta del bot (portal + cotizador): inyecta mensajes en el MISMO BotHandler.handle() que usa el
 * webhook (src/lib/bot.ts), como si llegaran del número de un usuario, con WhatsApp reemplazado por la consola.
 * No envía nada real: los textos se imprimen, los documentos/imágenes se guardan en out/simulacion/ (con prefijo de
 * secuencia) y los correos de cotización quedan como borrador en la misma carpeta.
 *
 *   npm run portal:simulate -- --as frank                         (interactivo)
 *   npm run portal:simulate -- --as frank --script scripts/guion-frank.txt
 *   npm run portal:simulate -- --as 51955344340 --audio nota.ogg
 *
 * Guion: una línea por mensaje; se ignoran líneas vacías y las que empiezan con #.
 *   @audio <archivo>             nota de voz: con DEEPGRAM_API_KEY se transcribe de verdad (Deepgram); sin ella se salta, con aviso
 *   @voz <transcripción>         nota de voz con la transcripción inyectada (sin Deepgram ni archivo): entra como un audio
 *                                real y el bot recibe <transcripción> como si la devolviera Deepgram (corrida D, punto 8:
 *                                cotización por voz). Ver scripts/guion-voz.txt
 *   @doc <archivo> [leyenda]     documento o imagen (por extensión) con leyenda opcional
 *   @fwd <texto>                 mensaje reenviado
 *   @btn <título, id o número>   pulsa un botón / fila del último mensaje interactivo del bot ("@btn Sí, guardar",
 *                                "@btn Asignarme", "@btn 2" en una lista). Entra como un `interactive` real
 *                                (button_reply / list_reply) por parseWebhook, con su id `pt:…`; si no existe, es un error
 *   @btn <botón> || <texto>      pulsa el botón si el bot lo ofreció; si no (p. ej. la empresa ya era suya en estos
 *                                datos), manda <texto> escrito, que es su equivalente
 *   @como <número|alias>         cambia de remitente a mitad de guion (alias = usuario del portal o vendedor de
 *                                config/pilot.json, como --as; un número cualquiera prueba la puerta de números no
 *                                registrados). Los mensajes siguientes salen de ese número
 *   @rafaga <n> <texto>          manda <n> veces <texto> en el mismo instante (prueba el tope de mensajes por minuto,
 *                                limits.burstPerMinute); los contadores salen sumados en una línea. El resto del guion
 *                                va a ritmo humano para ese tope: el reloj de ráfagas avanza 3 s por línea
 *   @cron [ventana]              corre el resumen diario (runDailyDigest, como /api/cron/daily) con este WhatsApp de
 *                                consola, para todos los usuarios; con `ventana` cada envío falla como fuera de las 24 h
 *                                (131047) y el resumen queda como aviso pendiente para el siguiente mensaje del usuario
 *   @pausa <segundos>            avanza el reloj del tope por minuto (p. ej. @pausa 60 antes de una @rafaga: la ventana
 *                                empieza vacía y el número de mensajes procesados no depende de las líneas anteriores)
 *   @texto-largo <n> <semilla>   un mensaje de texto de exactamente <n> caracteres (la semilla repetida)
 *   @empresa-prueba <RUC> <razón social>
 *                                crea en la copia de datos una empresa inventada como lo hace el import del padrón MTC
 *                                (upsertCompanies; la razón social es dato de terceros: HTML, instrucciones…), sin dueño
 *   @encuesta <comentario>       crea (en la copia) una encuesta para una empresa de prueba inventada y la responde con
 *                                ese comentario en "¿qué deberíamos mejorar?" por la MISMA función que la server action
 *                                (surveyFormTooLarge + submitSurvey); cuenta modelo/Deepgram igual que un mensaje
 * Verificación (corrida E, punto 6): sobre el mensaje anterior (o el bloque anterior de @rafaga / @encuesta). Si alguna
 * no se cumple, el guion sale con código 1 y al final se imprime la tabla de casos.
 *   @espera <clave><op><n> …     claves: modelo (llamadas medidas), deepgram, descargas, respuestas (mensajes al
 *                                remitente), admin (al administrador), otros (a cualquier otro número), bloqueadas (por
 *                                tope); op: = (exacto), <= o >=
 *   @espera-texto <fragmento>    alguna respuesta (a cualquier destinatario) contiene el fragmento (sin distinguir mayúsculas)
 *   @no-texto <fragmento>        ninguna respuesta lo contiene
 *   @sin-cambios [salvo t1 t2…]  los datos de negocio (store del portal y del cotizador) no cambiaron; `salvo` permite
 *                                cambios en esas tablas (p. ej. la respuesta de @encuesta). Ver BUSINESS_EXCLUDED
 * `modelo` y `deepgram` cuentan lo que pasó por el medidor (guard/usage.ts) o por el fetch de Deepgram del simulador, y
 * también las peticiones de red a api.anthropic.com / api.deepgram.com (fetch global envuelto): vale el mayor de los dos,
 * así una llamada que se saltara el medidor también cuenta.
 * En modo interactivo valen las mismas formas y /quit.
 *
 * Datos: por defecto store JSON del portal (PORTAL_STORE=json) y del cotizador, sin DATABASE_URL (salvo --db). Trabaja
 * sobre COPIAS en out/simulacion/ (data/ queda intacto); --persist escribe en data/portal-store.json y data/store.json.
 * Sin PORTAL_SESSION_SECRET usa uno de simulación. Sale con código 1 si algún mensaje termina en "Ocurrió un error" (guion).
 * Corrida G: si la copia no tiene puntajes de atractivo (`mejores` diría que el ranking no está listo), se calculan en la
 * copia con el catálogo de la copia del cotizador (recalcScores), como `npm run portal:recalc-score` en la base.
 * Contadores (corrida E): tras cada mensaje, cuántas llamadas al modelo, a Deepgram (también las de @voz, que en
 * producción irían a Deepgram) y descargas de medios provocó, y si alguna se bloqueó por un tope; los totales al final.
 */
import "./env";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { OutboundMessage, WhatsAppClient } from "../lib/whatsapp/client";
import { stripPortalPrefix, type InteractiveMessage } from "../lib/whatsapp/interactive";
import { parseWebhook, type InboundMessage } from "../lib/whatsapp/webhook";

interface Args {
  as: string;
  script?: string;
  audio?: string;
  db: boolean;
  persist: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { as: "frank", db: false, persist: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (!v) throw new Error(`falta el valor de ${a}`);
      return v;
    };
    if (a === "--as") out.as = next();
    else if (a === "--script") out.script = next();
    else if (a === "--audio") out.audio = next();
    else if (a === "--db") out.db = true;
    else if (a === "--persist") out.persist = true;
    else if (a === "--help" || a === "-h") {
      console.log("Uso: npm run portal:simulate -- --as <usuario|número> [--script <archivo>] [--audio <archivo>] [--db] [--persist]");
      process.exit(0);
    } else throw new Error(`argumento desconocido: ${a}`);
  }
  return out;
}

const outDir = path.resolve(process.cwd(), "out/simulacion");
const SIM_SECRET = "simulacion-portal-0123456789abcdef-no-usar-en-produccion";

/** Entorno de simulación: JSON local, sin base salvo --db, sin correo real; copias de los stores salvo --persist. */
function prepareEnv(args: Args): string[] {
  const notes: string[] = [];
  fs.mkdirSync(outDir, { recursive: true });
  // adjuntos y correos de la corrida anterior (los nombres empiezan con la secuencia)
  for (const f of fs.readdirSync(outDir)) if (/^(?:\d{3}-|correo-\d{2}-)/.test(f)) fs.rmSync(path.join(outDir, f));
  if (!args.db) {
    if (process.env.DATABASE_URL) notes.push("DATABASE_URL ignorada (usa --db para la base real).");
    delete process.env.DATABASE_URL;
    process.env.PORTAL_STORE = "json";
    if (!args.persist) {
      const copy = (src: string, dst: string, envKey: string) => {
        if (process.env[envKey]) return; // ruta explícita: se respeta
        const from = path.resolve(process.cwd(), src);
        const to = path.join(outDir, dst);
        if (fs.existsSync(from)) fs.copyFileSync(from, to);
        else if (fs.existsSync(to)) fs.rmSync(to);
        process.env[envKey] = to;
      };
      copy("data/portal-store.json", "portal-store.sim.json", "PORTAL_STORE_PATH");
      copy("data/store.json", "store.sim.json", "STORE_PATH");
      notes.push("Datos: copia de data/ en out/simulacion/ (data/ no cambia; --persist para escribir en data/).");
    } else notes.push("Datos: data/portal-store.json y data/store.json (--persist).");
  } else notes.push("⚠️ --db: se usa DATABASE_URL (base real).");
  delete process.env.RESEND_API_KEY; // los correos quedan como borrador en out/simulacion
  if (!process.env.PORTAL_SESSION_SECRET) {
    process.env.PORTAL_SESSION_SECRET = SIM_SECRET;
    notes.push("PORTAL_SESSION_SECRET de simulación (los enlaces no sirven en el portal real).");
  }
  return notes;
}

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ics": "text/calendar",
};

const safe = (s: string) => s.replace(/[^\w.\- áéíóúñÁÉÍÓÚÑ]+/g, "_").slice(0, 120) || "archivo";

/** WhatsApp de consola: imprime y guarda adjuntos; marca las respuestas de error del handler. */
class ConsoleWhatsAppClient implements WhatsAppClient {
  media = new Map<string, { data: Buffer; mimeType: string; fileName?: string }>();
  seq = 0;
  texts = 0;
  files = 0;
  errors: string[] = [];
  /** Todo lo enviado (destinatario y texto visible), para @espera / @espera-texto / @no-texto. */
  outbox: { to: string; text: string }[] = [];
  private save(name: string, data: Buffer): string {
    const p = path.join(outDir, `${String(++this.seq).padStart(3, "0")}-${safe(name)}`);
    fs.writeFileSync(p, data);
    this.files++;
    return p;
  }
  /** @rafaga: no imprime cada respuesta (se cuentan igual). */
  quiet = false;
  private print(m: OutboundMessage, to: string, extra = ""): void {
    if (this.quiet) return;
    const who = to === currentPhone ? "" : ` (→ ${to})`;
    if (m.kind === "text") console.log(`\n🤖${who} ${m.body}\n`);
    else console.log(`\n🤖${who} 📎 ${m.fileName ?? m.link ?? m.kind}${m.caption ? `  «${m.caption}»` : "  (sin leyenda)"}${extra}\n`);
  }
  async sendText(to: string, body: string): Promise<void> {
    this.texts++;
    this.outbox.push({ to, text: body });
    if (/^Ocurrió un error/.test(body)) this.errors.push(body);
    this.print({ to, kind: "text", body }, to);
  }
  async sendDocument(to: string, file: Buffer, fileName: string, caption?: string, mimeType?: string): Promise<void> {
    this.outbox.push({ to, text: `${fileName}${caption ? ` ${caption}` : ""}` });
    const p = this.save(fileName, file);
    this.print({ to, kind: "document", fileName, caption, mimeType }, to, `\n   guardado en ${path.relative(process.cwd(), p)}`);
  }
  async sendImage(to: string, image: { link?: string; data?: Buffer; mimeType?: string }, caption?: string): Promise<void> {
    this.outbox.push({ to, text: caption ?? "" });
    const p = image.data ? this.save(`imagen${image.mimeType === "image/png" ? ".png" : ".jpg"}`, image.data) : null;
    this.print({ to, kind: "image", link: image.link, caption, fileName: p ? path.basename(p) : image.link }, to, p ? `\n   guardado en ${path.relative(process.cwd(), p)}` : "");
  }
  /** El último interactivo enviado al usuario (para @btn). */
  lastInteractive: InteractiveMessage | null = null;
  async sendInteractive(to: string, message: InteractiveMessage): Promise<void> {
    this.texts++;
    const titles = message.type === "button" ? message.buttons.map((b) => b.title) : message.sections.flatMap((sec) => sec.rows).map((r) => `${r.title} ${r.description ?? ""}`);
    this.outbox.push({ to, text: [message.body, ...titles].join("\n") });
    if (to === currentPhone) this.lastInteractive = message;
    const who = to === currentPhone ? "" : ` (→ ${to})`;
    const opts =
      message.type === "button"
        ? message.buttons.map((b) => `[${b.title}]`).join(" ")
        : `☰ ${message.button}\n${message.sections
            .flatMap((sec) => sec.rows)
            .map((r, i) => `   ${i + 1}. ${r.title}${r.description ? ` — ${r.description}` : ""}  (id: ${r.id})`)
            .join("\n")}`;
    if (!this.quiet) console.log(`\n🤖${who} ${message.body}\n   ${opts}\n`);
  }
  /** Descargas de medios (contador de la corrida E). */
  downloads = 0;
  async downloadMedia(mediaId: string) {
    this.downloads++;
    const m = this.media.get(mediaId);
    if (!m) throw new Error(`medio simulado no encontrado: ${mediaId}`);
    return m;
  }
}

const foldBtn = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** El botón / fila de `m` que corresponde a `arg` (título, id con o sin prefijo, o número de fila de una lista). */
function findPressed(m: InteractiveMessage, arg: string): { kind: "button_reply" | "list_reply"; id: string; title: string; description?: string } | null {
  const a = foldBtn(arg);
  if (m.type === "button") {
    const b = m.buttons.find((x) => foldBtn(x.title) === a || foldBtn(x.id) === a || foldBtn(stripPortalPrefix(x.id)) === a);
    return b ? { kind: "button_reply", id: b.id, title: b.title } : null;
  }
  const rows = m.sections.flatMap((sec) => sec.rows);
  const n = /^\d{1,2}$/.test(a) ? rows[Number(a) - 1] : undefined;
  const r = n ?? rows.find((x) => foldBtn(x.title) === a || foldBtn(x.id) === a || foldBtn(stripPortalPrefix(x.id)) === a);
  return r ? { kind: "list_reply", id: r.id, title: r.title, description: r.description } : null;
}

let currentPhone = "";

/** --as: nombre de usuario del portal ("frank"), de un vendedor de config/pilot.json, o número. */
async function resolvePhone(as: string, listUsers: () => Promise<{ nombre: string; whatsapp: string | null }[]>): Promise<{ phone: string; label: string }> {
  const digits = as.replace(/\D/g, "");
  if (digits.length >= 8) return { phone: digits, label: digits };
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = fold(as.trim());
  const users = await listUsers();
  const u = users.find((x) => x.whatsapp && fold(x.nombre).startsWith(q)) ?? users.find((x) => x.whatsapp && fold(x.nombre).includes(q));
  if (u?.whatsapp) return { phone: u.whatsapp, label: u.nombre };
  const pilotFile = path.resolve(process.cwd(), "config/pilot.json");
  if (fs.existsSync(pilotFile)) {
    const sp = (JSON.parse(fs.readFileSync(pilotFile, "utf8")).salespeople ?? {}) as Record<string, { name?: string } | string>;
    for (const [num, v] of Object.entries(sp)) {
      if (typeof v === "object" && v?.name && fold(v.name).startsWith(q) && /^\d+$/.test(num)) return { phone: num, label: `${v.name} (config/pilot.json; no está en users)` };
    }
  }
  throw new Error(`No encontré al usuario «${as}» (ni en users del portal ni en config/pilot.json). Usa --as <número>.`);
}

/** Peticiones de red al modelo y a Deepgram (fetch global envuelto antes de crear los clientes). */
const net = { llm: 0, deepgram: 0 };
function watchNetwork(): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/^https?:\/\/[^/]*anthropic\.com\//i.test(url)) net.llm++;
    if (/^https?:\/\/[^/]*deepgram\.com\//i.test(url)) net.deepgram++;
    return realFetch(input, init);
  }) as typeof fetch;
}

/**
 * Tablas que NO son datos de negocio para @sin-cambios (registro o estado de la conversación):
 *  - cotizador: messages (registro de WhatsApp), processed (ids procesados y marcas de la puerta / avisos de tope),
 *    usage (llm_usage + audio_usage), blocked (blocked_inbound), quoteShadow (quote_shadow), conversations (el paso del
 *    diálogo del cotizador: cambia con cada mensaje —updatedAt, "cancelar"— y no es un dato guardado; lo que el vendedor
 *    confirma termina en quotes / counters, que sí se comparan).
 *  - portal: portalConversations (paso pendiente, borrador del reporte por confirmar, pausas: estado del diálogo; lo
 *    confirmado va a activities / contacts / opportunities…, que sí se comparan).
 * Todo lo demás (precios, cotizaciones, contadores, contratos, fotos, empresas, flota, ventas, usuarios, tokens de
 * acceso, sesiones, contactos, oportunidades, historial, actividades, citas, encuestas, vocabulario, OC, crédito) cuenta.
 * rate_limit_hits vive solo en memoria en el store JSON (no está en la instantánea).
 */
const BUSINESS_EXCLUDED: Record<"cotizador" | "portal", Set<string>> = {
  cotizador: new Set(["messages", "processed", "usage", "blocked", "quoteShadow", "conversations"]),
  portal: new Set(["portalConversations"]),
};

type Snapshot = Map<string, string>;

/** Huella por tabla de los datos de negocio de los dos stores JSON (en memoria; no escribe los archivos). */
function businessSnapshot(portal: unknown, store: unknown): Snapshot {
  const p = portal as { snapshot?: () => Record<string, unknown> };
  const q = store as { data?: Record<string, unknown> };
  if (typeof p.snapshot !== "function" || !q.data || typeof q.data !== "object") throw new Error("@sin-cambios necesita los stores JSON (sin --db)");
  const out: Snapshot = new Map();
  const add = (side: "cotizador" | "portal", data: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(data)) {
      if (BUSINESS_EXCLUDED[side].has(k)) continue;
      out.set(`${side}.${k}`, createHash("sha1").update(JSON.stringify(v) ?? "").digest("hex"));
    }
  };
  add("portal", p.snapshot.call(portal));
  add("cotizador", q.data);
  return out;
}

/** Tablas cuya huella cambió entre dos instantáneas. */
function changedTables(a: Snapshot, b: Snapshot): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => a.get(k) !== b.get(k)).sort();
}

/** Un caso del guion: un mensaje, un bloque de @rafaga o una @encuesta, con lo que provocó. */
interface Unit {
  label: string;
  lineNo: number;
  from: string;
  modelo: number;
  deepgram: number;
  descargas: number;
  bloqueadas: number;
  out: { to: string; text: string }[];
  before: Snapshot | null;
  checked: boolean;
  unchanged: boolean | null;
  failures: string[];
}

const CHECK_KEYS = ["modelo", "deepgram", "descargas", "respuestas", "admin", "otros", "bloqueadas"] as const;
type CheckKey = (typeof CHECK_KEYS)[number];
const isCheckLine = (l: string) => /^@(?:espera|espera-texto|no-texto|sin-cambios)(?:\s|$)/.test(l);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const notes = prepareEnv(args);
  watchNetwork();
  // después de preparar el entorno (los stores leen las variables al crearse)
  const { loadSettings } = await import("../lib/settings");
  const { getStore } = await import("../lib/store");
  const { getPortalStore } = await import("../lib/portal/store");
  const { BotHandler } = await import("../lib/whatsapp/handler");

  const portal = await getPortalStore();
  const store = await getStore();
  // corrida G: puntajes en la copia si no los tiene (solo sobre la copia: nunca en data/ ni en la base)
  const onCopy = !args.db && !args.persist && process.env.PORTAL_STORE_PATH === path.join(outDir, "portal-store.sim.json");
  if (onCopy && !(await portal.latestScoreRun())) {
    const { recalcScores } = await import("../lib/portal/scoring/recalc");
    const { loadPortalConfig } = await import("../lib/portal/config");
    const r = await recalcScores(portal, loadPortalConfig().scoring, { prices: store, log: (m) => console.error(`[puntaje] ${m}`) });
    await portal.flush();
    notes.push(`Puntajes calculados en la copia: ${r.empresas} empresas (A ${r.conteo.A} · B ${r.conteo.B} · C ${r.conteo.C}) en ${r.durationMs} ms.`);
  }
  let me = await resolvePhone(args.as, () => portal.listUsers());
  currentPhone = me.phone;
  const client = new ConsoleWhatsAppClient();
  // sin Graph API: las notas de voz (@audio / --audio) se "descargan" del archivo local que el guion cargó en el cliente
  const { configureReportBot } = await import("../lib/portal/bot");
  // @voz: la transcripción va en cola y este fetch la devuelve como Deepgram; el resto (@audio con clave) va a Deepgram
  const realDeepgram = !!process.env.DEEPGRAM_API_KEY;
  const injected: string[] = [];
  // contadores por mensaje (corrida E): modelo (eventos del medidor), Deepgram (este fetch) y descargas (el cliente)
  const counts = { llm: 0, deepgram: 0, blocked: 0, tokens: 0 };
  const totalsRun = { llm: 0, deepgram: 0, downloads: 0, blocked: 0, tokens: 0 };
  const { onUsageEvent } = await import("../lib/guard/usage");
  onUsageEvent((e) => {
    if (e.kind === "llm") {
      counts.llm++;
      counts.tokens += e.inputTokens + e.outputTokens;
    } else if (e.kind === "blocked") counts.blocked++;
  });
  const deepgramFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    counts.deepgram++;
    const transcript = injected.shift();
    if (transcript === undefined) return fetch(url, init);
    return new Response(JSON.stringify({ metadata: { duration: 5 }, results: { channels: [{ alternatives: [{ transcript, confidence: 0.9 }] }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  configureReportBot({ downloadMedia: (id) => client.downloadMedia(id), deepgramFetch });
  let emailSeq = 0;
  // reloj del tope por minuto: un guion se lee a ritmo humano (3 s por línea), no como una ráfaga; @rafaga lo congela
  let burstNow = Date.now();
  const bot = new BotHandler({
    burstClock: () => burstNow,
    client,
    store,
    settings: loadSettings(),
    portalStore: portal,
    log: (m) => console.error(`[bot] ${m}`),
    sendEmail: async (quote, attachments, draft) => {
      const p = path.join(outDir, `correo-${String(++emailSeq).padStart(2, "0")}-${safe(quote.number)}.txt`);
      fs.writeFileSync(p, `To: ${draft.to}\nSubject: ${draft.subject}\n${attachments.map((a) => `Attachment: ${a.filename}\n`).join("")}\n${draft.body}\n`);
      console.log(`   ✉️  correo simulado (no enviado): ${path.relative(process.cwd(), p)}`);
      return { sent: true, id: "simulacion" };
    },
  });

  for (const n of notes) console.log(`ℹ️  ${n}`);
  console.log(`Simulando como ${me.label} (${me.phone}). Adjuntos en ${path.relative(process.cwd(), outDir)}/\n`);

  let n = 0;
  let sent = 0;
  let skipped = 0;
  const thrown: string[] = [];
  const baseMsg = (): InboundMessage => ({ id: `sim.${Date.now()}.${++n}`, from: me.phone, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", forwarded: false });

  /** Una línea del guion / del modo interactivo -> mensaje (null = nada que enviar). */
  const toMessage = (line: string): InboundMessage | null => {
    const msg = baseMsg();
    const media = (file: string, type: string, caption?: string) => {
      const abs = path.resolve(process.cwd(), file);
      if (!fs.existsSync(abs)) {
        console.log(`⚠️  no existe: ${file} (se salta)`);
        skipped++;
        return null;
      }
      const mime = MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
      const id = `media.sim.${n}`;
      client.media.set(id, { data: fs.readFileSync(abs), mimeType: mime, fileName: path.basename(abs) });
      msg.type = type === "doc" ? (mime.startsWith("image/") ? "image" : "document") : "audio";
      msg.media = { id, mimeType: mime, fileName: type === "doc" ? path.basename(abs) : undefined, caption };
      msg.text = caption;
      return msg;
    };
    const voz = line.match(/^@voz\s+(\S.*)$/);
    if (voz) {
      // sin clave real, una de simulación: la transcripción no sale de la máquina (deepgramFetch la devuelve)
      if (!process.env.DEEPGRAM_API_KEY) process.env.DEEPGRAM_API_KEY = "simulacion";
      injected.length = 0; // una transcripción por nota (si la anterior no llegó a Deepgram, no se arrastra)
      injected.push(voz[1].trim());
      const id = `media.sim.${n}`;
      client.media.set(id, { data: Buffer.from("OggS-simulado"), mimeType: "audio/ogg; codecs=opus" });
      msg.type = "audio";
      msg.media = { id, mimeType: "audio/ogg; codecs=opus" };
      return msg;
    }
    const audio = line.match(/^@audio\s+(\S.*)$/);
    if (audio) {
      if (!realDeepgram) {
        console.log(`⚠️  sin DEEPGRAM_API_KEY: se salta el audio ${audio[1].trim()}`);
        skipped++;
        return null;
      }
      return media(audio[1].trim(), "audio");
    }
    const doc = line.match(/^@doc\s+(\S+)(?:\s+(.+))?$/);
    if (doc) return media(doc[1], "doc", doc[2]?.trim());
    const btn = line.match(/^@btn\s+(.+?)(?:\s+\|\|\s+(.+))?$/);
    if (btn) {
      const last = client.lastInteractive;
      const hit = last ? findPressed(last, btn[1].trim()) : null;
      if (!hit && btn[2]) {
        console.log(`ℹ️  el bot no ofreció el botón «${btn[1].trim()}»: se escribe su equivalente`);
        msg.text = btn[2].trim();
        return msg;
      }
      if (!hit) {
        thrown.push(`@btn ${btn[1]}: no hay ese botón en el último mensaje interactivo`);
        console.log(`⚠️  no hay botón «${btn[1]}» en el último mensaje interactivo${last ? "" : " (no hubo ninguno)"}`);
        return null;
      }
      client.lastInteractive = null; // un botón se pulsa una vez
      // como lo manda WhatsApp: webhook con interactive.button_reply / list_reply (y el id `pt:…`)
      const reply = hit.kind === "button_reply" ? { button_reply: { id: hit.id, title: hit.title } } : { list_reply: { id: hit.id, title: hit.title, ...(hit.description ? { description: hit.description } : {}) } };
      const payload = {
        object: "whatsapp_business_account",
        entry: [{ changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [{ id: msg.id, from: msg.from, timestamp: msg.timestamp, type: "interactive", interactive: { type: hit.kind, ...reply } }] } }] }],
      };
      return parseWebhook(payload).messages[0] ?? null;
    }
    const fwd = line.match(/^@fwd\s+([\s\S]+)$/);
    if (fwd) {
      msg.text = fwd[1].replace(/\\n/g, "\n");
      msg.forwarded = true;
      return msg;
    }
    msg.text = line.replace(/\\n/g, "\n"); // "\n" escrito en el guion = salto de línea (pedidos de varias líneas)
    return msg;
  };

  /** @cron: el resumen diario con la hora real (force: aunque ya se haya mandado hoy en estos datos). */
  const runCron = async (arg: string) => {
    const { runDailyDigest } = await import("../lib/portal/notify/send");
    const outside = /^ventana$/i.test(arg.trim());
    console.log(`⏰ cron diario${outside ? " (simulando que WhatsApp rechaza por la ventana de 24 h)" : ""}`);
    const cronClient: Pick<WhatsAppClient, "sendText"> = outside
      ? { sendText: async () => Promise.reject(new Error("WhatsApp API 400: (#131047) Re-engagement message")) }
      : client;
    try {
      const r = await runDailyDigest({ store: portal, client: cronClient, now: new Date(), force: true, log: (m) => console.error(`[cron] ${m}`) });
      console.log(`   enviados ${r.enviados} · sin nada ${r.sinNada} · fuera de ventana ${r.fueraDeVentana} · errores ${r.errores}`);
      for (const e of r.resultados.filter((x) => x.status === "error")) thrown.push(`@cron ${e.nombre}: ${e.error}`);
    } catch (err) {
      thrown.push(`@cron: ${(err as Error).message}`);
      console.log(`💥 ${(err as Error).stack ?? err}`);
    }
  };

  /** @como: cambia de remitente (alias o número, como --as). */
  const switchSender = async (arg: string) => {
    try {
      me = await resolvePhone(arg.trim(), () => portal.listUsers());
      currentPhone = me.phone;
      client.lastInteractive = null;
      console.log(`🔀 Ahora escribe ${me.label} (${me.phone})`);
    } catch (err) {
      thrown.push(`@como ${arg}: ${(err as Error).message}`);
      console.log(`⚠️  ${(err as Error).message}`);
    }
  };

  /** @rafaga: n veces el mismo texto en el mismo instante; una línea con los contadores sumados. */
  const burst = async (count: number, body: string) => {
    const before = { ...totalsRun };
    const textsBefore = client.texts;
    const outBefore = client.outbox.length;
    client.quiet = true;
    try {
      for (let i = 0; i < count; i++) await send(body, { quiet: true });
    } finally {
      client.quiet = false;
    }
    const outs = client.outbox.slice(outBefore).filter((o) => o.to === currentPhone);
    const distinct = [...new Map(outs.map((o) => [o.text, 0])).keys()];
    for (const t of distinct) console.log(`   🤖 ×${outs.filter((o) => o.text === t).length}: ${t.split("\n")[0].slice(0, 100)}`);
    const blocked = totalsRun.blocked - before.blocked;
    console.log(`👤 [ráfaga] ${count} × «${body.slice(0, 60)}» → ${client.texts - textsBefore} respuesta(s)`);
    console.log(`   📊 modelo ${totalsRun.llm - before.llm} · Deepgram ${totalsRun.deepgram - before.deepgram} · descargas ${totalsRun.downloads - before.downloads}${blocked ? ` · bloqueadas por tope ${blocked}` : ""}`);
  };

  const send = async (line: string, opts: { quiet?: boolean; shown?: string } = {}): Promise<void> => {
    const cron = line.match(/^@cron\b\s*(.*)$/);
    if (cron) return runCron(cron[1]);
    const como = line.match(/^@como\s+(\S.*)$/);
    if (como) return switchSender(como[1]);
    const rafaga = line.match(/^@rafaga\s+(\d+)\s+(\S.*)$/);
    if (rafaga) {
      burstNow = Math.max(burstNow + 3000, Date.now());
      return burst(Math.min(Number(rafaga[1]), 2000), rafaga[2]);
    }
    if (!opts.quiet) burstNow = Math.max(burstNow + 3000, Date.now());
    const msg = toMessage(line);
    if (!msg) return;
    const shown = msg.type === "audio" && /^@voz\s/.test(line) ? `[voz] «${line.replace(/^@voz\s+/, "")}»` : msg.media ? `[${msg.type}] ${msg.media.fileName ?? ""} ${msg.text ?? ""}`.trim() : msg.forwarded ? `[reenviado] ${msg.text}` : msg.type === "interactive" ? `[botón] ${msg.interactiveTitle ?? ""} (id: ${msg.interactiveId ?? ""} → «${msg.text ?? ""}»)` : msg.text;
    if (!opts.quiet) console.log(`👤 ${opts.shown ?? shown}`);
    sent++;
    counts.llm = counts.deepgram = counts.blocked = counts.tokens = 0;
    const downloadsBefore = client.downloads;
    try {
      await bot.handle(msg);
    } catch (err) {
      thrown.push(`${line}: ${(err as Error).message}`);
      console.log(`💥 ${(err as Error).stack ?? err}`);
    }
    const dl = client.downloads - downloadsBefore;
    totalsRun.llm += counts.llm;
    totalsRun.deepgram += counts.deepgram;
    totalsRun.downloads += dl;
    totalsRun.blocked += counts.blocked;
    totalsRun.tokens += counts.tokens;
    if (!opts.quiet) console.log(`   📊 modelo ${counts.llm}${counts.tokens ? ` (${counts.tokens} tokens)` : ""} · Deepgram ${counts.deepgram} · descargas ${dl}${counts.blocked ? ` · bloqueadas por tope ${counts.blocked}` : ""}`);
  };

  // ── casos y verificación (corrida E, punto 6) ──
  const adminNumber = [process.env.PORTAL_ADMIN_NUMBER, process.env.ADMIN_NUMBERS].map((v) => (v ?? "").split(",").map((x) => x.replace(/\D/g, "")).find(Boolean)).find(Boolean) ?? "";
  const units: Unit[] = [];
  let last: Unit | null = null;
  const checkFailures: string[] = [];

  /** Abre un caso: guarda los contadores y, si el guion lo va a pedir, la instantánea de los datos de negocio. */
  const beginUnit = (label: string, lineNo: number, snapshot: boolean) => {
    const base = { llm: totalsRun.llm, deepgram: totalsRun.deepgram, downloads: totalsRun.downloads, blocked: totalsRun.blocked, netLlm: net.llm, netDeepgram: net.deepgram, out: client.outbox.length };
    const before = snapshot ? businessSnapshot(portal, store) : null;
    return () => {
      const u: Unit = {
        label,
        lineNo,
        from: me.phone,
        modelo: Math.max(totalsRun.llm - base.llm, net.llm - base.netLlm),
        deepgram: Math.max(totalsRun.deepgram - base.deepgram, net.deepgram - base.netDeepgram),
        descargas: totalsRun.downloads - base.downloads,
        bloqueadas: totalsRun.blocked - base.blocked,
        out: client.outbox.slice(base.out),
        before,
        checked: false,
        unchanged: null,
        failures: [],
      };
      units.push(u);
      last = u;
      return u;
    };
  };

  const valueOf = (u: Unit, key: CheckKey): number => {
    if (key === "respuestas") return u.out.filter((o) => o.to === u.from).length;
    if (key === "admin") return u.out.filter((o) => o.to === adminNumber && o.to !== u.from).length;
    if (key === "otros") return u.out.filter((o) => o.to !== u.from && o.to !== adminNumber).length;
    return u[key];
  };
  const foldText = (t: string) => t.normalize("NFC").toLowerCase();

  /** @espera / @espera-texto / @no-texto / @sin-cambios sobre el último caso. */
  const runCheck = (line: string, lineNo: number) => {
    const u = last as Unit | null;
    const fail = (why: string) => {
      const msg = `línea ${lineNo}: ${line.slice(0, 80)} → ${why}`;
      checkFailures.push(msg);
      if (u) u.failures.push(why);
      console.log(`   ✗ ${why}`);
    };
    if (!u) return fail("no hay un mensaje anterior que verificar");
    u.checked = true;
    const espera = line.match(/^@espera\s+(.+)$/);
    if (espera) {
      for (const tok of espera[1].trim().split(/\s+/)) {
        const m = tok.match(/^([a-z]+)(<=|>=|=)(\d+)$/);
        if (!m || !(CHECK_KEYS as readonly string[]).includes(m[1])) {
          fail(`@espera: «${tok}» no se entiende (claves: ${CHECK_KEYS.join(", ")}; op =, <=, >=)`);
          continue;
        }
        const got = valueOf(u, m[1] as CheckKey);
        const want = Number(m[3]);
        const ok = m[2] === "=" ? got === want : m[2] === "<=" ? got <= want : got >= want;
        if (ok) console.log(`   ✔ ${m[1]}=${got}`);
        else fail(`${m[1]}: se esperaba ${m[2]}${want} y hubo ${got}`);
      }
      return;
    }
    const all = u.out.map((o) => foldText(o.text)).join("\n");
    const has = line.match(/^@espera-texto\s+(.+)$/);
    if (has) {
      if (all.includes(foldText(has[1].trim()))) console.log(`   ✔ contiene «${has[1].trim()}»`);
      else fail(`ninguna respuesta contiene «${has[1].trim()}»`);
      return;
    }
    const hasNot = line.match(/^@no-texto\s+(.+)$/);
    if (hasNot) {
      if (!all.includes(foldText(hasNot[1].trim()))) console.log(`   ✔ no contiene «${hasNot[1].trim()}»`);
      else fail(`una respuesta contiene «${hasNot[1].trim()}»`);
      return;
    }
    const same = line.match(/^@sin-cambios(?:\s+salvo\s+(.+))?\s*$/);
    if (same) {
      if (!u.before) return fail("@sin-cambios sin instantánea previa (va justo después del caso)");
      const allowed = new Set((same[1] ?? "").split(/[\s,]+/).filter(Boolean));
      const changed = changedTables(u.before, businessSnapshot(portal, store)).filter((k) => !allowed.has(k.replace(/^(?:portal|cotizador)\./, "")) && !allowed.has(k));
      u.unchanged = changed.length === 0;
      if (u.unchanged) console.log(`   ✔ datos de negocio sin cambios${allowed.size ? ` (salvo ${[...allowed].join(", ")})` : ""}`);
      else fail(`cambiaron datos de negocio: ${changed.join(", ")}`);
      return;
    }
    fail("directiva de verificación desconocida");
  };

  /** @pausa <s>: el reloj del tope por minuto avanza (la ventana de la siguiente ráfaga empieza vacía). */
  const pause = (sec: number) => {
    burstNow += sec * 1000;
    console.log(`⏳ pausa de ${sec} s (reloj del tope por minuto)`);
  };

  /** @empresa-prueba <RUC> <razón social>: como el import del padrón MTC (upsertCompanies), en la copia de datos. */
  const testCompany = async (ruc: string, razonSocial: string) => {
    if (!args.db && !args.persist) {
      const r = await portal.upsertCompanies([{ ruc, razonSocial, sector: null, departamento: "LIMA", unidades: 12, llantasPiso: 0, antiguedadMedia: null }]);
      console.log(`🏢 empresa de prueba ${ruc} (${r.inserted ? "nueva" : "ya existía"}): ${razonSocial}`);
    } else thrown.push("@empresa-prueba solo sobre la copia de datos (sin --db ni --persist)");
  };

  /** @encuesta <comentario>: encuesta nueva para una empresa inventada, respondida por la función de la server action. */
  const SURVEY_RUC = "20999999901";
  const survey = async (comment: string, lineNo: number, snapshot: boolean) => {
    if (args.db || args.persist) {
      thrown.push("@encuesta solo sobre la copia de datos (sin --db ni --persist)");
      return;
    }
    const { createSurveyLink, submitSurvey } = await import("../lib/portal/survey/service");
    const { surveyFormTooLarge, MAX_MEJORAR } = await import("../lib/portal/survey/questions");
    await portal.upsertCompanies([{ ruc: SURVEY_RUC, razonSocial: "EMPRESA DE PRUEBA ENCUESTA S.A.C.", sector: null, departamento: "LIMA", unidades: 5, llantasPiso: 0, antiguedadMedia: null }]);
    const company = await portal.getCompanyByRuc(SURVEY_RUC);
    const link = company ? await createSurveyLink(portal, { companyId: company.id, canal: "whatsapp_vendedor" }) : null;
    if (!company || !link) {
      thrown.push("@encuesta: no pude crear la encuesta de prueba");
      return;
    }
    console.log(`📝 [encuesta] empresa de prueba ${SURVEY_RUC}, comentario «${comment.slice(0, 80)}»`);
    const sender = me.phone;
    me = { ...me, phone: "encuesta" };
    const end = beginUnit(`[encuesta] ${comment}`, lineNo, snapshot);
    counts.llm = counts.deepgram = counts.blocked = counts.tokens = 0;
    const form = new FormData();
    for (const [k, v] of [["token", link.token], ["nps", "9"], ["valora", "precio"], ["satisfaccion", "5"], ["referencia", "si"], ["mejorar", comment]]) form.append(k, v);
    let result: string;
    if (surveyFormTooLarge(form)) result = "error=tamano";
    else {
      const r = await submitSurvey(portal, link.token, form);
      result = r.ok ? "r=ok" : r.reason === "datos" ? `error=${r.errors.join(",")}` : `r=${r.reason}`;
      if (r.ok && r.answer.mejorar !== comment.replace(/\r\n/g, "\n").trim().slice(0, MAX_MEJORAR)) thrown.push("@encuesta: el comentario no se guardó tal cual (texto)");
    }
    // la server action redirige a /encuesta/<token>?<resultado>: esa es la "respuesta" del caso
    client.outbox.push({ to: "encuesta", text: `redirect ?${result}` });
    totalsRun.llm += counts.llm;
    totalsRun.deepgram += counts.deepgram;
    totalsRun.blocked += counts.blocked;
    totalsRun.tokens += counts.tokens;
    const u = end();
    me = { ...me, phone: sender };
    console.log(`   → ${result}\n   📊 modelo ${u.modelo} · Deepgram ${u.deepgram} · descargas ${u.descargas}`);
  };

  const lines: { t: string; no: number }[] = [];
  if (args.script) {
    const raw = fs.readFileSync(path.resolve(process.cwd(), args.script), "utf8");
    raw.split(/\r?\n/).forEach((l, i) => {
      const t = l.trim();
      if (!t || t.startsWith("#")) return;
      lines.push({ t, no: i + 1 });
    });
  }
  if (args.audio) lines.push({ t: `@audio ${args.audio}`, no: 0 });

  /** Una línea: verificación, preparación (@pausa, @empresa-prueba) o un caso (mensaje, @rafaga, @encuesta…). */
  const step = async (line: string, lineNo: number, wantsSnapshot: boolean) => {
    if (isCheckLine(line)) return runCheck(line, lineNo);
    const pausa = line.match(/^@pausa\s+(\d+)\s*$/);
    if (pausa) return pause(Number(pausa[1]));
    const empresa = line.match(/^@empresa-prueba\s+(\d{11})\s+(\S.*)$/);
    if (empresa) return testCompany(empresa[1], empresa[2].trim());
    const encuesta = line.match(/^@encuesta\s+(\S.*)$/);
    if (encuesta) return survey(encuesta[1].replace(/\\n/g, "\n"), lineNo, wantsSnapshot);
    const largo = line.match(/^@texto-largo\s+(\d+)\s+(\S.*)$/);
    if (largo) {
      const n = Math.min(Number(largo[1]), 200_000);
      const seed = `${largo[2].trim()} `;
      line = seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
      console.log(`📏 texto de ${n} caracteres («${seed.trim().slice(0, 50)}…» repetido)`);
    }
    if (/^@como\s/.test(line)) return send(line);
    const end = beginUnit(line.length > 120 ? `${line.slice(0, 117)}…` : line, lineNo, wantsSnapshot);
    await send(line, largo ? { shown: `[texto de ${line.length} caracteres]` } : {});
    end();
  };

  if (lines.length) {
    for (let i = 0; i < lines.length; i++) {
      // ¿pide @sin-cambios alguna verificación que sigue a este caso? entonces la instantánea va antes
      let wants = false;
      for (let j = i + 1; j < lines.length && isCheckLine(lines[j].t); j++) if (/^@sin-cambios\b/.test(lines[j].t)) wants = true;
      await step(lines[i].t, lines[i].no, wants);
    }
  } else {
    console.log('Modo interactivo: escribe un mensaje ("@doc <archivo> [leyenda]", "@audio <archivo>", "@voz <transcripción>", "@fwd <texto>", "@btn <botón>", "@como <número|alias>", "@rafaga <n> <texto>", "@cron [ventana]", "@encuesta <comentario>", "@espera modelo=0 …", "/quit").');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
    rl.prompt();
    for await (const line of rl) {
      const t = line.trim();
      if (t === "/quit" || t === "/exit") break;
      if (t) await step(t, 0, !args.db);
      rl.prompt();
    }
    rl.close();
  }

  await portal.flush();
  await portal.close();
  await store.close();
  const checkedUnits = units.filter((u) => u.checked);
  if (checkedUnits.length) {
    console.log("\n── Casos verificados ──\nlínea | caso | modelo | deepgram | descargas | respuestas | sin cambios | resultado");
    for (const u of checkedUnits) {
      const unchanged = u.unchanged === null ? "—" : u.unchanged ? "sí" : "NO";
      console.log(`${u.lineNo} | ${u.label.replace(/\|/g, "¦").slice(0, 70)} | ${u.modelo} | ${u.deepgram} | ${u.descargas} | ${valueOf(u, "respuestas")} | ${unchanged} | ${u.failures.length ? `FALLA: ${u.failures.join("; ")}` : "ok"}`);
    }
  }
  const errors = [...client.errors, ...thrown, ...checkFailures];
  console.log(`\n── Resumen ──\nMensajes enviados al bot: ${sent}${skipped ? ` (saltados: ${skipped})` : ""}\nRespuestas de texto: ${client.texts} · archivos guardados: ${client.files}\nLlamadas: modelo ${totalsRun.llm} (${totalsRun.tokens} tokens) · Deepgram ${totalsRun.deepgram} · descargas ${totalsRun.downloads}${totalsRun.blocked ? ` · bloqueadas por tope ${totalsRun.blocked}` : ""} · red: anthropic ${net.llm}, deepgram ${net.deepgram}\nVerificaciones fallidas: ${checkFailures.length}\nErrores: ${errors.length}`);
  for (const e of errors) console.log(`  ✗ ${e.split("\n")[0]}`);
  if (errors.length && lines.length) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
