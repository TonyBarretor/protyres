import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ScoringSchema } from "./scoring/config";
import { MatchSchema } from "./match/config";

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
  /** Sector por mayoría: si esta porción de las unidades (o más) es de un origen, ese sector; si no, "mixto". */
  sectorMajority: z.number().gt(0.5).max(1).default(0.9),
});

/** Citas del bot (comando `cita`). */
const AppointmentsSchema = z.object({
  /** Duración de la cita en el .ics. */
  durationMinutes: z.number().int().min(5).max(24 * 60).default(60),
  /** Aviso del calendario antes de la cita (minutos; 0 = sin aviso). */
  alarmMinutes: z.number().int().min(0).max(24 * 60).default(30),
  /**
   * Corrida J: invitación de calendario por correo al vendedor (y al técnico si va). Sale solo con RESEND_API_KEY y un
   * EMAIL_FROM verificado (src/lib/portal/calendar/mail.ts); si no, el bot lo dice en una línea y queda el archivo.
   * transport: "smtp" (parte text/calendar inline por smtp.resend.com, la que Outlook muestra con Aceptar) o "api"
   * (API JSON de Resend con el .ics adjunto).
   */
  invite: z
    .object({
      enabled: z.boolean().default(true),
      transport: z.enum(["smtp", "api"]).default("smtp"),
    })
    .prefault({}),
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

/** Encuesta de satisfacción (bloque C3). */
const SurveysSchema = z.looseObject({
  /** Invitación automática: días después de la última venta real (no demo) a la empresa. */
  afterSaleDays: z.number().int().min(0).max(365).default(7),
  /** Tolerancia si el cron no corrió algún día: la última venta puede haber sido hasta afterSaleDays + windowDays - 1 días atrás. */
  windowDays: z.number().int().min(1).max(60).default(7),
  /** No se vuelve a encuestar a una empresa con una encuesta en estos últimos meses. */
  cooldownMonths: z.number().int().min(0).max(36).default(6),
  /** Vigencia del enlace. */
  expiresDays: z.number().int().min(1).max(365).default(30),
});

/** Tope diario de consumo (por usuario o del bot entero). */
const DailyCapsSchema = z.object({
  /** Llamadas al modelo de lenguaje. */
  llmCalls: z.number().int().min(0).default(150),
  /** Tokens de entrada + salida. */
  llmTokens: z.number().int().min(0).default(500_000),
  /** Minutos de audio transcrito (Deepgram). */
  audioMinutes: z.number().min(0).default(45),
});

const ModelPriceSchema = z.object({ inputPerMTok: z.number().min(0), outputPerMTok: z.number().min(0) });

/** Corrida E (protección): topes de gasto y de entrada del bot (src/lib/guard). */
const LimitsSchema = z.looseObject({
  perUserDaily: DailyCapsSchema.prefault({}),
  globalDaily: DailyCapsSchema.prefault({ llmCalls: 400, llmTokens: 1_500_000, audioMinutes: 120 }),
  /** Nota de voz más larga que esto: no se transcribe. */
  maxVoiceSeconds: z.number().int().min(10).max(3600).default(180),
  /** Texto del usuario que va al modelo (reporte, lectura de pedido): se corta aquí y se avisa. */
  maxUserChars: z.number().int().min(100).default(2000),
  /** Texto de una lista de precios (mensaje / PDF de proveedor) que va al modelo: es largo de verdad, tope propio. */
  maxPriceListChars: z.number().int().min(1000).default(60_000),
  /** max_tokens de salida por propósito (el resto, 4096). */
  maxTokens: z.record(z.string(), z.number().int().min(16)).default({ reporte: 1500, cotizador_pedido: 2048, cotizador_imagen: 2048, lista_precios: 8192 }),
  /** Mensajes por usuario por minuto; por encima no se procesan (se avisa una vez por minuto). */
  burstPerMinute: z.number().int().min(1).default(30),
  /** Mensajes del webhook más viejos que esto (timestamp de Meta) se descartan sin procesar. */
  maxMessageAgeMinutes: z.number().min(1).default(10),
  /** Precios para el costo estimado (USD). Modelo: clave = prefijo del id; "default" si ninguno coincide. */
  prices: z
    .looseObject({
      models: z.record(z.string(), ModelPriceSchema).default({ "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 }, default: { inputPerMTok: 3, outputPerMTok: 15 } }),
      deepgramPerMinute: z.number().min(0).default(0.0043),
    })
    .prefault({}),
});

/** Un límite de intentos: ventana fija de `windowMinutes`; por IP (hasheada) y, si aplica, por token del enlace. */
const RateRuleSchema = z.looseObject({
  windowMinutes: z.number().int().min(1).max(24 * 60),
  perIp: z.number().int().min(1),
  /** Sin valor: no hay límite por token (el cron no tiene token). */
  perToken: z.number().int().min(1).optional(),
});

/** Tipo y tamaño del Excel de "Subir ventas" (además de los 4 MB del formulario). */
const SalesUploadSchema = z.looseObject({
  /** Filas con datos por hoja; más que esto no se lee (se pide dividir el archivo). */
  maxRows: z.number().int().min(100).default(20_000),
  /** Columnas leídas por fila (las de más a la derecha se ignoran). */
  maxColumns: z.number().int().min(10).default(60),
  /** Hojas en el archivo (se cuentan en el índice del ZIP antes de abrirlo). */
  maxSheets: z.number().int().min(1).default(20),
  /** Tamaño descomprimido total del .xlsx (MB): corta un "zip bomb" antes de que exceljs lo cargue entero. */
  maxUncompressedMB: z.number().min(1).default(100),
});

/** Corrida E, punto 5: entradas públicas (login, encuesta, cron) y subida de Excel. */
const PublicInputsSchema = z.looseObject({
  rateLimits: z
    .looseObject({
      login: RateRuleSchema.default({ windowMinutes: 15, perIp: 30, perToken: 20 }),
      surveyView: RateRuleSchema.default({ windowMinutes: 60, perIp: 60, perToken: 20 }),
      surveySubmit: RateRuleSchema.default({ windowMinutes: 60, perIp: 30, perToken: 5 }),
      cron: RateRuleSchema.default({ windowMinutes: 60, perIp: 10 }),
    })
    .prefault({}),
  /** Token de enlace (login o encuesta) más largo que esto: se rechaza sin tocar la base. */
  maxTokenChars: z.number().int().min(64).max(1024).default(128),
  /** Cuerpo del POST de /portal/login. */
  maxLoginBodyBytes: z.number().int().min(256).default(4096),
  /** Cuerpo del envío de la encuesta (Content-Length, en el proxy). */
  maxSurveyBodyBytes: z.number().int().min(1024).default(32_768),
  salesUpload: SalesUploadSchema.prefault({}),
});

/**
 * Hotfix login 2: acceso al portal. `sessionDays`: vigencia de la sesión, que se renueva sola con cada visita.
 * `linkHours`: el enlace del bot sirve todas las veces que haga falta durante ese plazo (y `portal` lo reenvía renovado).
 * `botWhatsapp`: número del bot (solo dígitos, con 51) para el botón "Pedir enlace por WhatsApp" (wa.me con `portal`
 * escrito); la variable PORTAL_BOT_WHATSAPP lo reemplaza.
 */
const AccessSchema = z.looseObject({
  sessionDays: z.number().min(1).max(365).default(30),
  linkHours: z.number().min(0.25).max(24 * 7).default(24),
  botWhatsapp: z.string().regex(/^\d*$/).default(""),
});

/**
 * Corrida H, punto 3: pedido para Patricia. `ownStock` = cómo se llena el bloque "PRODUCTOS DE TERCEROS" de un producto
 * de stock propio (como lo hace el vendedor a mano); `warehouse` = almacén propio donde se descuenta el stock.
 * `supplierProviders`: proveedor de la lista de contactos -> proveedor del cotizador (config/providers.json, listas de
 * precios), cuando el nombre no basta para emparejarlos. `branchFileName`: nombre del Excel de un pedido por sucursal
 * ({Mes} Nov, {aa} 26, {Cliente}, {Venta}, {Sucursal}, {UBs} 1231-1812).
 */
const OrdersSchema = z.looseObject({
  ownStock: z
    .object({
      proveedor: z.string().default("STOCK 360PT"),
      contacto: z.string().default("PATRICIA"),
      telefono: z.string().default(""),
      email: z.string().default("-"),
      precioCompra: z.number().default(0),
      pago: z.string().default("contado"),
      entrega: z.string().default("SAN LUIS STOCK"),
      warehouse: z.string().default("SAN LUIS"),
    })
    .prefault({}),
  supplierProviders: z.record(z.string(), z.string()).default({}),
  branchFileName: z.string().default("{Mes}{aa}- {Cliente} - Venta {Venta} {Sucursal} UBs {UBs}"),
});

export const PortalConfigSchema = z.looseObject({
  import: ImportSchema.prefault({}),
  appointments: AppointmentsSchema.prefault({}),
  techLead: TechLeadSchema.prefault({}),
  quotes: QuotesSchema.prefault({}),
  goals: GoalsSchema.prefault({}),
  surveys: SurveysSchema.prefault({}),
  /** Feriados ("AAAA-MM-DD") que no cuentan como días hábiles. */
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  limits: LimitsSchema.prefault({}),
  publicInputs: PublicInputsSchema.prefault({}),
  /** Corrida G: puntaje de atractivo (src/lib/portal/scoring/config.ts). */
  scoring: ScoringSchema.prefault({}),
  /** Corrida H: pedido para Patricia (bloque de proveedor / stock propio). */
  orders: OrdersSchema.prefault({}),
  /** Hotfix login 2: sesión, enlace de entrada y número del bot. */
  access: AccessSchema.prefault({}),
  /** Corrida K: Match Venta (src/lib/portal/match/config.ts). */
  match: MatchSchema.prefault({}),
});

export type PortalConfig = z.infer<typeof PortalConfigSchema>;
export type PortalImportConfig = PortalConfig["import"];
export type PortalAppointmentsConfig = PortalConfig["appointments"];
export type PortalTechLeadConfig = PortalConfig["techLead"];
export type PortalQuotesConfig = PortalConfig["quotes"];
export type PortalGoalsConfig = PortalConfig["goals"];
export type PortalSurveysConfig = PortalConfig["surveys"];
export type PortalLimitsConfig = PortalConfig["limits"];
export type PortalPublicInputsConfig = PortalConfig["publicInputs"];
export type RateRule = z.infer<typeof RateRuleSchema>;
export type PortalScoringConfig = PortalConfig["scoring"];
export type PortalOrdersConfig = PortalConfig["orders"];
export type PortalAccessConfig = PortalConfig["access"];
export type PortalMatchConfig = PortalConfig["match"];

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
