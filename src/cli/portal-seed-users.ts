/**
 * Crea o actualiza los usuarios del portal desde la configuración (config/portal.json `users` + variables de entorno +
 * `salespeople` de config/pilot.json), sin tocar el padrón ni otras tablas. Nunca borra usuarios: los que están en el
 * store y ya no en la configuración solo se avisan. Si dos usuarios comparten número queda el de mayor rol
 * (admin > supervisor > vendedor > tecnico). Ver src/lib/portal/users.ts.
 *
 *   npm run portal:seed-users                 escribe en Postgres (DATABASE_URL) o en data/portal-store.json
 *   npm run portal:seed-users -- --dry-run    solo lee el store e imprime qué haría
 *   npm run portal:seed-users -- --json       fuerza el store JSON local (igual que PORTAL_STORE=json)
 *
 * Los números se muestran enmascarados (****340).
 */
import "./env";
import { parseArgs } from "node:util";
import { getPortalStore } from "../lib/portal/store";
import { maskNumber, seedUsers } from "../lib/portal/users";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

async function main(): Promise<void> {
  if (values.json) process.env.PORTAL_STORE = "json";
  const dryRun = values["dry-run"];
  const store = await getPortalStore();
  console.log(`Store: ${process.env.DATABASE_URL && process.env.PORTAL_STORE !== "json" ? "Postgres" : "JSON local"}${dryRun ? " (modo prueba: no se escribe nada)" : ""}`);
  try {
    const r = await seedUsers(store, undefined, { dryRun });
    console.log("");
    console.log(dryRun ? "Usuarios según la configuración (lo que se haría):" : "Usuarios del portal:");
    if (!r.entries.length) console.log("  (ninguno: faltan los números)");
    for (const e of r.entries) {
      const what =
        e.action === "crear" ? (dryRun ? "se crearía" : "creado") : e.action === "igual" ? "sin cambios" : `${dryRun ? "se actualizaría" : "actualizado"} (antes: ${e.before?.nombre} · ${e.before?.rol})`;
      const id = e.before ? `#${e.before.id}` : dryRun ? "nuevo" : `#${r.users.find((u) => u.whatsapp === e.whatsapp)?.id ?? "?"}`;
      console.log(`  ${e.nombre} · ${e.rol}  ${maskNumber(e.whatsapp)}  ${id}  ${what}  [${e.from}]`);
    }
    if (r.warnings.length) {
      console.log("");
      for (const w of r.warnings) console.log(`Aviso: ${w}`);
    }
    if (!dryRun) await store.flush();
    const all = await store.listUsers();
    console.log("");
    console.log(`Usuarios en el store: ${all.map((u) => `${u.nombre} · ${u.rol}${u.activo ? "" : " (inactivo)"}`).join(", ") || "ninguno"}`);
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
