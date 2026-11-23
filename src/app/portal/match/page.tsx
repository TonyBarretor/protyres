/**
 * Corrida K — Match Venta (/portal/match): a quién venderle el stock prioritario.
 *  - Vista 1 "¿Qué tengo que vender?": una tarjeta por producto prioritario (ordenadas por disponible) con el total
 *    arriba; desglose por almacén al tocar el detalle; avance; quitar prioridad y editar la aplicación; marcar otra
 *    llanta como prioridad (busca en el stock vivo solo cuando se abre esa sección).
 *  - "Ver por empresa": cada empresa una sola vez con todos sus matches.
 *  - Vista 2 "¿A quién se la ofrezco?" (?p=<código>): tarjetas de empresa con estado, match % estimado, desglose,
 *    insignias, ubicación, RUC, contacto y acciones; filtros en chips que quedan en la dirección; "Ver más" por tandas;
 *    "Clientes que ya compraron esta medida" aparte y sin porcentaje; marcar varias y "Planificar visitas".
 * Todo lee lo guardado por el cálculo por lotes (src/lib/portal/match): abrir la página no recalcula el cruce.
 * Vendedor, supervisor y admin (el técnico recibe "no encontrada").
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { canSeeAll, requireUser } from "@/lib/portal/auth/session";
import { botWhatsapp } from "@/lib/portal/auth/access";
import { loadPortalConfig } from "@/lib/portal/config";
import { loadMatchStock, matchesByCompany, matchesForProduct, matchOverview, productLabel, type MatchCard, type MatchProductCard } from "@/lib/portal/match";
import { getPortalStore } from "@/lib/portal/store";
import type { Contact, PortalStore, PortalUser } from "@/lib/portal/store/types";
import { fmtInt } from "@/lib/portal/ui/labels";
import {
  canEditMatchProduct,
  canUseMatch,
  filterChips,
  hasFilters,
  MATCH_DEPARTAMENTOS,
  MATCH_PAGE,
  MATCH_MAX_SHOWN,
  MATCH_PLAN_PATH,
  MAX_APLICACION,
  MAX_PLAN,
  matchHref,
  parseMatchParams,
  progressLine,
  splitNotes,
  type MatchParams,
} from "@/lib/portal/ui/match";
import { loadMatchProgress } from "@/lib/portal/ui/match-progress";
import { formatLimaDateTime } from "@/lib/portal/ui/time";
import { ownStockSource } from "@/lib/store/own-stock";
import type { MatchProgressRow } from "@/lib/portal/match";
import { Flash } from "../_components/bits";
import { saveAplicacion, togglePriority } from "./actions";
import { CompanyGroupCard, CompanyMatchCard, PLAN_FORM, SalesOnlyCard } from "./cards";
import { AutoSubmitSelect, PlanBar } from "./client";
import "./match.css";

export const metadata = { title: "Match Venta · Portal 360 Tyres" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function contactsOf(store: PortalStore, ids: (number | null)[]): Promise<Map<number, Contact[]>> {
  const uniq = [...new Set(ids.filter((x): x is number => x !== null))];
  const lists = await Promise.all(uniq.map((id) => store.listContacts(id)));
  return new Map(uniq.map((id, i) => [id, lists[i]]));
}

async function ownerNames(store: PortalStore, user: PortalUser): Promise<Map<number, string>> {
  if (!canSeeAll(user)) return new Map();
  return new Map((await store.listUsers()).map((u) => [u.id, u.nombre]));
}

function Head({ p, aviso, error, sub }: { p: MatchParams; aviso?: string; error?: string; sub: string }) {
  return (
    <>
      <div className="pt-page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1 style={{ marginBottom: "0.15rem" }}>Match Venta</h1>
          <p className="pt-muted pt-small" style={{ margin: 0 }}>
            {sub}
          </p>
        </div>
        {!p.code && (
          <nav className="pt-shortcuts" aria-label="Vista">
            <Link href={matchHref(p, { vista: "productos" })} aria-current={p.vista === "productos" ? "page" : undefined}>
              Por producto
            </Link>
            <Link href={matchHref(p, { vista: "empresas" })} aria-current={p.vista === "empresas" ? "page" : undefined}>
              Ver por empresa
            </Link>
          </nav>
        )}
      </div>
      <Flash aviso={aviso} error={error} />
    </>
  );
}

function Chips({ p, cortes }: { p: MatchParams; cortes: number[] }) {
  const chips = filterChips(p, cortes);
  const base = new URLSearchParams(matchHref(p, { filters: { ...p.filters, departamento: undefined, limaCallao: undefined } }).split("?")[1] ?? "");
  const hidden = Object.fromEntries([...base].filter(([k]) => k !== "n"));
  const [first, rest] = [chips.slice(0, 5), chips.slice(5)];
  const chip = (c: (typeof chips)[number]) => (
    <Link key={c.id} href={c.href} className={`mv-chip${c.active ? " mv-chip-on" : ""}`} aria-pressed={c.active} scroll={false}>
      {c.active ? "✓ " : ""}
      {c.label}
    </Link>
  );
  return (
    <div className="mv-chips" role="group" aria-label="Filtros">
      {first.map(chip)}
      <AutoSubmitSelect
        name="dep"
        value={p.filters.departamento ?? ""}
        label="Departamento"
        hidden={hidden}
        options={[{ value: "", label: "Departamento: todos" }, ...MATCH_DEPARTAMENTOS.map((d) => ({ value: d, label: d.charAt(0) + d.slice(1).toLowerCase() }))]}
      />
      {rest.map(chip)}
      {hasFilters(p.filters) && (
        <Link href={matchHref(p, { filters: {} })} className="mv-chip mv-chip-clear" scroll={false}>
          Quitar filtros
        </Link>
      )}
    </div>
  );
}

function MoreLink({ p, shown, total }: { p: MatchParams; shown: number; total: number }) {
  if (shown >= total) return null;
  const next = Math.min(MATCH_MAX_SHOWN, p.n + MATCH_PAGE);
  if (next <= p.n) return <p className="pt-small pt-muted">Mostrando las primeras {fmtInt(shown)} de {fmtInt(total)}. Usa los filtros para acotar la lista.</p>;
  return (
    <div className="mv-more-wrap">
      <Link className="pt-btn" href={matchHref(p, { n: next }, `#tanda-${p.n}`)} scroll={false}>
        Ver {fmtInt(Math.min(MATCH_PAGE, total - shown))} más
      </Link>
      <span className="pt-small pt-muted">
        {fmtInt(shown)} de {fmtInt(total)}
      </span>
    </div>
  );
}

function PlanForm({ back }: { back: string }) {
  return (
    <form id={PLAN_FORM} method="get" action={MATCH_PLAN_PATH} hidden>
      <input type="hidden" name="volver" value={back} />
    </form>
  );
}

// ── Vista 1 ──

function ProductCard({ prod, progress, user, back }: { prod: MatchProductCard; progress: MatchProgressRow | undefined; user: PortalUser; back: string }) {
  const notes = splitNotes(prod.notas);
  const edit = canEditMatchProduct(user);
  const alm = Object.entries(prod.almacenes);
  return (
    <li className="pt-card mv-prod" id={`prod-${prod.code}`}>
      <Link className="mv-prod-main" href={`/portal/match?p=${prod.code}`}>
        <div className="mv-prod-head">
          <span className="mv-medida">{prod.medida}</span>
          <span className="mv-disp">
            <b>{fmtInt(prod.disponible)}</b> en Lima
          </span>
        </div>
        <div className="mv-prod-name">
          {prod.nombre} <span className="pt-muted pt-small">{prod.code}</span>
        </div>
        {prod.aplicacion && <div className="mv-aplic">{prod.aplicacion}</div>}
        <div className="mv-prod-count">
          <b>{fmtInt(prod.empresas)} empresas</b> hacen match
          {prod.yaCompraron > 0 && (
            <span>
              {" "}
              ({fmtInt(prod.yaCompraron)} ya te {prod.yaCompraron === 1 ? "compró" : "compraron"})
            </span>
          )}
        </div>
        <span className="mv-cta">¿A quién se la ofrezco? →</span>
      </Link>
      {notes.aviso.map((n) => (
        <p key={n} className="mv-note">
          {n}
        </p>
      ))}
      {progress && <p className="pt-small mv-progress">Avance: {progressLine(progress)}</p>}
      <details className="mv-detail">
        <summary>Detalle del stock</summary>
        <dl className="pt-kv" style={{ marginTop: "0.4rem" }}>
          {alm.map(([w, q]) => (
            <div key={w}>
              <dt>{w}</dt>
              <dd>{fmtInt(q)}</dd>
            </div>
          ))}
          <div>
            <dt>Reserva</dt>
            <dd>−{fmtInt(prod.reserva)}</dd>
          </div>
          <div>
            <dt>En pedidos</dt>
            <dd>−{fmtInt(prod.enPedidos)}</dd>
          </div>
          <div className="pt-kv-wide">
            <dt>Disponible en Lima</dt>
            <dd>
              <b>{fmtInt(prod.disponible)}</b>
            </dd>
          </div>
        </dl>
        {notes.tecnicas.map((n) => (
          <p key={n} className="pt-small pt-muted" style={{ marginTop: "0.4rem" }}>
            {n}
          </p>
        ))}
      </details>
      {edit && (
        <details className="mv-detail">
          <summary>Aplicación y prioridad</summary>
          <form action={saveAplicacion} className="mv-panel">
            <input type="hidden" name="code" value={prod.code} />
            <input type="hidden" name="volver" value={`${back}#prod-${prod.code}`} />
            <label className="pt-field">
              Aplicación (afina a quién se le ofrece)
              <input type="text" name="aplicacion" maxLength={MAX_APLICACION} defaultValue={prod.aplicacion ?? ""} placeholder="Delantera regional" />
            </label>
            <button type="submit" className="pt-btn pt-btn-sm pt-btn-dark">
              Guardar aplicación
            </button>
          </form>
          <form action={togglePriority} className="mv-panel">
            <input type="hidden" name="code" value={prod.code} />
            <input type="hidden" name="on" value="0" />
            <input type="hidden" name="volver" value={back} />
            <button type="submit" className="pt-btn pt-btn-sm pt-btn-danger">
              Quitar prioridad
            </button>
          </form>
        </details>
      )}
    </li>
  );
}

async function AddPriority({ p, store, priorityCodes }: { p: MatchParams; store: PortalStore; priorityCodes: Set<string> }) {
  if (!p.agregar) {
    return (
      <p id="agregar">
        <Link className="pt-btn" href={matchHref(p, { agregar: true }, "#agregar")} scroll={false}>
          ＋ Marcar otra llanta como prioridad
        </Link>
      </p>
    );
  }
  const { stock } = await loadMatchStock({ store, prices: ownStockSource() });
  const q = p.buscar
    .toUpperCase()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean);
  const rows = stock
    .filter((s) => !priorityCodes.has(s.code) && s.available > 0)
    .filter((s) => {
      const hay = `${s.code} ${s.size} ${s.sizeDisplay} ${s.brand} ${s.model}`.toUpperCase();
      return q.every((w) => hay.includes(w));
    })
    .sort((a, b) => b.available - a.available || a.code.localeCompare(b.code));
  const shown = rows.slice(0, 15);
  return (
    <section className="pt-card" id="agregar" aria-labelledby="agregar-title">
      <h2 id="agregar-title">Marcar otra llanta como prioridad</h2>
      <form method="get" action="/portal/match#agregar" className="pt-row" style={{ flexWrap: "nowrap" }}>
        <input type="hidden" name="agregar" value="1" />
        <label style={{ flex: 1 }}>
          <span className="pt-sr-only">Buscar en el stock</span>
          <input type="search" name="buscar" defaultValue={p.buscar} maxLength={60} placeholder="Medida, modelo o código: 295/80 flama" />
        </label>
        <button type="submit" className="pt-btn pt-btn-dark">
          Buscar
        </button>
      </form>
      {!stock.length ? (
        <p className="pt-muted" style={{ marginTop: "0.6rem" }}>
          No hay stock propio cargado. Carga el reporte de stock de Odoo (por WhatsApp o con el administrador) y vuelve aquí.
        </p>
      ) : !shown.length ? (
        <p className="pt-muted" style={{ marginTop: "0.6rem" }}>
          {p.buscar ? `Ninguna llanta con stock coincide con «${p.buscar}». Prueba solo con la medida (295/80) o el modelo.` : "Todas las llantas con stock ya son prioridad."}
        </p>
      ) : (
        <ul className="pt-list" style={{ marginTop: "0.8rem" }}>
          {shown.map((s) => (
            <li key={s.code} className="mv-add-row">
              <div style={{ minWidth: 0 }}>
                <strong>{productLabel(s)}</strong>
                <div className="pt-small pt-muted">
                  {s.code} · {fmtInt(s.available)} disponibles en Lima
                </div>
              </div>
              <form action={togglePriority}>
                <input type="hidden" name="code" value={s.code} />
                <input type="hidden" name="on" value="1" />
                <input type="hidden" name="volver" value={`/portal/match#prod-${s.code}`} />
                <button type="submit" className="pt-btn pt-btn-sm pt-btn-primary">
                  Marcar prioridad
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      {rows.length > shown.length && <p className="pt-small pt-muted">Hay {fmtInt(rows.length - shown.length)} más: escribe la medida o el modelo para encontrarla.</p>}
    </section>
  );
}

async function Overview({ p, store, user, flash }: { p: MatchParams; store: PortalStore; user: PortalUser; flash: { aviso?: string; error?: string } }) {
  const [ov, progress] = await Promise.all([matchOverview(store, user), loadMatchProgress(store).catch(() => [] as MatchProgressRow[])]);
  const prog = new Map(progress.map((r) => [r.code, r]));
  const back = matchHref(p, { agregar: false, buscar: "" });
  return (
    <div className="pt-stack mv-page">
      <Head p={p} {...flash} sub="¿Qué tengo que vender?" />
      {ov.vacio ? (
        <p className="pt-notice">{ov.vacio}</p>
      ) : (
        <>
          <div className="mv-total">
            <span>
              <b>{fmtInt(ov.totalLlantas)}</b> llantas prioritarias · <b>{fmtInt(ov.empresas)}</b> empresas
            </span>
            {ov.calculadoAt && <span className="pt-small pt-muted">actualizado {formatLimaDateTime(ov.calculadoAt)}</span>}
          </div>
          <p className="pt-small pt-muted" style={{ margin: 0 }}>
            Toca un producto para ver a quién ofrecérselo. El match es una estimación: la medida de cada flota se deduce del tipo de vehículo del padrón del MTC.
          </p>
          <ul className="mv-prods">
            {ov.productos.map((prod) => (
              <ProductCard key={prod.code} prod={prod} progress={prog.get(prod.code)} user={user} back={back} />
            ))}
          </ul>
        </>
      )}
      {canEditMatchProduct(user) && <AddPriority p={p} store={store} priorityCodes={new Set(ov.productos.map((x) => x.code))} />}
    </div>
  );
}

// ── Ver por empresa ──

async function ByCompany({ p, store, user, flash, now }: { p: MatchParams; store: PortalStore; user: PortalUser; flash: { aviso?: string; error?: string }; now: Date }) {
  const cfg = loadPortalConfig().match;
  const [ov, groups, owners] = await Promise.all([matchOverview(store, user, { cfg }), matchesByCompany(store, user, p.filters, { cfg, limit: p.n, now }), ownerNames(store, user)]);
  const contacts = await contactsOf(store, groups.map((g) => g.companyId));
  const products = new Map(ov.productos.map((x) => [x.code, x]));
  const total = groups.total ?? groups.length;
  const back = matchHref(p);
  const bot = botWhatsapp();
  return (
    <div className="pt-stack mv-page">
      <Head p={p} {...flash} sub="Cada empresa una sola vez, con todos los productos prioritarios que le sirven." />
      <Chips p={p} cortes={cfg.cortesFlota} />
      {ov.vacio ? (
        <p className="pt-notice">{ov.vacio}</p>
      ) : !groups.length ? (
        <div className="pt-notice">
          {hasFilters(p.filters) ? "Ninguna empresa cumple estos filtros. " : "Ninguna empresa hace match con los productos prioritarios. "}
          {hasFilters(p.filters) ? <Link href={matchHref(p, { filters: {} })}>Quitar filtros</Link> : "Marca otro producto como prioridad o revisa por producto."}
        </div>
      ) : (
        <>
          <p className="pt-small pt-muted" style={{ margin: 0 }}>
            <b>{fmtInt(total)}</b> empresas · primero las de mayor match (cada producto adicional las sube)
          </p>
          <PlanForm back={back} />
          <ul className="mv-list">
            {groups.map((g, i) => (
              <CompanyGroupCard
                key={g.companyId}
                matches={g.matches}
                products={products}
                viewer={user}
                contacts={contacts.get(g.companyId) ?? []}
                back={back}
                bot={bot}
                owner={g.matches[0].ownerUserId !== null ? (owners.get(g.matches[0].ownerUserId) ?? null) : null}
                now={now}
                anchor={i > 0 && i === p.n - MATCH_PAGE ? `tanda-${i}` : undefined}
              />
            ))}
          </ul>
          <MoreLink p={p} shown={groups.length} total={total} />
          <PlanBar formId={PLAN_FORM} max={MAX_PLAN} />
        </>
      )}
    </div>
  );
}

// ── Vista 2 ──

async function ProductView({ p, store, user, flash, now }: { p: MatchParams; store: PortalStore; user: PortalUser; flash: { aviso?: string; error?: string }; now: Date }) {
  const cfg = loadPortalConfig().match;
  const [r, owners] = await Promise.all([matchesForProduct(store, user, p.code!, p.filters, { cfg, limit: p.n, now }), ownerNames(store, user)]);
  const prod = r.product;
  if (!prod) {
    return (
      <div className="pt-stack mv-page">
        <Link href="/portal/match" className="pt-small pt-muted">
          ← Productos prioritarios
        </Link>
        <Head p={p} {...flash} sub="¿A quién se la ofrezco?" />
        <p className="pt-notice">{r.vacio}</p>
      </div>
    );
  }
  const contacts = await contactsOf(store, r.empresas.map((c) => c.companyId));
  const notes = splitNotes(r.notas);
  const back = matchHref(p);
  const bot = botWhatsapp();
  const owner = (c: MatchCard) => (c.ownerUserId !== null ? (owners.get(c.ownerUserId) ?? null) : null);
  return (
    <div className="pt-stack mv-page">
      <Link href={`/portal/match#prod-${prod.code}`} className="pt-small pt-muted">
        ← Productos prioritarios
      </Link>
      <Flash {...flash} />
      <section className="mv-prod-hero" aria-label="Producto">
        <p className="pt-muted pt-small" style={{ margin: 0 }}>
          ¿A quién se la ofrezco?
        </p>
        <div className="mv-prod-head">
          <h1 className="mv-medida" style={{ margin: 0 }}>
            {prod.medida}
          </h1>
          <span className="mv-disp">
            <b>{fmtInt(prod.disponible)}</b> en Lima
          </span>
        </div>
        <div className="mv-prod-name">
          {prod.nombre} <span className="pt-muted pt-small">{prod.code}</span>
          {prod.aplicacion && <span className="mv-aplic"> · {prod.aplicacion}</span>}
        </div>
        <div className="mv-prod-count">
          <b>{fmtInt(prod.empresas)} empresas</b> hacen match
          {prod.yaCompraron > 0 && ` (${fmtInt(prod.yaCompraron)} ya te ${prod.yaCompraron === 1 ? "compró" : "compraron"})`}
        </div>
        {notes.aviso.map((n) => (
          <p key={n} className="mv-note">
            {n}
          </p>
        ))}
      </section>
      <Chips p={p} cortes={cfg.cortesFlota} />
      {r.vacio ? (
        <div className="pt-notice">
          <p style={{ margin: 0 }}>{r.vacio}</p>
          {hasFilters(p.filters) && (
            <p style={{ margin: "0.4rem 0 0" }}>
              <Link href={matchHref(p, { filters: {} })}>Quitar todos los filtros</Link>
            </p>
          )}
        </div>
      ) : (
        <>
          {r.empresas.length > 0 ? (
            <>
              <p className="pt-small pt-muted" style={{ margin: 0 }}>
                <b>{fmtInt(r.total)}</b> {r.total === 1 ? "empresa" : "empresas"} · de mayor a menor match
                {r.ocultasPorFiltro > 0 && ` · ${fmtInt(r.ocultasPorFiltro)} fuera por los filtros`}
              </p>
              <PlanForm back={back} />
              <ul className="mv-list">
                {r.empresas.map((c, i) => (
                  <CompanyMatchCard
                    key={c.id}
                    c={c}
                    product={prod}
                    viewer={user}
                    contacts={c.companyId !== null ? (contacts.get(c.companyId) ?? []) : []}
                    back={back}
                    bot={bot}
                    owner={owner(c)}
                    now={now}
                    anchor={i > 0 && i === p.n - MATCH_PAGE ? `tanda-${i}` : undefined}
                  />
                ))}
              </ul>
              <MoreLink p={p} shown={r.empresas.length} total={r.total} />
              <PlanBar formId={PLAN_FORM} max={MAX_PLAN} />
            </>
          ) : (
            <p className="pt-notice">Ninguna flota del padrón hace match con estos filtros; abajo, quienes ya te compraron esta medida.</p>
          )}
          {r.soloVentas.length > 0 && (
            <section aria-labelledby="solo-ventas-title" className="pt-stack mv-page" style={{ gap: "0.6rem" }}>
              <div>
                <h2 id="solo-ventas-title" style={{ marginBottom: "0.2rem" }}>
                  Clientes que ya compraron esta medida
                </h2>
                <p className="pt-small pt-muted" style={{ margin: 0 }}>
                  Te compraron {prod.medida} pero no están en el padrón del MTC (no hay datos de su flota), así que no llevan porcentaje.
                </p>
              </div>
              <ul className="mv-list">
                {r.soloVentas.map((c) => (
                  <SalesOnlyCard key={c.id} c={c} product={prod} viewer={user} back={back} bot={bot} now={now} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {notes.tecnicas.length > 0 && (
        <details className="pt-small pt-muted">
          <summary>Medidas que requieren revisión técnica</summary>
          {notes.tecnicas.map((n) => (
            <p key={n} style={{ margin: "0.3rem 0 0" }}>
              {n}
            </p>
          ))}
        </details>
      )}
    </div>
  );
}

export default async function MatchPage({ searchParams }: Props) {
  const user = await requireUser();
  if (!canUseMatch(user)) notFound();
  const sp = await searchParams;
  const p = parseMatchParams(sp);
  const store = await getPortalStore();
  const flash = { aviso: str(sp.aviso), error: str(sp.error) };
  const now = new Date();
  if (p.code) return <ProductView p={p} store={store} user={user} flash={flash} now={now} />;
  if (p.vista === "empresas") return <ByCompany p={p} store={store} user={user} flash={flash} now={now} />;
  return <Overview p={p} store={store} user={user} flash={flash} />;
}
