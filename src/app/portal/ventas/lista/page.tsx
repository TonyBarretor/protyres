/**
 * Corrida J, punto 5 — pantalla general de ventas: todas las líneas de venta (lo más reciente primero, paginadas en la
 * base), filtros combinables que quedan en la dirección, resumen del filtro y vista "Por cliente" ordenable.
 * Vendedor, supervisor y admin (canSeeSalesHistory; el técnico recibe "no encontrada"). Precio, costo, proveedor y margen
 * son internos. Sin JavaScript: el formulario es GET. En el celular la tabla pasa a tarjetas. Sin exportar a Excel.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/portal/auth/session";
import { getPortalStore } from "@/lib/portal/store";
import { fmtInt } from "@/lib/portal/ui/labels";
import {
  CLIENT_SORTS,
  LINE_TYPES,
  loadSalesListView,
  SALES_LIST_PATH,
  salesListHref,
  type PartyView,
  type SalesListClientView,
  type SalesListParams,
  type SalesListRowView,
  type SalesListView,
} from "@/lib/portal/ui/ventas-lista";
import type { SaleRowView } from "@/lib/portal/ui/ventas";
import type { SalesClientSort } from "@/lib/portal/store/types";
import { DemoTag } from "../../_components/bits";

export const metadata = { title: "Ventas · Portal 360 Tyres" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

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

function Party({ p }: { p: PartyView }) {
  return p.companyId ? (
    <Link className="pt-company-link" href={`/portal/empresas/${p.companyId}`}>
      {p.nombre}
    </Link>
  ) : (
    <strong>{p.nombre}</strong>
  );
}

function Cliente({ r }: { r: SalesListRowView }) {
  return (
    <>
      <Party p={r.cliente} /> <span className="pt-small pt-muted pt-mono">{r.cliente.ruc}</span>
      {r.clienteFinal && (
        <div className="pt-small pt-leasing">
          cliente final: <Party p={r.clienteFinal} />
        </div>
      )}
    </>
  );
}

function Summary({ v }: { v: SalesListView }) {
  const s = v.summary;
  const demo = v.params.demo ? <DemoTag /> : null;
  return (
    <section aria-label="Resumen del filtro" className="pt-stack" style={{ gap: "0.5rem" }}>
      <div className="pt-kpis">
        <div className="pt-kpi">
          <div className="pt-kpi-label">Neumáticos netos {demo}</div>
          <div className="pt-kpi-value">{s.neumaticosText}</div>
          <div className="pt-kpi-sub">{fmtInt(s.lineas)} líneas</div>
        </div>
        <div className="pt-kpi">
          <div className="pt-kpi-label">Total S/ {demo}</div>
          <div className="pt-kpi-value" style={{ fontSize: "1.25rem" }}>
            {s.totalPenText}
          </div>
          <div className="pt-kpi-sub">{s.totalUsdText}</div>
        </div>
        <div className="pt-kpi">
          <div className="pt-kpi-label">Margen promedio ponderado {demo}</div>
          <div className="pt-kpi-value">{s.margenText}</div>
          <div className="pt-kpi-sub">por venta en soles</div>
        </div>
        <div className="pt-kpi">
          <div className="pt-kpi-label">Clientes {demo}</div>
          <div className="pt-kpi-value">{fmtInt(s.clientes)}</div>
          <div className="pt-kpi-sub">RUC distintos</div>
        </div>
      </div>
      {s.notasCreditoText && (
        <p className="pt-small pt-muted" style={{ margin: 0 }}>
          <span className="pt-tag pt-tag-nc" style={{ marginLeft: 0 }}>
            Nota de crédito
          </span>{" "}
          {s.notasCreditoText}.
        </p>
      )}
      <details className="pt-small pt-muted">
        <summary>Cómo se calcula</summary>
        <p style={{ margin: "0.3rem 0 0" }}>
          Neumáticos netos: unidades de las líneas de neumáticos; las notas de crédito restan (las que solo corrigen el monto no restan unidades). Totales: suma de
          «TOTAL VTA S/» y «TOTAL VTA $» del reporte, con las notas de crédito en negativo. Margen ponderado = (venta S/ − costo S/) ÷ venta S/ de las líneas con margen
          numérico y de las notas de crédito; los servicios «SIN COSTO» no entran. Las ventas anuladas no salen.
        </p>
      </details>
    </section>
  );
}

function Filters({ v }: { v: SalesListView }) {
  const p = v.params;
  return (
    <form className="pt-card pt-filters" method="get" action={SALES_LIST_PATH}>
      {p.demo && <input type="hidden" name="demo" value="1" />}
      {p.vista === "clientes" && (
        <>
          <input type="hidden" name="vista" value="clientes" />
          <input type="hidden" name="orden" value={p.orden} />
          <input type="hidden" name="dir" value={p.dir} />
        </>
      )}
      <div className="pt-filters-grid">
        <label className="pt-field pt-q">
          Buscar
          <input type="search" name="q" defaultValue={p.q} maxLength={80} placeholder="Cliente, RUC, factura o producto" />
        </label>
        <label className="pt-field">
          Medida
          <input type="text" name="medida" defaultValue={p.medida} maxLength={40} placeholder="295/80R22.5" />
        </label>
        <label className="pt-field">
          Marca
          <select name="marca" defaultValue={p.marca.toUpperCase()}>
            <option value="">Todas</option>
            {v.options.marcas.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            {p.marca && !v.options.marcas.includes(p.marca.toUpperCase()) && <option value={p.marca.toUpperCase()}>{p.marca}</option>}
          </select>
        </label>
        <label className="pt-field">
          Tipo
          <select name="tipo" defaultValue={p.tipo}>
            <option value="">Todos</option>
            {LINE_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="pt-field">
          Vendedor
          <select name="vendedor" defaultValue={p.vendedor}>
            <option value="">Todos</option>
            {v.options.vendedores.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            {p.vendedor && !v.options.vendedores.includes(p.vendedor) && <option value={p.vendedor}>{p.vendedor}</option>}
          </select>
        </label>
        <label className="pt-field">
          Desde
          <input type="date" name="desde" defaultValue={p.desde} />
        </label>
        <label className="pt-field">
          Hasta
          <input type="date" name="hasta" defaultValue={p.hasta} />
        </label>
      </div>
      <label className="pt-row pt-small" style={{ flexWrap: "nowrap" }}>
        <input type="checkbox" name="leasing" value="1" defaultChecked={p.leasing} style={{ width: "auto" }} />
        Solo leasing sin cliente final
      </label>
      <div className="pt-row">
        <button className="pt-btn pt-btn-dark" type="submit">
          Filtrar
        </button>
        {v.hasFilters && (
          <Link className="pt-btn" href={salesListHref({ ...p, q: "", medida: "", marca: "", tipo: "", vendedor: "", desde: "", hasta: "", leasing: false, page: 1 })}>
            Limpiar
          </Link>
        )}
      </div>
    </form>
  );
}

function LinesTable({ rows }: { rows: SalesListRowView[] }) {
  return (
    <>
      <div className="pt-table-wrap pt-sales-table">
        <table className="pt-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Factura</th>
              <th>Cliente</th>
              <th>Producto</th>
              <th>Medida</th>
              <th className="pt-num">Cant.</th>
              <th className="pt-num">Precio unit.</th>
              <th className="pt-num">Costo unit.</th>
              <th>Proveedor</th>
              <th className="pt-num">Margen</th>
              <th>Vendedor</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.notaCredito ? "pt-nc" : undefined}>
                <td className="pt-mono">{r.fecha}</td>
                <td>
                  <span className="pt-mono">{r.documento}</span>
                  {r.demo && <DemoTag />}
                  <DocTags r={r} />
                </td>
                <td>
                  <Cliente r={r} />
                </td>
                <td>{r.producto}</td>
                <td className="pt-mono">{r.medida ?? "—"}</td>
                <td className="pt-num pt-qty">{qty(r.cantidad)}</td>
                <td className="pt-num">{r.precio}</td>
                <td className="pt-num">{r.costo}</td>
                <td className="pt-small">{r.proveedor}</td>
                <td className="pt-num">{r.margen}</td>
                <td className="pt-small">{r.vendedor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="pt-cards pt-sales-cards" aria-label="Líneas de venta">
        {rows.map((r) => (
          <li key={r.id} className={`pt-card${r.notaCredito ? " pt-nc" : ""}`}>
            <div className="pt-small">
              <span className="pt-mono">{r.fecha}</span> · <span className="pt-mono">{r.documento}</span>
              {r.demo && <DemoTag />}
              <DocTags r={r} />
            </div>
            <div>
              <Cliente r={r} />
            </div>
            <div>{r.producto}</div>
            <dl className="pt-kv">
              <div>
                <dt>Cantidad</dt>
                <dd className="pt-qty">{qty(r.cantidad)}</dd>
              </div>
              <div>
                <dt>Medida</dt>
                <dd>{r.medida ?? "—"}</dd>
              </div>
              <div>
                <dt>Precio unit.</dt>
                <dd>{r.precio}</dd>
              </div>
              <div>
                <dt>Costo unit.</dt>
                <dd>{r.costo}</dd>
              </div>
              <div>
                <dt>Margen</dt>
                <dd>{r.margen}</dd>
              </div>
              <div>
                <dt>Vendedor</dt>
                <dd>{r.vendedor}</dd>
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

function SortHeader({ p, id, label, num }: { p: SalesListParams; id: SalesClientSort; label: string; num?: boolean }) {
  const active = p.orden === id;
  const def = CLIENT_SORTS.find((s) => s.id === id)!.dir;
  const dir = active ? (p.dir === "asc" ? "desc" : "asc") : def;
  return (
    <th className={num ? "pt-num" : undefined} aria-sort={active ? (p.dir === "asc" ? "ascending" : "descending") : undefined}>
      <Link href={salesListHref(p, { orden: id, dir, page: 1 })}>
        {label}
        {active ? (p.dir === "asc" ? " ↑" : " ↓") : ""}
      </Link>
    </th>
  );
}

function ClientsTable({ v, rows }: { v: SalesListView; rows: SalesListClientView[] }) {
  const p = v.params;
  return (
    <>
      <nav className="pt-shortcuts" aria-label="Ordenar clientes">
        <span className="pt-small pt-muted">Ordenar por:</span>
        {CLIENT_SORTS.map((s) => {
          const active = p.orden === s.id;
          return (
            <Link key={s.id} href={salesListHref(p, { orden: s.id, dir: active ? (p.dir === "asc" ? "desc" : "asc") : s.dir, page: 1 })} aria-current={active ? "page" : undefined}>
              {s.label}
              {active ? (p.dir === "asc" ? " ↑" : " ↓") : ""}
            </Link>
          );
        })}
      </nav>
      <div className="pt-table-wrap pt-sales-table">
        <table className="pt-table">
          <thead>
            <tr>
              <SortHeader p={p} id="cliente" label="Cliente" />
              <SortHeader p={p} id="neumaticos" label="Neumáticos" num />
              <SortHeader p={p} id="total" label="Total S/" num />
              <th className="pt-num">Total US$</th>
              <SortHeader p={p} id="margen" label="Margen" num />
              <SortHeader p={p} id="ultima" label="Última compra" />
              <th className="pt-num">Líneas</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.cliente.ruc} className={r.neumaticosNegativos ? "pt-nc" : undefined}>
                <td>
                  <Party p={r.cliente} /> <span className="pt-small pt-muted pt-mono">{r.cliente.ruc}</span>
                </td>
                <td className="pt-num pt-qty">{r.neumaticos}</td>
                <td className="pt-num">{r.totalPen}</td>
                <td className="pt-num">{r.totalUsd}</td>
                <td className="pt-num">{r.margen}</td>
                <td className="pt-mono">{r.ultimaCompra}</td>
                <td className="pt-num">
                  <Link href={r.href}>{fmtInt(r.lineas)}</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="pt-cards pt-sales-cards" aria-label="Ventas por cliente">
        {rows.map((r) => (
          <li key={r.cliente.ruc} className={`pt-card${r.neumaticosNegativos ? " pt-nc" : ""}`}>
            <div>
              <Party p={r.cliente} /> <span className="pt-small pt-muted pt-mono">{r.cliente.ruc}</span>
            </div>
            <dl className="pt-kv">
              <div>
                <dt>Neumáticos</dt>
                <dd className="pt-qty">{r.neumaticos}</dd>
              </div>
              <div>
                <dt>Margen</dt>
                <dd>{r.margen}</dd>
              </div>
              <div>
                <dt>Total S/</dt>
                <dd>{r.totalPen}</dd>
              </div>
              <div>
                <dt>Total US$</dt>
                <dd>{r.totalUsd}</dd>
              </div>
              <div>
                <dt>Última compra</dt>
                <dd>{r.ultimaCompra}</dd>
              </div>
              <div>
                <dt>Líneas</dt>
                <dd>
                  <Link href={r.href}>{fmtInt(r.lineas)}</Link>
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

export default async function VentasListaPage({ searchParams }: Props) {
  const user = await requireUser();
  const store = await getPortalStore();
  const v = await loadSalesListView(store, user, await searchParams);
  if (!v) notFound();
  const p = v.params;
  const unidad = p.vista === "clientes" ? "clientes" : "líneas";

  return (
    <div className="pt-stack">
      <div className="pt-page-head" style={{ marginBottom: 0 }}>
        <h1>
          Ventas {p.demo && <DemoTag />}
        </h1>
        <span className="pt-muted pt-small">
          precio, costo y margen son internos · <Link href="/portal/ventas">Subir ventas</Link>
        </span>
      </div>

      {p.demo ? (
        <p className="pt-notice">
          <DemoTag /> Solo las <strong>ventas de demostración</strong> ({fmtInt(v.demoCount)}). No se suman a las reales.{" "}
          <Link href={salesListHref(p, { demo: false, page: 1 })}>Volver a las ventas reales</Link>
        </p>
      ) : (
        v.demoCount > 0 && (
          <p className="pt-notice">
            Hay {fmtInt(v.demoCount)} ventas <DemoTag /> que no se mezclan con estas. <Link href={salesListHref(p, { demo: true, page: 1 })}>Verlas aparte</Link>
          </p>
        )
      )}

      <Filters v={v} />
      {v.medidaNoReconocida && <p className="pt-notice pt-error">No reconocí la medida «{v.medidaNoReconocida}»: no se filtró por medida. Escríbela como 295/80R22.5.</p>}

      <Summary v={v} />

      <nav className="pt-shortcuts" aria-label="Vista">
        <Link href={salesListHref(p, { vista: "lineas", page: 1 })} aria-current={p.vista === "lineas" ? "page" : undefined}>
          Líneas
        </Link>
        <Link href={salesListHref(p, { vista: "clientes", page: 1 })} aria-current={p.vista === "clientes" ? "page" : undefined}>
          Por cliente
        </Link>
      </nav>

      {v.total === 0 ? (
        <p className="pt-muted">{v.hasFilters ? "Ninguna venta con estos filtros." : p.demo ? "No hay ventas de demostración." : "Todavía no hay ventas cargadas."}</p>
      ) : p.page > v.pages ? (
        <p className="pt-muted">
          No hay página {fmtInt(p.page)}: son {fmtInt(v.pages)}. <Link href={salesListHref(p, { page: 1 })}>Ir a la primera</Link>
        </p>
      ) : (
        <>
          {p.vista === "clientes" ? <ClientsTable v={v} rows={v.clientes} /> : <LinesTable rows={v.lineas} />}
          <nav className="pt-pager" aria-label="Páginas">
            <span className="pt-muted pt-small">
              {fmtInt(v.from)}–{fmtInt(v.to)} de {fmtInt(v.total)} {unidad} · página {fmtInt(Math.min(p.page, v.pages))} de {fmtInt(v.pages)}
            </span>
            <span className="pt-row">
              {p.page > 1 && (
                <Link className="pt-btn pt-btn-sm" href={salesListHref(p, { page: Math.min(p.page - 1, v.pages) })}>
                  ← Anterior
                </Link>
              )}
              {p.page < v.pages && (
                <Link className="pt-btn pt-btn-sm" href={salesListHref(p, { page: p.page + 1 })}>
                  Siguiente →
                </Link>
              )}
            </span>
          </nav>
        </>
      )}
    </div>
  );
}
