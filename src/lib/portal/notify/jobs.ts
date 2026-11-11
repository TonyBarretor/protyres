/**
 * Trabajos del cron diario (/api/cron/daily, 8:00 de Lima). El plan Hobby de Vercel permite un cron una vez al día, así
 * que todo lo diario va en esta lista y corre en la misma llamada, en orden; si uno falla, los demás siguen.
 *
 * Punto de extensión (fase C): añadir aquí la invitación de encuestas, p. ej.
 *   { name: "encuestas", run: (deps) => runSurveyInvites(deps) }
 * Cada trabajo recibe las mismas dependencias y devuelve un informe JSON (sale tal cual en la respuesta de la ruta).
 * Con `dryRun` no debe enviar ni escribir nada.
 */
import type { PortalStore } from "../store/types";
import type { WhatsAppClient } from "../../whatsapp/client";
import { runDailyDigest } from "./send";

export interface DailyJobDeps {
  store: PortalStore;
  /** null solo con dryRun. */
  client: WhatsAppClient | null;
  now: Date;
  dryRun: boolean;
  env: Record<string, string | undefined>;
  log: (msg: string) => void;
}

export interface DailyJob {
  name: string;
  run: (deps: DailyJobDeps) => Promise<unknown>;
}

export const DAILY_JOBS: DailyJob[] = [
  { name: "resumen", run: (d) => runDailyDigest({ store: d.store, client: d.client, now: d.now, dryRun: d.dryRun, env: d.env, log: d.log }) },
  // fase C: { name: "encuestas", run: (d) => ... },
];

export type DailyJobsReport = Record<string, { ok: true; report: unknown } | { ok: false; error: string }>;

export async function runDailyJobs(deps: DailyJobDeps, jobs: readonly DailyJob[] = DAILY_JOBS): Promise<DailyJobsReport> {
  const out: DailyJobsReport = {};
  for (const job of jobs) {
    try {
      out[job.name] = { ok: true, report: await job.run(deps) };
    } catch (err) {
      deps.log(`cron diario: ${job.name} falló: ${(err as Error).message}`);
      out[job.name] = { ok: false, error: (err as Error).message };
    }
  }
  return out;
}
