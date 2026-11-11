import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Portal settings (config/portal.json). Other blocks add their own keys here; unknown keys are kept. */
const ImportSchema = z.object({
  /** Only companies with at least this many current units are imported. */
  minUnits: z.number().int().min(1).default(10),
  /** FECHA_CORTE of the current fleet (carga and pasajeros). */
  currentCut: z.string().regex(/^\d{8}$/).default("20251231"),
  /** Older carga cuts used to fill N_LLANTAS by PLACA, in priority order. */
  tyreCuts: z.array(z.string().regex(/^\d{8}$/)).default(["20241231", "20231231", "20221231"]),
  /** Folder with the MTC CSVs (relative to the repo root). */
  dir: z.string().default("data/mtc"),
});

/** Citas del bot (comando `cita`). */
const AppointmentsSchema = z.object({
  /** Duración de la cita en el .ics. */
  durationMinutes: z.number().int().min(5).max(24 * 60).default(60),
  /** Aviso del calendario antes de la cita (minutos; 0 = sin aviso). */
  alarmMinutes: z.number().int().min(0).max(24 * 60).default(30),
});

/** Jefe del Dpto. Técnico ("cita … con danyer"): número fijo o variable de entorno; sin número, el bot lo dice. */
const TechLeadSchema = z.object({
  nombre: z.string().min(1).default("Danyer Saavedra"),
  whatsapp: z.string().optional(),
  whatsappEnv: z.string().default("PORTAL_TECH_LEAD_NUMBER"),
});

/** Cotización enlazada (bloque B4): recordatorio de cotización sin respuesta. */
const QuotesSchema = z.object({
  /** Días hábiles (lun–vie en Lima, sin feriados) sin respuesta registrada tras los que se avisa al vendedor. */
  followUpBusinessDays: z.number().int().min(1).max(30).default(3),
});

/** Meta de ventas (monto en `goals.currency`, sin IGV como las ventas). */
const GoalSchema = z.object({
  monthly: z.number().min(0).nullable().default(null),
  yearly: z.number().min(0).nullable().default(null),
});

/**
 * Metas del tablero (bloque C2). `users`: clave = WhatsApp (solo dígitos) o nombre del usuario (se compara sin tildes ni
 * mayúsculas, también por palabras: "Frank" vale para "Frank Rodríguez"). `_ejemplo: true` = valores de ejemplo: la UI y
 * el bot los muestran como "Meta de ejemplo" hasta que se pongan las metas reales y se quite la marca.
 */
const GoalsSchema = z.looseObject({
  currency: z.string().min(1).default("USD"),
  company: GoalSchema.prefault({}),
  users: z.record(z.string(), GoalSchema).default({}),
  _ejemplo: z.boolean().default(false),
});

export const PortalConfigSchema = z.looseObject({
  import: ImportSchema.prefault({}),
  appointments: AppointmentsSchema.prefault({}),
  techLead: TechLeadSchema.prefault({}),
  quotes: QuotesSchema.prefault({}),
  goals: GoalsSchema.prefault({}),
  /** Feriados ("AAAA-MM-DD") que no cuentan como días hábiles. */
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
});

export type PortalConfig = z.infer<typeof PortalConfigSchema>;
export type PortalImportConfig = PortalConfig["import"];
export type PortalAppointmentsConfig = PortalConfig["appointments"];
export type PortalTechLeadConfig = PortalConfig["techLead"];
export type PortalQuotesConfig = PortalConfig["quotes"];
export type PortalGoalsConfig = PortalConfig["goals"];

export function portalConfigPath(): string {
  return process.env.PORTAL_CONFIG || path.join(process.cwd(), "config", "portal.json");
}

let cached: PortalConfig | null = null;

/** Load config/portal.json with defaults; a missing file yields the defaults. Throws on invalid values. */
export function loadPortalConfig(opts: { file?: string; force?: boolean } = {}): PortalConfig {
  if (cached && !opts.force && !opts.file) return cached;
  const file = opts.file ?? portalConfigPath();
  const raw = fs.existsSync(/* turbopackIgnore: true */ file) ? JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")) : {};
  const parsed = PortalConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`config/portal.json inválido: ${parsed.error.message}`);
  if (!opts.file) cached = parsed.data;
  return parsed.data;
}
