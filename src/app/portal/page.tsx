/**
 * Prospectos: empresas del padrón MTC con búsqueda, filtros (por searchParams, en el servidor) y paginación.
 * Tabla en escritorio; tarjetas en el celular.
 */
import Link from "next/link";
import { requireUser } from "@/lib/portal/auth/session";
import { getPortalStore } from "@/lib/portal/store";
import type { CompanyRow, PortalUser } from "@/lib/portal/store/types";
import {
  BRAND_SHORTCUTS,
  FLEET_RANGES,
  ORDERS,
  PAGE_SIZE,
  SECTORS,
  filtersQuery,
  hasActiveFilters,
  isShortcutActive,
  pageCount,
  parseProspectFilters,
  toCompanySearch,
} from "@/lib/portal/ui/filters";
import { fmtInt, sectorLabel } from "@/lib/portal/ui/labels";
import { DemoTag, MTC_LEGEND, MtcTag, TempChip } from "./_components/bits";

export const metadata = { title: "Prospectos · Portal 360 Tyres" };

/** Marcas que se listan como casillas (las de más vehículos); las elegidas fuera de esta lista se muestran igual. */
const MARCAS_VISIBLES = 40;

function Participacion({ row }: { row: CompanyRow }) {
  return (
    <span>
      <strong className="pt-mono">{fmtInt(row.participacion)}</strong>
      <span className="pt-muted pt-small"> / {fmtInt(row.llantasPiso)} en piso</span> {row.participacionDemo && <DemoTag />}
    </span>
  );
}

export default async function ProspectosPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const store = await getPortalStore();
  const filters = parseProspectFilters(await searchParams);
  const [result, marcas, departamentos, users] = await Promise.all([store.searchCompanies(toCompanySearch(filters)), store.listMarcas(), store.listDepartamentos(), store.listUsers()]);
  const userName = new Map<number, string>(users.map((u: PortalUser) => [u.id, u.nombre.split(" ")[0]]));
  const pages = pageCount(result.total);
  const from = result.total ? (filters.page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(result.total, filters.page * PAGE_SIZE);
  const marcaOptions = marcas.slice(0, MARCAS_VISIBLES).map((m) => m.marca);
  for (const m of filters.marcas) if (!marcaOptions.includes(m)) marcaOptions.unshift(m);
  const marcaCount = new Map(marcas.map((m) => [m.marca, m.empresas]));
  const owner = (r: CompanyRow) => (r.ownerUserId === null ? "—" : r.ownerUserId === user.id ? "Tú" : (userName.get(r.ownerUserId) ?? `#${r.ownerUserId}`));

  return (
    <div className="pt-stack">
      <div className="pt-page-head">
        <h1>Prospectos</h1>
        <span className="pt-muted pt-small">
          {fmtInt(result.total)} empresa{result.total === 1 ? "" : "s"}
          {hasActiveFilters(filters) ? " con estos filtros" : " en el padrón (≥10 unidades)"}
        </span>
      </div>

      <form className="pt-card pt-filters" method="get" action="/portal">
        <div className="pt-filters-grid">
          <label className="pt-field pt-q">
            Buscar
            <input type="search" name="q" defaultValue={filters.q} placeholder="Razón social o RUC" />
          </label>
          <label className="pt-field">
            Departamento
            <select name="dep" defaultValue={filters.departamento ?? ""}>
              <option value="">Todos</option>
              {departamentos.map((d) => (
                <option key={d.departamento} value={d.departamento}>
                  {d.departamento} ({fmtInt(d.empresas)})
                </option>
              ))}
            </select>
          </label>
          <label className="pt-field">
            Sector
            <select name="sector" defaultValue={filters.sector ?? ""}>
              <option value="">Todos</option>
              {SECTORS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="pt-field">
            Tamaño de flota
            <select name="flota" defaultValue={filters.flota ?? ""}>
              <option value="">Cualquiera</option>
              {FLEET_RANGES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="pt-field">
            Cliente / prospecto
            <select name="tipo" defaultValue={filters.tipo ?? ""}>
              <option value="">Todos</option>
              <option value="prospecto">Prospectos</option>
              <option value="cliente">Clientes</option>
            </select>
          </label>
          <label className="pt-field">
            Ordenar por
            <select name="orden" defaultValue={filters.orden}>
              {ORDERS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="pt-shortcuts">
          <span className="pt-small pt-muted">Marca de vehículo:</span>
          {BRAND_SHORTCUTS.map((s) => {
            const active = isShortcutActive(filters, s.marcas);
            return (
              <Link key={s.label} href={`/portal${filtersQuery(filters, { marcas: active ? [] : s.marcas })}`} aria-pressed={active}>
                {s.label}
              </Link>
            );
          })}
          {filters.marcas.length > 0 && <Link href={`/portal${filtersQuery(filters, { marcas: [] })}`}>Quitar marcas</Link>}
        </div>

        <details className="pt-marcas" open={filters.marcas.length > 0 && !BRAND_SHORTCUTS.some((s) => isShortcutActive(filters, s.marcas))}>
          <summary>
            Elegir marcas{filters.marcas.length ? ` (${filters.marcas.length} elegida${filters.marcas.length === 1 ? "" : "s"}: ${filters.marcas.join(", ")})` : ""}
          </summary>
          <div className="pt-marcas-list">
            {marcaOptions.map((m) => (
              <label key={m}>
                <input type="checkbox" name="marca" value={m} defaultChecked={filters.marcas.includes(m)} />
                {m} <span className="pt-muted pt-small">({fmtInt(marcaCount.get(m) ?? 0)})</span>
              </label>
            ))}
          </div>
          <label className="pt-field" style={{ marginTop: "0.6rem", maxWidth: 360 }}>
            Otra marca (separa con comas)
            <input type="text" name="marca" placeholder="p. ej. FOTON, JAC" />
          </label>
        </details>

        <div className="pt-row">
          <button className="pt-btn pt-btn-dark" type="submit">
            Filtrar
          </button>
          {hasActiveFilters(filters) && (
            <Link className="pt-btn" href="/portal">
              Limpiar
            </Link>
          )}
        </div>
      </form>

      <p className="pt-legend">
        {MTC_LEGEND} Participación = neumáticos vendidos en los últimos 12 meses (al lado, llantas en piso).
      </p>

      {result.rows.length === 0 ? (
        <p className="pt-card pt-muted">No hay empresas con estos filtros.</p>
      ) : (
        <>
          <div className="pt-table-wrap pt-prospects">
            <table className="pt-table">
              <thead>
                <tr>
                  <th>Empresa</th>
                  <th>Sector</th>
                  <th>Departamento</th>
                  <th className="pt-num">Unidades</th>
                  <th className="pt-num">
                    Llantas en piso <MtcTag />
                  </th>
                  <th>Participación</th>
                  <th>Dueño</th>
                  <th>Temperatura</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link className="pt-company-link" href={`/portal/empresas/${r.id}`}>
                        {r.razonSocial}
                      </Link>{" "}
                      {r.esCliente && <span className="pt-tag pt-tag-client">cliente</span>}
                      <div className="pt-muted pt-small pt-mono">RUC {r.ruc}</div>
                    </td>
                    <td>{sectorLabel(r.sector)}</td>
                    <td>{r.departamento ?? "—"}</td>
                    <td className="pt-num">{fmtInt(r.unidades)}</td>
                    <td className="pt-num">{fmtInt(r.llantasPiso)}</td>
                    <td>
                      <Participacion row={r} />
                    </td>
                    <td>{owner(r)}</td>
                    <td>
                      <TempChip t={r.temperatura} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pt-cards">
            {result.rows.map((r) => (
              <article className="pt-card" key={r.id}>
                <div className="pt-row" style={{ justifyContent: "space-between" }}>
                  <Link className="pt-company-link" href={`/portal/empresas/${r.id}`}>
                    {r.razonSocial}
                  </Link>
                  <TempChip t={r.temperatura} />
                </div>
                <div className="pt-muted pt-small pt-mono">
                  RUC {r.ruc} · {sectorLabel(r.sector)} · {r.departamento ?? "—"} {r.esCliente && <span className="pt-tag pt-tag-client">cliente</span>}
                </div>
                <dl className="pt-kv">
                  <div>
                    <dt>Unidades</dt>
                    <dd>{fmtInt(r.unidades)}</dd>
                  </div>
                  <div>
                    <dt>
                      Llantas en piso <MtcTag />
                    </dt>
                    <dd>{fmtInt(r.llantasPiso)}</dd>
                  </div>
                  <div>
                    <dt>Participación</dt>
                    <dd>
                      <Participacion row={r} />
                    </dd>
                  </div>
                  <div>
                    <dt>Dueño</dt>
                    <dd>{owner(r)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>

          <nav className="pt-pager" aria-label="Páginas">
            <span className="pt-muted pt-small">
              {fmtInt(from)}–{fmtInt(to)} de {fmtInt(result.total)} · página {filters.page} de {pages}
            </span>
            <span className="pt-row">
              {filters.page > 1 && (
                <Link className="pt-btn pt-btn-sm" href={`/portal${filtersQuery(filters, { page: filters.page - 1 })}`}>
                  ← Anterior
                </Link>
              )}
              {filters.page < pages && (
                <Link className="pt-btn pt-btn-sm" href={`/portal${filtersQuery(filters, { page: filters.page + 1 })}`}>
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
