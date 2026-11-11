/** Cierra la sesión del portal (borra la fila y la cookie) y vuelve a /portal/login. */
import { logout } from "@/lib/portal/auth/login";
import { getPortalStore } from "@/lib/portal/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return logout(req, getPortalStore);
}

export function GET(req: Request): Promise<Response> {
  return logout(req, getPortalStore);
}
