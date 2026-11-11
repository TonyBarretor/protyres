"use client";
/** Navegación del portal; marca la sección actual. "Tablero" llega en la fase C. */
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/portal", label: "Prospectos", match: (p: string) => p === "/portal" || p.startsWith("/portal/empresas") },
  { href: "/portal/pipeline", label: "Pipeline", match: (p: string) => p.startsWith("/portal/pipeline") },
  { href: "/portal/hoy", label: "Hoy", match: (p: string) => p.startsWith("/portal/hoy") },
  { href: "/portal/ventas", label: "Subir ventas", match: (p: string) => p.startsWith("/portal/ventas") },
];

export function Nav() {
  const pathname = usePathname() ?? "";
  return (
    <nav className="pt-nav" aria-label="Secciones del portal">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={l.match(pathname) ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
      <span className="pt-nav-soon" title="Disponible en la fase C">
        Tablero
      </span>
    </nav>
  );
}
