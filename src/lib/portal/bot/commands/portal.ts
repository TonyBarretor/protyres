/** `portal` -> enlace de acceso de un solo uso (fase A). */
import { LOGIN_TOKEN_TTL_MS } from "../../auth/constants";
import { PortalAuthConfigError, createLoginLink } from "../../auth/tokens";
import { registerPortalCommand } from "../registry";

export const noConfigReply = (detail: string): string => `El portal aún no está configurado: ${detail} Avísale a Tony.`;

registerPortalCommand("portal", async (ctx) => {
  try {
    const link = await createLoginLink(ctx.store, ctx.user, { env: ctx.env, now: ctx.now });
    await ctx.store.flush();
    const minutes = Math.round(LOGIN_TOKEN_TTL_MS / 60000);
    await ctx.reply(`Hola ${ctx.user.nombre.split(/\s+/)[0]}, entra al portal aquí:\n${link.url}\n\n_Válido ${minutes} min y un solo uso. No lo compartas._`);
  } catch (err) {
    if (!(err instanceof PortalAuthConfigError)) throw err;
    ctx.log(`portal: ${err.message}`);
    await ctx.reply(noConfigReply(err.message));
  }
});
