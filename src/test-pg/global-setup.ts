/** globalSetup de vitest.pg.config.mts: crea la base temporal una vez y la elimina al final. */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "./harness";

let db: TestDatabase | null = null;
let scratch: string | null = null;

export async function setup() {
  db = await createTestDatabase((m) => console.log(m));
  process.env.PGTEST_DB_URL = db.url;
  // Las pruebas (los workers heredan este entorno) nunca ven la base real ni escriben en data/: sin DATABASE_URL,
  // getStore() caería al JSON de data/store.json; se apunta a un archivo temporal. El modelo y el correo, apagados.
  delete process.env.DATABASE_URL;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "protyres-pgtest-"));
  process.env.STORE_PATH = path.join(scratch, "store.json");
  process.env.PORTAL_STORE_PATH = path.join(scratch, "portal-store.json");
  process.env.LLM_DISABLED = "1";
  delete process.env.RESEND_API_KEY;
}

export async function teardown() {
  await db?.drop();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
}
