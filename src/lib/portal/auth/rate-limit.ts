/**
 * Corrida E, punto 5: límite de intentos en las entradas públicas (/portal/login, /encuesta/<token>, /api/cron/daily).
 *
 * Ventana fija (`windowMinutes` de config/portal.json → publicInputs.rateLimits): cada intento suma 1 al contador de su
 * IP y, si la entrada tiene token, al de su token; pasado el máximo, 429 hasta que empiece la ventana siguiente. Los
 * contadores viven en el store del portal (tabla rate_limit_hits en Postgres) para valer entre instancias serverless.
 *
 * Privacidad: ni la IP ni el token se guardan en claro; la clave es HMAC-SHA256(PORTAL_SESSION_SECRET) truncado.
 * Si el store falla (p. ej. falta `npm run db:migrate`), se deja pasar y se registra: el límite no debe tumbar el login.
 *
 * Sin llamadas al modelo ni a Deepgram (lo fija src/lib/portal/auth/public-entries.test.ts).
 */
import { createHmac } from "node:crypto";
import { loadPortalConfig, type PortalPublicInputsConfig } from "../config";
import { getPortalStore, JsonPortalStore } from "../store";
import type { PortalStore } from "../store/types";

type Env = Record<string, string | undefined>;

export type RateScope = "login" | "surveyView" | "surveySubmit" | "cron";

export interface RateLimitDeps {
  store: Pick<PortalStore, "hitRateLimit"> | (() => Promise<Pick<PortalStore, "hitRateLimit">>);
  env?: Env;
  now?: Date;
  /** Por defecto config/portal.json → publicInputs. */
  config?: PortalPublicInputsConfig;
  log?: (m: string) => void;
}

export type RateLimitResult = { ok: true } | { ok: false; by: "ip" | "token"; retryAfterSec: number };

export function publicInputsConfig(): PortalPublicInputsConfig {
  return loadPortalConfig().publicInputs;
}

/**
 * IP del cliente: primer valor de x-forwarded-for (Vercel lo reescribe con la IP real del cliente), si no x-real-ip, si no
 * "desconocida" (todas las peticiones sin IP comparten un contador). Recortada: nunca se guarda en claro.
 */
export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = fwd || headers.get("x-real-ip")?.trim() || "desconocida";
  return ip.slice(0, 64);
}

const FALLBACK_SECRET = "protyres-rate-limit";

/** HMAC-SHA256 (PORTAL_SESSION_SECRET; sin él, una sal fija) de `kind:value`, 32 hex. */
export function hashBucketPart(kind: "ip" | "token", value: string, env: Env = process.env): string {
  const secret = (env.PORTAL_SESSION_SECRET ?? "").trim() || FALLBACK_SECRET;
  return createHmac("sha256", secret).update(`${kind}:${value}`).digest("hex").slice(0, 32);
}

export function windowStartOf(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * Cuenta el intento (IP y token, si hay) y dice si pasa. Se cuentan ambos aunque uno ya esté pasado, para que un atacante
 * que rota IPs siga gastando el contador del token.
 */
export async function checkRateLimit(deps: RateLimitDeps, scope: RateScope, who: { ip: string; token?: string | null }): Promise<RateLimitResult> {
  const cfg = deps.config ?? publicInputsConfig();
  const rule = cfg.rateLimits[scope];
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const windowMs = rule.windowMinutes * 60_000;
  const ws = windowStartOf(now, windowMs);
  const retryAfterSec = Math.max(1, Math.ceil((ws.getTime() + windowMs - now.getTime()) / 1000));
  const checks: { by: "ip" | "token"; bucket: string; max: number }[] = [{ by: "ip", bucket: `${scope}:ip:${hashBucketPart("ip", who.ip, env)}`, max: rule.perIp }];
  if (who.token && rule.perToken) checks.push({ by: "token", bucket: `${scope}:tk:${hashBucketPart("token", who.token, env)}`, max: rule.perToken });
  try {
    const store = typeof deps.store === "function" ? await deps.store() : deps.store;
    let blocked: "ip" | "token" | null = null;
    for (const c of checks) {
      const n = await store.hitRateLimit(c.bucket, ws);
      if (n > c.max && !blocked) blocked = c.by;
    }
    if (blocked) {
      (deps.log ?? console.warn)(`[rate-limit] ${scope}: bloqueado por ${blocked === "ip" ? "IP" : "token"} hasta ${new Date(ws.getTime() + windowMs).toISOString()}`);
      return { ok: false, by: blocked, retryAfterSec };
    }
    return { ok: true };
  } catch (err) {
    (deps.log ?? console.warn)(`[rate-limit] ${scope}: no se pudo contar el intento, se deja pasar (${err instanceof Error ? err.message : String(err)})`);
    return { ok: true };
  }
}

let proxyLocal: JsonPortalStore | null = null;

/**
 * Store de contadores para src/proxy.ts. Con Postgres, el del portal (tabla rate_limit_hits, compartida entre instancias).
 * Con el store JSON (desarrollo, simulador) uno vacío en memoria de este proceso: así el proxy no carga ni vuelve a leer
 * data/portal-store.json en cada visita a la encuesta (los contadores del JSON tampoco van al archivo).
 */
export async function proxyRateLimitStore(): Promise<Pick<PortalStore, "hitRateLimit">> {
  if (process.env.DATABASE_URL && process.env.PORTAL_STORE !== "json") return getPortalStore();
  return (proxyLocal ??= JsonPortalStore.memory());
}

/** Minutos para el texto ("1 minuto", "15 minutos"). */
export function retryText(retryAfterSec: number): string {
  const min = Math.max(1, Math.ceil(retryAfterSec / 60));
  return min === 1 ? "1 minuto" : `${min} minutos`;
}
