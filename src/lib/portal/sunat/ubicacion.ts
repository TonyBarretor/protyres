/**
 * Corrida L — qué dirección y qué ubicación se muestran de una empresa, y su aviso de SUNAT. Lo usan las pantallas (ficha,
 * tarjetas de Match Venta y Prospectos), el bot y los filtros.
 *
 *  - Dirección: la de operación escrita a mano por el vendedor (companies.direccion, "Agregar dirección de operación")
 *    manda en todas las vistas; si no hay, el domicilio fiscal de SUNAT. La reimportación de SUNAT nunca toca la manual.
 *  - Ubicación efectiva (distrito para filtrar y repartir visitas): la de SUNAT si su domicilio está en el departamento de
 *    la empresa (Lima y Callao cuentan como uno) o la empresa no tiene departamento; si no, la del MTC (provincia/distrito
 *    de su flota de pasajeros). Una flota de Arequipa con domicilio fiscal en Surco se sigue repartiendo en Arequipa.
 *  - Aviso: estado o condición de SUNAT en alerta (config/portal.json `sunat`) en rojo; las condiciones "de aviso" (NO
 *    HALLADO…) en ámbar. Las de alerta bajan al final de Match Venta y de "mejores", nunca se ocultan.
 */
import type { Company, SunatAlertMatch, SunatBrief } from "../store/types";
import { foldPlace, lookupUbigeo, sameDepartamento, ubigeoByNames } from "./ubigeo";

export interface UbicacionEfectiva {
  /** Como el padrón del MTC (mayúsculas sin tildes), para comparar con los filtros. */
  departamento: string | null;
  provincia: string | null;
  distrito: string | null;
  /** Código INEI (de SUNAT, o el de los nombres del MTC si está en la tabla). */
  ubigeo: string | null;
  fuente: "sunat" | "mtc" | null;
}

type CompanyPlace = Pick<Company, "departamento"> & { provincia?: string | null; distrito?: string | null };
type SunatPlace = Pick<SunatBrief, "ubigeo" | "departamento" | "provincia" | "distrito">;

/** ¿El domicilio de SUNAT sirve como ubicación de la empresa? (ver la cabecera). */
export function sunatUbicacionAplica(c: Pick<Company, "departamento">, s: SunatPlace | null | undefined): s is SunatPlace & { distrito: string } {
  if (!s?.distrito || !s.departamento) return false;
  return !c.departamento || sameDepartamento(c.departamento, s.departamento);
}

export function ubicacionEfectiva(c: CompanyPlace, s: SunatPlace | null | undefined): UbicacionEfectiva {
  if (sunatUbicacionAplica(c, s)) {
    return { departamento: c.departamento ?? s.departamento, provincia: s.provincia, distrito: s.distrito, ubigeo: s.ubigeo, fuente: "sunat" };
  }
  const provincia = c.provincia ?? null;
  const distrito = c.distrito ?? null;
  return {
    departamento: c.departamento ?? null,
    provincia,
    distrito,
    ubigeo: distrito ? ubigeoByNames(c.departamento, provincia, distrito) : null,
    fuente: distrito || provincia ? "mtc" : null,
  };
}

/** ¿La ubicación efectiva es ese distrito (código INEI)? Compara por nombres plegados: el MTC no guarda el código. */
export function enDistrito(u: Pick<UbicacionEfectiva, "departamento" | "provincia" | "distrito">, ubigeo: string): boolean {
  const target = lookupUbigeo(ubigeo);
  if (!target || !u.distrito) return false;
  if (u.departamento && !sameDepartamento(u.departamento, target.departamento)) return false;
  return foldPlace(u.distrito) === foldPlace(target.distrito) && (!u.provincia || foldPlace(u.provincia) === foldPlace(target.provincia));
}

/** Nombre legible del lugar efectivo: "Santiago de Surco, Lima" (de la tabla si se conoce el código; si no, tipo título). */
export function ubicacionTexto(u: UbicacionEfectiva): string {
  const t = lookupUbigeo(u.ubigeo);
  if (t) return [t.distrito, t.departamento].filter((x, i, a) => a.indexOf(x) === i).join(", ");
  const title = (s: string) => s.toLowerCase().replace(/(^|[\s/-])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
  return [u.distrito, u.departamento].filter((x): x is string => !!x).filter((x, i, a) => a.indexOf(x) === i).map(title).join(", ");
}

export interface DireccionVisible {
  /** La dirección en una línea. */
  texto: string;
  /** "operacion": escrita por el vendedor (manda); "fiscal": domicilio fiscal de SUNAT. */
  fuente: "operacion" | "fiscal";
  /** "Según SUNAT al 22/11/2026" (solo la fiscal). */
  segun: string | null;
}

/** "2026-11-22" -> "22/11/2026". */
export function fechaSunat(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** La dirección que se muestra: la de operación (a mano) o, si no hay, la fiscal de SUNAT; null si ninguna. */
export function direccionVisible(c: { direccion?: string | null }, s: Pick<SunatBrief, "direccion" | "fecha"> | null | undefined): DireccionVisible | null {
  const manual = (c.direccion ?? "").trim();
  if (manual) return { texto: manual, fuente: "operacion", segun: null };
  if (s?.direccion) return { texto: s.direccion, fuente: "fiscal", segun: `Según SUNAT al ${fechaSunat(s.fecha)}` };
  return null;
}

/** La línea de aviso bajo el domicilio fiscal. */
export const AVISO_DOMICILIO_FISCAL = "El domicilio fiscal puede no ser donde opera la flota";

export interface SunatAvisoConfig extends SunatAlertMatch {
  /** Condiciones que se muestran en ámbar sin bajar la empresa ("NO HALLADO…"). */
  condicionesAviso: string[];
}

export interface SunatAviso {
  /** "alerta": en rojo y la empresa baja al final; "aviso": en ámbar, sin cambiar el orden. */
  nivel: "alerta" | "aviso";
  /** "BAJA DE OFICIO · NO HABIDO" (legible, en mayúsculas como SUNAT). */
  texto: string;
}

/** Valores que SUNAT corta a 20 caracteres o sin tilde -> forma legible (el resto, tal cual). */
const LABEL: Record<string, string> = {
  "SUSPENSION TEMPORAL": "SUSPENSIÓN TEMPORAL",
  "BAJA PROV. POR OFICI": "BAJA PROVISIONAL POR OFICIO",
  "BAJA MULT.INSCR. Y O": "BAJA MULT. INSCR. Y OTROS",
  "NO HALLADO SE MUDO D": "NO HALLADO (SE MUDÓ DE DOMICILIO)",
  "NO HALLADO DESTINATA": "NO HALLADO (DESTINATARIO DESCONOCIDO)",
  "NO HALLADO CERRADO": "NO HALLADO (CERRADO)",
  "NO HALLADO OTROS MOT": "NO HALLADO (OTROS MOTIVOS)",
  "NO HALLADO NRO.PUERT": "NO HALLADO (NRO. DE PUERTA NO EXISTE)",
  "NO HALLADO NO EXISTE": "NO HALLADO (NO EXISTE)",
  "NO HALLADO RECHAZADO": "NO HALLADO (RECHAZADO)",
  "NO HALLADO FALLECIO": "NO HALLADO (FALLECIÓ)",
};

export function sunatLabel(v: string): string {
  return LABEL[v.toUpperCase()] ?? v.toUpperCase();
}

const fold = (s: string | null | undefined) => foldPlace(s);
const matches = (value: string | null | undefined, prefixes: string[]) => {
  const v = fold(value);
  return !!v && prefixes.some((p) => v.startsWith(fold(p)));
};

/** ¿Estado o condición en alerta? (las que bajan al final). */
export function sunatEnAlerta(s: Pick<SunatBrief, "estado" | "condicion"> | null | undefined, cfg: SunatAlertMatch): boolean {
  return !!s && (matches(s.estado, cfg.estados) || matches(s.condicion, cfg.condiciones));
}

/** El aviso de SUNAT de una empresa, o null (ACTIVO y HABIDO, o sin dato). */
export function sunatAviso(s: Pick<SunatBrief, "estado" | "condicion" | "encontrado"> | null | undefined, cfg: SunatAvisoConfig): SunatAviso | null {
  if (!s || !s.encontrado) return null;
  const parts: string[] = [];
  const estadoAlerta = matches(s.estado, cfg.estados);
  const condAlerta = matches(s.condicion, cfg.condiciones);
  if (estadoAlerta && s.estado) parts.push(sunatLabel(s.estado));
  if (condAlerta && s.condicion) parts.push(sunatLabel(s.condicion));
  if (parts.length) return { nivel: "alerta", texto: parts.join(" · ") };
  if (matches(s.condicion, cfg.condicionesAviso) && s.condicion) return { nivel: "aviso", texto: sunatLabel(s.condicion) };
  return null;
}
