/**
 * Corrida H, punto 2 — el guion completo de Frank (scripts/guion-frank.txt) contra Postgres: la base temporal de
 * test:pg sembrada desde data/ (solo lectura, ver seed.ts) y el simulador real (src/cli/portal-simulate.ts --pg-test),
 * que sale con código 1 si algún mensaje termina en "Ocurrió un error" o falla un @espera.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { testDbUrl, truncateAll } from "./harness";
import { seedFromLocalData } from "./seed";

const PORTAL_FILE = path.resolve(process.cwd(), "data/portal-store.json");
const STORE_FILE = path.resolve(process.cwd(), "data/store.json");
/** ZBUSS S.A.C., la empresa del padrón que recorre el guion. */
const ZBUSS = "20602221505";
const hasData = fs.existsSync(PORTAL_FILE) && fs.existsSync(STORE_FILE);

describe.runIf(hasData)("guion de Frank contra Postgres", () => {
  beforeAll(async () => {
    await truncateAll(testDbUrl());
    // la flota entera (150 mil vehículos) tarda ~3 min por el pooler: solo la de ZBUSS (la del guion) y la de las
    // empresas con ventas. Las demás empresas sí van (el ranking de "mejores" las recorre todas)
    const sales = (JSON.parse(fs.readFileSync(PORTAL_FILE, "utf8")).sales ?? []) as { ruc: string }[];
    const fleetRucs = [ZBUSS, ...new Set(sales.map((s) => s.ruc))];
    const r = await seedFromLocalData(testDbUrl(), { portalFile: PORTAL_FILE, storeFile: STORE_FILE, fleetRucs });
    console.log(`test:pg: siembra ${JSON.stringify(r)}`);
  }, 600_000);

  it("scripts/guion-frank.txt sin errores ni verificaciones fallidas", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "protyres-frank-pg-"));
    const r = spawnSync("npx", ["tsx", "--tsconfig", "tsconfig.cli.json", "src/cli/portal-simulate.ts", "--as", "frank", "--pg-test", "--out", out, "--script", "scripts/guion-frank.txt"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 540_000,
      // la base de pruebas también como DATABASE_URL: aunque algo leyera esa variable, no llega a la real
      env: { ...process.env, PGTEST_DB_URL: testDbUrl(), DATABASE_URL: testDbUrl(), LLM_DISABLED: "1", PHOTOS_DISABLED: "1" },
    });
    fs.writeFileSync(path.join(out, "salida.txt"), `${r.stdout}\n--- stderr ---\n${r.stderr}`);
    const resumen = r.stdout.slice(r.stdout.lastIndexOf("── Resumen ──"));
    console.log(`test:pg: guion de Frank (salida completa en ${out}/salida.txt)\n${resumen}`);
    expect(r.stdout).not.toMatch(/Ocurrió un error/);
    expect(resumen).toMatch(/Verificaciones fallidas: 0/);
    expect(resumen).toMatch(/Errores: 0/);
    expect(r.status).toBe(0);
  }, 600_000);
});
