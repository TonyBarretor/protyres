/**
 * Chat with the bot in the terminal, no WhatsApp needed.
 *
 *   npm run wa:simulate
 *
 *   > Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com
 *   > 1
 *   > enviar
 *   > /fwd Michelin X Multi Z 295/80R22.5 a 410       (simulate a forwarded provider message)
 *   > /file samples/proveedor-b-lista.pdf              (simulate sending a PDF/Excel/photo)
 *   > /quit
 *
 * PDFs the bot "sends" are written to ./out.
 */
import "./env";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { loadSettings } from "../lib/settings";
import { getStore } from "../lib/store";
import { FakeWhatsAppClient } from "../lib/whatsapp/client";
import { BotHandler } from "../lib/whatsapp/handler";
import type { InboundMessage } from "../lib/whatsapp/webhook";

const PHONE = process.env.SIM_PHONE || "51955344340";
const outDir = path.resolve(process.cwd(), "out");
fs.mkdirSync(outDir, { recursive: true });

async function main() {
  const store = await getStore();
  const client = new FakeWhatsAppClient();
  client.onSend = (m) => {
    if (m.kind === "text") console.log(`\n🤖 ${m.body}\n`);
    else {
      const p = path.join(outDir, m.fileName ?? "file.bin");
      if (m.file) fs.writeFileSync(p, m.file);
      console.log(`\n🤖 📎 ${m.fileName}  (${m.caption ?? ""})\n   guardado en ${p}\n`);
    }
  };
  const bot = new BotHandler({ client, store, settings: loadSettings(), log: (m) => console.error(`[bot] ${m}`) });
  console.log(`Simulador del bot (número ${PHONE}). Escribe "ayuda", "/fwd <texto>", "/file <ruta>", "/quit".`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();
  let n = 0;
  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      continue;
    }
    if (text === "/quit" || text === "/exit") break;
    const msg: InboundMessage = { id: `sim.${Date.now()}.${++n}`, from: PHONE, timestamp: String(Date.now()), type: "text", forwarded: false };
    if (text.startsWith("/fwd ")) {
      msg.text = text.slice(5);
      msg.forwarded = true;
    } else if (text.startsWith("/file ")) {
      const file = text.slice(6).trim();
      if (!fs.existsSync(file)) {
        console.log(`no existe: ${file}`);
        rl.prompt();
        continue;
      }
      const ext = path.extname(file).toLowerCase();
      const mime = ext === ".pdf" ? "application/pdf" : ext === ".xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : ext === ".csv" ? "text/csv" : ext === ".png" ? "image/png" : "image/jpeg";
      const id = `media.${n}`;
      client.media.set(id, { data: fs.readFileSync(file), mimeType: mime, fileName: path.basename(file) });
      msg.type = mime.startsWith("image/") ? "image" : "document";
      msg.media = { id, mimeType: mime, fileName: path.basename(file) };
    } else {
      msg.text = text;
    }
    await bot.handle(msg);
    rl.prompt();
  }
  await store.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
