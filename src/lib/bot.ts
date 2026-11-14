/** Wires the real dependencies for the web app (webhook route). */
import { loadSettings } from "./settings";
import { getStore } from "./store";
import { BotHandler } from "./whatsapp/handler";
import { GraphWhatsAppClient, graphConfigFromEnv, type WhatsAppClient } from "./whatsapp/client";
import type { InboundMessage } from "./whatsapp/webhook";
import { admitWebhookMessage } from "./guard/inbound";
import { limitsConfig } from "./guard/usage";

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

function allowedList(): string[] {
  return (process.env.WHATSAPP_ALLOWED_NUMBERS ?? "")
    .split(",")
    .map((s) => s.replace(/\D/g, ""))
    .filter(Boolean);
}

/**
 * Mensajes del webhook: lista blanca (WHATSAPP_ALLOWED_NUMBERS), antigüedad (Meta reintenta durante horas: más de
 * limits.maxMessageAgeMinutes no se procesa, para no pagar dos veces ni contestar tarde) y repetidos por id. La puerta de
 * números no registrados y el tope por minuto están en BotHandler.handle (así también pasa el simulador).
 */
export async function processInbound(messages: InboundMessage[], now: () => number = Date.now): Promise<void> {
  const store = await getStore();
  const bot = await getBot();
  for (const m of messages) {
    const verdict = admitWebhookMessage(m, { nowMs: now(), maxAgeMinutes: limitsConfig().maxMessageAgeMinutes, allowed: allowedList() });
    if (!verdict.ok) {
      console.log(`[bot] mensaje ${m.id} de ${m.from} descartado: ${verdict.reason === "viejo" ? `más de ${limitsConfig().maxMessageAgeMinutes} min de antigüedad` : "número fuera de WHATSAPP_ALLOWED_NUMBERS"}`);
      if (verdict.reason === "viejo") await store.logBlocked({ phone: m.from, kind: m.type || "?", reason: "viejo" }).catch(() => undefined);
      continue;
    }
    if (!(await store.markProcessed(m.id))) continue; // webhook retry
    await bot.handle(m);
  }
}
