/**
 * `npm run quote:shadow-report`: comparación reglas vs modelo del modo sombra (QUOTE_LLM_MODE=shadow, corrida E punto 4).
 * Cuántos pedidos se compararon, en cuántos difiere el modelo y en qué campos, qué descartaron las validaciones, y los
 * últimos N casos con diferencias (texto del pedido recortado: es dato de cliente, solo para esta consola).
 *
 *   npm run quote:shadow-report                          store JSON local (data/store.json)
 *   npm run quote:shadow-report -- --db                  Postgres (DATABASE_URL)
 *   npm run quote:shadow-report -- --days 7 --last 20    ventana y casos a listar (por defecto 30 días y 10 casos)
 */
import "./env";
import { fmtTable } from "./env";

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Uso: npm run quote:shadow-report [-- --db] [--days N] [--last N]");
    return;
  }
  const useDb = args.includes("--db");
  const days = Math.max(1, parseInt(argValue(args, "--days") ?? "30", 10) || 30);
  const last = Math.max(0, parseInt(argValue(args, "--last") ?? "10", 10) || 0);
  if (!useDb) {
    delete process.env.DATABASE_URL;
    process.env.PORTAL_STORE = "json";
  } else if (!process.env.DATABASE_URL) throw new Error("--db: DATABASE_URL no está definida");
  const { getStore } = await import("../lib/store");
  const { summarizeShadow } = await import("../lib/quote/shadow");
  const { quoteLlmMode } = await import("../lib/llm/client");

  const store = await getStore();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await store.listQuoteShadow({ since, limit: 5000 });
  const s = summarizeShadow(rows);
  const pct = (n: number) => (s.total ? `${Math.round((n / s.total) * 100)}%` : "—");

  console.log(`Fuente: ${useDb ? "Postgres (DATABASE_URL)" : "store JSON local"} · últimos ${days} días · QUOTE_LLM_MODE=${quoteLlmMode()}${process.env.QUOTE_LLM_MODE ? "" : " (por defecto)"}\n`);
  console.log(`Pedidos comparados: ${s.total} · con lectura válida del modelo: ${s.withModel} (${pct(s.withModel)}) · con alguna diferencia: ${s.differing} (${pct(s.differing)})`);
  if (!s.total) {
    console.log("\nSin comparaciones todavía (el modo sombra registra una por pedido escrito de un vendedor).");
    await store.close();
    return;
  }
  if (s.errors.length) {
    console.log("\n── Sin lectura del modelo ──");
    console.log(fmtTable(s.errors.map((e) => ({ motivo: e.reason, casos: e.count }))));
  }
  if (s.byField.length) {
    console.log("\n── Campos distintos (casos) ──");
    console.log(fmtTable(s.byField.map((f) => ({ campo: f.field, casos: f.cases, "%": pct(f.cases) }))));
  }
  if (s.byRejection.length) {
    console.log("\n── Descartado por las validaciones (veces) ──");
    console.log(fmtTable(s.byRejection.map((r) => ({ tipo: r.kind, veces: r.count }))));
  }
  const cases = rows.filter((r) => r.diffs.length || r.rejected.length).slice(0, last);
  if (cases.length) {
    console.log(`\n── Últimos ${cases.length} casos con diferencias ──`);
    for (const r of cases) {
      const text = r.text.replace(/\s+/g, " ").trim();
      console.log(`\n#${r.id} · ${r.at.toISOString().slice(0, 16).replace("T", " ")} UTC · ${r.phone} · «${text.length > 120 ? `${text.slice(0, 119)}…` : text}»`);
      if (r.diffs.length) console.log(fmtTable(r.diffs.map((d) => ({ campo: d.item ? `${d.field} (ítem ${d.item})` : d.field, reglas: d.rules, modelo: d.model }))));
      for (const x of r.rejected) console.log(`  descartado: ${x}`);
    }
  }
  console.log("\nCriterio sugerido para pasar a on: muchas comparaciones con pocas diferencias de ítems/medida/cantidad, y las que hay a favor del modelo.");
  await store.close();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
