/**
 * Proxy de Next 16 (antes "middleware"). Comprobación barata y optimista para /portal/**: sin cookie de sesión se va a
 * /portal/login (pantalla pública que explica cómo pedir el enlace). La validación real de la sesión la hace requireUser()
 * (src/lib/portal/auth/session.ts) en el servidor. El resto de la app (webhook, API, home) no pasa por aquí.
 */
import { NextResponse, type NextRequest } from "next/server";
import { LOGIN_PATH, SESSION_COOKIE } from "./lib/portal/auth/constants";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`)) return NextResponse.next();
  if (request.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = LOGIN_PATH;
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/portal", "/portal/:path*"],
};
