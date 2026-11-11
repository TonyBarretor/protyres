import { runDailyJobs } from "@/lib/portal/notify/jobs";
import { getPortalStore } from "@/lib/portal/store";
import { getStore } from "@/lib/store";
import { GraphWhatsAppClient, graphConfigFromEnv, type WhatsAppClient } from "@/lib/whatsapp/client";
import { LoggingWhatsAppClient } from "@/lib/whatsapp/logging-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Cron diario del portal (vercel.json: "0 13 * * *" = 8:00 de Lima; el plan Hobby permite uno al día). Corre los trabajos
 * de src/lib/portal/notify/jobs.ts (resumen diario; la fase C añade ahí las encuestas). Vercel manda
 * `Authorization: Bearer $CRON_SECRET`. Prueba sin enviar nada:
 *   curl -H "Authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/daily?dry=1"
 */
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ ok: false, error: "CRON_SECRET no está configurado" }, { status: 500 });
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const dryRun = new URL(req.url).searchParams.get("dry") === "1";
  const log = (m: string) => console.log(`[cron] ${m}`);
  try {
    let client: WhatsAppClient | null = null;
    if (!dryRun) {
      const cfg = graphConfigFromEnv();
      if (!cfg) return Response.json({ ok: false, error: "WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID no están configurados" }, { status: 500 });
      // como el bot: lo enviado queda en `messages` (historial)
      client = new LoggingWhatsAppClient(new GraphWhatsAppClient(cfg), await getStore(), log);
    }
    const store = await getPortalStore();
    const jobs = await runDailyJobs({ store, client, now: new Date(), dryRun, env: process.env, log });
    if (!dryRun) await store.flush();
    return Response.json({ ok: true, dryRun, jobs });
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
