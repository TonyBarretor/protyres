import { after } from "next/server";
import { processInbound } from "@/lib/bot";
import { parseWebhook, verifyChallenge, verifySignature } from "@/lib/whatsapp/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Meta calls this once when you register the webhook URL. */
export async function GET(req: Request): Promise<Response> {
  const challenge = verifyChallenge(new URL(req.url).searchParams, process.env.WHATSAPP_VERIFY_TOKEN);
  if (challenge === null) return new Response("forbidden", { status: 403 });
  return new Response(challenge, { status: 200 });
}

/** Every inbound message / status update. Must answer 200 fast; the work happens after the response. */
export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), process.env.WHATSAPP_APP_SECRET)) {
    return new Response("bad signature", { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const { messages } = parseWebhook(payload);
  if (messages.length > 0) {
    after(async () => {
      try {
        await processInbound(messages);
      } catch (err) {
        console.error("[webhook] processing failed", err);
      }
    });
  }
  return Response.json({ ok: true, received: messages.length });
}
