/**
 * `portal` -> enlace de acceso (hotfix login 2: si el usuario ya tiene uno vigente, el MISMO enlace renovado a
 * access.linkHours; sirve todas las veces que haga falta en ese plazo). `cerrar portal` -> cierra todas sus sesiones y anula
 * sus enlaces (teléfono perdido o enlace reenviado por error).
 */
import { daysText, hoursText, linkTtlMs, sessionTtlMs } from "../../auth/access";
import { PortalAuthConfigError, loginLinkFor, revokeAccess } from "../../auth/tokens";
import { registerPortalCommand } from "../registry";

/** Sin secreto u otra configuración: el detalle (con el nombre de la variable) va al log, no al chat (corrida F, punto 3). */
export const noConfigReply = (_detail?: string): string => "El portal aún no está configurado: contacta al administrador.";

/** El mensaje con el enlace (lo prueba src/lib/portal/bot y el simulador). */
export function portalLinkReply(nombre: string, url: string): string {
  return `Hola ${nombre.split(/\s+/)[0]}, entra al portal aquí:\n${url}\n\n_Sirve por ${hoursText(linkTtlMs())}. Después de entrar, tu teléfono queda con la sesión abierta por ${daysText(sessionTtlMs())}. No lo compartas._`;
}

registerPortalCommand("portal", async (ctx) => {
  try {
    const link = await loginLinkFor(ctx.store, ctx.user, { env: ctx.env, now: ctx.now });
    await ctx.store.flush();
    if (link.reused) ctx.log("portal: reenvío el enlace vigente (renovado)");
    await ctx.reply(portalLinkReply(ctx.user.nombre, link.url));
  } catch (err) {
    if (!(err instanceof PortalAuthConfigError)) throw err;
    ctx.log(`portal: sin configuración para el enlace: ${err.message}`);
    await ctx.reply(noConfigReply(err.message));
  }
});

registerPortalCommand("cerrar_portal", async (ctx) => {
  const r = await revokeAccess(ctx.store, ctx.user.id, { now: ctx.now });
  ctx.log(`portal: cerrar portal de ${ctx.user.nombre}: ${r.sessions} sesiones y ${r.links} enlaces anulados`);
  const sesiones = r.sessions === 1 ? "1 sesión abierta" : `${r.sessions} sesiones abiertas`;
  await ctx.reply(
    `Listo: cerré tu portal en todos los teléfonos (${sesiones}) y anulé tus enlaces de entrada. Para volver a entrar, escribe *portal* y te mando uno nuevo.`,
  );
});
