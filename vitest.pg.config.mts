// Corrida H, punto 2: pruebas de integración contra Postgres real (`npm run test:pg`). Ver src/test-pg/harness.ts.
import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  resolve: { alias: { "@": path.resolve(root, "src") } },
  test: {
    include: ["src/**/*.pg.test.ts"],
    environment: "node",
    globalSetup: ["src/test-pg/global-setup.ts"],
    // una sola base: los archivos corren uno tras otro
    fileParallelism: false,
    testTimeout: Number(process.env.PGTEST_TIMEOUT ?? 120_000),
    hookTimeout: 180_000,
  },
});
