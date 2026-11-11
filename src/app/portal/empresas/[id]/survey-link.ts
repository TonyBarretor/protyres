import { isSurveyTokenShape } from "@/lib/portal/survey/tokens";

/** Cookie de paso con el enlace recién creado ("<surveyId>.<token>"): ver survey-actions.ts. */
export const SURVEY_LINK_COOKIE = "pt_survey_link";

export function parseSurveyLinkCookie(v: string | undefined, surveyId: number): string | null {
  if (!v) return null;
  const dot = v.indexOf(".");
  if (dot < 0 || Number(v.slice(0, dot)) !== surveyId) return null;
  const token = v.slice(dot + 1);
  return isSurveyTokenShape(token) ? token : null;
}
