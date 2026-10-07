import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Settings } from "../settings";
import { displayTotal, displayUnit } from "./build";
import { fmtMoney } from "./pricing";
import type { EmailDraft, Quote } from "./types";

export function buildEmailDraft(quote: Quote, settings: Settings): EmailDraft {
  const who = quote.customer.attention
    ? `Estimado/a ${quote.customer.attention}`
    : quote.customer.name
      ? `Estimado/a ${quote.customer.name}`
      : quote.customer.company
        ? `Estimados señores de ${quote.customer.company}`
        : "Estimado cliente";
  const taxNote = quote.pricesIncludeTax ? `precios incluyen ${quote.taxLabel} ${quote.taxPct}%` : `precios no incluyen ${quote.taxLabel} ${quote.taxPct}%`;
  const subjectItems = quote.items
    .slice(0, 3)
    .map((i) => [i.brand, i.sizeDisplay || i.description.split(" ").slice(0, 3).join(" ")].filter(Boolean).join(" "))
    .join(", ");
  const subject = `Cotización ${quote.number} – ${subjectItems}${quote.items.length > 3 ? ` y ${quote.items.length - 3} más` : ""}${quote.customer.ref ? ` (ref. ${quote.customer.ref})` : ""}`;
  const sp = quote.salesperson;
  const lines = [
    `${who},`,
    "",
    `Gracias por su consulta. Adjunto la cotización ${quote.number} (${taxNote}):`,
    "",
    ...quote.items.map((i) => {
      const measure = i.size ? `${i.sizeDisplay}${i.ply ? ` ${i.ply}PR` : ""}` : "";
      const name = [i.brand, i.model, measure].filter(Boolean).join(" ") || i.description;
      return `• ${name} — ${i.quantity} x ${fmtMoney(displayUnit(i, quote), quote.currency)}${i.discountPct > 0 ? ` (dscto ${i.discountPct}%)` : ""} = ${fmtMoney(displayUnit(i, quote) * i.quantity, quote.currency)}`;
    }),
    "",
    `Total: ${fmtMoney(displayTotal(quote), quote.currency)} (${taxNote})`,
    "",
    quote.paymentType || quote.paymentTerm ? `Pago: ${[quote.paymentType, quote.paymentTerm].filter(Boolean).join(" · ")}` : "",
    quote.deliveryTerm ? `Entrega: ${quote.deliveryTerm}` : "",
    `Validez de la oferta: ${quote.validityDays} días (hasta el ${quote.validUntil.split("-").reverse().join("/")}).`,
    quote.notes ? quote.notes : "",
    "",
    "Quedo atento a cualquier consulta.",
    "",
    "Saludos cordiales,",
    sp.name,
    sp.title,
    settings.company.signatureName || settings.company.tradeName || settings.company.name,
    [sp.phone ? `Cel. ${sp.phone}` : "", sp.email].filter(Boolean).join(" · "),
  ].filter((l, i, arr) => !(l === "" && arr[i - 1] === ""));
  return { to: quote.customer.email ?? "", subject, body: lines.join("\n") };
}

export interface SendResult {
  sent: boolean;
  id?: string;
  dryRunPath?: string;
  error?: string;
}

/**
 * Send the quote email with the PDF attached via Resend.
 * Without RESEND_API_KEY it writes a .eml-like text file to ./out and reports dryRun.
 */
export async function sendQuoteEmail(quote: Quote, pdf: Buffer, draft: EmailDraft, opts: { outDir?: string } = {}): Promise<SendResult> {
  const to = process.env.EMAIL_REDIRECT_TO || draft.to;
  if (!to) return { sent: false, error: "no recipient email" };
  const from = process.env.EMAIL_FROM || "Cotizaciones <onboarding@resend.dev>";
  const fileName = `Cotización ${quote.number.replace(/[\\/:*?"<>|]+/g, "-")}.pdf`;
  if (!process.env.RESEND_API_KEY) {
    // dry run: keep a copy on disk (falls back to the temp dir on read-only deployments)
    const body = `From: ${from}\nTo: ${to}\nSubject: ${draft.subject}\nAttachment: ${fileName}\n\n${draft.body}\n`;
    const name = `${safeName(quote.number)}.email.txt`;
    for (const dir of [opts.outDir ?? path.join(process.cwd(), "out"), path.join(os.tmpdir(), "protyres-out")]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const p = path.join(dir, name);
        fs.writeFileSync(p, body);
        return { sent: false, dryRunPath: p };
      } catch {
        // try the next location
      }
    }
    return { sent: false, error: "sin RESEND_API_KEY y sin carpeta donde guardar el borrador" };
  }
  const { Resend } = await import("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from,
    to: [to],
    replyTo: quote.salesperson.email || undefined,
    subject: draft.subject,
    text: draft.body,
    attachments: [{ filename: fileName, content: pdf.toString("base64") }],
  });
  if (error) return { sent: false, error: error.message };
  return { sent: true, id: data?.id };
}

/** "OCTUBRE 2026 - 016" -> "OCTUBRE-2026-016" (file names). */
export function safeName(number: string): string {
  return number.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s*-\s*/g, "-").replace(/\s+/g, "-");
}
