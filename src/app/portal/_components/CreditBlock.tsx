/**
 * Bloque "Crédito" de la ficha. Por ahora solo el estado `sin evaluar` y el plazo habitual si lo hubiera; la fase C (C4)
 * lo completa con el historial y el proveedor de buró (CreditBureauProvider). Mantener la firma: recibe la empresa.
 */
import type { Company } from "@/lib/portal/store/types";

export function CreditBlock({ company }: { company: Pick<Company, "id" | "creditTermsDays"> }) {
  return (
    <section className="pt-card" aria-labelledby="credito-title">
      <div className="pt-section-head">
        <h2 id="credito-title">Crédito</h2>
        <span className="pt-credit-status">sin evaluar</span>
      </div>
      <p className="pt-muted pt-small">
        {company.creditTermsDays ? `Plazo habitual: ${company.creditTermsDays} días. ` : ""}
        La evaluación crediticia aún no está disponible.
      </p>
    </section>
  );
}
