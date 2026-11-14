/**
 * Next.js 16: register() corre UNA vez al arrancar cada instancia del servidor (también en Vercel, por instancia), antes
 * de atender peticiones. Corrida E: advertencia visible si el webhook de WhatsApp no verifica la firma (falta
 * WHATSAPP_APP_SECRET). Solo en Node (el webhook corre en Node; en edge no hay nada que avisar).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { appSecretWarning } = await import("./lib/whatsapp/webhook");
  const warning = appSecretWarning(process.env);
  if (warning) console.warn(warning);
}
