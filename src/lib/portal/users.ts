/**
 * Siembra de usuarios del portal (Frank vendedor, Juan Bustios supervisor, Tony admin).
 * Los números no se inventan: salen de config/pilot.json (`salespeople`) o de variables de entorno. Si falta uno, ese
 * usuario se omite y se devuelve un aviso.
 *
 * Lista en config/portal.json, clave `users`: [{ nombre, rol, whatsapp | whatsappEnv | whatsappSalesperson }]
 *   - whatsapp: número fijo (solo dígitos).
 *   - whatsappEnv: variable (o lista de variables, se usa la primera con valor); si trae varios números separados por
 *     coma (ADMIN_NUMBERS) se toma el primero.
 *   - whatsappSalesperson: prefijo del nombre en `salespeople` de config/pilot.json ("Frank").
 * Sin la clave se usa DEFAULT_PORTAL_USERS.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { digits } from "./store/shared";
import type { PortalStore, PortalUser } from "./store/types";

export const PortalUserSeedSchema = z.object({
  nombre: z.string().min(1),
  rol: z.enum(["vendedor", "supervisor", "tecnico", "admin"]),
  whatsapp: z.string().optional(),
  whatsappEnv: z.union([z.string(), z.array(z.string())]).optional(),
  whatsappSalesperson: z.string().optional(),
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
  users: PortalUser[];
  warnings: string[];
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

/**
 * Crea o actualiza los usuarios configurados. Idempotente (clave: número de WhatsApp).
 * `config` por defecto: loadSeedUsersConfig(); `env` por defecto: process.env.
 */
export async function seedUsers(store: PortalStore, config: SeedUsersConfig = loadSeedUsersConfig()): Promise<SeedUsersResult> {
  const env = config.env ?? process.env;
  const seeds = config.users ?? DEFAULT_PORTAL_USERS;
  const result: SeedUsersResult = { users: [], warnings: [] };
  const taken = new Map<string, string>();
  for (const seed of seeds) {
    const { number, from } = numberFor(seed, config, env);
    if (!number) {
      result.warnings.push(`No se creó a ${seed.nombre} (${seed.rol}): falta su número de WhatsApp (${from}).`);
      continue;
    }
    const prev = taken.get(number);
    if (prev) {
      result.warnings.push(`No se creó a ${seed.nombre} (${seed.rol}): el número ${number} ya es de ${prev}.`);
      continue;
    }
    taken.set(number, seed.nombre);
    result.users.push(await store.upsertUser({ nombre: seed.nombre, whatsapp: number, rol: seed.rol }));
  }
  return result;
}
