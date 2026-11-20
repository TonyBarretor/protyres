/**
 * ventas-odoo, puntos 8 y 9: "Historial de ventas" de la ficha (neumáticos con precio, costo, proveedor y margen; servicios
 * por tipo; otros productos) y, en la ficha de un banco, el formulario para asignar el cliente final de sus facturas.
 * Precio, costo, proveedor y margen son internos: el bloque solo se muestra a vendedor, supervisor y admin
 * (canSeeSalesHistory); el técnico ve la ficha sin él.
 * Filtro por medida con enlaces (?medida=295/80R22.5), sin JavaScript. En el celular la tabla pasa a tarjetas.
 */
import Link from "next/link";
import { findCompanyForClienteFinal } from "@/lib/portal/sales/history";
import { digits } from "@/lib/portal/store/shared";
import type { Company, PortalStore, PortalUser } from "@/lib/portal/store/types";
import { fmtInt } from "@/lib/portal/ui/labels";
import { canAssignClienteFinal, canSeeSalesHistory } from "@/lib/portal/ui/permissions";
import { fichaSalesView, parseMedidaParam, type ClienteFinalDoc, type ClienteFinalDocs, type FichaSalesView, type SaleRowView } from "@/lib/portal/ui/ventas";
import { Flash } from "../../_components/bits";
import { assignClienteFinalAction } from "./sales-actions";

/** Medidas a la vista en el filtro (las de más unidades); el resto en un desplegable. */
const MEDIDAS_SHOWN = 10;

export type SP = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function href(base: string, params: Record<string, string | null>, hash: string): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return `${base}${s ? `?${s}` : ""}#${hash}`;
}

function DocTags({ r }: { r: SaleRowView }) {
  if (!r.notaCredito) return null;
  return (
    <>
      {" "}
      <span className="pt-tag pt-tag-nc">Nota de crédito</span>
      {r.soloMonto && <span className="pt-tag pt-tag-mtc">solo monto</span>}
      {r.revierte && <span className="pt-small pt-muted"> revierte {r.revierte}</span>}
    </>
  );
}

function qty(n: number): string {
  return n < 0 ? `−${fmtInt(-n)}` : fmtInt(n);
}

function SalesTable({ rows }: { rows: SaleRowView[] }) {
  return (
    <>
      <div className="pt-table-wrap pt-sales-table">
        <table className="pt-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Factura</th>
              <th>Producto</th>
              <th className="pt-num">Cant.</th>
              <th className="pt-num">Precio unit.</th>
              <th className="pt-num">Costo unit.</th>
              <th>Proveedor</th>
              <th className="pt-num">Margen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.notaCredito ? "pt-nc" : undefined}>
                <td className="pt-mono">{r.fecha}</td>
                <td>
                  <span className="pt-mono">{r.documento}</span>
                  <DocTags r={r} />
                </td>
                <td>
                  {r.producto}
                  {r.leasing && <div className="pt-small pt-leasing">{r.leasing}</div>}
                </td>
                <td className="pt-num pt-qty">{qty(r.cantidad)}</td>
                <td className="pt-num">{r.precio}</td>
                <td className="pt-num">{r.costo}</td>
                <td className="pt-small">{r.proveedor}</td>
                <td className="pt-num">{r.margen}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="pt-cards pt-sales-cards" aria-label="Ventas">
        {rows.map((r) => (
          <li key={r.id} className={`pt-card${r.notaCredito ? " pt-nc" : ""}`}>
            <div className="pt-small">
              <span className="pt-mono">{r.fecha}</span> · <span className="pt-mono">{r.documento}</span>
              <DocTags r={r} />
            </div>
            <strong>{r.producto}</strong>
            {r.leasing && <div className="pt-small pt-leasing">{r.leasing}</div>}
            <dl className="pt-kv">
              <div>
                <dt>Cantidad</dt>
                <dd className="pt-qty">{qty(r.cantidad)}</dd>
              </div>
              <div>
                <dt>Margen</dt>
                <dd>{r.margen}</dd>
              </div>
              <div>
                <dt>Precio unit.</dt>
                <dd>{r.precio}</dd>
              </div>
              <div>
                <dt>Costo unit.</dt>
                <dd>{r.costo}</dd>
              </div>
              <div className="pt-kv-wide">
                <dt>Proveedor</dt>
                <dd>{r.proveedor}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

function docText(d: ClienteFinalDoc): string {
  const parts = [d.fecha, `${fmtInt(d.neumaticos)} neumático${d.neumaticos === 1 ? "" : "s"}`, d.productos.slice(0, 2).join(", ") + (d.productos.length > 2 ? "…" : "")];
  if (d.notas.length) parts.push(`con nota de crédito ${d.notas.join(", ")}`);
  return parts.join(" · ");
}

export interface ClienteFinalSearch {
  q: string;
  found: Company[];
  aviso?: string;
  error?: string;
}

/** Busca la empresa del cliente final (?cf=) y lee los mensajes de la última asignación. Sin el propio banco. */
export async function loadClienteFinalSearch(store: PortalStore, bankRuc: string, sp: SP): Promise<ClienteFinalSearch> {
  const q = (str(sp.cf) ?? "").trim().slice(0, 80);
  const found = q ? (await findCompanyForClienteFinal(store, q)).filter((c) => digits(c.ruc) !== digits(bankRuc)) : [];
  return { q, found, aviso: str(sp.cfaviso), error: str(sp.cferror) };
}

/**
 * Formulario del cliente final de las facturas de un banco. `base`: la página donde está (ficha del banco o
 * /portal/ventas/leasing/<ruc>), a la que vuelven la búsqueda y la acción.
 */
export function ClienteFinalBlock({ bankRuc, base, docs, search }: { bankRuc: string; base: string; docs: ClienteFinalDocs; search: ClienteFinalSearch }) {
  const { q, found } = search;
  return (
    <section className="pt-card pt-stack" id="cliente-final" aria-labelledby="cf-title" style={{ gap: "0.75rem" }}>
      <div className="pt-section-head" style={{ marginBottom: 0 }}>
        <h2 id="cf-title">Cliente final (leasing)</h2>
        <span className="pt-small pt-muted">
          {fmtInt(docs.pendientes.length)} por asignar · {fmtInt(docs.asignadas.length)} asignadas
        </span>
      </div>
      <p className="pt-small pt-muted" style={{ margin: 0 }}>
        Las facturas al banco cuentan para la empresa que usa los neumáticos. Busca la empresa, marca sus facturas y asigna.
      </p>
      <Flash aviso={search.aviso} error={search.error} />

      <form method="get" action={`${base}#cliente-final`} className="pt-row">
        <label className="pt-sr-only" htmlFor="cf-q">
          Empresa del cliente final (nombre o RUC)
        </label>
        <input id="cf-q" type="search" name="cf" defaultValue={q} maxLength={80} placeholder="Nombre o RUC del cliente final" style={{ flex: "1 1 200px", width: "auto", minWidth: 0 }} />
        <button className="pt-btn" type="submit">
          Buscar
        </button>
      </form>

      <form action={assignClienteFinalAction} className="pt-stack" style={{ gap: "0.75rem" }}>
        <input type="hidden" name="bankRuc" value={bankRuc} />
        <input type="hidden" name="volver" value={base} />
        {q && (
          <fieldset className="pt-fieldset">
            <legend>Empresa del cliente final</legend>
            {found.length === 0 ? (
              <p className="pt-small pt-muted" style={{ margin: 0 }}>
                No encontré «{q}» en el padrón. Prueba con el RUC.
              </p>
            ) : (
              <ul className="pt-check-list">
                {found.map((c, i) => (
                  <li key={c.id}>
                    <label>
                      <input type="radio" name="clienteFinalId" value={c.id} defaultChecked={i === 0 && found.length === 1} required />
                      <span>
                        <strong>{c.razonSocial}</strong> <span className="pt-small pt-muted pt-mono">RUC {c.ruc}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        )}

        <fieldset className="pt-fieldset">
          <legend>Facturas sin cliente final</legend>
          {docs.pendientes.length === 0 ? (
            <p className="pt-small pt-muted" style={{ margin: 0 }}>
              Ninguna.
            </p>
          ) : (
            <ul className="pt-check-list">
              {docs.pendientes.map((d) => (
                <li key={d.documento}>
                  <label>
                    <input type="checkbox" name="documento" value={d.documento} />
                    <span>
                      <strong className="pt-mono">{d.documento}</strong>
                      {d.notaCredito && <span className="pt-tag pt-tag-nc">Nota de crédito</span>} <span className="pt-small pt-muted">{docText(d)}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        {docs.asignadas.length > 0 && (
          <details>
            <summary>
              <strong>Facturas con cliente final ({fmtInt(docs.asignadas.length)})</strong> <span className="pt-small pt-muted">márcalas para cambiarlo o quitarlo</span>
            </summary>
            <ul className="pt-check-list" style={{ marginTop: "0.5rem" }}>
              {docs.asignadas.map((d) => (
                <li key={d.documento}>
                  <label>
                    <input type="checkbox" name="documento" value={d.documento} />
                    <span>
                      <strong className="pt-mono">{d.documento}</strong> <span className="pt-small pt-muted">{docText(d)}</span>
                      <span className="pt-small pt-leasing" style={{ display: "block" }}>
                        cliente final:{" "}
                        {d.clienteFinal?.id ? <Link href={`/portal/empresas/${d.clienteFinal.id}`}>{d.clienteFinal.razonSocial}</Link> : d.clienteFinal?.razonSocial}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="pt-row">
          <button className="pt-btn pt-btn-primary" type="submit" name="accion" value="asignar" disabled={!found.length}>
            Asignar cliente final
          </button>
          {docs.asignadas.length > 0 && (
            <button className="pt-btn pt-btn-sm" type="submit" name="accion" value="quitar" formNoValidate>
              Quitar cliente final
            </button>
          )}
          {!found.length && <span className="pt-small pt-muted">Primero busca la empresa del cliente final.</span>}
        </div>
      </form>
    </section>
  );
}

export interface SalesHistoryData {
  view: FichaSalesView;
  /** null si el usuario no puede asignar o la empresa no es un banco. */
  search: ClienteFinalSearch | null;
}

/**
 * Lee lo que muestra el bloque (la página lo llama antes de renderizar: el bloque es síncrono). null si el usuario no puede
 * ver el historial (técnico).
 */
export async function loadSalesHistory(store: PortalStore, company: Company, user: PortalUser, sp: SP): Promise<SalesHistoryData | null> {
  if (!canSeeSalesHistory(user)) return null;
  const view = await fichaSalesView(store, company, { medida: parseMedidaParam(str(sp.medida)), todas: str(sp.ventas) === "todas" });
  if (!view.clienteFinal || !canAssignClienteFinal(user)) return { view, search: null };
  return { view, search: await loadClienteFinalSearch(store, company.ruc, sp) };
}

export function SalesHistory({ company, data }: { company: Company; data: SalesHistoryData | null }) {
  if (!data) return null;
  const v = data.view;
  const base = `/portal/empresas/${company.id}`;
  const more = v.neumaticosTotal - v.neumaticos.length;

  return (
    <>
      <section className="pt-card pt-stack" id="ventas" aria-labelledby="ventas-title" style={{ gap: "0.75rem" }}>
        <div className="pt-section-head" style={{ marginBottom: 0 }}>
          <h2 id="ventas-title">Historial de ventas</h2>
          <span className="pt-small pt-muted">{fmtInt(v.neumaticosNetos)} neumáticos netos · precio, costo y margen son internos</span>
        </div>
        {v.sinVentas ? (
          <p className="pt-muted" style={{ margin: 0 }}>
            Sin ventas registradas.
          </p>
        ) : (
          <>
            {v.medidas.length > 1 && (
              <nav className="pt-shortcuts" aria-label="Filtrar por medida">
                <span className="pt-small pt-muted">Medida:</span>
                <Link href={href(base, {}, "ventas")} aria-current={v.medida ? undefined : "page"}>
                  Todas
                </Link>
                {v.medidas.slice(0, MEDIDAS_SHOWN).map((m) => (
                  <Link key={m} href={href(base, { medida: m }, "ventas")} aria-current={v.medida === m ? "page" : undefined}>
                    {m}
                  </Link>
                ))}
                {v.medida && !v.medidas.slice(0, MEDIDAS_SHOWN).includes(v.medida) && (
                  <Link href={href(base, { medida: v.medida }, "ventas")} aria-current="page">
                    {v.medida}
                  </Link>
                )}
              </nav>
            )}
            {v.medidas.length > MEDIDAS_SHOWN && (
              <details>
                <summary className="pt-small">Otras {fmtInt(v.medidas.length - MEDIDAS_SHOWN)} medidas</summary>
                <div className="pt-shortcuts" style={{ marginTop: "0.4rem" }}>
                  {v.medidas.slice(MEDIDAS_SHOWN).map((m) => (
                    <Link key={m} href={href(base, { medida: m }, "ventas")} aria-current={v.medida === m ? "page" : undefined}>
                      {m}
                    </Link>
                  ))}
                </div>
              </details>
            )}
            {v.neumaticos.length === 0 ? (
              <p className="pt-muted" style={{ margin: 0 }}>
                {v.medida ? `Sin ventas de neumáticos ${v.medida}.` : "Sin ventas de neumáticos."}
              </p>
            ) : (
              <SalesTable rows={v.neumaticos} />
            )}
            {more > 0 && (
              <p style={{ margin: 0 }}>
                <Link href={href(base, { medida: v.medida, ventas: "todas" }, "ventas")}>Ver las {fmtInt(v.neumaticosTotal)} líneas</Link>
              </p>
            )}
          </>
        )}
      </section>

      {(v.servicios.length > 0 || v.tieneContrato) && (
        <section className="pt-card" aria-labelledby="servicios-title">
          <div className="pt-section-head">
            <h2 id="servicios-title">Servicios</h2>
            {v.tieneContrato && <span className="pt-chip pt-chip-contrato">Tiene contrato de servicio</span>}
          </div>
          <div className="pt-table-wrap">
            <table className="pt-table">
              <thead>
                <tr>
                  <th>Servicio</th>
                  <th className="pt-num">Veces</th>
                  <th className="pt-num">Cant.</th>
                  <th>Último</th>
                </tr>
              </thead>
              <tbody>
                {v.servicios.map((s) => (
                  <tr key={s.tipo}>
                    <td>{s.label}</td>
                    <td className="pt-num">{fmtInt(s.veces)}</td>
                    <td className="pt-num">{qty(s.cantidad)}</td>
                    <td className="pt-mono">{s.ultimoMes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {v.otros.length > 0 && (
        <section className="pt-card" aria-labelledby="otros-title">
          <div className="pt-section-head">
            <h2 id="otros-title">Otros productos</h2>
            <span className="pt-small pt-muted">
              {v.otrosTotal > v.otros.length ? `${fmtInt(v.otros.length)} de ${fmtInt(v.otrosTotal)}` : fmtInt(v.otrosTotal)} líneas
            </span>
          </div>
          <ul className="pt-list">
            {v.otros.map((r) => (
              <li key={r.id} className={r.notaCredito ? "pt-nc" : undefined}>
                <div className="pt-small pt-muted">
                  <span className="pt-mono">{r.fecha}</span> · <span className="pt-mono">{r.documento}</span>
                  <DocTags r={r} />
                </div>
                <div>
                  {r.producto} · <span className="pt-qty">{qty(r.cantidad)}</span> u. · {r.precio}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {v.clienteFinal && data.search && <ClienteFinalBlock bankRuc={company.ruc} base={base} docs={v.clienteFinal} search={data.search} />}
    </>
  );
}
