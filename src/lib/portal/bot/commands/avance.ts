/**
 * `avance` -> tres líneas: vendido, meta y proyección del mes (bloque C2). Vendedor: lo suyo; supervisor/admin: el
 * total del equipo. Mismas cifras que /portal/tablero (dashboard/load.ts).
 */
import { canSeeAll } from "../../auth/permissions";
import { avanceLines } from "../../dashboard/format";
import { loadDashboard } from "../../dashboard/load";
import { registerPortalCommand } from "../registry";

registerPortalCommand("avance", async (ctx) => {
  const scope = canSeeAll(ctx.user) ? ({ kind: "equipo" } as const) : ({ kind: "usuario", userId: ctx.user.id } as const);
  const d = await loadDashboard(ctx.store, { scope, now: ctx.now, details: false });
  await ctx.reply(avanceLines(d).join("\n"));
});
