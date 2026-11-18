/**
 * Hotfix login 2: valores del acceso al portal (config/portal.json → access). Vigencia de la sesión (se renueva sola con
 * el uso), del enlace del bot (reutilizable durante ese plazo) y el número del bot para el botón "Pedir enlace por
 * WhatsApp" de la entrada.
 */
import { loadPortalConfig, type PortalAccessConfig } from "../config";
import { LOGIN_TOKEN_TTL_MS, SESSION_TTL_MS } from "./constants";

type Env = Record<string, string | undefined>;

function accessConfig(): PortalAccessConfig | null {
  try {
    return loadPortalConfig().access;
  } catch {
    return null; // config ilegible: los valores por defecto (el login no debe caerse por eso)
  }
}

/** Vigencia de la sesión (ms): access.sessionDays, 30 días por defecto. */
export function sessionTtlMs(): number {
  const days = accessConfig()?.sessionDays;
  return days ? Math.round(days * 86_400_000) : SESSION_TTL_MS;
}

/** Vigencia del enlace de entrada (ms): access.linkHours, 24 h por defecto. */
export function linkTtlMs(): number {
  const hours = accessConfig()?.linkHours;
  return hours ? Math.round(hours * 3_600_000) : LOGIN_TOKEN_TTL_MS;
}

/** "24 horas", "30 días" (para los textos del bot y de la entrada). */
export function hoursText(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return `${Math.round(ms / 60_000)} minutos`;
  return h === 1 ? "1 hora" : `${h} horas`;
}

export function daysText(ms: number): string {
  const d = Math.round(ms / 86_400_000);
  return d === 1 ? "1 día" : `${d} días`;
}

/** Número del bot (solo dígitos): PORTAL_BOT_WHATSAPP, si no access.botWhatsapp; "" si no hay. */
export function botWhatsapp(env: Env = process.env): string {
  const fromEnv = (env.PORTAL_BOT_WHATSAPP ?? "").replace(/\D/g, "");
  return fromEnv || (accessConfig()?.botWhatsapp ?? "").replace(/\D/g, "");
}

/** Chat del bot con `portal` ya escrito (wa.me), o null si no hay número configurado. */
export function botChatUrl(env: Env = process.env): string | null {
  const n = botWhatsapp(env);
  return n.length >= 8 ? `https://wa.me/${n}?text=${encodeURIComponent("portal")}` : null;
}
