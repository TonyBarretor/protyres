import { syncDriveFolder } from "@/lib/drive/sync";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Re-read the shared Drive folder. Call it from a scheduler (Vercel cron, cron-job.org) or by hand:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/ingest/refresh
 */
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (secret && auth !== `Bearer ${secret}`) return new Response("unauthorized", { status: 401 });
  try {
    const store = await getStore();
    const force = new URL(req.url).searchParams.get("force") === "1";
    const report = await syncDriveFolder(store, { force });
    return Response.json({ ok: true, ...report });
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
