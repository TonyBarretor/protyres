/**
 * Validar el ranking (corrida G, punto 6): 20 empresas elegidas por el sistema (pickValidationSample: mezcla de niveles,
 * primero las que el vendedor conoce), en orden aleatorio y SIN puntaje, nivel ni explicación, para no influir. Para cada
 * una: A, B, C o "No la conozco" y una nota opcional. Vendedor, supervisor y admin (canValidateRanking).
 * Solo datos neutros de la empresa y sin enlace a la ficha (allí se ve el nivel).
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/portal/auth/session";
import { loadPortalConfig } from "@/lib/portal/config";
import { pickValidationSample } from "@/lib/portal/scoring/validation";
import { getPortalStore } from "@/lib/portal/store";
import { fmtInt, sectorLabel } from "@/lib/portal/ui/labels";
import { canValidateRanking } from "@/lib/portal/ui/permissions";
import { NOTE_MAX, VALIDATION_ANSWERS } from "@/lib/portal/ui/ranking";
import { Flash } from "../_components/bits";
import { submitRankingValidation } from "./actions";

export const metadata = { title: "Validar ranking · Portal 360 Tyres" };

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ValidarRankingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  if (!canValidateRanking(user)) notFound();
  const sp = await searchParams;
  const gracias = Number.parseInt(str(sp.gracias) ?? "", 10);

  if (Number.isSafeInteger(gracias) && gracias >= 0) {
    return (
      <div className="pt-stack pt-validate">
        <h1>Validar ranking</h1>
        <section className="pt-card" role="status">
          <h2>¡Gracias!</h2>
          <p>
            Guardamos {gracias} respuesta{gracias === 1 ? "" : "s"}. Con tu criterio y el de tus compañeros se ajusta la estimación que ordena Prospectos y Hoy.
          </p>
          <p className="pt-row">
            <Link className="pt-btn pt-btn-primary" href="/portal/validar-ranking">
              Hacer otra ronda
            </Link>
            <Link className="pt-btn" href="/portal/hoy">
              Ir a Hoy
            </Link>
          </p>
        </section>
      </div>
    );
  }

  const store = await getPortalStore();
  const sample = await pickValidationSample(store, user, loadPortalConfig().scoring);

  return (
    <div className="pt-stack pt-validate">
      <div>
        <h1>Validar ranking</h1>
        <p>
          El portal estima qué flotas conviene trabajar primero. Antes de confiar en esa estimación, queremos compararla con tu experiencia: para cada empresa marca qué tan buena es para
          360 Tyres. <strong>A</strong> = de las mejores, <strong>B</strong> = intermedia, <strong>C</strong> = poco interesante. Si no la conoces, marca{" "}
          <strong>No la conozco</strong>.
        </p>
        <p className="pt-small pt-muted">No mostramos lo que dice el sistema para no influirte. Responde las que quieras; la nota es opcional.</p>
      </div>
      <Flash error={str(sp.error)} />

      {sample.length === 0 ? (
        <p className="pt-card pt-muted">Por ahora no hay empresas para validar. Vuelve cuando se haya calculado el nivel de las flotas.</p>
      ) : (
        <form action={submitRankingValidation} className="pt-stack">
          <input type="hidden" name="ids" value={sample.map((c) => c.id).join(",")} />
          {sample.map((c, i) => (
            <fieldset key={c.id} className="pt-card pt-validate-item">
              <legend>
                <span className="pt-muted">{i + 1}.</span> {c.razonSocial}
              </legend>
              <div className="pt-small pt-muted pt-mono">
                RUC {c.ruc} · {sectorLabel(c.sector)} · {c.departamento ?? "—"}
              </div>
              <div className="pt-small">
                {fmtInt(c.unidades)} unidades · {fmtInt(c.llantasPiso)} llantas en piso
              </div>
              <div className="pt-validate-opts" role="radiogroup" aria-label={`Nivel para ${c.razonSocial}`}>
                {VALIDATION_ANSWERS.map((a) => (
                  <label key={a.id} className={a.id === "desconocida" ? "pt-validate-unknown" : undefined}>
                    <input type="radio" name={`nivel_${c.id}`} value={a.id} />
                    <span>{a.label}</span>
                  </label>
                ))}
              </div>
              <label className="pt-field">
                ¿Por qué? (opcional)
                <input type="text" name={`nota_${c.id}`} maxLength={NOTE_MAX} placeholder="p. ej. ya compra a otro proveedor" />
              </label>
            </fieldset>
          ))}
          <div className="pt-row">
            <button className="pt-btn pt-btn-primary" type="submit">
              Enviar respuestas
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
