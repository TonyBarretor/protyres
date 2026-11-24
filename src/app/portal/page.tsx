/**
 * Prospectos: empresas del padrón MTC con búsqueda, filtros (por searchParams, en el servidor) y paginación.
 * Tabla en escritorio; tarjetas en el celular. Cada empresa muestra unidades, llantas en piso (MTC), medidas probables con
 * sus unidades (inferidas), participación y si es cliente, sin entrar a la ficha (corrida F, punto 2).
 * Corrida G: por defecto ordena por atractivo; filtro por nivel y, en cada empresa, su nivel (estimación) con la
 * explicación de una línea.
 * Corrida L: filtro por distrito (aparece con un departamento elegido; ?dist=<código INEI>) y en cada empresa su dirección
 * (la de operación manda; si no, el domicilio fiscal de SUNAT) con Cómo llegar y copiar, y el aviso de SUNAT.
 */
import Link from "next/link";
import { requireUser } from "@/lib/portal/auth/session";
import { ESTIMATE_NOTE, explainLine } from "@/lib/portal/scoring/explain";
import { getPortalStore } from "@/lib/portal/store";
import type { CompanyRow, MedidaCount, PortalUser } from "@/lib/portal/store/types";
import { PortalTimeoutError } from "@/lib/portal/ui/deadline";
import {
  BRAND_SHORTCUTS,
  FLEET_RANGES,
  NIVELES,
  ORDERS,
  PAGE_SIZE,
  SECTORS,
  filtersQuery,
  hasActiveFilters,
  isShortcutActive,
  pageCount,
  parseProspectFilters,
} from "@/lib/portal/ui/filters";
import { loadProspectos, type ProspectosData } from "@/lib/portal/ui/prospectos";
import { fmtInt, sectorLabel } from "@/lib/portal/ui/labels";
import { DemoTag, ExplainLine, InferidaTag, ManualTag, MTC_LEGEND, MtcTag, NivelBadge, TempChip } from "./_components/bits";
import { canCreateCompany } from "@/lib/portal/ui/empresa-nueva";
import { loadPortalConfig } from "@/lib/portal/config";
import { ubicacionEfectiva, ubicacionTexto } from "@/lib/portal/sunat/ubicacion";
import { direccionUi } from "@/lib/portal/ui/direccion";
import { titleCase } from "@/lib/portal/ui/match";
import { DIRECCION_LEGEND, DireccionLine, SunatAvisoTag } from "./_components/Direccion";

export const metadata = { title: "Prospectos · Portal 360 Tyres" };

/** Marcas que se listan como casillas (las de más vehículos); las elegidas fuera de esta lista se muestran igual. */
const MARCAS_VISIBLES = 40;

function ClienteTag({ row }: { row: CompanyRow }) {
  return row.esCliente ? <span className="pt-tag pt-tag-client">cliente</span> : <span className="pt-tag pt-tag-prospect">prospecto</span>;
}

/** Medidas probables (inferidas) con cuántas unidades las llevan; "—" si la flota no tiene medida estimada. */
function Medidas({ medidas }: { medidas: MedidaCount[] | undefined }) {
  if (!medidas?.length) return <span className="pt-muted">—</span>;
  return (
    <ul className="pt-medidas">
      {medidas.map((m) => (
        <li key={m.medida}>
          <span className="pt-mono">{m.medida}</span> <span className="pt-muted pt-small">· {fmtInt(m.unidades)} u.</span>
        </li>
      ))}
    </ul>
  );
}

/** Corrida L: la dirección de la fila (operación > fiscal) con Cómo llegar y copiar. */
function RowDireccion({ row }: { row: CompanyRow }) {
  const d = direccionUi(row, row.sunat, loadPortalConfig().sunat);
  return <DireccionLine d={d} lugar={ubicacionTexto(ubicacionEfectiva(row, row.sunat)) || undefined} localesHref={`/portal/empresas/${row.id}#direccion`} />;
}

function rowAviso(row: CompanyRow) {
  return direccionUi(row, row.sunat, loadPortalConfig().sunat).aviso;
}

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
  let data: ProspectosData;
  try {
    data = await loadProspectos(store, filters);
  } catch (e) {
    if (!(e instanceof PortalTimeoutError)) throw e;
    console.error(`[portal] ${e.message}`);
    return (
      <div className="pt-stack">
        <h1>Prospectos</h1>
        <p className="pt-card pt-error" role="alert">
          La búsqueda tardó demasiado y se canceló. Vuelve a intentarlo en un momento; si sigue igual, avisa al administrador.
        </p>
        <p>
          <Link className="pt-btn pt-btn-dark" href={`/portal${filtersQuery(filters)}`}>
            Reintentar
          </Link>
        </p>
      </div>
    );
  }
  const { result, marcas, departamentos, users, distritos } = data;
  const dists = distritos.filter((d): d is typeof d & { ubigeo: string } => !!d.ubigeo);
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
        {/* corrida J: empresas que no están en el padrón */}
        {canCreateCompany(user) && (
          <Link className="pt-btn pt-btn-primary pt-btn-sm" href="/portal/empresas/nueva">
            Agregar empresa
          </Link>
        )}
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
          {/* corrida L: el distrito depende del departamento (aparece al filtrar por uno) */}
          {filters.departamento && dists.length > 0 && (
            <label className="pt-field">
              Distrito
              <select name="dist" defaultValue={filters.distrito ?? ""}>
                <option value="">Todos</option>
                {dists.map((d) => (
                  <option key={d.ubigeo} value={d.ubigeo}>
                    {titleCase(d.distrito)} ({fmtInt(d.empresas)})
                  </option>
                ))}
              </select>
            </label>
          )}
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

        <fieldset className="pt-nivel-pick">
          <legend className="pt-small pt-muted">Nivel (estimación):</legend>
          {NIVELES.map((n) => (
            <label key={n}>
              <input type="checkbox" name="nivel" value={n} defaultChecked={filters.nivel.includes(n)} />
              {n}
            </label>
          ))}
        </fieldset>

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
        <strong>Nivel A, B, C:</strong> {ESTIMATE_NOTE} {MTC_LEGEND} Participación = neumáticos vendidos en los últimos 12 meses (al lado, llantas en piso).
        <br />
        {DIRECCION_LEGEND}
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
                  <th>Sector · Depto.</th>
                  <th className="pt-num">Unidades</th>
                  <th className="pt-num">
                    Llantas en piso <MtcTag />
                  </th>
                  <th>
                    Medidas probables <InferidaTag />
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
                      <ClienteTag row={r} /> {r.origen === "manual" && <ManualTag />} <SunatAvisoTag aviso={rowAviso(r)} />
                      <div className="pt-muted pt-small pt-mono">RUC {r.ruc}</div>
                      <div className="pt-nivel-line">
                        <NivelBadge nivel={r.nivel} />
                      </div>
                      <ExplainLine text={explainLine(r.scoreDetalle)} />
                      <RowDireccion row={r} />
                    </td>
                    <td>
                      {sectorLabel(r.sector)}
                      <div className="pt-muted pt-small">{r.departamento ?? "—"}</div>
                    </td>
                    <td className="pt-num">{fmtInt(r.unidades)}</td>
                    <td className="pt-num">{fmtInt(r.llantasPiso)}</td>
                    <td>
                      <Medidas medidas={r.medidas} />
                    </td>
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
                  RUC {r.ruc} · {sectorLabel(r.sector)} · {r.departamento ?? "—"} <ClienteTag row={r} /> {r.origen === "manual" && <ManualTag />}
                </div>
                <SunatAvisoTag aviso={rowAviso(r)} />
                <div>
                  <NivelBadge nivel={r.nivel} />
                  <ExplainLine text={explainLine(r.scoreDetalle)} />
                </div>
                <RowDireccion row={r} />
                <dl className="pt-kv">
                  <div>
                    <dt>Unidades</dt>
                    <dd>{fmtInt(r.unidades)}</dd>
                  </div>
                  <div>
                    <dt>
                      Llantas en piso {r.origen === "manual" ? <ManualTag /> : <MtcTag />}
                    </dt>
                    <dd>{fmtInt(r.llantasPiso)}</dd>
                  </div>
                  <div className="pt-kv-wide">
                    <dt>
                      Medidas probables <InferidaTag />
                    </dt>
                    <dd>
                      <Medidas medidas={r.medidas} />
                    </dd>
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
