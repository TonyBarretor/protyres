/**
 * WhatsApp Cloud API (Meta Graph API) client + a fake for tests / local simulation.
 */
import { graphInteractive, type InteractiveMessage } from "./interactive";

export type { InteractiveMessage } from "./interactive";

export interface OutboundMessage {
  to: string;
  kind: "text" | "document" | "image" | "interactive";
  /** Texto (kind "text") o body del interactivo. */
  body?: string;
  /** Botones / lista (kind "interactive"). */
  interactive?: InteractiveMessage;
  /** image by public URL (no upload) */
  link?: string;
  fileName?: string;
  caption?: string;
  file?: Buffer;
  mimeType?: string;
}

export interface WhatsAppClient {
  sendText(to: string, body: string): Promise<void>;
  sendDocument(to: string, file: Buffer, fileName: string, caption?: string, mimeType?: string): Promise<void>;
  /** Send a picture: a public URL, or bytes (uploaded first). */
  sendImage(to: string, image: { link?: string; data?: Buffer; mimeType?: string }, caption?: string): Promise<void>;
  downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string; fileName?: string }>;
  /**
   * Botones de respuesta o lista (ya validados con prepareInteractive). Lanza si WhatsApp lo rechaza: quien llama cae a
   * texto (deliverInteractive en interactive.ts).
   */
  sendInteractive(to: string, message: InteractiveMessage): Promise<void>;
}

export interface GraphConfig {
  token: string;
  phoneNumberId: string;
  version?: string;
}

export function graphConfigFromEnv(): GraphConfig | null {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return null;
  return { token, phoneNumberId, version: process.env.GRAPH_API_VERSION || "v22.0" };
}

export class GraphWhatsAppClient implements WhatsAppClient {
  private base: string;
  constructor(private cfg: GraphConfig) {
    this.base = `https://graph.facebook.com/${cfg.version || "v22.0"}`;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${json.error?.message ?? JSON.stringify(json)}`);
    return json;
  }

  async sendText(to: string, body: string): Promise<void> {
    // WhatsApp caps text messages at 4096 chars
    for (const chunk of splitChunks(body, 3900)) {
      await this.post(`${this.cfg.phoneNumberId}/messages`, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body: chunk },
      });
    }
  }

  async sendInteractive(to: string, message: InteractiveMessage): Promise<void> {
    await this.post(`${this.cfg.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: graphInteractive(message),
    });
  }

  async uploadMedia(file: Buffer, fileName: string, mimeType: string): Promise<string> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([new Uint8Array(file)], { type: mimeType }), fileName);
    const res = await fetch(`${this.base}/${this.cfg.phoneNumberId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.token}` },
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!res.ok || !json.id) throw new Error(`WhatsApp media upload ${res.status}: ${json.error?.message ?? JSON.stringify(json)}`);
    return json.id;
  }

  async sendDocument(to: string, file: Buffer, fileName: string, caption?: string, mimeType = "application/pdf"): Promise<void> {
    const id = await this.uploadMedia(file, fileName, mimeType);
    await this.post(`${this.cfg.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "document",
      document: { id, filename: fileName, caption: caption || undefined }, // no caption: the field is left out
    });
  }

  async sendImage(to: string, image: { link?: string; data?: Buffer; mimeType?: string }, caption?: string): Promise<void> {
    const ref = image.data ? { id: await this.uploadMedia(image.data, "foto.jpg", image.mimeType ?? "image/jpeg") } : { link: image.link };
    await this.post(`${this.cfg.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "image",
      image: { ...ref, caption },
    });
  }

  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string; fileName?: string }> {
    const meta = await fetch(`${this.base}/${mediaId}`, { headers: { Authorization: `Bearer ${this.cfg.token}` } });
    const info = (await meta.json()) as { url?: string; mime_type?: string; error?: { message?: string } };
    if (!meta.ok || !info.url) throw new Error(`WhatsApp media lookup ${meta.status}: ${info.error?.message ?? JSON.stringify(info)}`);
    const bin = await fetch(info.url, { headers: { Authorization: `Bearer ${this.cfg.token}` } });
    if (!bin.ok) throw new Error(`WhatsApp media download ${bin.status}`);
    return { data: Buffer.from(await bin.arrayBuffer()), mimeType: info.mime_type ?? bin.headers.get("content-type") ?? "application/octet-stream" };
  }
}

export function splitChunks(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/** Records messages instead of sending them (tests, `npm run wa:simulate`). */
export class FakeWhatsAppClient implements WhatsAppClient {
  sent: OutboundMessage[] = [];
  media = new Map<string, { data: Buffer; mimeType: string; fileName?: string }>();
  onSend?: (m: OutboundMessage) => void;

  async sendText(to: string, body: string): Promise<void> {
    const m: OutboundMessage = { to, kind: "text", body };
    this.sent.push(m);
    this.onSend?.(m);
  }
  async sendDocument(to: string, file: Buffer, fileName: string, caption?: string, mimeType?: string): Promise<void> {
    const m: OutboundMessage = { to, kind: "document", file, fileName, caption, mimeType };
    this.sent.push(m);
    this.onSend?.(m);
  }
  async sendImage(to: string, image: { link?: string; data?: Buffer; mimeType?: string }, caption?: string): Promise<void> {
    const m: OutboundMessage = { to, kind: "image", link: image.link, file: image.data, mimeType: image.mimeType, caption };
    this.sent.push(m);
    this.onSend?.(m);
  }
  /** Tests: si se define, sendInteractive lanza este error (para probar la caída a texto). */
  failInteractive?: Error;
  async sendInteractive(to: string, message: InteractiveMessage): Promise<void> {
    if (this.failInteractive) throw this.failInteractive;
    const m: OutboundMessage = { to, kind: "interactive", body: message.body, interactive: message };
    this.sent.push(m);
    this.onSend?.(m);
  }
  async downloadMedia(mediaId: string) {
    const m = this.media.get(mediaId);
    if (!m) throw new Error(`fake media not found: ${mediaId}`);
    return m;
  }
  /** Lo que el usuario lee: textos y el body de los interactivos (los botones, en `interactive`). */
  texts(): string[] {
    return this.sent.filter((m) => m.kind === "text" || m.kind === "interactive").map((m) => m.body ?? "");
  }
  /** Los interactivos enviados. */
  interactives(): InteractiveMessage[] {
    return this.sent.filter((m) => m.kind === "interactive" && m.interactive).map((m) => m.interactive!);
  }
  last(): OutboundMessage | undefined {
    return this.sent[this.sent.length - 1];
  }
}
