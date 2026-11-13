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
 *   @cron [ventana]              corre el resumen diario (runDailyDigest, como /api/cron/daily) con este WhatsApp de
 *                                consola, para todos los usuarios; con `ventana` cada envío falla como fuera de las 24 h
 *                                (131047) y el resumen queda como aviso pendiente para el siguiente mensaje del usuario
 * En modo interactivo valen las mismas formas y /quit.
 *
 * Datos: por defecto store JSON del portal (PORTAL_STORE=json) y del cotizador, sin DATABASE_URL (salvo --db). Trabaja
 * sobre COPIAS en out/simulacion/ (data/ queda intacto); --persist escribe en data/portal-store.json y data/store.json.
 * Sin PORTAL_SESSION_SECRET usa uno de simulación. Sale con código 1 si algún mensaje termina en "Ocurrió un error" (guion).
 */
import "./env";
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
  private save(name: string, data: Buffer): string {
    const p = path.join(outDir, `${String(++this.seq).padStart(3, "0")}-${safe(name)}`);
    fs.writeFileSync(p, data);
    this.files++;
    return p;
  }
  private print(m: OutboundMessage, to: string, extra = ""): void {
    const who = to === currentPhone ? "" : ` (→ ${to})`;
    if (m.kind === "text") console.log(`\n🤖${who} ${m.body}\n`);
    else console.log(`\n🤖${who} 📎 ${m.fileName ?? m.link ?? m.kind}${m.caption ? `  «${m.caption}»` : "  (sin leyenda)"}${extra}\n`);
  }
  async sendText(to: string, body: string): Promise<void> {
    this.texts++;
    if (/^Ocurrió un error/.test(body)) this.errors.push(body);
    this.print({ to, kind: "text", body }, to);
  }
  async sendDocument(to: string, file: Buffer, fileName: string, caption?: string, mimeType?: string): Promise<void> {
    const p = this.save(fileName, file);
    this.print({ to, kind: "document", fileName, caption, mimeType }, to, `\n   guardado en ${path.relative(process.cwd(), p)}`);
  }
  async sendImage(to: string, image: { link?: string; data?: Buffer; mimeType?: string }, caption?: string): Promise<void> {
    const p = image.data ? this.save(`imagen${image.mimeType === "image/png" ? ".png" : ".jpg"}`, image.data) : null;
    this.print({ to, kind: "image", link: image.link, caption, fileName: p ? path.basename(p) : image.link }, to, p ? `\n   guardado en ${path.relative(process.cwd(), p)}` : "");
  }
  /** El último interactivo enviado al usuario (para @btn). */
  lastInteractive: InteractiveMessage | null = null;
  async sendInteractive(to: string, message: InteractiveMessage): Promise<void> {
    this.texts++;
    if (to === currentPhone) this.lastInteractive = message;
    const who = to === currentPhone ? "" : ` (→ ${to})`;
    const opts =
      message.type === "button"
        ? message.buttons.map((b) => `[${b.title}]`).join(" ")
        : `☰ ${message.button}\n${message.sections
            .flatMap((sec) => sec.rows)
            .map((r, i) => `   ${i + 1}. ${r.title}${r.description ? ` — ${r.description}` : ""}  (id: ${r.id})`)
            .join("\n")}`;
    console.log(`\n🤖${who} ${message.body}\n   ${opts}\n`);
  }
  async downloadMedia(mediaId: string) {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const notes = prepareEnv(args);
  // después de preparar el entorno (los stores leen las variables al crearse)
  const { loadSettings } = await import("../lib/settings");
  const { getStore } = await import("../lib/store");
  const { getPortalStore } = await import("../lib/portal/store");
  const { BotHandler } = await import("../lib/whatsapp/handler");

  const portal = await getPortalStore();
  const store = await getStore();
  const me = await resolvePhone(args.as, () => portal.listUsers());
  currentPhone = me.phone;
  const client = new ConsoleWhatsAppClient();
  // sin Graph API: las notas de voz (@audio / --audio) se "descargan" del archivo local que el guion cargó en el cliente
  const { configureReportBot } = await import("../lib/portal/bot");
  // @voz: la transcripción va en cola y este fetch la devuelve como Deepgram; el resto (@audio con clave) va a Deepgram
  const realDeepgram = !!process.env.DEEPGRAM_API_KEY;
  const injected: string[] = [];
  const deepgramFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const transcript = injected.shift();
    if (transcript === undefined) return fetch(url, init);
    return new Response(JSON.stringify({ metadata: { duration: 5 }, results: { channels: [{ alternatives: [{ transcript, confidence: 0.9 }] }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  configureReportBot({ downloadMedia: (id) => client.downloadMedia(id), deepgramFetch });
  let emailSeq = 0;
  const bot = new BotHandler({
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

  const send = async (line: string) => {
    const cron = line.match(/^@cron\b\s*(.*)$/);
    if (cron) return runCron(cron[1]);
    const msg = toMessage(line);
    if (!msg) return;
    const shown = msg.type === "audio" && /^@voz\s/.test(line) ? `[voz] «${line.replace(/^@voz\s+/, "")}»` : msg.media ? `[${msg.type}] ${msg.media.fileName ?? ""} ${msg.text ?? ""}`.trim() : msg.forwarded ? `[reenviado] ${msg.text}` : msg.type === "interactive" ? `[botón] ${msg.interactiveTitle ?? ""} (id: ${msg.interactiveId ?? ""} → «${msg.text ?? ""}»)` : msg.text;
    console.log(`👤 ${shown}`);
    sent++;
    try {
      await bot.handle(msg);
    } catch (err) {
      thrown.push(`${line}: ${(err as Error).message}`);
      console.log(`💥 ${(err as Error).stack ?? err}`);
    }
  };

  const lines: string[] = [];
  if (args.script) {
    const raw = fs.readFileSync(path.resolve(process.cwd(), args.script), "utf8");
    for (const l of raw.split(/\r?\n/)) {
      const t = l.trim();
      if (!t || t.startsWith("#")) continue;
      lines.push(t);
    }
  }
  if (args.audio) lines.push(`@audio ${args.audio}`);

  if (lines.length) {
    for (const l of lines) await send(l);
  } else {
    console.log('Modo interactivo: escribe un mensaje ("@doc <archivo> [leyenda]", "@audio <archivo>", "@voz <transcripción>", "@fwd <texto>", "@btn <botón>", "@cron [ventana]", "/quit").');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
    rl.prompt();
    for await (const line of rl) {
      const t = line.trim();
      if (t === "/quit" || t === "/exit") break;
      if (t) await send(t);
      rl.prompt();
    }
    rl.close();
  }

  await portal.flush();
  await portal.close();
  await store.close();
  const errors = [...client.errors, ...thrown];
  console.log(`\n── Resumen ──\nMensajes enviados al bot: ${sent}${skipped ? ` (saltados: ${skipped})` : ""}\nRespuestas de texto: ${client.texts} · archivos guardados: ${client.files}\nErrores: ${errors.length}`);
  for (const e of errors) console.log(`  ✗ ${e.split("\n")[0]}`);
  if (errors.length && lines.length) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
