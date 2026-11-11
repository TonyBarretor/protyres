import path from "node:path";
import { JsonPortalStore } from "./json-portal-store";
import type { PortalStore } from "./types";

export type * from "./types";
export { JsonPortalStore } from "./json-portal-store";

let shared: PortalStore | null = null;

export function portalStorePath(): string {
  return process.env.PORTAL_STORE_PATH || path.resolve(process.cwd(), "data/portal-store.json");
}

/**
 * Store del portal. DATABASE_URL definida y PORTAL_STORE distinto de "json" -> Postgres (Supabase);
 * si no, JSON local en PORTAL_STORE_PATH o data/portal-store.json.
 */
export async function getPortalStore(): Promise<PortalStore> {
  if (shared) return shared;
  if (process.env.DATABASE_URL && process.env.PORTAL_STORE !== "json") {
    const { PgPortalStore } = await import("./pg-portal-store");
    shared = PgPortalStore.connect(process.env.DATABASE_URL);
  } else {
    shared = new JsonPortalStore(portalStorePath());
  }
  return shared;
}

/** Para tests: fija el store (p. ej. JsonPortalStore.memory()); null vuelve a la elección por entorno. */
export function __setPortalStoreForTests(store: PortalStore | null): void {
  shared = store;
}
