import { checkRateLimit, clientIp } from "@/lib/portal/auth/rate-limit";
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
 * de src/lib/portal/notify/jobs.ts (resumen diario e invitación a la encuesta con SURVEY_AUTO). Vercel manda
 * `Authorization: Bearer $CRON_SECRET`. Prueba sin enviar nada:
 *   curl -H "Authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/daily?dry=1"
 */
/** Ventanas del límite de intentos más viejas que esto se borran en cada corrida (las ventanas duran como mucho 1 h). */
const RATE_LIMIT_KEEP_MS = 2 * 24 * 3600_000;

export async function GET(req: Request): Promise<Response> {
  // Corrida E, punto 5: límite por IP antes de mirar el secreto (Vercel llama una vez al día; frena a quien lo adivine)
  const limit = await checkRateLimit({ store: getPortalStore }, "cron", { ip: clientIp(req.headers) });
  if (!limit.ok) return Response.json({ ok: false, error: "Demasiados intentos; vuelva a intentarlo más tarde" }, { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } });
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
    // limpieza del límite de intentos (tabla rate_limit_hits); si falla (sin migrar) no tumba el cron
    await store.pruneRateLimitHits(new Date(Date.now() - RATE_LIMIT_KEEP_MS)).catch((err: unknown) => log(`limpieza de rate_limit_hits: ${(err as Error).message}`));
    if (!dryRun) await store.flush();
    return Response.json({ ok: true, dryRun, jobs });
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
