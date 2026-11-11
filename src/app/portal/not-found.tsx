import Link from "next/link";

export default function PortalNotFound() {
  return (
    <div className="pt-card pt-stack">
      <h1>No encontrado</h1>
      <p className="pt-muted">La empresa o página que buscas no existe.</p>
      <p>
        <Link className="pt-btn" href="/portal">
          Volver a Prospectos
        </Link>
      </p>
    </div>
  );
}
