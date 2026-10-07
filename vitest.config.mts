import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Next.js forces "jsx": "preserve" in tsconfig.json; tell Vite's transformer to compile JSX itself.
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  resolve: { alias: { "@": path.resolve(root, "src") } },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    testTimeout: 30_000,
  },
});
