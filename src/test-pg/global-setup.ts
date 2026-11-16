/** globalSetup de vitest.pg.config.mts: crea la base temporal una vez y la elimina al final. */
import "dotenv/config";
import { createTestDatabase, type TestDatabase } from "./harness";

let db: TestDatabase | null = null;

export async function setup() {
  db = await createTestDatabase((m) => console.log(m));
  process.env.PGTEST_DB_URL = db.url;
}

export async function teardown() {
  await db?.drop();
}
