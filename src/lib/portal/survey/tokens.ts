/**
 * Token del enlace de la encuesta (/encuesta/<token>): 32 bytes aleatorios en base64url (43 caracteres, no adivinable).
 * En la base solo se guarda su sha256; el token en claro solo existe en el enlace enviado.
 */
import { createHash, randomBytes } from "node:crypto";
import { portalBaseUrl } from "../auth/tokens";

export const SURVEY_PATH = "/encuesta";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newSurveyToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSurveyToken(token) };
}

export function hashSurveyToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Forma válida (antes de ir al store: lo demás ni se busca). */
export function isSurveyTokenShape(token: string | null | undefined): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

export function surveyUrl(token: string, env: Record<string, string | undefined> = process.env): string {
  return `${portalBaseUrl(env)}${SURVEY_PATH}/${token}`;
}
