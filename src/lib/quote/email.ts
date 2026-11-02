import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Settings } from "../settings";
import { displayTotal, displayUnit } from "./build";
import { PDF_MIME, withExtension } from "./files";
import { fmtMoney } from "./pricing";
import { findProfile, hasExcelFormat } from "./profiles";
import type { EmailDraft, Quote } from "./types";

/** A file attached to the quote email (the PDF; the customer's Excel format when its profile has one). */
export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

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
  const profile = findProfile(settings, quote.customerProfile);
  const formats = hasExcelFormat(profile) ? ` en PDF y en su formato Excel de cotización de proveedores` : "";
  const lines = [
    `${who},`,
    "",
    `Gracias por su consulta. Adjunto la cotización ${quote.number}${formats} (${taxNote}):`,
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

/**
 * The text the salesman forwards to the customer together with the PDF, as it is (no bot commands, no emojis):
 *
 *   Estimados señores MOVIL BUS S.A.C.
 *   Atención: Sr. Jonathan Matta
 *   Adjunto la cotización OCTUBRE 2026 - 032:
 *   • 8 × Fenixway Flama 77 315/80R22.5 20PR – US$ 254.00 c/u
 *   Total: US$ 2,032.00 + IGV
 *   Forma de pago: Factura crédito, 45 días · Entrega: 48 hrs post OC · Validez: 7 días
 *   Quedo atento a cualquier consulta.
 *   Frank Melek Rodríguez Mirano · 360 by Professional Tyres · 955 344 340
 *
 * A customer with units (Prosegur) also gets its unit / UB line, and each item its own UB when it has another.
 */
export function buildClientMessage(quote: Quote, settings: Settings): string {
  const c = quote.customer;
  const greeting = c.company ? `Estimados señores ${c.company}` : c.name ? `Estimado/a ${c.name}` : "Estimados señores";
  const attention = c.attention && c.attention !== c.name ? `Atención: ${c.attention}` : c.attention && c.company ? `Atención: ${c.attention}` : "";
  const unit = quote.customerProfile && (quote.unit || quote.ub) ? [quote.unit ? `Unidad: ${quote.unit}` : "", quote.ub ? `UB ${quote.ub}` : ""].filter(Boolean).join(" · ") : "";
  const items = quote.items.map((i) => {
    const measure = i.size ? `${i.sizeDisplay || i.size}${i.ply ? ` ${i.ply}PR` : ""}` : "";
    const name = i.size ? [i.brand, i.model, measure].filter(Boolean).join(" ") : i.description;
    const refs = [quote.customerProfile ? i.application : "", i.plate ? `placa ${i.plate}` : "", i.ub && i.ub !== quote.ub ? `UB ${i.ub}` : ""].filter(Boolean).join(" ");
    return `• ${i.quantity} × ${name}${refs ? ` ${refs}` : ""} – ${fmtMoney(displayUnit(i, quote), quote.currency)} c/u`;
  });
  const tax = quote.pricesIncludeTax ? `inc. ${quote.taxLabel}` : `+ ${quote.taxLabel}`;
  const pay = [quote.paymentType, quote.paymentTerm].filter(Boolean).join(", ");
  const terms = [pay ? `Forma de pago: ${pay}` : "", quote.deliveryTerm ? `Entrega: ${quote.deliveryTerm}` : "", `Validez: ${quote.validityDays} días`].filter(Boolean).join(" · ");
  const sp = quote.salesperson;
  const signature = [sp.name, settings.company.signatureName || settings.company.tradeName || settings.company.name, sp.phone].filter(Boolean).join(" · ");
  return [greeting, attention, unit, `Adjunto la cotización ${quote.number}:`, ...items, `Total: ${fmtMoney(displayTotal(quote), quote.currency)} ${tax}`, terms, "Quedo atento a cualquier consulta.", signature].filter(Boolean).join("\n");
}

export interface SendResult {
  sent: boolean;
  id?: string;
  dryRunPath?: string;
  error?: string;
}

/**
 * Send the quote email via Resend with its attachments: a PDF buffer (named after the quote, "OCTUBRE 2026 - 451.pdf"),
 * or the full list (PDF + the customer's Excel).
 * Without RESEND_API_KEY it writes a .eml-like text file to ./out and reports dryRun.
 */
export async function sendQuoteEmail(quote: Quote, pdfOrAttachments: Buffer | EmailAttachment[], draft: EmailDraft, opts: { outDir?: string } = {}): Promise<SendResult> {
  const to = process.env.EMAIL_REDIRECT_TO || draft.to;
  if (!to) return { sent: false, error: "no recipient email" };
  const from = process.env.EMAIL_FROM || "Cotizaciones <onboarding@resend.dev>";
  const attachments: EmailAttachment[] = Buffer.isBuffer(pdfOrAttachments) ? [{ filename: withExtension(quote.files?.pdfName || quote.number, ".pdf"), content: pdfOrAttachments, contentType: PDF_MIME }] : pdfOrAttachments;
  if (!process.env.RESEND_API_KEY) {
    // dry run: keep a copy on disk (falls back to the temp dir on read-only deployments)
    const body = `From: ${from}\nTo: ${to}\nSubject: ${draft.subject}\n${attachments.map((a) => `Attachment: ${a.filename}\n`).join("")}\n${draft.body}\n`;
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
    attachments: attachments.map((a) => ({ filename: a.filename, content: a.content.toString("base64"), contentType: a.contentType })),
  });
  if (error) return { sent: false, error: error.message };
  return { sent: true, id: data?.id };
}

/** "OCTUBRE 2026 - 016" -> "OCTUBRE-2026-016" (file names). */
export function safeName(number: string): string {
  return number.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s*-\s*/g, "-").replace(/\s+/g, "-");
}
