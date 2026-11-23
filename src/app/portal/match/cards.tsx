/**
 * Tarjetas de Match Venta (componentes de servidor): empresa de un producto (Vista 2), empresa con todos sus matches
 * ("Ver por empresa") y producto prioritario (Vista 1). Las acciones son formularios con server actions o enlaces:
 * funcionan sin JavaScript (salvo "Copiar").
 */
import Link from "next/link";
import type { MatchCard, MatchProductCard } from "@/lib/portal/match";
import { directionsLink, locationText } from "@/lib/portal/match";
import { canEditDireccion } from "@/lib/portal/match/company";
import type { Contact, PortalUser } from "@/lib/portal/store/types";
import { botTextUrl, cardActions, phoneLinks, quoteText, type MatchActionId } from "@/lib/portal/ui/match";
import { limaDateKey } from "@/lib/portal/ui/time";
import { assignMatch, saveDireccion, scheduleMatch } from "./actions";
import { CopyButton } from "./client";

type Viewer = Pick<PortalUser, "id" | "rol" | "activo" | "nombre">;
type ProductRef = Pick<MatchProductCard, "code" | "nombre" | "medida" | "disponible" | "etiqueta">;

export const PLAN_FORM = "plan-form";

const ESTADO_CLASS: Record<string, string> = { Cliente: "mv-st-cliente", Prospecto: "mv-st-prospecto", Tuya: "mv-st-tuya", "Sin dueño": "mv-st-libre" };

export function EstadoTag({ estado, owner }: { estado: string; owner?: string | null }) {
  return (
    <span className={`mv-estado ${ESTADO_CLASS[estado] ?? ""}`}>
      {estado}
      {owner ? ` · de ${owner}` : ""}
    </span>
  );
}

/** Porcentaje grande con su barra y "estimado" (la medida de la flota se infiere por tipo de vehículo). */
export function MatchPct({ pct, small = false }: { pct: number; small?: boolean }) {
  return (
    <div className={`mv-pct${small ? " mv-pct-sm" : ""}`} title="Estimado: la medida de cada flota se infiere por tipo de vehículo; no es un dato confirmado.">
      <div className="mv-pct-head">
        <span className="mv-pct-num">{pct}%</span>
        <span className="mv-badge mv-badge-est">estimado · flota</span>
      </div>
      <div className="mv-bar" role="img" aria-label={`Match estimado ${pct}%`}>
        <span style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
      </div>
    </div>
  );
}

/** Insignias: compra real (ventas), migración posible, crédito y el "podría llevar". */
export function MatchBadges({ c }: { c: MatchCard }) {
  return (
    <>
      {c.compraTexto && (
        <p className="mv-real">
          <span className="mv-badge mv-badge-real">dato real · ventas</span> {c.compraTexto}
        </p>
      )}
      {c.migracionTexto && (
        <p className="mv-migra">
          <span className="mv-badge mv-badge-migra">migración posible</span> {c.migracionTexto.replace(/^Migración posible /, "")}
        </p>
      )}
      {c.avisoCredito && <p className="mv-credito">{c.avisoCredito}</p>}
    </>
  );
}

function Ruc({ ruc }: { ruc: string }) {
  return (
    <span className="mv-ruc">
      RUC <span className="pt-mono">{ruc}</span> <CopyButton text={ruc} label="Copiar" className="mv-copy" />
    </span>
  );
}

function Location({ c, viewer, back }: { c: MatchCard; viewer: Viewer; back: string }) {
  const loc = locationText(c);
  const canAdd = c.companyId !== null && canEditDireccion(viewer, { ownerUserId: c.ownerUserId });
  return (
    <div className="mv-line">
      <span aria-hidden="true">📍</span>
      <div style={{ minWidth: 0 }}>
        {loc || "Ubicación no registrada"}
        {c.direccion ? <div className="pt-small">{c.direccion}</div> : null}
        {canAdd && (
          <details className="mv-inline">
            <summary className="mv-link">{c.direccion ? "Cambiar dirección" : "Agregar dirección"}</summary>
            <form action={saveDireccion} className="mv-panel">
              <input type="hidden" name="companyId" value={c.companyId!} />
              <input type="hidden" name="volver" value={back} />
              <label className="pt-field">
                Dirección (calle, número, referencia)
                <input type="text" name="direccion" maxLength={200} defaultValue={c.direccion ?? ""} placeholder="Av. Nicolás Ayllón 1234, Ate" />
              </label>
              <button type="submit" className="pt-btn pt-btn-sm pt-btn-dark">
                Guardar dirección
              </button>
            </form>
          </details>
        )}
      </div>
    </div>
  );
}

function ContactLine({ c, contacts }: { c: MatchCard; contacts: Contact[] }) {
  if (c.companyId === null) return null;
  const k = contacts.find((x) => x.telefono) ?? contacts[0];
  if (!k) {
    return (
      <div className="mv-line pt-muted">
        <span aria-hidden="true">👤</span>
        <span>
          Sin contacto ·{" "}
          <Link className="mv-link" href={`/portal/empresas/${c.companyId}#contactos-title`}>
            Agregar contacto
          </Link>
        </span>
      </div>
    );
  }
  const ph = phoneLinks(k.telefono);
  return (
    <div className="mv-line">
      <span aria-hidden="true">👤</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div>
          {k.nombre}
          {k.cargo ? <span className="pt-muted">, {k.cargo}</span> : null}
          {contacts.length > 1 && <span className="pt-muted pt-small"> (+{contacts.length - 1})</span>}
        </div>
        {ph ? (
          <div className="pt-row" style={{ gap: "0.35rem", marginTop: "0.25rem" }}>
            <a className="pt-btn pt-btn-sm" href={ph.tel}>
              📞 Llamar
            </a>
            {ph.wa && (
              <a className="pt-btn pt-btn-sm" href={ph.wa} target="_blank" rel="noopener noreferrer">
                WhatsApp
              </a>
            )}
          </div>
        ) : (
          <Link className="mv-link pt-small" href={`/portal/empresas/${c.companyId}#contactos-title`}>
            Agregar teléfono
          </Link>
        )}
      </div>
    </div>
  );
}

export function ScheduleForm({ companyId, products, back, now }: { companyId: number; products: ProductRef[]; back: string; now: Date }) {
  return (
    <form action={scheduleMatch} className="mv-panel mv-sched">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="volver" value={back} />
      {products.length === 1 ? (
        <input type="hidden" name="code" value={products[0].code} />
      ) : (
        <label className="pt-field">
          Para ofrecer
          <select name="code" defaultValue={products[0].code}>
            {products.map((p) => (
              <option key={p.code} value={p.code}>
                {p.etiqueta}
              </option>
            ))}
          </select>
        </label>
      )}
      <fieldset className="mv-days">
        <legend className="pt-small pt-muted">Día</legend>
        <label>
          <input type="radio" name="dia" value="hoy" /> Hoy
        </label>
        <label>
          <input type="radio" name="dia" value="manana" defaultChecked /> Mañana
        </label>
        <label>
          <input type="radio" name="dia" value="otra" /> Otra fecha
        </label>
      </fieldset>
      <label className="pt-field mv-fecha">
        Fecha
        <input type="date" name="fecha" min={limaDateKey(now)} />
      </label>
      <label className="pt-field">
        Hora (opcional; sin hora, 9:00)
        <input type="time" name="hora" step={900} />
      </label>
      <button type="submit" className="pt-btn pt-btn-primary">
        Agendar visita
      </button>
    </form>
  );
}

function QuotePanel({ text, bot }: { text: string; bot: string }) {
  const url = botTextUrl(bot, text);
  return (
    <div className="mv-panel">
      <p className="pt-small pt-muted" style={{ margin: 0 }}>
        Escríbele esto al bot para cotizar (el precio lo pone el cotizador):
      </p>
      <p className="mv-quote">{text}</p>
      <div className="pt-row" style={{ gap: "0.4rem" }}>
        <CopyButton text={text} label="Copiar texto" />
        {url && (
          <a className="pt-btn pt-btn-sm pt-btn-primary" href={url} target="_blank" rel="noopener noreferrer">
            Abrir el bot
          </a>
        )}
      </div>
    </div>
  );
}

interface ActionCtx {
  c: MatchCard;
  products: ProductRef[];
  back: string;
  bot: string;
  now: Date;
}

function Action({ id, ctx, menu }: { id: MatchActionId; ctx: ActionCtx; menu: boolean }) {
  const { c, products, back, bot } = ctx;
  const btn = (extra = "") => `pt-btn pt-btn-sm${extra}${menu ? " mv-menu-item" : ""}`;
  switch (id) {
    case "asignar":
      return (
        <form action={assignMatch} className={menu ? "mv-menu-form" : undefined}>
          <input type="hidden" name="companyId" value={c.companyId!} />
          <input type="hidden" name="volver" value={back} />
          <button type="submit" className={btn(" pt-btn-dark")}>
            Asignármela
          </button>
        </form>
      );
    case "agendar":
      return (
        <details className="mv-act">
          <summary className={btn(" pt-btn-primary")}>Agendar visita</summary>
          <ScheduleForm companyId={c.companyId!} products={products} back={back} now={ctx.now} />
        </details>
      );
    case "cotizar":
      return (
        <details className="mv-act">
          <summary className={btn()}>Cotizar</summary>
          <QuotePanel text={quoteText(products[0], c)} bot={bot} />
        </details>
      );
    case "llegar": {
      const d = directionsLink(c);
      return (
        <a className={btn()} href={d.url} target="_blank" rel="noopener noreferrer" title={d.aproximada ? "Sin dirección registrada: busca por razón social y distrito en el mapa (aproximado)." : "Abre el mapa con la dirección."}>
          Cómo llegar{d.aproximada ? " (aprox.)" : ""}
        </a>
      );
    }
    case "ficha":
      return (
        <Link className={btn()} href={`/portal/empresas/${c.companyId}`}>
          Ver ficha
        </Link>
      );
    case "ventas":
      return (
        <Link className={btn()} href={`/portal/ventas/lista?q=${c.ruc}`}>
          Ver sus compras
        </Link>
      );
  }
}

function Actions({ viewer, ctx }: { viewer: Viewer; ctx: ActionCtx }) {
  const a = cardActions(ctx.c, viewer);
  return (
    <div className="mv-actions">
      {a.visibles.map((id) => (
        <Action key={id} id={id} ctx={ctx} menu={false} />
      ))}
      {a.mas.length > 0 && (
        <details className="mv-act mv-more">
          <summary className="pt-btn pt-btn-sm">Más ▾</summary>
          <div className="mv-menu">
            {a.mas.map((id) => (
              <Action key={id} id={id} ctx={ctx} menu />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function PlanCheck({ c, code }: { c: MatchCard; code: string }) {
  if (c.companyId === null) return null;
  return (
    <label className="mv-check">
      <input type="checkbox" name="v" value={`${c.companyId}:${code}`} form={PLAN_FORM} />
      <span>Planificar</span>
    </label>
  );
}

/** Vista 2: una empresa para un producto. */
export function CompanyMatchCard({
  c,
  product,
  viewer,
  contacts,
  back,
  bot,
  owner,
  now,
  anchor,
}: {
  c: MatchCard;
  product: ProductRef;
  viewer: Viewer;
  contacts: Contact[];
  back: string;
  bot: string;
  owner: string | null;
  now: Date;
  anchor?: string;
}) {
  const id = `e-${c.companyId ?? c.ruc}`;
  const back1 = `${back}#${id}`;
  return (
    <li className="pt-card mv-card" id={id}>
      {anchor && <span id={anchor} className="mv-anchor" />}
      <div className="mv-card-top">
        <EstadoTag estado={c.estado} owner={c.estado === "Prospecto" ? owner : null} />
        {c.excluida && <span className="pt-tag pt-tag-mtc">{c.excluida === "estado" ? "Estado" : "Leasing"}</span>}
        <PlanCheck c={c} code={product.code} />
      </div>
      <h3 className="mv-name">{c.companyId !== null ? <Link href={`/portal/empresas/${c.companyId}`}>{c.razonSocial}</Link> : c.razonSocial}</h3>
      <Ruc ruc={c.ruc} />
      {c.pct !== null && <MatchPct pct={c.pct} />}
      <p className="mv-desglose">{c.detalle.desglose}</p>
      <MatchBadges c={c} />
      {(c.podriaLlevarTexto || c.tamanoTexto) && <p className="pt-small pt-muted mv-meta">{[c.podriaLlevarTexto, c.tamanoTexto].filter(Boolean).join(" · ")}</p>}
      <Location c={c} viewer={viewer} back={back1} />
      <ContactLine c={c} contacts={contacts} />
      <Actions viewer={viewer} ctx={{ c, products: [product], back: back1, bot, now }} />
    </li>
  );
}

/** "Ver por empresa": los dos mejores matches a la vista; el resto, al tocar (una empresa con 7 productos ocupaba media pantalla). */
const GROUP_SHOWN = 2;

function SubMatch({ m, p }: { m: MatchCard; p: ProductRef | undefined }) {
  return (
    <li>
      <div className="mv-sub-head">
        <Link className="mv-sub-prod" href={`/portal/match?p=${m.productCode}`}>
          {p?.etiqueta ?? m.productCode}
        </Link>
        {m.pct !== null && <MatchPct pct={m.pct} small />}
      </div>
      <p className="mv-desglose">{m.detalle.desglose}</p>
      <MatchBadges c={{ ...m, avisoCredito: null }} />
      {m.podriaLlevarTexto && <p className="pt-small pt-muted mv-meta">{m.podriaLlevarTexto}</p>}
    </li>
  );
}

/** "Ver por empresa": una empresa con todos sus matches. */
export function CompanyGroupCard({
  matches,
  products,
  viewer,
  contacts,
  back,
  bot,
  owner,
  now,
  anchor,
}: {
  matches: MatchCard[];
  products: Map<string, ProductRef>;
  viewer: Viewer;
  contacts: Contact[];
  back: string;
  bot: string;
  owner: string | null;
  now: Date;
  anchor?: string;
}) {
  const c = matches[0];
  const id = `e-${c.companyId}`;
  const back1 = `${back}#${id}`;
  const refs = matches.map((m) => products.get(m.productCode)).filter((p): p is ProductRef => !!p);
  return (
    <li className="pt-card mv-card" id={id}>
      {anchor && <span id={anchor} className="mv-anchor" />}
      <div className="mv-card-top">
        <EstadoTag estado={c.estado} owner={c.estado === "Prospecto" ? owner : null} />
        {c.excluida && <span className="pt-tag pt-tag-mtc">{c.excluida === "estado" ? "Estado" : "Leasing"}</span>}
        {refs[0] && <PlanCheck c={c} code={refs[0].code} />}
      </div>
      <h3 className="mv-name">
        <Link href={`/portal/empresas/${c.companyId}`}>{c.razonSocial}</Link>
      </h3>
      <Ruc ruc={c.ruc} />
      <p className="pt-small pt-muted mv-meta">
        {matches.length === 1 ? "1 producto prioritario le sirve" : `${matches.length} productos prioritarios le sirven`}
        {c.tamanoTexto ? ` · ${c.tamanoTexto}` : ""}
      </p>
      <ul className="mv-sublist">
        {matches.slice(0, GROUP_SHOWN).map((m) => (
          <SubMatch key={m.id} m={m} p={products.get(m.productCode)} />
        ))}
      </ul>
      {matches.length > GROUP_SHOWN && (
        <details className="mv-detail">
          <summary>
            Ver {matches.length - GROUP_SHOWN === 1 ? "el otro producto" : `los otros ${matches.length - GROUP_SHOWN} productos`}
          </summary>
          <ul className="mv-sublist" style={{ marginTop: "0.45rem" }}>
            {matches.slice(GROUP_SHOWN).map((m) => (
              <SubMatch key={m.id} m={m} p={products.get(m.productCode)} />
            ))}
          </ul>
        </details>
      )}
      {c.avisoCredito && <p className="mv-credito">{c.avisoCredito}</p>}
      <Location c={c} viewer={viewer} back={back1} />
      <ContactLine c={c} contacts={contacts} />
      {refs.length > 0 && <Actions viewer={viewer} ctx={{ c, products: refs, back: back1, bot, now }} />}
    </li>
  );
}

/** Bloque "Clientes que ya compraron esta medida" (fuera del padrón: sin porcentaje). */
export function SalesOnlyCard({ c, product, viewer, back, bot, now }: { c: MatchCard; product: ProductRef; viewer: Viewer; back: string; bot: string; now: Date }) {
  const id = `e-${c.companyId ?? c.ruc}`;
  return (
    <li className="pt-card mv-card" id={id}>
      <div className="mv-card-top">
        <EstadoTag estado={c.estado} />
        {c.detalle.bancoSinClienteFinal && <span className="pt-tag pt-tag-mtc">Leasing sin cliente final</span>}
      </div>
      <h3 className="mv-name">{c.companyId !== null ? <Link href={`/portal/empresas/${c.companyId}`}>{c.razonSocial}</Link> : c.razonSocial}</h3>
      <Ruc ruc={c.ruc} />
      <MatchBadges c={c} />
      {c.podriaLlevarTexto && <p className="pt-small pt-muted mv-meta">{c.podriaLlevarTexto}</p>}
      <Actions viewer={viewer} ctx={{ c, products: [product], back: `${back}#${id}`, bot, now }} />
    </li>
  );
}

