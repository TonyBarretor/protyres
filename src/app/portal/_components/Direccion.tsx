/**
 * Corrida L, punto 2 — la dirección de una empresa en pantalla (lo que se muestra sale de src/lib/portal/ui/direccion.ts):
 *  - DireccionLine: una línea con "Cómo llegar" y copiar, y debajo "Según SUNAT al …" o "Dirección de operación (…)".
 *    La usan las tarjetas de Match Venta y de Prospectos (sin la línea de aviso del domicilio fiscal en cada tarjeta: la
 *    lista la dice una vez arriba, DIRECCION_LEGEND).
 *  - SunatAvisoTag: estado / condición de SUNAT en rojo (alerta) o ámbar (aviso).
 *  - DireccionFicha: el bloque de la ficha (siempre con el aviso del domicilio fiscal, el domicilio fiscal aparte si manda
 *    la de operación, "Agregar / Editar dirección de operación" y los locales anexos desplegables).
 */
import type { ReactNode } from "react";
import { AVISO_DOMICILIO_FISCAL, type DireccionUi, type LocalesUi } from "@/lib/portal/ui/direccion";
import type { SunatAviso } from "@/lib/portal/sunat/ubicacion";
import { saveDireccion } from "../match/actions";
import { CopyButton } from "../match/client";

/** Leyenda de las listas (una vez, no en cada tarjeta). */
export const DIRECCION_LEGEND = `Dirección: la de operación si un vendedor la anotó; si no, el domicilio fiscal de SUNAT. ${AVISO_DOMICILIO_FISCAL}.`;

export function SunatAvisoTag({ aviso }: { aviso: SunatAviso | null }) {
  if (!aviso) return null;
  return (
    <span className={`pt-sunat pt-sunat-${aviso.nivel}`} title={aviso.nivel === "alerta" ? "Estado o condición de SUNAT en alerta: va al final de las listas." : "SUNAT no encontró su domicilio."}>
      SUNAT: {aviso.texto}
    </span>
  );
}

function MapLink({ url, aproximada, label = "Cómo llegar" }: { url: string; aproximada: boolean; label?: string }) {
  return (
    <a
      className="pt-btn pt-btn-sm"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={aproximada ? "Sin dirección: busca por razón social y distrito en el mapa (aproximado)." : "Abre el mapa con la dirección completa."}
    >
      {label}
      {aproximada ? " (aprox.)" : ""}
    </a>
  );
}

/** "Agregar / Editar dirección de operación" (saveDireccion; vuelve a `back`). */
export function DireccionForm({ companyId, actual, back, open = false }: { companyId: number; actual: string | null; back: string; open?: boolean }) {
  return (
    <details className="pt-dir-edit" open={open}>
      <summary className="pt-dir-editlink">{actual ? "Editar dirección de operación" : "Agregar dirección de operación"}</summary>
      <form action={saveDireccion} className="pt-dir-form">
        <input type="hidden" name="companyId" value={companyId} />
        <input type="hidden" name="volver" value={back} />
        <label className="pt-field">
          Dónde opera la flota (calle, número, distrito, referencia)
          <input type="text" name="direccion" maxLength={200} defaultValue={actual ?? ""} placeholder="Av. Nicolás Ayllón 1234, Ate" />
        </label>
        <p className="pt-small pt-muted" style={{ margin: 0 }}>
          Manda sobre el domicilio fiscal en todas las vistas; la importación de SUNAT no la toca.{actual ? " Déjala vacía para borrarla." : ""}
        </p>
        <div className="pt-row">
          <button type="submit" className="pt-btn pt-btn-sm pt-btn-dark">
            Guardar
          </button>
        </div>
      </form>
    </details>
  );
}

/** Tarjetas: la dirección en una línea, con Cómo llegar y copiar; `lugar` cuando no hay dirección ("Ate, Lima"). */
export function DireccionLine({ d, lugar, localesHref, children }: { d: DireccionUi; lugar?: string; localesHref?: string | null; children?: ReactNode }) {
  return (
    <div className="pt-dir">
      <span aria-hidden="true" className="pt-dir-pin">
        📍
      </span>
      <div className="pt-dir-body">
        {d.texto ? (
          <>
            <div className="pt-dir-text">{d.texto}</div>
            <div className="pt-dir-note">{d.nota}</div>
          </>
        ) : (
          <>
            {lugar && <div className="pt-dir-text">{lugar}</div>}
            <div className="pt-dir-note">{d.sinDireccion}</div>
          </>
        )}
        <div className="pt-dir-acts">
          <MapLink url={d.mapa.url} aproximada={d.mapa.aproximada} />
          {d.texto && <CopyButton text={d.texto} label="Copiar" />}
          {d.anexos > 0 && localesHref && (
            <a className="pt-dir-editlink" href={localesHref}>
              {d.anexos === 1 ? "1 local anexo" : `${d.anexos} locales anexos`}
            </a>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

/** La ficha: dirección, aviso, domicilio fiscal aparte, edición y locales anexos. */
export function DireccionFicha({
  d,
  locales,
  edit,
  todosHref,
  abierto = false,
}: {
  d: DireccionUi;
  locales: LocalesUi | null;
  edit: { companyId: number; actual: string | null; back: string } | null;
  todosHref: string;
  /** Lista de locales desplegada (se pidió "ver todos"). */
  abierto?: boolean;
}) {
  return (
    <section className="pt-card pt-dir-card" id="direccion" aria-labelledby="direccion-title">
      <div className="pt-section-head">
        <h2 id="direccion-title" style={{ margin: 0 }}>
          Dirección
        </h2>
      </div>
      {d.aviso && (
        <p className={`pt-sunat-line pt-sunat-line-${d.aviso.nivel}`}>
          {d.aviso.nivel === "alerta"
            ? `SUNAT la tiene como ${d.aviso.texto}. Confirma que siga operando antes de visitarla.`
            : `SUNAT: ${d.aviso.texto}. Su domicilio fiscal puede estar desactualizado.`}
        </p>
      )}
      <DireccionLine d={d} />
      {d.fiscal && (
        <div className="pt-dir pt-dir-sec">
          <span aria-hidden="true" className="pt-dir-pin">
            🏛️
          </span>
          <div className="pt-dir-body">
            <div className="pt-small pt-muted">Domicilio fiscal</div>
            <div className="pt-dir-text">{d.fiscal.texto}</div>
            <div className="pt-dir-note">{d.fiscal.segun}</div>
            <div className="pt-dir-acts">
              <MapLink url={d.fiscal.url} aproximada={false} />
              <CopyButton text={d.fiscal.texto} label="Copiar" />
            </div>
          </div>
        </div>
      )}
      {d.hayFiscal && <p className="pt-dir-warn">{AVISO_DOMICILIO_FISCAL}.</p>}
      {d.razonSunat && <p className="pt-small pt-muted" style={{ margin: 0 }}>En SUNAT figura como: {d.razonSunat}</p>}
      {edit && <DireccionForm companyId={edit.companyId} actual={edit.actual} back={edit.back} />}
      {locales && locales.total > 0 && (
        <details className="pt-dir-locales" id="locales" open={abierto}>
          <summary>
            Ver {locales.total === 1 ? "1 local anexo" : `${locales.total} locales anexos`}
            {locales.destacados > 0 && locales.departamento ? ` (${locales.destacados} en ${locales.departamento})` : ""}
          </summary>
          {(() => {
            const dest = locales.items.filter((l) => l.destacado);
            const rest = locales.items.filter((l) => !l.destacado);
            const list = (items: typeof locales.items) => (
              <ul className="pt-dir-list">
                {items.map((l) => (
                  <li key={l.id} className={l.destacado ? "pt-dir-dest" : undefined}>
                    <div style={{ minWidth: 0 }}>{l.texto}</div>
                    <MapLink url={l.url} aproximada={false} />
                  </li>
                ))}
              </ul>
            );
            return (
              <>
                {dest.length > 0 && <h3 className="pt-dir-group">En {locales.departamento}, donde está su flota</h3>}
                {dest.length > 0 && list(dest)}
                {dest.length > 0 && rest.length > 0 && <h3 className="pt-dir-group">Otros departamentos</h3>}
                {rest.length > 0 && list(rest)}
              </>
            );
          })()}
          {locales.ocultos > 0 && (
            <p style={{ margin: "0.5rem 0 0" }}>
              <a className="pt-dir-editlink" href={todosHref}>
                Ver todos ({locales.total})
              </a>
            </p>
          )}
        </details>
      )}
    </section>
  );
}
