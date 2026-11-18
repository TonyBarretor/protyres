/**
 * Entrada al portal con el enlace del bot (ver src/lib/portal/auth/login.ts). Es un route handler, no una página: no pasa
 * por src/app/portal/layout.tsx (que exige sesión) y src/proxy.ts lo deja pasar.
 */
import { loginGet, loginPost } from "@/lib/portal/auth/login";
import { getPortalStore } from "@/lib/portal/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Límite de intentos por IP y por token (corrida E, punto 5): contadores en el store del portal. */
const limits = { store: getPortalStore };

export function GET(req: Request): Promise<Response> {
  return loginGet(req, { limits, store: getPortalStore });
}

export function POST(req: Request): Promise<Response> {
  return loginPost(req, getPortalStore, { limits });
}
