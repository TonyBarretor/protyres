/**
 * Edición manual del crédito desde la ficha: lectura del formulario y decisión (permiso, transición, validación, quién
 * consultó, PDF, plazo habitual) en funciones puras. La server action (src/app/portal/actions.ts) solo lee la sesión, el
 * store y el archivo, llama a planCreditUpdate y guarda lo que devuelve.
 */
import { canEditCompany } from "../auth/permissions";
import type { Company, CompanyCredit, CreditEstado, CreditPdf, CreditSaveInput, PortalUser } from "../store/types";
import { formText, type FormLike } from "../ui/labels";
import { limaDateKey } from "../ui/time";
import { canTransition, creditEstadoLabel, creditEstadoOf, isCreditEstado, validateCredit } from "./states";

/** Mismo límite que "Subir ventas": Vercel corta el cuerpo en 4,5 MB (bodySizeLimit 4.5mb en next.config.ts). */
export const MAX_CREDIT_PDF_BYTES = 4_000_000;

export interface CreditForm {
  estado: CreditEstado;
  calificacion: string | null;
  linea: number | null;
  moneda: string | null;
  plazoDias: number | null;
  fuente: string | null;
  consultadoAt: Date | null;
  notas: string | null;
  quitarPdf: boolean;
  /** Checkbox "usar este plazo como plazo habitual de la empresa". */
  actualizarPlazo: boolean;
}

type Parsed<T> = { ok: true; data: T } | { ok: false; error: string };

/** "50,000.50", "50000", "S/ 12 000" -> número; "" -> null; basura -> NaN (lo rechaza validateCredit). */
function parseAmount(raw: string): number | null {
  const s = raw.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  if (!s) return raw.trim() ? Number.NaN : null;
  return Number(s);
}

function parseDays(raw: string): number | null {
  const s = raw.replace(/\s*d[ií]as?$/i, "").trim();
  if (!s) return null;
  return /^\d+$/.test(s) ? Number(s) : Number.NaN;
}

/** "AAAA-MM-DD" (input date) -> mediodía de Lima de ese día; vacío -> null; inválida -> undefined. */
export function parseLimaDate(raw: string): Date | null | undefined {
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 17)); // 12:00 Lima (UTC-5)
  return d.getUTCDate() === Number(m[3]) ? d : undefined;
}

export function parseCreditForm(f: FormLike): Parsed<CreditForm> {
  const estado = formText(f, "estado", 30);
  if (!isCreditEstado(estado)) return { ok: false, error: "Estado de crédito no válido." };
  const consultadoAt = parseLimaDate(formText(f, "consultadoAt", 20));
  if (consultadoAt === undefined) return { ok: false, error: "Fecha de consulta no válida." };
  const notasRaw = f.get("notas");
  const notas = typeof notasRaw === "string" ? notasRaw.replace(/\r\n/g, "\n").trim().slice(0, 1000) : "";
  const moneda = formText(f, "moneda", 5).toUpperCase();
  return {
    ok: true,
    data: {
      estado,
      calificacion: formText(f, "calificacion", 60) || null,
      linea: parseAmount(formText(f, "linea", 30)),
      moneda: moneda || null,
      plazoDias: parseDays(formText(f, "plazoDias", 15)),
      fuente: formText(f, "fuente", 120) || null,
      consultadoAt,
      notas: notas || null,
      quitarPdf: f.get("quitarPdf") === "on",
      actualizarPlazo: f.get("actualizarPlazo") === "on",
    },
  };
}

/** El archivo subido como PDF del reporte: hasta 4 MB y que realmente sea un PDF (empieza con "%PDF-"). */
export function readCreditPdf(file: { name: string; type: string; size: number }, bytes: Uint8Array): Parsed<CreditPdf> {
  if (file.size > MAX_CREDIT_PDF_BYTES || bytes.length > MAX_CREDIT_PDF_BYTES) return { ok: false, error: "El PDF pesa más de 4 MB." };
  const head = Buffer.from(bytes.subarray(0, 5)).toString("latin1");
  if (head !== "%PDF-") return { ok: false, error: "El adjunto debe ser un PDF." };
  const name = file.name.replace(/[\\/\0]/g, "_").trim().slice(0, 150) || "reporte-credito.pdf";
  return { ok: true, data: { name, mime: "application/pdf", data: Buffer.from(bytes).toString("base64") } };
}

export interface CreditPlanInput {
  user: Pick<PortalUser, "id" | "rol" | "activo"> | null;
  company: Pick<Company, "id" | "ownerUserId" | "creditTermsDays">;
  prev: CompanyCredit | null;
  form: CreditForm;
  /** PDF nuevo ya validado (readCreditPdf), si se subió uno. */
  pdf?: CreditPdf | null;
  now: Date;
}

export type CreditPlan =
  | { ok: false; error: string }
  | {
      ok: true;
      input: CreditSaveInput;
      /** Plazo a guardar como habitual de la empresa (companies.credit_terms_days); null = no tocarlo. */
      termsDays: number | null;
    };

/**
 * Decide qué guardar. Permiso: vendedor dueño de la empresa o supervisor/admin (canEditCompany). La transición debe ser
 * válida (canTransition) y el estado destino cumplir validateCredit. Quién consultó: el usuario, si cambia la fecha de
 * consulta o sube un PDF (un PDF sin fecha toma hoy); si no, se conserva.
 */
export function planCreditUpdate({ user, company, prev, form, pdf, now }: CreditPlanInput): CreditPlan {
  if (!user || !canEditCompany(user, company)) return { ok: false, error: "Solo el dueño de la empresa (o supervisor) puede editar el crédito." };
  const from = creditEstadoOf(prev);
  if (!canTransition(from, form.estado)) return { ok: false, error: `No se puede pasar de "${creditEstadoLabel(from)}" a "${creditEstadoLabel(form.estado)}".` };
  const errors = validateCredit(form);
  if (errors.length) return { ok: false, error: errors.join(" ") };

  let consultadoAt = form.consultadoAt;
  if (pdf && !consultadoAt) consultadoAt = parseLimaDate(limaDateKey(now)) ?? now;
  // el formulario solo trae el día: mismo día de Lima que lo guardado = sin cambio (se conserva el instante guardado)
  if (consultadoAt && prev?.consultadoAt && limaDateKey(consultadoAt) === limaDateKey(prev.consultadoAt)) consultadoAt = prev.consultadoAt;
  const fechaCambio = (consultadoAt?.getTime() ?? null) !== (prev?.consultadoAt?.getTime() ?? null);
  const consultadoPor = consultadoAt ? (fechaCambio || pdf ? user.id : (prev?.consultadoPor ?? user.id)) : null;

  const input: CreditSaveInput = {
    estado: form.estado,
    calificacion: form.calificacion,
    linea: form.linea,
    moneda: form.linea !== null ? (form.moneda ?? "USD") : form.moneda,
    plazoDias: form.plazoDias,
    fuente: form.fuente,
    consultadoAt,
    consultadoPor,
    notas: form.notas,
    pdf: pdf ? pdf : form.quitarPdf ? null : undefined,
  };
  const termsDays = form.estado === "aprobado" && form.actualizarPlazo && form.plazoDias !== null && form.plazoDias !== company.creditTermsDays ? form.plazoDias : null;
  return { ok: true, input, termsDays };
}

/** Checkbox "actualizar plazo habitual": marcado por defecto solo si la empresa no tenía plazo. */
export function defaultUpdateTerms(company: Pick<Company, "creditTermsDays">): boolean {
  return company.creditTermsDays === null;
}
