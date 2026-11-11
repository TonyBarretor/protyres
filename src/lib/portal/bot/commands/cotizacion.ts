/** `enlazar` (cotización recién armada → oportunidad del portal) y `reenviada 032` (pasa a Cotización enviada). */
import { confirmQuoteLink, markQuoteForwarded } from "../../quotes/link";
import { registerPortalCommand } from "../registry";

registerPortalCommand("enlazar", async (ctx, args) => {
  await confirmQuoteLink(ctx, args);
});

registerPortalCommand("reenviada", async (ctx, args) => {
  await markQuoteForwarded(ctx, args);
});
