/**
 * Corrida L, punto 2 — qué muestran las pantallas de la dirección de una empresa (ficha, tarjetas de Match Venta y de
 * Prospectos). Puro: sin Next ni store (la lógica de fondo está en src/lib/portal/sunat/).
 *
 *  - Una línea: la dirección de operación escrita por el vendedor (companies.direccion) manda; si no hay, el domicilio
 *    fiscal de SUNAT. Debajo, "Según SUNAT al <fecha>" o "Dirección de operación (la escribió <vendedor>)".
 *  - "Cómo llegar" (mapas con la dirección completa; sin ninguna, búsqueda aproximada por nombre) y copiar.
 *  - Aviso de SUNAT (estado / condición): rojo ("alerta") o ámbar ("aviso").
 *  - Sin dirección: por qué (no se importó, no aparece en el padrón, persona natural, SUNAT la tiene en blanco).
 *  - Locales anexos: los del departamento de la flota primero y destacados (el vendedor no tiene departamento propio en
 *    el portal: se usa el de la flota, como el bot), los primeros N y "ver todos".
 */
import { directionsLink, mapsUrl } from "../match/company";
import type { SunatConfig } from "../sunat/config";
import { AVISO_DOMICILIO_FISCAL, direccionVisible, fechaSunat, sunatAviso, type SunatAviso } from "../sunat/ubicacion";
import { lookupUbigeo, sameDepartamento } from "../sunat/ubigeo";
import type { Activity, Company, PortalUser, SunatBrief, SunatLocal } from "../store/types";

export { AVISO_DOMICILIO_FISCAL };

/** Locales anexos que la ficha muestra antes de "Ver todos". */
export const LOCALES_SHOWN = 12;

type CompanyLike = Pick<Company, "razonSocial" | "ruc" | "departamento"> & { direccion?: string | null; distrito?: string | null; provincia?: string | null };

export interface DireccionUi {
  /** La línea que se muestra (null: no hay ninguna). */
  texto: string | null;
  fuente: "operacion" | "fiscal" | null;
  /** "Según SUNAT al 23/11/2026" / "Dirección de operación (la escribió Frank)". */
  nota: string | null;
  /** "Cómo llegar": la dirección de arriba, o búsqueda aproximada por nombre si no hay. */
  mapa: { url: string; aproximada: boolean };
  /** Con la de operación al frente: el domicilio fiscal aparte (lo muestra la ficha). */
  fiscal: { texto: string; segun: string; url: string } | null;
  /** Hay domicilio fiscal a la vista (la ficha añade AVISO_DOMICILIO_FISCAL). */
  hayFiscal: boolean;
  aviso: SunatAviso | null;
  /** Por qué no hay dirección (null si la hay). */
  sinDireccion: string | null;
  /** Locales anexos según SUNAT. */
  anexos: number;
  /** Razón social de SUNAT si difiere mucho de la del portal (solo la ficha la trae). */
  razonSunat: string | null;
}

/** Nombre corto del vendedor ("Frank"). */
const firstName = (n: string) => n.trim().split(/\s+/)[0] ?? n;

/** Quién escribió la dirección de operación: la nota más reciente de "Agregar dirección" (setCompanyDireccion). */
export function direccionAutor(activities: Pick<Activity, "userId" | "texto" | "data" | "occurredAt">[], users: Pick<PortalUser, "id" | "nombre">[]): string | null {
  const last = [...activities]
    .filter((a) => (a.data as { evento?: unknown } | null)?.evento === "direccion" && a.texto.startsWith("Dirección:"))
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
  if (!last || last.userId === null) return null;
  const u = users.find((x) => x.id === last.userId);
  return u ? firstName(u.nombre) : null;
}

/** Por qué no hay dirección que mostrar. */
function motivoSinDireccion(c: Pick<Company, "ruc">, s: (SunatBrief & { razonSocial?: string | null }) | null | undefined): string {
  if (!s) return "Sin dirección: aún no se cargó SUNAT para este RUC.";
  if (!s.encontrado) return `Sin dirección: no aparece en el padrón de SUNAT al ${fechaSunat(s.fecha)}.`;
  if (c.ruc.startsWith("10")) return "Sin dirección: persona natural (SUNAT no publica su domicilio).";
  return "Sin dirección: SUNAT no tiene su domicilio fiscal.";
}

export function direccionUi(
  c: CompanyLike,
  sunat: (SunatBrief & { razonSocial?: string | null }) | null | undefined,
  cfg: Pick<SunatConfig, "estadosAlerta" | "condicionesAlerta" | "condicionesAviso">,
  opts: { autor?: string | null } = {},
): DireccionUi {
  const v = direccionVisible(c, sunat);
  const link = directionsLink(c, sunat ?? null);
  const fiscalTexto = sunat?.direccion ?? null;
  const fiscal = v?.fuente === "operacion" && fiscalTexto ? { texto: fiscalTexto, segun: `Según SUNAT al ${fechaSunat(sunat!.fecha)}`, url: mapsUrl(`${fiscalTexto}, Perú`) } : null;
  const nota = !v ? null : v.fuente === "fiscal" ? v.segun : `Dirección de operación${opts.autor ? ` (la escribió ${opts.autor})` : ""}`;
  return {
    texto: v?.texto ?? null,
    fuente: v?.fuente ?? null,
    nota,
    mapa: { url: link.url, aproximada: link.aproximada },
    fiscal,
    hayFiscal: !!fiscalTexto,
    aviso: sunatAviso(sunat, { estados: cfg.estadosAlerta, condiciones: cfg.condicionesAlerta, condicionesAviso: cfg.condicionesAviso }),
    sinDireccion: v ? null : motivoSinDireccion(c, sunat),
    anexos: sunat?.anexos ?? 0,
    razonSunat: sunat?.razonSocial ?? null,
  };
}

/** Como localesOrdenados del bot (bot/commands/direccion.ts), sin importar el módulo del bot (registra comandos al cargarse). */
function ordenar(locales: SunatLocal[], departamento: string | null): { local: SunatLocal; mismoDepartamento: boolean }[] {
  const tagged = locales.map((l) => ({ local: l, mismoDepartamento: !!departamento && sameDepartamento(l.departamento, departamento) }));
  return [...tagged.filter((t) => t.mismoDepartamento), ...tagged.filter((t) => !t.mismoDepartamento)];
}

export interface LocalUi {
  id: number;
  /** La dirección armada, o el lugar si SUNAT no trae calle. */
  texto: string;
  url: string;
  /** En el departamento de la flota: destacado y primero. */
  destacado: boolean;
}

export interface LocalesUi {
  items: LocalUi[];
  total: number;
  /** Cuántos quedan para "Ver todos" (0 si se muestran todos). */
  ocultos: number;
  /** Cuántos están en el departamento de la flota. */
  destacados: number;
  /** "Lima" (legible) o null si la empresa no tiene departamento. */
  departamento: string | null;
}

/** Los locales anexos de la ficha: los del departamento de la flota primero y destacados; `todos` o los primeros LOCALES_SHOWN. */
export function localesUi(locales: SunatLocal[], departamento: string | null, opts: { todos?: boolean; shown?: number } = {}): LocalesUi {
  const ordered = ordenar(locales, departamento);
  const limit = opts.todos ? ordered.length : (opts.shown ?? LOCALES_SHOWN);
  const items = ordered.slice(0, limit).map(({ local, mismoDepartamento }) => {
    const lugar = lookupUbigeo(local.ubigeo);
    const texto = local.direccion ?? (lugar ? `${lugar.distrito}, ${lugar.departamento} (sin calle)` : "Sin dirección");
    return { id: local.id, texto, url: mapsUrl(`${local.direccion ?? texto.replace(/ \(sin calle\)$/, "")}, Perú`), destacado: mismoDepartamento };
  });
  // Lima y Callao cuentan como uno (sameDepartamento): la etiqueta lo dice
  const dep = !departamento ? null : sameDepartamento(departamento, "LIMA") ? "Lima y Callao" : (lookupUbigeo(locales.find((l) => sameDepartamento(l.departamento, departamento))?.ubigeo)?.departamento ?? titleDep(departamento));
  return { items, total: ordered.length, ocultos: ordered.length - items.length, destacados: ordered.filter((t) => t.mismoDepartamento).length, departamento: dep };
}

const titleDep = (d: string) => d.toLowerCase().replace(/(^|[\s/-])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
