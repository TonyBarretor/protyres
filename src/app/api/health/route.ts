import { getStore } from "@/lib/store";
import { llmAvailable } from "@/lib/llm/client";
import { calendarEmailStatus } from "@/lib/portal/calendar/mail";
import { graphConfigFromEnv } from "@/lib/whatsapp/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const store = await getStore();
  const providers = await store.providers();
  return Response.json({
    ok: true,
    time: new Date().toISOString(),
    whatsapp: !!graphConfigFromEnv(),
    llm: llmAvailable(),
    email: !!process.env.RESEND_API_KEY,
    // corrida J: true solo con RESEND_API_KEY y un EMAIL_FROM propio (no de ejemplo, ni resend.dev, ni @360tyres.pe)
    calendarInvite: calendarEmailStatus().ready,
    drive: !!process.env.GOOGLE_DRIVE_FOLDER_ID,
    store: process.env.DATABASE_URL ? "postgres" : "json",
    providers: providers.map((p) => ({ provider: p.provider, rows: p.rows, lastPriceDate: p.lastPriceDate })),
  });
}
