/**
 * Layout del portal: exige sesión (requireUser redirige a /portal/login). Estructura mínima; el diseño lo hace el bloque
 * de pantallas. /portal/login es un route handler y no pasa por aquí.
 */
import type { ReactNode } from "react";
import { requireUser } from "@/lib/portal/auth/session";

export const metadata = { title: "Portal 360 Tyres", robots: { index: false, follow: false } };

export default async function PortalLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <div>
      <header style={{ display: "flex", gap: "1rem", alignItems: "center", justifyContent: "space-between" }}>
        <strong>Portal 360 Tyres</strong>
        <form action="/api/portal/logout" method="post">
          <span>
            {user.nombre} ({user.rol}){" "}
          </span>
          <button type="submit">Salir</button>
        </form>
      </header>
      <main>{children}</main>
    </div>
  );
}
