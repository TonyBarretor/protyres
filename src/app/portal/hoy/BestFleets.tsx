/**
 * "Tus 20 mejores flotas para trabajar" (Hoy, corrida G punto 5): las de mayor puntaje que no son de otro vendedor
 * (bestFleets), primero las sin dueño (con Asignarme, que vuelve a Hoy) y luego las propias sin actividad reciente.
 */
import Link from "next/link";
import { ESTIMATE_NOTE, explainLine } from "@/lib/portal/scoring/explain";
import type { BestCompany } from "@/lib/portal/store/types";
import { fmtInt, sectorLabel } from "@/lib/portal/ui/labels";
import { assignCompany } from "../actions";
import { ExplainLine, NivelBadge } from "../_components/bits";

function Item({ c, assign }: { c: BestCompany; assign: boolean }) {
  return (
    <li className="pt-best-item">
      <div className="pt-best-main">
        <div className="pt-row" style={{ gap: "0.4rem" }}>
          <NivelBadge nivel={c.nivel} />
          <Link className="pt-company-link" href={`/portal/empresas/${c.id}`}>
            {c.razonSocial}
          </Link>
        </div>
        <ExplainLine text={explainLine(c.scoreDetalle)} />
        <div className="pt-small pt-muted">
          {sectorLabel(c.sector)} · {c.departamento ?? "—"} · {fmtInt(c.unidades)} unidades
        </div>
      </div>
      {assign && (
        <form action={assignCompany}>
          <input type="hidden" name="companyId" value={c.id} />
          <input type="hidden" name="volver" value="/portal/hoy" />
          <button className="pt-btn pt-btn-sm pt-btn-primary" type="submit">
            Asignarme
          </button>
        </form>
      )}
    </li>
  );
}

export function BestFleets({ size, dias, sinDueno, propias }: { size: number; dias: number; sinDueno: BestCompany[]; propias: BestCompany[] }) {
  return (
    <section className="pt-card pt-best" aria-labelledby="mejores-title">
      <h2 id="mejores-title">Tus {size} mejores flotas para trabajar</h2>
      <p className="pt-small pt-muted">
        Las de nivel más alto que no son de otro vendedor. {ESTIMATE_NOTE}
      </p>
      {sinDueno.length === 0 && propias.length === 0 ? (
        <p className="pt-muted">Por ahora no hay flotas con nivel calculado libres para ti.</p>
      ) : (
        <>
          {sinDueno.length > 0 && (
            <>
              <h3 id="mejores-sin-dueno">Sin dueño</h3>
              <ul className="pt-list" aria-labelledby="mejores-sin-dueno">
                {sinDueno.map((c) => (
                  <Item key={c.id} c={c} assign />
                ))}
              </ul>
            </>
          )}
          {propias.length > 0 && (
            <>
              <h3 id="mejores-propias" style={{ marginTop: "1rem" }}>
                Tuyas sin actividad en {dias} días
              </h3>
              <p className="pt-muted pt-small">Ya son tuyas: registra una llamada o visita para retomarlas.</p>
              <ul className="pt-list" aria-labelledby="mejores-propias">
                {propias.map((c) => (
                  <Item key={c.id} c={c} assign={false} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
