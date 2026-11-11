/** Cierra la sesión del portal (borra la fila y la cookie) y vuelve a /portal/login. Solo POST. */
import { logout, logoutMethodNotAllowed } from "@/lib/portal/auth/login";
import { getPortalStore } from "@/lib/portal/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return logout(req, getPortalStore);
}

/** Solo POST: un GET (enlace, precarga del navegador) no debe cerrar la sesión. */
export function GET(): Response {
  return logoutMethodNotAllowed();
}
