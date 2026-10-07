import path from "node:path";
import { JsonStore } from "./json-store";
import type { PriceStore } from "./types";

export type { PriceStore, ConversationState, ProviderSummary } from "./types";

let shared: PriceStore | null = null;

/**
 * The store used by the CLI and the web app.
 * DATABASE_URL set -> Postgres (Supabase); otherwise ./data/store.json (or STORE_PATH).
 */
export async function getStore(): Promise<PriceStore> {
  if (shared) return shared;
  if (process.env.DATABASE_URL) {
    const { PgStore } = await import("./pg-store");
    shared = await PgStore.connect(process.env.DATABASE_URL);
  } else {
    shared = new JsonStore(process.env.STORE_PATH || path.resolve(process.cwd(), "data/store.json"), process.env.STORE_SEED_PATH || path.resolve(process.cwd(), "data/seed.json.gz"));
  }
  return shared;
}

/** For tests: use an in-memory store. */
export function __setStoreForTests(store: PriceStore | null): void {
  shared = store;
}
