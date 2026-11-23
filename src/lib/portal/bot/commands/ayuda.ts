/** `ayuda portal` -> lista corta de comandos del portal con un ejemplo de cada uno. */
import { registerPortalCommand } from "../registry";

export const PORTAL_HELP = [
  "*Portal 360 Tyres* 🗂️",
  "",
  "• *portal* — enlace para entrar al portal (sirve varias veces; después tu teléfono queda con la sesión abierta)",
  "• *cerrar portal* — cierra el portal en todos tus teléfonos y anula tus enlaces",
  "• *empresa ZBUSS* (o el RUC) — ficha corta",
  "• *asignarme ZBUSS* (o el RUC; también por voz) — la empresa pasa a ti, con su ficha",
  "• *nueva empresa* (también por voz) — registra una empresa que no está en el padrón: RUC, razón social, sector y departamento",
  "• *contacto ZBUSS: Juan Pérez, jefe de flota, 987654321* — guarda un contacto",
  "• *hoy* — acciones y citas pendientes",
  "• *mejores* — tus 5 mejores flotas para trabajar (estimación), para asignártelas; *más* trae otras 5",
  "• *match* (o por voz: _¿a quién le vendo mi stock?_) — tus llantas prioritarias y cuántas empresas hacen match",
  "• *match P0433* (o la medida: *match 295/80R22.5*) — las 5 empresas que mejor encajan, para asignártelas o agendar la visita; *más* trae otras 5",
  "• *prioridad P0428* / *quitar prioridad P0428* (o medida y modelo: *prioridad 295 flama 66*; también por voz) — marca o quita una llanta prioritaria",
  "• *avance match* — por llanta prioritaria: disponible, cotizado, pedido, lo que queda y las visitas",
  "• *cita ZBUSS martes 10am en su base con danyer* — agenda una cita (te llega la invitación a tu correo para Outlook)",
  "• *cita cancelar ZBUSS* — cancela su cita (y la quita de tu calendario)",
  "• *enlazar* — une la cotización recién armada a la empresa del portal (si el cliente no está, te ofrece crearlo)",
  "• *reenviada 032* — ya le reenvié la cotización 032 al cliente",
  "• *oc ZBUSS 4500123* — orden de compra (puedes adjuntar el PDF o la foto)",
  "• *estado ZBUSS* — en qué paso vas con la empresa (1 Asignada … 7 Pedido a Patricia) y qué sigue",
  "• *continuar* / *descartar* — retoma o descarta lo que dejaste en pausa (aparece en *hoy*)",
  "• *avance* — cómo vas en el mes",
  "• *prepropuesta ZBUSS* — PDF de pre-propuesta",
  "• *aprende flama = Flama 77* — enséñame un término",
  "• *ultima venta ZBUSS 295/80R22.5* (la medida es opcional; también por voz) — las 3 últimas ventas con precio, costo y margen",
  "• *cliente final F003-4050 ZBUSS* (o el RUC) — la factura de un banco (leasing) cuenta para esa empresa",
  "• Reporte: escribe o manda una *nota de voz* (p. ej. _visité ZBUSS, hablé con el jefe de flota, quiere cotización de 295/80R22.5_)",
  "",
  "Para cotizar, escribe el pedido como siempre. *cancelar* borra lo pendiente.",
].join("\n");

registerPortalCommand("ayuda_portal", async (ctx) => {
  await ctx.reply(PORTAL_HELP);
});
