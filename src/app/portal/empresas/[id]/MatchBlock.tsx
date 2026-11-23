/**
 * Corrida K — ficha de empresa: bloque "Match con tu stock" (companyMatchBlock): los productos prioritarios que le
 * sirven, con el match estimado, el desglose y las insignias (compra real, migración), y "Cómo llegar". Solo para
 * quien usa Match Venta; nada si ningún producto prioritario le sirve.
 */
import Link from "next/link";
import { canSeeAll } from "@/lib/portal/auth/permissions";
import { companyMatchBlock, directionsLink, loadMatchStock, productLabel, productName, type MatchCard } from "@/lib/portal/match";
import type { Company, PortalStore, PortalUser } from "@/lib/portal/store/types";
import { canUseMatch } from "@/lib/portal/ui/match";
import { MatchBadges, MatchPct, ScheduleForm } from "../../match/cards";
import "../../match/match.css";

/** Los tres mejores a la vista; el resto al tocar (una flota grande puede hacer match con casi todo el stock prioritario). */
const SHOWN = 3;

function Item({ c, label }: { c: MatchCard; label: string }) {
  return (
    <li>
      <div className="mv-sub-head">
        <Link className="mv-sub-prod" href={`/portal/match?p=${c.productCode}`}>
          {label}
        </Link>
        {c.pct !== null && <MatchPct pct={c.pct} small />}
      </div>
      <p className="mv-desglose">{c.detalle.desglose}</p>
      <MatchBadges c={{ ...c, avisoCredito: null }} />
      {c.podriaLlevarTexto && <p className="pt-small pt-muted mv-meta">{c.podriaLlevarTexto}</p>}
    </li>
  );
}

export interface MatchBlockData {
  cards: MatchCard[];
  labels: Record<string, string>;
  refs: { code: string; nombre: string; medida: string; disponible: number; etiqueta: string }[];
}

/** Lo que muestra el bloque (null: quien mira no usa Match Venta o ningún producto prioritario le sirve). */
export async function loadMatchBlock(store: PortalStore, user: PortalUser, company: Company): Promise<MatchBlockData | null> {
  if (!canUseMatch(user)) return null;
  const [cards, { stock }] = await Promise.all([companyMatchBlock(store, user, company.id).catch(() => [] as MatchCard[]), loadMatchStock({ store, prices: null }).catch(() => ({ stock: [] }))]);
  if (!cards.length) return null;
  const refs = cards.flatMap((c) => {
    const s = stock.find((x) => x.code === c.productCode);
    return s ? [{ code: s.code, nombre: productName(s), medida: s.sizeDisplay, disponible: s.available, etiqueta: productLabel(s) }] : [];
  });
  return { cards, labels: Object.fromEntries(stock.map((s) => [s.code, productLabel(s)])), refs };
}

export function MatchBlock({ data, user, company }: { data: MatchBlockData | null; user: PortalUser; company: Company }) {
  if (!data) return null;
  const { cards, refs } = data;
  const label = new Map(Object.entries(data.labels));
  const d = directionsLink(company);
  const canSchedule = user.rol !== "tecnico" && (company.ownerUserId === null || company.ownerUserId === user.id || canSeeAll(user));
  return (
    <section className="pt-card" aria-labelledby="match-title">
      <div className="pt-section-head">
        <h2 id="match-title" style={{ margin: 0 }}>
          Match con tu stock
        </h2>
        <a className="pt-btn pt-btn-sm" href={d.url} target="_blank" rel="noopener noreferrer" title={d.aproximada ? "Sin dirección registrada: búsqueda aproximada por razón social y distrito." : undefined}>
          Cómo llegar{d.aproximada ? " (aprox.)" : ""}
        </a>
      </div>
      <ul className="mv-ficha-list">
        {cards.slice(0, SHOWN).map((c) => (
          <Item key={c.id} c={c} label={label.get(c.productCode) ?? c.productCode} />
        ))}
      </ul>
      {cards.length > SHOWN && (
        <details className="mv-detail" style={{ marginTop: "0.5rem" }}>
          <summary>Ver {cards.length - SHOWN === 1 ? "el otro producto" : `los otros ${cards.length - SHOWN} productos`}</summary>
          <ul className="mv-ficha-list" style={{ marginTop: "0.5rem" }}>
            {cards.slice(SHOWN).map((c) => (
              <Item key={c.id} c={c} label={label.get(c.productCode) ?? c.productCode} />
            ))}
          </ul>
        </details>
      )}
      {canSchedule && refs.length > 0 && (
        <details className="mv-act" style={{ marginTop: "0.7rem" }}>
          <summary className="pt-btn pt-btn-sm pt-btn-primary">Agendar visita para ofrecerlas</summary>
          <ScheduleForm companyId={company.id} products={refs} back={`/portal/empresas/${company.id}`} now={new Date()} />
        </details>
      )}
    </section>
  );
}
