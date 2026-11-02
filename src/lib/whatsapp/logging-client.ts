/**
 * Message log: every message the bot receives and every reply / document it sends goes to the store (table
 * messages) for "historial <número>". Media bytes are never stored, only file names. Logging never breaks handling:
 * a failing store is ignored.
 */
import type { MessageLogEntry, PriceStore } from "../store/types";
import type { WhatsAppClient } from "./client";
import type { InboundMessage } from "./webhook";

/** Sends through the wrapped client, then logs what was sent (with the quote the conversation is on, when known). */
export class LoggingWhatsAppClient implements WhatsAppClient {
  /** phone -> quote number the outgoing messages belong to (set while a quote is presented / resent). */
  private quoteOf = new Map<string, string>();

  constructor(
    private inner: WhatsAppClient,
    private store: PriceStore,
    private onError?: (msg: string) => void,
  ) {}

  /** Tags the next outgoing messages to `phone` with this quote number (undefined clears it). */
  setQuote(phone: string, quoteNumber: string | undefined): void {
    if (quoteNumber) this.quoteOf.set(phone, quoteNumber);
    else this.quoteOf.delete(phone);
  }

  async logInbound(msg: InboundMessage, quoteNumber?: string): Promise<void> {
    const media = msg.media;
    const body = msg.text ?? media?.caption ?? (media ? `(${msg.type})` : "");
    await this.log({ phone: msg.from, direction: "in", kind: msg.type || "text", body, fileName: media?.fileName, quoteNumber });
  }

  async sendText(to: string, body: string): Promise<void> {
    await this.inner.sendText(to, body);
    await this.log({ phone: to, direction: "out", kind: "text", body, quoteNumber: this.quoteOf.get(to) });
  }

  async sendDocument(to: string, file: Buffer, fileName: string, caption?: string, mimeType?: string): Promise<void> {
    await this.inner.sendDocument(to, file, fileName, caption, mimeType);
    await this.log({ phone: to, direction: "out", kind: "document", body: caption ?? "", fileName, quoteNumber: this.quoteOf.get(to) });
  }

  async sendImage(to: string, image: { link?: string; data?: Buffer; mimeType?: string }, caption?: string): Promise<void> {
    await this.inner.sendImage(to, image, caption);
    const fileName = image.link ? image.link.split("?")[0].split("/").pop() || image.link : undefined;
    await this.log({ phone: to, direction: "out", kind: "image", body: caption ?? "", fileName, quoteNumber: this.quoteOf.get(to) });
  }

  downloadMedia(mediaId: string) {
    return this.inner.downloadMedia(mediaId);
  }

  private async log(entry: MessageLogEntry): Promise<void> {
    try {
      await this.store.logMessage(entry);
    } catch (err) {
      this.onError?.(`no pude registrar el mensaje: ${(err as Error).message}`);
    }
  }
}

const LIMA = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

/** "30/10 17:16" in Lima time. */
export function limaTime(iso: string): string {
  const parts = Object.fromEntries(LIMA.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.day}/${parts.month} ${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
}

/** What a file is, for the history: "PDF", "Excel", "foto", "archivo". */
function fileLabel(kind: string, fileName: string): string {
  if (/\.pdf$/i.test(fileName)) return "PDF";
  if (/\.xlsx?$/i.test(fileName)) return "Excel";
  if (kind === "image") return "foto";
  return "archivo";
}

/** One line of "historial": `30/10 17:16 ← precio 1 254` / `30/10 17:16 → *1.* Fenixway … (PDF: Cotizacion 26 - 0031.pdf)`. */
export function historyLine(m: { direction: string; kind: string; body: string; fileName?: string; createdAt: string }, max = 80): string {
  const flat = m.body.replace(/\s+/g, " ").trim();
  const body = flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
  const file = m.fileName ? `(${fileLabel(m.kind, m.fileName)}: ${m.fileName})` : !body && m.kind !== "text" ? `(${m.kind})` : "";
  return `${limaTime(m.createdAt)} ${m.direction === "in" ? "←" : "→"} ${[body, file].filter(Boolean).join(" ")}`;
}
