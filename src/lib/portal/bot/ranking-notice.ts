/**
 * Corrida G, punto 6 — aviso de validar el ranking: el bot le dice UNA vez a cada vendedor, supervisor y admin que puede
 * comparar el ranking con su criterio en /portal/validar-ranking. Va al final de `mejores` y de `hoy`, solo cuando ya hay
 * un cálculo de puntajes (sin él no hay nada que validar). "Una vez" lo garantiza store.markUserNotice (atómico: aunque
 * dos instancias respondan a la vez, solo una da el aviso).
 *
 * El enlace es el de `portal` (hotfix login 2: el vigente del usuario, reutilizable 24 h) con destino
 * /portal/validar-ranking (`next`, lista cerrada en auth/constants.ts). Sin configuración del enlace va la dirección de la pantalla. Si algo falla, el aviso no rompe la
 * respuesta: se registra y no se da (queda para la próxima si no llegó a marcarse).
 */
import { hoursText, linkTtlMs } from "../auth/access";
import { loginLinkFor, portalBaseUrl } from "../auth/tokens";
import { canValidateRanking } from "../ui/permissions";
import type { PortalContext } from "./registry";

export const RANKING_NOTICE_KEY = "validar-ranking";
export const VALIDATE_RANKING_PATH = "/portal/validar-ranking";

export function rankingNoticeText(link: string, withLink: boolean): string {
  return [
    "📝 *Ayúdanos a afinar el ranking*",
    "Marca A, B o C en 20 empresas que conoces (unos 5 min): así ajustamos la estimación a tu criterio.",
    `Entra aquí: ${link}`,
    withLink ? `_El enlace sirve por ${hoursText(linkTtlMs())}. Si vence, escribe *portal* y entra a *Validar* en el menú._` : "_También desde el portal, en *Validar* del menú._",
  ].join("\n");
}

/** El aviso si le toca ahora a este usuario (y lo marca como dado); null si no. Nunca lanza. */
export async function rankingNotice(ctx: Pick<PortalContext, "store" | "user" | "env" | "now" | "log">): Promise<string | null> {
  const { store, user } = ctx;
  // los mismos que pueden abrir la pantalla (vendedor, supervisor, admin; no el técnico)
  if (!canValidateRanking(user)) return null;
  try {
    if (!(await store.latestScoreRun())) return null;
    if (!(await store.markUserNotice(user.id, RANKING_NOTICE_KEY))) return null;
  } catch (err) {
    ctx.log(`portal: no pude revisar el aviso de validar el ranking: ${(err as Error).message}`);
    return null;
  }
  try {
    const link = await loginLinkFor(store, user, { env: ctx.env, now: ctx.now, next: VALIDATE_RANKING_PATH });
    await store.flush();
    return rankingNoticeText(link.url, true);
  } catch (err) {
    // sin secreto para el enlace (u otro error al guardarlo): la dirección de la pantalla, que pide entrar si hace falta
    ctx.log(`portal: aviso de validar el ranking sin enlace de entrada: ${(err as Error).message}`);
    return rankingNoticeText(`${portalBaseUrl(ctx.env)}${VALIDATE_RANKING_PATH}`, false);
  }
}
