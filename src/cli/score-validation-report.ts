/**
 * Corrida G, punto 6 — informe de la validación del ranking (/portal/validar-ranking): porcentaje de coincidencia de
 * nivel entre el vendedor y el sistema, en cuáles difiere más y las notas. Con eso se ajustan los pesos (`scoring` en
 * config/portal.json) y se vuelve a correr `npm run portal:recalc-score`.
 *
 *   npm run score:validation-report              Postgres (DATABASE_URL) o data/portal-store.json
 *   npm run score:validation-report -- --json    fuerza el store JSON local
 *   npm run score:validation-report -- --dias 30 solo las respuestas de los últimos N días
 */
import "./env";
import { parseArgs } from "node:util";
import { compareValidations, formatValidationReport } from "../lib/portal/scoring/validation";
import { getPortalStore } from "../lib/portal/store";

const { values } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    dias: { type: "string" },
  },
});

async function main(): Promise<void> {
  if (values.json) process.env.PORTAL_STORE = "json";
  const store = await getPortalStore();
  try {
    const dias = values.dias ? Number(values.dias) : null;
    if (dias !== null && !(dias > 0)) throw new Error(`--dias inválido: ${values.dias}`);
    const since = dias ? new Date(Date.now() - dias * 86_400_000) : undefined;
    const rows = await store.listRankingValidations({ since });
    const report = compareValidations(rows);
    const ids = [...new Set([...report.diferencias.map((d) => d.companyId), ...report.notas.map((n) => n.companyId)])];
    const names = new Map<number, string>();
    for (const id of ids) names.set(id, (await store.getCompany(id))?.razonSocial ?? `Empresa #${id}`);
    const users = new Map((await store.listUsers()).map((u) => [u.id, u.nombre]));
    console.log(formatValidationReport(report, { company: (id) => names.get(id) ?? `Empresa #${id}`, user: (id) => users.get(id) ?? `usuario #${id}` }));
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
