/**
 * Subir ventas (.xlsx con mapeo de columnas de config/portal.json). Solo supervisor/admin; el resto ve el estado.
 * Muestra cuántas ventas demo hay y cómo borrarlas.
 */
import { requireUser } from "@/lib/portal/auth/session";
import { getPortalStore } from "@/lib/portal/store";
import { fmtInt } from "@/lib/portal/ui/labels";
import { canUploadSales } from "@/lib/portal/ui/permissions";
import { DemoTag } from "../_components/bits";
import { UploadForm } from "./UploadForm";

export const metadata = { title: "Subir ventas · Portal 360 Tyres" };

export default async function VentasPage() {
  const user = await requireUser();
  const store = await getPortalStore();
  const counts = await store.countSales();
  const reales = counts.total - counts.demo;

  return (
    <div className="pt-stack">
      <div className="pt-page-head" style={{ marginBottom: 0 }}>
        <h1>Subir ventas</h1>
        <span className="pt-muted pt-small">
          {fmtInt(reales)} ventas reales · {fmtInt(counts.demo)} demo
        </span>
      </div>

      {counts.demo > 0 && (
        <p className="pt-notice">
          <DemoTag /> Hay <strong>{fmtInt(counts.demo)} ventas de demostración</strong>. Toda cifra que las incluya lleva la etiqueta DEMO. Para borrarlas, en el
          servidor: <code>npm run portal:clear-demo</code> (las ventas reales no se tocan).
        </p>
      )}

      <section className="pt-card">
        <h2>Cómo funciona</h2>
        <ol className="pt-small" style={{ margin: 0, paddingLeft: "1.1rem" }}>
          <li>Exporta el reporte de ventas a Excel (.xlsx). Columnas obligatorias: fecha, RUC y cantidad; opcionales: razón social, medida, marca, diseño, precio unitario, total y vendedor.</li>
          <li>Pulsa «Vista previa»: verás qué columna se usó para cada campo, las filas válidas y los errores por fila. No se guarda nada.</li>
          <li>Si todo está bien, «Confirmar» guarda las filas válidas (las filas con error se omiten).</li>
        </ol>
      </section>

      {canUploadSales(user) ? (
        <UploadForm />
      ) : (
        <p className="pt-notice">Solo el supervisor o el administrador pueden subir ventas. Si tienes un reporte nuevo, envíaselo a ellos.</p>
      )}
    </div>
  );
}
