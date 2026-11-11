/**
 * Punto de entrada único del portal en el bot (BotHandler.handle() lo llama antes del flujo de cotización).
 * Devuelve true si atendió el mensaje; con false el cotizador sigue como siempre.
 *
 * Fase A: solo el comando `portal` (texto exacto, sin importar mayúsculas ni tildes) -> enlace de acceso de un solo uso.
 * La fase B amplía este router (empresa, asignarme, contacto, hoy, ...).
 */
import { fold } from "../../tyre/brands";
import { LOGIN_TOKEN_TTL_MS } from "../auth/constants";
import { PortalAuthConfigError, createLoginLink } from "../auth/tokens";
import { getPortalStore } from "../store";
import type { PortalStore } from "../store/types";

export interface PortalCommandInput {
  from: string;
  text: string;
  reply: (body: string) => Promise<void>;
  /** Inyectado en tests; por defecto getPortalStore() (perezoso: solo si el mensaje es del portal). */
  store?: PortalStore;
  env?: Record<string, string | undefined>;
  now?: Date;
  log?: (msg: string) => void;
}

export const NOT_REGISTERED = "Tu número no está registrado en el portal. Pide a Tony que te agregue.";
export const noConfigReply = (detail: string): string => `El portal aún no está configurado: ${detail} Avísale a Tony.`;

export function isPortalCommand(text: string): boolean {
  return fold(text) === "portal";
}

export async function handlePortalCommand(input: PortalCommandInput): Promise<boolean> {
  if (!isPortalCommand(input.text)) return false;
  const store = input.store ?? (await getPortalStore());
  const user = await store.getUserByWhatsapp(input.from);
  if (!user || !user.activo) {
    await input.reply(NOT_REGISTERED);
    return true;
  }
  try {
    const link = await createLoginLink(store, user, { env: input.env, now: input.now });
    await store.flush();
    const minutes = Math.round(LOGIN_TOKEN_TTL_MS / 60000);
    await input.reply(`Hola ${user.nombre.split(/\s+/)[0]}, entra al portal aquí:\n${link.url}\n\n_Válido ${minutes} min y un solo uso. No lo compartas._`);
  } catch (err) {
    if (!(err instanceof PortalAuthConfigError)) throw err;
    input.log?.(`portal: ${err.message}`);
    await input.reply(noConfigReply(err.message));
  }
  return true;
}
