/**
 * Siembra de usuarios del portal (Frank vendedor, Juan Bustios supervisor, Tony admin).
 * Los números no se inventan: salen de config/pilot.json (`salespeople`) o de variables de entorno. Si falta uno, ese
 * usuario se omite y se devuelve un aviso.
 *
 * Lista en config/portal.json, clave `users`: [{ nombre, rol, whatsapp | whatsappEnv | whatsappSalesperson, email?, calendarLinks? }]
 *   - whatsapp: número fijo (solo dígitos).
 *   - whatsappEnv: variable (o lista de variables, se usa la primera con valor); si trae varios números separados por
 *     coma (ADMIN_NUMBERS) se toma el primero.
 *   - whatsappSalesperson: prefijo del nombre en `salespeople` de config/pilot.json ("Frank").
 *   - email (corrida J): correo para la invitación de calendario de las citas. Sin él, el de `salespeople` de
 *     config/pilot.json si el usuario sale de ahí (el de Frank). Sin ninguno, el correo que tenga en el store se conserva.
 *   - calendarLinks (corrida J): enlaces "Agregar a Outlook web / Google Calendar" en la cita; apagado si no se pone.
 * Sin la clave se usa DEFAULT_PORTAL_USERS. Si dos usuarios comparten número queda el de mayor rol (ROLE_RANK) y se
 * avisa. Lo usan `npm run portal:seed-users` (solo usuarios) y `npm run portal:import-mtc` (al final del import).
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { digits, normEmail } from "./store/shared";
import type { PortalStore, PortalUser } from "./store/types";

export const PortalUserSeedSchema = z.object({
  nombre: z.string().min(1),
  rol: z.enum(["vendedor", "supervisor", "tecnico", "admin"]),
  whatsapp: z.string().optional(),
  whatsappEnv: z.union([z.string(), z.array(z.string())]).optional(),
  whatsappSalesperson: z.string().optional(),
  email: z.string().optional(),
  calendarLinks: z.boolean().optional(),
});
export type PortalUserSeed = z.infer<typeof PortalUserSeedSchema>;

export const DEFAULT_PORTAL_USERS: PortalUserSeed[] = [
  { nombre: "Frank Rodríguez", rol: "vendedor", whatsappSalesperson: "Frank" },
  { nombre: "Juan Bustios", rol: "supervisor", whatsappEnv: "PORTAL_SUPERVISOR_NUMBER" },
  { nombre: "Tony Barreto", rol: "admin", whatsappEnv: ["PORTAL_ADMIN_NUMBER", "ADMIN_NUMBERS"] },
];

export interface SeedUsersConfig {
  /** Lista de usuarios (config/portal.json `users`); por defecto DEFAULT_PORTAL_USERS. */
  users?: PortalUserSeed[];
  /** `salespeople` de config/pilot.json: número -> { name, ... } (o "default" -> número). */
  salespeople?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
}

export interface SeedUsersResult {
  /** Usuarios escritos (vacío con dryRun). */
  users: PortalUser[];
  warnings: string[];
  /** Qué se hizo (o haría) con cada usuario configurado. */
  entries: SeedEntry[];
}

function readJson(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(/* turbopackIgnore: true */ file)) return null;
  return JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")) as Record<string, unknown>;
}

/** Lee config/portal.json (`users`) y config/pilot.json (`salespeople`) del directorio de trabajo. */
export function loadSeedUsersConfig(cwd = process.cwd()): SeedUsersConfig {
  const portal = readJson(process.env.PORTAL_CONFIG || path.join(cwd, "config", "portal.json"));
  const pilot = readJson(process.env.PILOT_CONFIG || path.join(cwd, "config", "pilot.json"));
  const cfg: SeedUsersConfig = {};
  if (portal && Array.isArray(portal.users)) cfg.users = z.array(PortalUserSeedSchema).parse(portal.users);
  if (pilot && pilot.salespeople && typeof pilot.salespeople === "object") cfg.salespeople = pilot.salespeople as Record<string, unknown>;
  return cfg;
}

/** Correo configurado del usuario: `email` o el de su entrada en `salespeople` (config/pilot.json). */
function emailFor(seed: PortalUserSeed, cfg: SeedUsersConfig, number: string): string | null {
  if (seed.email !== undefined) return normEmail(seed.email);
  if (!seed.whatsappSalesperson) return null;
  const sp = (cfg.salespeople ?? {})[number];
  return sp && typeof sp === "object" ? normEmail(String((sp as { email?: unknown }).email ?? "")) : null;
}

function numberFor(seed: PortalUserSeed, cfg: SeedUsersConfig, env: Record<string, string | undefined>): { number: string | null; from: string } {
  if (seed.whatsapp) return { number: digits(seed.whatsapp) || null, from: "whatsapp" };
  if (seed.whatsappEnv) {
    const vars = Array.isArray(seed.whatsappEnv) ? seed.whatsappEnv : [seed.whatsappEnv];
    for (const v of vars) {
      const first = (env[v] ?? "")
        .split(",")
        .map((s) => digits(s))
        .find(Boolean);
      if (first) return { number: first, from: v };
    }
    return { number: null, from: vars.join(" / ") };
  }
  if (seed.whatsappSalesperson) {
    const prefix = seed.whatsappSalesperson.toLowerCase();
    for (const [key, val] of Object.entries(cfg.salespeople ?? {})) {
      if (!val || typeof val !== "object") continue;
      const name = String((val as { name?: unknown }).name ?? "");
      if (name.toLowerCase().startsWith(prefix) && digits(key)) return { number: digits(key), from: `salespeople (${name})` };
    }
    return { number: null, from: `salespeople "${seed.whatsappSalesperson}…" de config/pilot.json` };
  }
  return { number: null, from: "(sin origen de número)" };
}

/** Rango para resolver números repetidos: si dos usuarios configurados comparten número, queda el de mayor rol. */
export const ROLE_RANK: Record<PortalUserSeed["rol"], number> = { admin: 4, supervisor: 3, vendedor: 2, tecnico: 1 };

/** "****340": los avisos y la salida del CLI nunca muestran el número completo. */
export function maskNumber(n: string | null | undefined): string {
  const d = digits(n ?? "");
  return d ? `****${d.slice(-3)}` : "(sin número)";
}

export interface PlannedUser {
  nombre: string;
  rol: PortalUserSeed["rol"];
  whatsapp: string;
  /** De dónde salió el número (variable, salespeople, whatsapp). */
  from: string;
  /** Correo configurado (null = no configurado: se conserva el del store). */
  email: string | null;
  /** Enlaces de calendario (undefined = no configurado: se conserva). */
  calendarLinks?: boolean;
}

/**
 * Qué usuarios quedarían según la configuración, sin tocar el store: resuelve cada número, avisa de los que faltan y,
 * si dos comparten número, deja el de mayor rol (admin > supervisor > vendedor > tecnico; a igual rol, el primero de la
 * lista). El orden de salida es el de la configuración.
 */
export function planUsers(config: SeedUsersConfig = loadSeedUsersConfig()): { users: PlannedUser[]; warnings: string[] } {
  const env = config.env ?? process.env;
  const seeds = config.users ?? DEFAULT_PORTAL_USERS;
  const warnings: string[] = [];
  const resolved: PlannedUser[] = [];
  for (const seed of seeds) {
    const { number, from } = numberFor(seed, config, env);
    if (!number) {
      warnings.push(`Falta el número de WhatsApp de ${seed.nombre} (${seed.rol}): no se crea (sin número en ${from}).`);
      continue;
    }
    resolved.push({ nombre: seed.nombre, rol: seed.rol, whatsapp: number, from, email: emailFor(seed, config, number), ...(seed.calendarLinks !== undefined ? { calendarLinks: seed.calendarLinks } : {}) });
  }
  const winner = new Map<string, PlannedUser>();
  for (const u of resolved) {
    const prev = winner.get(u.whatsapp);
    if (!prev || ROLE_RANK[u.rol] > ROLE_RANK[prev.rol]) winner.set(u.whatsapp, u);
  }
  for (const [number, win] of winner) {
    const losers = resolved.filter((u) => u.whatsapp === number && u !== win);
    if (!losers.length) continue;
    const all = resolved.filter((u) => u.whatsapp === number).map((u) => `${u.nombre} (${u.rol})`);
    warnings.push(`El número ${maskNumber(number)} está en ${all.join(" y ")}: queda ${win.nombre} (${win.rol}), el de mayor rol; no se crea a ${losers.map((u) => u.nombre).join(", ")}. Revisa la configuración.`);
  }
  return { users: resolved.filter((u) => winner.get(u.whatsapp) === u), warnings };
}

export interface SeedEntry extends PlannedUser {
  /** crear: no hay nadie con ese número; actualizar: existe con otro nombre/rol; igual: nada que cambiar. */
  action: "crear" | "actualizar" | "igual";
  before?: { id: number; nombre: string; rol: PortalUser["rol"]; activo: boolean; email?: string | null };
}

/**
 * Crea o actualiza los usuarios configurados. Idempotente (clave: número de WhatsApp). Nunca borra: los usuarios del
 * store que ya no están en la configuración solo se avisan. Con `dryRun` no escribe (users queda vacío; entries dice
 * qué haría). `config` por defecto: loadSeedUsersConfig(); `env` por defecto: process.env.
 */
export async function seedUsers(store: PortalStore, config: SeedUsersConfig = loadSeedUsersConfig(), opts: { dryRun?: boolean } = {}): Promise<SeedUsersResult> {
  const plan = planUsers(config);
  const result: SeedUsersResult = { users: [], warnings: [...plan.warnings], entries: [] };
  for (const p of plan.users) {
    const prev = await store.getUserByWhatsapp(p.whatsapp);
    const before = prev ? { id: prev.id, nombre: prev.nombre, rol: prev.rol, activo: prev.activo, email: prev.email ?? null } : undefined;
    const same =
      !!prev && prev.nombre === p.nombre && prev.rol === p.rol && (!p.email || prev.email === p.email) && (p.calendarLinks === undefined || !!prev.calendarLinks === p.calendarLinks);
    const action = !prev ? "crear" : same ? "igual" : "actualizar";
    result.entries.push({ ...p, action, before });
    if (prev && prev.nombre !== p.nombre) {
      result.warnings.push(
        `El registro #${prev.id} (${maskNumber(p.whatsapp)}) pasa de ${prev.nombre} · ${prev.rol} a ${p.nombre} · ${p.rol}: lo que tenga asignado (empresas, oportunidades, actividades) queda a nombre de ${p.nombre}.`,
      );
    }
    // el correo solo se escribe si está configurado: uno cargado a mano en el store no se borra al volver a sembrar
    const extra = { ...(p.email ? { email: p.email } : {}), ...(p.calendarLinks !== undefined ? { calendarLinks: p.calendarLinks } : {}) };
    if (!opts.dryRun) result.users.push(await store.upsertUser({ nombre: p.nombre, whatsapp: p.whatsapp, rol: p.rol, ...extra }));
  }
  const configured = new Set(plan.users.map((u) => u.whatsapp));
  for (const u of await store.listUsers()) {
    if (u.whatsapp && configured.has(digits(u.whatsapp))) continue;
    result.warnings.push(`${u.nombre} (${u.rol}, ${maskNumber(u.whatsapp)}${u.activo ? "" : ", inactivo"}) está en la base y no está en la configuración: no se borra.`);
  }
  return result;
}
