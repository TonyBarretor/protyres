/**
 * Layout de la encuesta pública (/encuesta/[token]): sin sesión (está fuera de /portal, el proxy no la toca), sin índice
 * de buscadores y sin Referer (el token va en la URL). Misma identidad visual del portal.
 */
import type { ReactNode } from "react";
import { Inter, Space_Grotesk } from "next/font/google";
import "./encuesta.css";

const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], display: "swap", variable: "--font-space-grotesk", weight: ["500", "600", "700"] });

export const metadata = { title: "Encuesta de satisfacción · 360 Tyres", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export const viewport = { width: "device-width", initialScale: 1, themeColor: "#16181c" };

export default function EncuestaLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`sv-shell ${inter.variable} ${spaceGrotesk.variable}`}>
      <header className="sv-top">
        <div className="sv-top-inner">
          <div className="sv-brand">
            360 <span>Tyres</span>
          </div>
        </div>
      </header>
      <main className="sv-main">{children}</main>
    </div>
  );
}
