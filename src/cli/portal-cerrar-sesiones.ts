/**
 * Hotfix login 2: el administrador cierra el portal de un usuario (lo mismo que `cerrar portal` en el bot): borra todas
 * sus sesiones (sale en todos los teléfonos) y anula sus enlaces de entrada vigentes. Para volver a entrar, el usuario
 * escribe `portal` al bot.
 *
 *   npm run portal:cerrar-sesiones                         lista los usuarios (id, nombre, número enmascarado)
 *   npm run portal:cerrar-sesiones -- --usuario 2          por id
 *   npm run portal:cerrar-sesiones -- --usuario 51955344340   por número (o sus últimos dígitos, si es uno solo)
 *   npm run portal:cerrar-sesiones -- --json ...           sobre el store JSON local (igual que PORTAL_STORE=json)
 */
import "./env";
import { parseArgs } from "node:util";
import { revokeAccess } from "../lib/portal/auth/tokens";
import { getPortalStore } from "../lib/portal/store";
import type { PortalUser } from "../lib/portal/store/types";
import { maskNumber } from "../lib/portal/users";

const { values } = parseArgs({
  options: {
    usuario: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

/** Por id exacto, o por número completo, o por sus últimos dígitos (solo si coincide con uno). */
function findUser(users: PortalUser[], query: string): PortalUser | PortalUser[] | null {
  const q = query.replace(/\D/g, "");
  if (!q) return null;
  const byId = users.find((u) => String(u.id) === q);
  if (byId && q.length < 6) return byId;
  const exact = users.find((u) => u.whatsapp === q);
  if (exact) return exact;
  const tail = users.filter((u) => (u.whatsapp ?? "").endsWith(q));
  return tail.length === 1 ? tail[0] : tail.length ? tail : null;
}

async function main(): Promise<void> {
  if (values.json) process.env.PORTAL_STORE = "json";
  const store = await getPortalStore();
  console.log(`Store: ${process.env.DATABASE_URL && process.env.PORTAL_STORE !== "json" ? "Postgres" : "JSON local"}`);
  try {
    const users = await store.listUsers();
    const list = () => users.forEach((u) => console.log(`  #${u.id}  ${u.nombre} · ${u.rol}  ${maskNumber(u.whatsapp)}${u.activo ? "" : "  (inactivo)"}`));
    if (!values.usuario) {
      console.log("Usuarios (cierra el portal de uno con --usuario <id o número>):");
      list();
      return;
    }
    const found = findUser(users, values.usuario);
    if (!found || Array.isArray(found)) {
      console.log(found ? `Varios usuarios terminan en ${values.usuario}: usa el id.` : `No encontré al usuario ${values.usuario}.`);
      list();
      process.exitCode = 1;
      return;
    }
    const r = await revokeAccess(store, found.id);
    console.log(`Listo: ${found.nombre} (#${found.id}) salió del portal en todos sus teléfonos (${r.sessions} sesiones cerradas) y se anularon ${r.links} enlaces vigentes.`);
    console.log("Para volver a entrar debe escribir *portal* al bot.");
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
