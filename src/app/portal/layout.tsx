/**
 * Layout del portal: exige sesión (requireUser redirige a /portal/login), barra con navegación y usuario.
 * /portal/login es un route handler y no pasa por aquí. Cada página y cada server action vuelve a llamar a requireUser().
 * Fuentes: Inter (texto) y Space Grotesk (títulos) con next/font (se descargan en el build y se sirven desde la app).
 */
import type { ReactNode } from "react";
import { Inter, Space_Grotesk } from "next/font/google";
import { requireUser } from "@/lib/portal/auth/session";
import { rolLabel } from "@/lib/portal/ui/labels";
import { Nav } from "./_components/Nav";
import "./portal.css";

const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], display: "swap", variable: "--font-space-grotesk", weight: ["500", "600", "700"] });

export const metadata = { title: "Portal 360 Tyres", robots: { index: false, follow: false } };
/**
 * Tope de cada pantalla del portal en Vercel (antes, el de la plataforma: 300 s). Cada pantalla responde en < 2 s contra la
 * base real; si algo se traba, la función corta a los 30 s y no queda colgada (corrida F, punto 1).
 */
export const maxDuration = 30;
export const viewport = { width: "device-width", initialScale: 1, themeColor: "#16181c" };

export default async function PortalLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <div className={`pt-shell ${inter.variable} ${spaceGrotesk.variable}`}>
      <header className="pt-top">
        <div className="pt-top-inner">
          <a className="pt-brand" href="/portal">
            360 <span>Tyres</span>
          </a>
          <Nav />
          <form className="pt-user" action="/api/portal/logout" method="post">
            <span>
              {user.nombre} · {rolLabel(user.rol)}
            </span>
            <button type="submit">Salir</button>
          </form>
        </div>
      </header>
      <main className="pt-main">{children}</main>
    </div>
  );
}
