/** `ayuda portal` -> lista corta de comandos del portal con un ejemplo de cada uno. */
import { registerPortalCommand } from "../registry";

export const PORTAL_HELP = [
  "*Portal 360 Tyres* 🗂️",
  "",
  "• *portal* — enlace para entrar al portal",
  "• *empresa ZBUSS* (o el RUC) — ficha corta",
  "• *asignarme 20602221505* — la empresa pasa a ti, con su ficha",
  "• *contacto ZBUSS: Juan Pérez, jefe de flota, 987654321* — guarda un contacto",
  "• *hoy* — acciones y citas pendientes",
  "• *cita ZBUSS martes 10am en su base con danyer* — agenda una cita",
  "• *enlazar* — une la cotización recién armada a la empresa del portal",
  "• *reenviada 032* — ya le reenvié la cotización 032 al cliente",
  "• *oc ZBUSS 4500123* — orden de compra (puedes adjuntar el PDF o la foto)",
  "• *avance* — cómo vas en el mes",
  "• *prepropuesta ZBUSS* — PDF de pre-propuesta",
  "• *aprende flama = Flama 77* — enséñame un término",
  "• Reporte: escribe o manda una *nota de voz* (p. ej. _visité ZBUSS, hablé con el jefe de flota, quiere cotización de 295/80R22.5_)",
  "",
  "Para cotizar, escribe el pedido como siempre. *cancelar* borra lo pendiente.",
].join("\n");

registerPortalCommand("ayuda_portal", async (ctx) => {
  await ctx.reply(PORTAL_HELP);
});
