/**
 * The Prosegur contract flow as the salesman sees it on WhatsApp: the real bot (BotHandler) with a simulated WhatsApp
 * (FakeWhatsAppClient), an in-memory store and the real config (config/pilot.json, config/customers.json). The email is
 * not sent (the bot is told it was), nothing touches the database.
 *
 *   npx tsx --tsconfig tsconfig.cli.json scripts/prosegur-chat.ts [archivo.txt] [--docs]
 *
 * Prints the transcript and writes it (default out/ejemplo-prosegur-chat.txt) with the bot's replies exactly as sent and
 * the names of the documents; --docs also saves the PDF and Excel the bot sends, next to it. Part 1 is the everyday
 * three-line quote (Ayacucho already has a quote, 451, so the bot remembers its solicitante and email); part 2 is a unit
 * quoted for the first time with a model whose APLICACIÓN the bot does not know yet.
 */
import fs from "node:fs";
import path from "node:path";
import { loadSettings } from "../src/lib/settings";
import { JsonStore } from "../src/lib/store/json-store";
import { FakeWhatsAppClient, type OutboundMessage } from "../src/lib/whatsapp/client";
import { BotHandler } from "../src/lib/whatsapp/handler";

process.env.LLM_DISABLED = "1"; // the shorthand never needs it; keeps the run deterministic
process.env.PHOTOS_DISABLED = "1"; // no image downloads

const PHONE = "51955344340"; // Frank, the salesman of config/pilot.json

async function main() {
  const args = process.argv.slice(2);
  const saveDocs = args.includes("--docs");
  const outFile = path.resolve(args.find((a) => !a.startsWith("--")) ?? "out/ejemplo-prosegur-chat.txt");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const settings = loadSettings();
  const store = JsonStore.memory();
  const client = new FakeWhatsAppClient();
  const bot = new BotHandler({ client, store, settings, sendEmail: async () => ({ sent: true, id: "ejemplo" }) });
  let id = 0;
  const send = (body: string) => bot.handle({ id: `ejemplo.${++id}`, from: PHONE, timestamp: String(Date.now()), type: "text", text: body, forwarded: false });

  const out: string[] = [];
  const show = (m: OutboundMessage) => {
    if (m.kind === "text") return out.push(`[Bot]\n${m.body}\n`);
    out.push(`[Bot] documento: ${m.fileName}\n${m.caption ?? ""}\n`);
    if (saveDocs && m.file && m.fileName) fs.writeFileSync(path.join(path.dirname(outFile), m.fileName), m.file);
  };
  const say = async (body: string) => {
    out.push(`[Vendedor]\n${body}\n`);
    const before = client.sent.length;
    await send(body);
    client.sent.slice(before).forEach(show);
  };

  // before the example: an earlier quote of Ayacucho (number 451), so the bot knows its solicitante and email
  await send("prosegur ayacucho 1830\n2 v99\n4 v89\nsolicitante: Johann Castañeda\ncorreo compras@prosegur.com\nnúmero 451");
  await send("enviar");
  if (!client.texts().some((t) => t.startsWith("Enviado ✔"))) throw new Error(`la cotización previa no se armó:\n${client.texts().join("\n---\n")}`);

  const today = new Date().toISOString().slice(0, 10).split("-").reverse().join("/");
  out.push(
    "EJEMPLO · Cotización Prosegur con precios de contrato",
    `(conversación generada con el bot real y un WhatsApp simulado — scripts/prosegur-chat.ts, ${today})`,
    "",
    "1) Lo de todos los días: un mensaje de 3 líneas, y *enviar*",
    "   Ayacucho ya tiene una cotización anterior (la 451): el bot recuerda el solicitante y el correo.",
    "",
  );
  await say("prosegur ayacucho 1830\n2 v99\n4 v89");
  await say("enviar");

  out.push(
    "",
    "2) Solo la primera vez: una unidad nueva y un modelo sin aplicación",
    "   El bot pregunta el solicitante de esa unidad (una vez; luego lo recuerda) y la aplicación de la f77 (una vez; queda guardada).",
    "",
  );
  await say("prosegur cusco 1900\n2 v99\n1 f77");
  await say("Ana Torres");
  await say("post");
  await say("enviar");

  out.push(
    "",
    "También entiende:",
    "• todo en una línea: prosegur ayacucho 1830, 2 v99, 4 v89",
    "• una UB distinta para una llanta: v89 x4 ub 1845",
    "• la línea completa: 215/75R17.5 18PR Fenixway Valor 99 x2",
    "• cada llanta en un mensaje aparte: se agrega a la cotización que acaba de llegar",
    "• los precios del contrato: contrato prosegur",
  );
  const transcript = `${out.join("\n")}\n`;
  fs.writeFileSync(outFile, transcript);
  console.log(transcript);
  console.log(`Conversación de ejemplo: ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
