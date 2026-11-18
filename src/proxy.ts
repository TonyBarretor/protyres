/**
 * Proxy de Next 16 (antes "middleware"). Comprobación barata y optimista para /portal/**: sin cookie de sesión se va a
 * /portal/login (pantalla pública que explica cómo pedir el enlace). La validación real de la sesión la hace requireUser()
 * (src/lib/portal/auth/session.ts) en el servidor. El resto de la app (webhook, API, home) no pasa por aquí.
 *
 * Corrida E, punto 5: /encuesta/<token> (página pública y el POST de su server action) pasa por surveyGate: límite de
 * intentos por IP y por token, token absurdo y cuerpo enorme, con 429/404/413 de verdad (una página no puede fijar el estado).
 */
import { NextResponse, type NextRequest } from "next/server";
import { LOGIN_PATH, SESSION_COOKIE } from "./lib/portal/auth/constants";
import { proxyRateLimitStore } from "./lib/portal/auth/rate-limit";
import { surveyGate } from "./lib/portal/survey/gate";
import { SURVEY_PATH } from "./lib/portal/survey/tokens";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith(`${SURVEY_PATH}/`)) return (await surveyGate(request, { store: proxyRateLimitStore })) ?? NextResponse.next();
  if (pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`)) return NextResponse.next();
  if (request.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  // hotfix login (18/11): sin cookie (el navegador no la guardó o no la mandó): que quede en los registros
  console.log(`[portal] ${pathname} sin cookie de sesión: a la entrada`);
  const url = request.nextUrl.clone();
  url.pathname = LOGIN_PATH;
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/portal", "/portal/:path*", "/encuesta/:path*"],
};
