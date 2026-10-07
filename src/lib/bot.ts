/** Wires the real dependencies for the web app (webhook route). */
import { loadSettings } from "./settings";
import { getStore } from "./store";
import { BotHandler } from "./whatsapp/handler";
import { GraphWhatsAppClient, graphConfigFromEnv, type WhatsAppClient } from "./whatsapp/client";
import type { InboundMessage } from "./whatsapp/webhook";

let handler: BotHandler | null = null;

export async function getBot(clientOverride?: WhatsAppClient): Promise<BotHandler> {
  if (handler && !clientOverride) return handler;
  const cfg = graphConfigFromEnv();
  const client = clientOverride ?? (cfg ? new GraphWhatsAppClient(cfg) : null);
  if (!client) throw new Error("WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set");
  const store = await getStore();
  const bot = new BotHandler({ client, store, settings: loadSettings(), log: (m) => console.log(`[bot] ${m}`) });
  if (!clientOverride) handler = bot;
  return bot;
}

export function allowedSender(phone: string): boolean {
  const list = (process.env.WHATSAPP_ALLOWED_NUMBERS ?? "")
    .split(",")
    .map((s) => s.replace(/\D/g, ""))
    .filter(Boolean);
  if (list.length === 0) return true;
  return list.includes(phone.replace(/\D/g, ""));
}

export async function processInbound(messages: InboundMessage[]): Promise<void> {
  const store = await getStore();
  const bot = await getBot();
  for (const m of messages) {
    if (!allowedSender(m.from)) {
      console.log(`[bot] ignoring message from non-allowed number ${m.from}`);
      continue;
    }
    if (!(await store.markProcessed(m.id))) continue; // webhook retry
    await bot.handle(m);
  }
}
