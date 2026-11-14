/**
 * `npm run voice:review`: las últimas transcripciones de voz con lo que el bot entendió (corrida F, punto 9), para revisar
 * los fallos del piloto desde consola (nunca en pantalla del portal: la transcripción es dato de cliente).
 *
 *   npm run voice:review                                  últimas 20, store JSON local (data/portal-store.json)
 *   npm run voice:review -- --db                          Postgres (DATABASE_URL)
 *   npm run voice:review -- --fallos                      solo fallos y preguntas (medida no entendida, varias posibles, cliente)
 *   npm run voice:review -- --solo fallo|pregunta|ok      solo ese resultado
 *   npm run voice:review -- --usuario frank               por usuario (nombre, WhatsApp o id)
 *   npm run voice:review -- --desde 2026-11-14 --hasta 2026-11-15   por fecha (hora de Lima); o --dias 7
 *   npm run voice:review -- --last 50                     cuántas (por defecto 20)
 *   npm run voice:review -- --json                        tal cual, para procesar
 */
import "./env";
import { fmtTable } from "./env";

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** "2026-11-14" a medianoche de Lima (UTC-5, sin horario de verano). */
const limaDay = (s: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Fecha inválida «${s}»: usa AAAA-MM-DD`);
  return new Date(`${s}T00:00:00-05:00`);
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Uso: npm run voice:review [-- --db] [--fallos | --solo fallo|pregunta|ok] [--usuario <nombre|whatsapp|id>] [--desde AAAA-MM-DD] [--hasta AAAA-MM-DD] [--dias N] [--last N] [--json]");
    return;
  }
  const useDb = args.includes("--db");
  if (!useDb) {
    delete process.env.DATABASE_URL;
    process.env.PORTAL_STORE = "json";
  } else if (!process.env.DATABASE_URL) throw new Error("--db: DATABASE_URL no está definida");
  const { getPortalStore } = await import("../lib/portal/store");
  const store = await getPortalStore();
  try {
    const last = Math.max(1, parseInt(argValue(args, "--last") ?? "20", 10) || 20);
    const solo = argValue(args, "--solo");
    if (solo && !["fallo", "pregunta", "ok"].includes(solo)) throw new Error("--solo: usa fallo, pregunta u ok");
    const outcomes = args.includes("--fallos") ? (["fallo", "pregunta"] as const) : solo ? ([solo] as ("fallo" | "pregunta" | "ok")[]) : undefined;
    const days = argValue(args, "--dias");
    const desde = argValue(args, "--desde");
    const hasta = argValue(args, "--hasta");
    const since = desde ? limaDay(desde) : days ? new Date(Date.now() - Math.max(1, parseInt(days, 10) || 1) * 24 * 60 * 60 * 1000) : undefined;
    // --hasta incluye ese día entero
    const until = hasta ? new Date(limaDay(hasta).getTime() + 24 * 60 * 60 * 1000) : undefined;
    const users = await store.listUsers();
    const who = argValue(args, "--usuario");
    let userId: number | undefined;
    let phone: string | undefined;
    if (who) {
      const w = who.trim().toLowerCase();
      const u = users.find((x) => String(x.id) === w || x.whatsapp === w.replace(/\D/g, "") || x.nombre.toLowerCase().includes(w));
      if (u) userId = u.id;
      else if (/^\d{8,}$/.test(w)) phone = w;
      else throw new Error(`No encontré el usuario «${who}» (nombre, WhatsApp o id)`);
    }
    const rows = await store.listVoiceTranscripts({ limit: last, since, until, userId, phone, outcomes: outcomes ? [...outcomes] : undefined });
    if (args.includes("--json")) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    const name = new Map(users.map((u) => [u.id, u.nombre.split(/\s+/)[0]]));
    const filters = [outcomes ? `resultado: ${outcomes.join("/")}` : "", who ? `usuario: ${who}` : "", desde || days ? `desde ${desde ?? `hace ${days} días`}` : "", hasta ? `hasta ${hasta}` : ""].filter(Boolean);
    console.log(`Fuente: ${useDb ? "Postgres (DATABASE_URL)" : "store JSON local"} · ${rows.length} transcripción(es)${filters.length ? ` · ${filters.join(" · ")}` : ""}\n`);
    if (!rows.length) {
      console.log("Sin transcripciones (se registran desde la corrida F con cada nota de voz de cotización).");
      return;
    }
    console.log(
      fmtTable(
        rows.map((r) => ({
          fecha: r.createdAt.toLocaleString("es-PE", { timeZone: "America/Lima", dateStyle: "short", timeStyle: "short" }),
          quien: (r.userId !== null ? name.get(r.userId) : null) ?? r.phone,
          contexto: r.context,
          resultado: r.outcome,
          medida: r.understood.sizes.join(" ") || "—",
          cant: r.understood.quantities.join(" ") || "—",
          marca: r.understood.brand ?? "—",
          diseño: clip(r.understood.design ?? "—", 18),
          cliente: clip(r.understood.customer ?? "—", 18),
        })),
      ),
    );
    console.log("\n── Detalle ──");
    for (const r of rows) {
      console.log(`\n#${r.id} ${r.outcome.toUpperCase()} · ${r.context}`);
      console.log(`  oído:     ${r.transcript}`);
      if (r.understood.fixes.length) console.log(`  corregí:  ${r.understood.fixes.map((f) => `«${f.from}» → ${f.to}`).join(", ")}`);
      if (r.understood.questions.length) console.log(`  preguntó: ${r.understood.questions.join(" · ")}`);
      if (r.understood.text) console.log(`  al cotizador: ${r.understood.text.replace(/\n/g, " · ")}`);
    }
  } finally {
    await store.close();
  }
}

main().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
