/**
 * Corrida E, punto 5: puerta de la encuesta pública /encuesta/<token>. La llama src/proxy.ts antes de la página y de su
 * server action (el envío del formulario es un POST a la misma URL), así puede responder 429/413/404 de verdad.
 *
 *   token con otra forma (no 43 caracteres base64url) -> 404 "Enlace no válido", sin tocar la base
 *   POST con Content-Length > publicInputs.maxSurveyBodyBytes -> 413
 *   GET/HEAD -> cuenta en rateLimits.surveyView; POST -> en rateLimits.surveySubmit (por IP y por token) -> 429
 *
 * Nada aquí llama al modelo ni a Deepgram (src/lib/portal/auth/public-entries.test.ts).
 */
import { page } from "../auth/pages";
import { checkRateLimit, clientIp, publicInputsConfig, retryText, type RateLimitDeps } from "../auth/rate-limit";
import { isSurveyTokenShape, SURVEY_PATH } from "./tokens";

const NOT_VALID = `<h1>Enlace no válido</h1><p>Revise que el enlace esté completo. Si el problema sigue, pida uno nuevo a su ejecutivo de 360 Tyres.</p>`;

export async function surveyGate(req: Request, deps: RateLimitDeps): Promise<Response | null> {
  const cfg = deps.config ?? publicInputsConfig();
  const { pathname } = new URL(req.url);
  if (!pathname.startsWith(`${SURVEY_PATH}/`)) return null;
  const rest = pathname.slice(SURVEY_PATH.length + 1).replace(/\/$/, "");
  if (!rest) return null;
  // el token va crudo en la URL ([A-Za-z0-9_-]); cualquier otra cosa (larga, codificada, con "/") no es un enlace nuestro
  if (rest.length > cfg.maxTokenChars || !isSurveyTokenShape(rest)) return page("Enlace no válido", NOT_VALID, 404);
  const isPost = req.method === "POST";
  if (isPost) {
    const len = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(len) && len > cfg.maxSurveyBodyBytes) {
      return page("Respuesta demasiado grande", `<h1>Respuesta demasiado grande</h1><p>Acorte su comentario y vuelva a enviarla.</p>`, 413);
    }
  }
  const r = await checkRateLimit({ ...deps, config: cfg }, isPost ? "surveySubmit" : "surveyView", { ip: clientIp(req.headers), token: rest });
  if (r.ok) return null;
  return page(
    "Demasiados intentos",
    `<h1>Demasiados intentos</h1><p>Recibimos muchas solicitudes con este enlace o desde esta conexión. Vuelva a intentarlo en unos ${retryText(r.retryAfterSec)}.</p>`,
    429,
    { "retry-after": String(r.retryAfterSec) },
  );
}
