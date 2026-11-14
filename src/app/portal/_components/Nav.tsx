"use client";
/** Navegación del portal; marca la sección actual. `validar`: muestra "Validar" (ranking, corrida G) a quien puede. */
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/portal", label: "Prospectos", match: (p: string) => p === "/portal" || p.startsWith("/portal/empresas") },
  { href: "/portal/pipeline", label: "Pipeline", match: (p: string) => p.startsWith("/portal/pipeline") },
  { href: "/portal/hoy", label: "Hoy", match: (p: string) => p.startsWith("/portal/hoy") },
  { href: "/portal/tablero", label: "Tablero", match: (p: string) => p.startsWith("/portal/tablero") },
  { href: "/portal/ventas", label: "Subir ventas", match: (p: string) => p.startsWith("/portal/ventas") },
];

const VALIDAR = { href: "/portal/validar-ranking", label: "Validar", match: (p: string) => p.startsWith("/portal/validar-ranking") };

export function Nav({ validar = false }: { validar?: boolean }) {
  const pathname = usePathname() ?? "";
  const links = validar ? [...LINKS, VALIDAR] : LINKS;
  return (
    <nav className="pt-nav" aria-label="Secciones del portal">
      {links.map((l) => (
        <Link key={l.href} href={l.href} aria-current={l.match(pathname) ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
