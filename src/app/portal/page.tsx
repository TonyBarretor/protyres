/** Inicio provisional del portal (el bloque de pantallas lo reemplaza). */
import { requireUser } from "@/lib/portal/auth/session";

export default async function PortalHome() {
  const user = await requireUser();
  return <h1>Hola, {user.nombre}</h1>;
}
