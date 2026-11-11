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
 *   @audio <archivo>             nota de voz (se salta, con aviso, si no hay DEEPGRAM_API_KEY)
 *   @doc <archivo> [leyenda]     documento o imagen (por extensión) con leyenda opcional
 *   @fwd <texto>                 mensaje reenviado
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
import type { InboundMessage } from "../lib/whatsapp/webhook";

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
  async downloadMedia(mediaId: string) {
    const m = this.media.get(mediaId);
    if (!m) throw new Error(`medio simulado no encontrado: ${mediaId}`);
    return m;
  }
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
    const audio = line.match(/^@audio\s+(\S.*)$/);
    if (audio) {
      if (!process.env.DEEPGRAM_API_KEY) {
        console.log(`⚠️  sin DEEPGRAM_API_KEY: se salta el audio ${audio[1].trim()}`);
        skipped++;
        return null;
      }
      return media(audio[1].trim(), "audio");
    }
    const doc = line.match(/^@doc\s+(\S+)(?:\s+(.+))?$/);
    if (doc) return media(doc[1], "doc", doc[2]?.trim());
    const fwd = line.match(/^@fwd\s+([\s\S]+)$/);
    if (fwd) {
      msg.text = fwd[1].replace(/\\n/g, "\n");
      msg.forwarded = true;
      return msg;
    }
    msg.text = line.replace(/\\n/g, "\n"); // "\n" escrito en el guion = salto de línea (pedidos de varias líneas)
    return msg;
  };

  const send = async (line: string) => {
    const msg = toMessage(line);
    if (!msg) return;
    console.log(`👤 ${msg.media ? `[${msg.type}] ${msg.media.fileName ?? ""} ${msg.text ?? ""}`.trim() : msg.forwarded ? `[reenviado] ${msg.text}` : msg.text}`);
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
    console.log('Modo interactivo: escribe un mensaje ("@doc <archivo> [leyenda]", "@audio <archivo>", "@fwd <texto>", "/quit").');
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
