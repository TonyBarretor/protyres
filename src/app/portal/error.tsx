"use client";
/** Error inesperado en una pantalla del portal (los errores de permisos y validación llegan como ?error=). */
export default function PortalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="pt-card pt-stack">
      <h1>Algo salió mal</h1>
      <p className="pt-muted">No se pudo cargar esta pantalla. Inténtalo de nuevo; si sigue fallando, avisa al administrador.</p>
      <p>
        <button className="pt-btn pt-btn-dark" type="button" onClick={() => reset()}>
          Reintentar
        </button>
      </p>
    </div>
  );
}
