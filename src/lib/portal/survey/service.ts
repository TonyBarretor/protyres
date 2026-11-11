/**
 * Encuesta de satisfacción (bloque C3): crear una encuesta con su enlace, abrirla por token y guardar la respuesta (una sola).
 */
import { loadPortalConfig } from "../config";
import type { Company, PortalStore, Survey, SurveyAnswer, SurveyCanal } from "../store/types";
import { addDays } from "../ui/time";
import { parseSurveyForm, type SurveyFieldError, type SurveyFormLike } from "./questions";
import { hashSurveyToken, isSurveyTokenShape, newSurveyToken, surveyUrl } from "./tokens";

type Env = Record<string, string | undefined>;

export interface CreatedSurvey {
  survey: Survey;
  /** Token en claro: solo existe aquí (en la base va el sha256). */
  token: string;
  url: string;
}

export interface CreateSurveyOptions {
  companyId: number;
  contactId?: number | null;
  canal: SurveyCanal;
  createdBy?: number | null;
  now?: Date;
  /** Por defecto config/portal.json → surveys.expiresDays. */
  expiresDays?: number;
  /** Si se pasa, no crea nada (null) cuando la empresa ya tiene una encuesta que cuenta desde esa fecha (atómico). */
  onlyIfNoneSince?: Date;
  env?: Env;
}

export async function createSurveyLink(store: PortalStore, opts: CreateSurveyOptions): Promise<CreatedSurvey | null> {
  const now = opts.now ?? new Date();
  const days = opts.expiresDays ?? loadPortalConfig().surveys.expiresDays;
  const { token, tokenHash } = newSurveyToken();
  const survey = await store.createSurvey(
    { companyId: opts.companyId, contactId: opts.contactId ?? null, tokenHash, canal: opts.canal, createdBy: opts.createdBy ?? null, expiresAt: addDays(now, days), createdAt: now },
    { onlyIfNoneSince: opts.onlyIfNoneSince },
  );
  if (!survey) return null;
  return { survey, token, url: surveyUrl(token, opts.env) };
}

export type OpenSurvey =
  | { status: "invalida" }
  | { status: "vencida"; survey: Survey; company: Company | null }
  | { status: "respondida"; survey: Survey; company: Company | null }
  | { status: "abierta"; survey: Survey; company: Company | null };

/** Busca la encuesta del enlace. Si venció sin respuesta, la marca vencida. */
export async function openSurvey(store: PortalStore, token: string | null | undefined, now: Date = new Date()): Promise<OpenSurvey> {
  if (!isSurveyTokenShape(token)) return { status: "invalida" };
  let survey = await store.getSurveyByTokenHash(hashSurveyToken(token));
  if (!survey) return { status: "invalida" };
  const company = await store.getCompany(survey.companyId);
  if (survey.estado === "respondida") return { status: "respondida", survey, company };
  if (survey.estado === "vencida") return { status: "vencida", survey, company };
  if (survey.expiresAt.getTime() <= now.getTime()) {
    survey = (await store.expireSurvey(survey.id)) ?? survey;
    return { status: "vencida", survey, company };
  }
  return { status: "abierta", survey, company };
}

export type SubmitResult =
  | { ok: true; survey: Survey; answer: SurveyAnswer }
  | { ok: false; reason: "invalida" | "vencida" | "respondida" }
  | { ok: false; reason: "datos"; errors: SurveyFieldError[] };

/** Valida el formulario y guarda la respuesta (una sola vez: la segunda se rechaza con "respondida"). */
export async function submitSurvey(store: PortalStore, token: string | null | undefined, form: SurveyFormLike, now: Date = new Date()): Promise<SubmitResult> {
  const open = await openSurvey(store, token, now);
  if (open.status !== "abierta") return { ok: false, reason: open.status };
  const parsed = parseSurveyForm(form);
  if (!parsed.ok) return { ok: false, reason: "datos", errors: parsed.errors };
  const r = await store.answerSurvey(open.survey.id, parsed.answer, now);
  if (!r.ok) return { ok: false, reason: r.reason === "no_existe" ? "invalida" : r.reason };
  return { ok: true, survey: r.survey, answer: r.answer };
}
