import { getStore } from "@/lib/store";
import { llmAvailable } from "@/lib/llm/client";
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
    drive: !!process.env.GOOGLE_DRIVE_FOLDER_ID,
    store: process.env.DATABASE_URL ? "postgres" : "json",
    providers: providers.map((p) => ({ provider: p.provider, rows: p.rows, lastPriceDate: p.lastPriceDate })),
  });
}
