import { createHmac, timingSafeEqual } from "node:crypto";

export interface InboundMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: string;
  /** Message was forwarded by the salesman (e.g. a provider's price message). */
  forwarded: boolean;
  media?: { id: string; mimeType: string; fileName?: string; caption?: string; sha256?: string };
  /** Reply to one of our messages (context.id) */
  replyTo?: string;
  /** Display name from the contacts array. */
  profileName?: string;
}

interface WebhookPayload {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: { phone_number_id?: string };
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: Record<string, unknown>[];
        statuses?: unknown[];
      };
    }[];
  }[];
}

/** Extract the inbound messages from a Cloud API webhook payload (status updates are ignored). */
export function parseWebhook(payload: unknown): { messages: InboundMessage[]; phoneNumberId?: string } {
  const out: InboundMessage[] = [];
  let phoneNumberId: string | undefined;
  const p = payload as WebhookPayload;
  for (const entry of p?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (!v || change.field !== "messages") continue;
      phoneNumberId = v.metadata?.phone_number_id ?? phoneNumberId;
      const names = new Map<string, string>();
      for (const c of v.contacts ?? []) if (c.wa_id && c.profile?.name) names.set(c.wa_id, c.profile.name);
      for (const m of v.messages ?? []) {
        const type = String(m.type ?? "");
        const ctx = (m.context ?? {}) as { forwarded?: boolean; frequently_forwarded?: boolean; id?: string };
        const msg: InboundMessage = {
          id: String(m.id ?? ""),
          from: String(m.from ?? ""),
          timestamp: String(m.timestamp ?? ""),
          type,
          forwarded: !!(ctx.forwarded || ctx.frequently_forwarded),
          replyTo: ctx.id,
          profileName: names.get(String(m.from ?? "")),
        };
        if (type === "text") msg.text = String((m.text as { body?: string })?.body ?? "");
        else if (type === "document" || type === "image" || type === "audio" || type === "video") {
          const med = m[type] as { id?: string; mime_type?: string; filename?: string; caption?: string; sha256?: string };
          msg.media = { id: String(med?.id ?? ""), mimeType: med?.mime_type ?? "", fileName: med?.filename, caption: med?.caption, sha256: med?.sha256 };
          msg.text = med?.caption;
        } else if (type === "button") msg.text = String((m.button as { text?: string })?.text ?? "");
        else if (type === "interactive") {
          const i = m.interactive as { button_reply?: { title?: string }; list_reply?: { title?: string } };
          msg.text = i?.button_reply?.title ?? i?.list_reply?.title;
        }
        out.push(msg);
      }
    }
  }
  return { messages: out, phoneNumberId };
}

/** Validate X-Hub-Signature-256 (sha256=<hex>) against the raw body using the app secret. */
export function verifySignature(rawBody: string, header: string | null | undefined, appSecret: string | undefined): boolean {
  if (!appSecret) return true; // not configured: accept (pilot); set WHATSAPP_APP_SECRET in production
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const given = header.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

/** Handle the GET verification handshake. Returns the challenge to echo, or null. */
export function verifyChallenge(params: URLSearchParams, verifyToken: string | undefined): string | null {
  if (params.get("hub.mode") !== "subscribe") return null;
  if (!verifyToken || params.get("hub.verify_token") !== verifyToken) return null;
  return params.get("hub.challenge");
}
