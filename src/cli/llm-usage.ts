/**
 * `npm run llm:usage`: consumo del modelo de lenguaje y de la voz (corrida E). Hoy y últimos 7 días (Lima), por usuario y
 * por propósito: llamadas, tokens, minutos de audio y costo estimado; los topes vigentes (config/portal.json, `limits`) con
 * el % usado hoy; y los mensajes que la puerta no procesó (número no registrado, ráfaga, viejos).
 *
 *   npm run llm:usage            store JSON local (data/store.json, el mismo del simulador con --persist)
 *   npm run llm:usage -- --db    Postgres (DATABASE_URL)
 */
import "./env";
import { fmtTable } from "./env";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useDb = args.includes("--db");
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Uso: npm run llm:usage [-- --db]");
    return;
  }
  if (!useDb) {
    delete process.env.DATABASE_URL;
    process.env.PORTAL_STORE = "json";
  } else if (!process.env.DATABASE_URL) throw new Error("--db: DATABASE_URL no está definida");
  const { getStore } = await import("../lib/store");
  const { getPortalStore } = await import("../lib/portal/store");
  const { loadPortalConfig } = await import("../lib/portal/config");
  const { loadUsageReport, fmtPct, fmtUsd, METRIC_NAMES } = await import("../lib/guard/report");
  const { loadSettings } = await import("../lib/settings");

  const store = await getStore();
  const names = new Map<string, string>();
  try {
    for (const [num, v] of Object.entries(loadSettings().salespeople)) if (typeof v === "object" && v.name && /^\d+$/.test(num)) names.set(num, v.name);
    const portal = await getPortalStore();
    for (const u of await portal.listUsers()) if (u.whatsapp) names.set(u.whatsapp, u.nombre);
    await portal.close();
  } catch {
    // sin nombres: se muestran los números
  }
  const cfg = loadPortalConfig().limits;
  const r = await loadUsageReport(store, cfg, { names });
  const rows = (lines: { label: string; llmCalls: number; tokens: number; audioMinutes: number; costUsd: number }[]) =>
    lines.map((l) => ({ quién: l.label, llamadas: l.llmCalls, tokens: l.tokens.toLocaleString("es-PE"), "min voz": l.audioMinutes.toFixed(1), "costo est.": fmtUsd(l.costUsd) }));

  console.log(`Fuente: ${useDb ? "Postgres (DATABASE_URL)" : "store JSON local"} · costos ESTIMADOS con limits.prices de config/portal.json\n`);
  for (const p of [r.today, r.week]) {
    console.log(`── ${p.title} ── total: ${p.total.llmCalls} llamadas · ${p.total.tokens.toLocaleString("es-PE")} tokens · ${p.total.audioMinutes.toFixed(1)} min de voz · ${fmtUsd(p.total.costUsd)}`);
    console.log("\nPor usuario:");
    console.log(fmtTable(rows(p.byUser)));
    console.log("\nPor propósito:");
    console.log(fmtTable(rows(p.byPurpose).map(({ quién, ...rest }) => ({ propósito: quién, ...rest }))));
    console.log("");
  }
  console.log("── Topes vigentes (hoy) ──");
  console.log(
    fmtTable(
      r.caps.map((c) => ({
        alcance: c.scope === "global" ? "global" : "por usuario",
        quién: c.label,
        tope: METRIC_NAMES[c.metric],
        usado: c.metric === "audioMinutes" ? c.used.toFixed(1) : c.used.toLocaleString("es-PE"),
        límite: c.limit.toLocaleString("es-PE"),
        "%": fmtPct(c.pct),
      })),
    ),
  );
  console.log(`\nPor usuario y día: ${cfg.perUserDaily.llmCalls} llamadas, ${cfg.perUserDaily.llmTokens.toLocaleString("es-PE")} tokens, ${cfg.perUserDaily.audioMinutes} min de voz. Nota de voz máx. ${cfg.maxVoiceSeconds} s; texto al modelo máx. ${cfg.maxUserChars} caracteres (listas de precios: ${cfg.maxPriceListChars}); ${cfg.burstPerMinute} mensajes por minuto.`);
  console.log(`Interruptores: LLM_DISABLED=${process.env.LLM_DISABLED ?? "(no)"} · VOICE_DISABLED=${process.env.VOICE_DISABLED ?? "(no)"} · QUOTE_LLM_MODE=${process.env.QUOTE_LLM_MODE ?? "(sin definir: shadow)"}`);
  if (r.blocked.length) {
    console.log("\n── Mensajes no procesados (7 días) ──");
    const why: Record<string, string> = { no_registrado: "número no registrado", rafaga: "ráfaga", viejo: "viejo (reintento de Meta)" };
    console.log(fmtTable(r.blocked.map((b) => ({ motivo: why[b.reason] ?? b.reason, números: b.phones, mensajes: b.messages }))));
  }
  await store.close();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
