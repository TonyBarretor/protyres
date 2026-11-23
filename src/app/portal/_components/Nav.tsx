"use client";
/**
 * Navegación del portal; marca la sección actual. `validar`: muestra "Validar" (ranking, corrida G) a quien puede.
 * `ventas`: muestra "Ventas" (pantalla general de ventas, corrida J) a vendedor, supervisor y admin; la página lo vuelve a
 * comprobar en el servidor. `match`: "Match Venta" (corrida K) a vendedor, supervisor y admin.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

const isLista = (p: string) => p.startsWith("/portal/ventas/lista");

const LINKS = [
  { href: "/portal", label: "Prospectos", match: (p: string) => p === "/portal" || p.startsWith("/portal/empresas") },
  { href: "/portal/pipeline", label: "Pipeline", match: (p: string) => p.startsWith("/portal/pipeline") },
  { href: "/portal/hoy", label: "Hoy", match: (p: string) => p.startsWith("/portal/hoy") },
  { href: "/portal/tablero", label: "Tablero", match: (p: string) => p.startsWith("/portal/tablero") },
];

const VENTAS = { href: "/portal/ventas/lista", label: "Ventas", match: isLista };
const SUBIR = { href: "/portal/ventas", label: "Subir ventas", match: (p: string) => p.startsWith("/portal/ventas") && !isLista(p) };
const MATCH = { href: "/portal/match", label: "Match Venta", match: (p: string) => p.startsWith("/portal/match") };
const VALIDAR = { href: "/portal/validar-ranking", label: "Validar", match: (p: string) => p.startsWith("/portal/validar-ranking") };

export function Nav({ validar = false, ventas = false, match = false }: { validar?: boolean; ventas?: boolean; match?: boolean }) {
  const pathname = usePathname() ?? "";
  const links = [LINKS[0], ...(match ? [MATCH] : []), ...LINKS.slice(1), ...(ventas ? [VENTAS] : []), SUBIR, ...(validar ? [VALIDAR] : [])];
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
