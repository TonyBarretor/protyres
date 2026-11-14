/**
 * Puerta de entrada del bot (corrida E): quién puede hacer gastar. Todo puro salvo la consulta del usuario del portal.
 *
 *  - admitWebhookMessage: descarta lo que Meta reintenta tarde (timestamp de más de limits.maxMessageAgeMinutes). Los
 *    repetidos por id los descarta processInbound con store.markProcessed (src/lib/bot.ts).
 *  - isRegisteredSender: número registrado = vendedor de config/pilot.json (`salespeople`, sin la clave "default"),
 *    número de ADMIN_NUMBERS / WHATSAPP_ALLOWED_NUMBERS / PORTAL_*_NUMBER (y las variables que nombra config/portal.json
 *    en `users` y `techLead`), o usuario ACTIVO del portal (tabla users). Un número no registrado no llega al cotizador
 *    ni al portal: cero llamadas al modelo, cero Deepgram, cero descargas; como mucho UNA respuesta fija por día.
 *  - BurstLimiter: tope de mensajes por usuario por minuto (limits.burstPerMinute); se avisa una vez por minuto.
 */
import type { PortalConfig } from "../portal/config";
import type { Settings } from "../settings";
import type { InboundMessage } from "../whatsapp/webhook";

export const UNKNOWN_SENDER_REPLY = "Este número es solo para el equipo de *360 Tyres*. Si eres cliente, escríbele a tu asesor comercial, por favor.";
export const BURST_REPLY = "Vas muy rápido 🙂 Dejé de procesar tus mensajes por un minuto; espera un momento y vuelve a escribir.";

const digits = (s: string | undefined | null) => (s ?? "").replace(/\D/g, "");

/** Variables de entorno con números del equipo (además de las que nombra config/portal.json). */
export const TEAM_NUMBER_ENVS = ["ADMIN_NUMBERS", "WHATSAPP_ALLOWED_NUMBERS", "PORTAL_ADMIN_NUMBER", "PORTAL_SUPERVISOR_NUMBER", "PORTAL_TECH_LEAD_NUMBER"];

/** ¿Mensaje del webhook demasiado viejo? (timestamp de Meta en segundos; sin timestamp válido se admite). */
export function isStaleMessage(msg: Pick<InboundMessage, "timestamp">, nowMs: number, maxAgeMinutes: number): boolean {
  const ts = Number(msg.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return nowMs - ts * 1000 > maxAgeMinutes * 60_000;
}

export type WebhookAdmission = { ok: true } | { ok: false; reason: "no_permitido" | "viejo" };

/**
 * Admisión de un mensaje del webhook antes de marcarlo como procesado (pura): lista blanca WHATSAPP_ALLOWED_NUMBERS
 * (vacía = todos) y antigüedad.
 */
export function admitWebhookMessage(msg: Pick<InboundMessage, "from" | "timestamp">, opts: { nowMs: number; maxAgeMinutes: number; allowed: string[] }): WebhookAdmission {
  if (opts.allowed.length && !opts.allowed.includes(digits(msg.from))) return { ok: false, reason: "no_permitido" };
  if (isStaleMessage(msg, opts.nowMs, opts.maxAgeMinutes)) return { ok: false, reason: "viejo" };
  return { ok: true };
}

/** Números del equipo que no dependen del store: vendedores de pilot.json, variables de entorno, números fijos del portal. */
export function staticTeamNumbers(settings: Pick<Settings, "salespeople">, env: Record<string, string | undefined>, portal?: Pick<PortalConfig, "techLead"> & { users?: unknown }): Set<string> {
  const out = new Set<string>();
  for (const [key, val] of Object.entries(settings.salespeople ?? {})) {
    if (key === "default" || typeof val !== "object") continue; // "default" apunta a otro número: no registra a nadie
    const d = digits(key);
    if (d.length >= 8) out.add(d);
  }
  const envs = new Set(TEAM_NUMBER_ENVS);
  const users = Array.isArray(portal?.users) ? (portal.users as { whatsapp?: unknown; whatsappEnv?: unknown }[]) : [];
  for (const u of users) {
    if (typeof u?.whatsapp === "string" && digits(u.whatsapp)) out.add(digits(u.whatsapp));
    for (const v of Array.isArray(u?.whatsappEnv) ? u.whatsappEnv : [u?.whatsappEnv]) if (typeof v === "string") envs.add(v);
  }
  if (portal?.techLead) {
    if (portal.techLead.whatsapp && digits(portal.techLead.whatsapp)) out.add(digits(portal.techLead.whatsapp));
    if (portal.techLead.whatsappEnv) envs.add(portal.techLead.whatsappEnv);
  }
  for (const name of envs) {
    for (const part of (env[name] ?? "").split(",")) {
      const d = digits(part);
      if (d.length >= 8) out.add(d);
    }
  }
  return out;
}

/**
 * ¿Es del equipo? Primero lo estático (sin store); si no, usuario ACTIVO del portal. Si la consulta falla o tarda, no
 * está registrado (no gasta) y se registra por qué.
 */
export async function isRegisteredSender(
  phone: string,
  opts: { team: Set<string>; lookupUser?: (phone: string) => Promise<{ activo: boolean } | null>; timeoutMs?: number; log?: (m: string) => void },
): Promise<boolean> {
  const p = digits(phone);
  if (!p) return false;
  if (opts.team.has(p)) return true;
  if (!opts.lookupUser) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const user = await Promise.race([
      opts.lookupUser(p),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("tiempo de espera agotado")), opts.timeoutMs ?? 4000);
      }),
    ]);
    return !!user?.activo;
  } catch (err) {
    opts.log?.(`puerta: no pude consultar el usuario del portal ${p} (${(err as Error).message}); se trata como no registrado`);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Tope de mensajes por usuario por minuto (ventana deslizante de 60 s, en memoria del proceso). `check` devuelve "ok",
 * "aviso" (primer mensaje rechazado de la ventana: se avisa) o "silencio" (rechazado, ya se avisó en esta ventana).
 */
export class BurstLimiter {
  private hits = new Map<string, number[]>();
  private warnedAt = new Map<string, number>();

  constructor(private limit: () => number) {}

  check(phone: string, nowMs: number): "ok" | "aviso" | "silencio" {
    const p = digits(phone);
    const from = nowMs - 60_000;
    const list = (this.hits.get(p) ?? []).filter((t) => t > from);
    if (list.length >= this.limit()) {
      this.hits.set(p, list);
      const warned = this.warnedAt.get(p);
      if (warned !== undefined && warned > from) return "silencio";
      this.warnedAt.set(p, nowMs);
      return "aviso";
    }
    list.push(nowMs);
    this.hits.set(p, list);
    // limpieza ocasional de números sin actividad
    if (this.hits.size > 500) for (const [k, v] of this.hits) if (!v.some((t) => t > from)) this.hits.delete(k);
    return "ok";
  }
}
