/**
 * Corrida L — tabla de ubigeos (departamento, provincia, distrito) como datos del sistema: ubigeo-inei.json, códigos INEI,
 * que son los que usa SUNAT en el padrón reducido del RUC (comprobado con el archivo del 22/11/2026: 150140 = Lima / Lima /
 * Santiago de Surco, 150122 Miraflores, 150131 San Isidro, 070101 Callao; RENIEC usa otra numeración, p. ej. 140101 = Lima).
 * Fuente y armado: el campo `_fuente` del JSON. Dos distritos nuevos que la fuente no trae con código INEI se agregan aquí
 * (EXTRA). Los códigos viejos que SUNAT conserva (distritos que pasaron a otra provincia) no tienen correspondencia:
 * lookupUbigeo devuelve null y el import los reporta.
 *
 * Nombres legibles ("Santiago de Surco", "Áncash"); `fold` da la forma del padrón del MTC ("SANTIAGO DE SURCO", "ANCASH")
 * para comparar con companies.departamento / provincia / distrito.
 */
import data from "./ubigeo-inei.json";

interface UbigeoData {
  departamentos: Record<string, string>;
  provincias: Record<string, string>;
  distritos: Record<string, string>;
}

/**
 * Distritos creados después de las fuentes que SUNAT ya usa (en el archivo del 22/11/2026: 130112 en 392 empresas, 180107
 * en 699). Comprobado con las filas: las de 130112 están en zonas de Alto Trujillo (Trujillo) y las de 180107 en San
 * Antonio (Mariscal Nieto; la fuente solo trae su código RENIEC, 170107).
 */
const EXTRA: Record<string, string> = {
  "130112": "Alto Trujillo",
  "180107": "San Antonio",
};

const table = data as unknown as UbigeoData;
/** La fuente llama "Prov. Const. del Callao" a la provincia 0701: en una dirección basta "Callao". */
const PROVINCIA_NOMBRE: Record<string, string> = { "0701": "Callao" };
const DISTRITOS: Record<string, string> = { ...table.distritos, ...EXTRA };

export interface Ubigeo {
  /** 6 dígitos (INEI). */
  ubigeo: string;
  /** Legibles: "Lima", "Lima", "Santiago de Surco". */
  departamento: string;
  provincia: string;
  distrito: string;
}

/** Mayúsculas sin tildes ni signos dobles: como el padrón del MTC ("JUNÍN" -> "JUNIN", "Áncash" -> "ANCASH"). */
export function foldPlace(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 150140 -> Lima / Lima / Santiago de Surco; null si el código no está en la tabla (o no son 6 dígitos). */
export function lookupUbigeo(code: string | null | undefined): Ubigeo | null {
  const c = (code ?? "").trim();
  if (!/^\d{6}$/.test(c)) return null;
  const distrito = DISTRITOS[c];
  const provincia = PROVINCIA_NOMBRE[c.slice(0, 4)] ?? table.provincias[c.slice(0, 4)];
  const departamento = table.departamentos[c.slice(0, 2)];
  if (!distrito || !provincia || !departamento) return null;
  return { ubigeo: c, departamento, provincia, distrito };
}

let byNames: Map<string, string> | null = null;

/** El código de un distrito por sus nombres (cualquier forma: "SANTIAGO DE SURCO" o "Santiago de Surco"); null si no está. */
export function ubigeoByNames(departamento: string | null | undefined, provincia: string | null | undefined, distrito: string | null | undefined): string | null {
  if (!departamento || !provincia || !distrito) return null;
  if (!byNames) {
    byNames = new Map();
    for (const code of Object.keys(DISTRITOS)) {
      const u = lookupUbigeo(code);
      if (u) byNames.set(`${foldPlace(u.departamento)}|${foldPlace(u.provincia)}|${foldPlace(u.distrito)}`, code);
    }
  }
  return byNames.get(`${foldPlace(departamento)}|${foldPlace(provincia)}|${foldPlace(distrito)}`) ?? null;
}

/** Los departamentos (legibles), por nombre. */
export function listDepartamentosUbigeo(): { codigo: string; nombre: string }[] {
  return Object.entries(table.departamentos)
    .map(([codigo, nombre]) => ({ codigo, nombre }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

/**
 * Los distritos de un departamento (por nombre en cualquier forma, "LIMA" o "Lima"), ordenados por provincia y distrito:
 * las opciones del filtro "Distrito" que depende del departamento. Lima y Callao van juntos (el padrón del MTC no separa
 * Callao): pedir "LIMA" trae también los de Callao.
 */
export function distritosDe(departamento: string | null | undefined): Ubigeo[] {
  const dep = foldPlace(departamento);
  if (!dep) return [];
  const deps = new Set(isLimaOrCallao(dep) ? ["LIMA", "CALLAO"] : [dep]);
  const out: Ubigeo[] = [];
  for (const code of Object.keys(DISTRITOS)) {
    const u = lookupUbigeo(code);
    if (u && deps.has(foldPlace(u.departamento))) out.push(u);
  }
  return out.sort((a, b) => a.provincia.localeCompare(b.provincia, "es") || a.distrito.localeCompare(b.distrito, "es"));
}

/** "LIMA" / "CALLAO" (cualquier forma). */
export function isLimaOrCallao(departamento: string | null | undefined): boolean {
  const d = foldPlace(departamento);
  return d === "LIMA" || d === "CALLAO";
}

/** ¿Mismo departamento? Lima y Callao cuentan como uno (el MTC pone las flotas del Callao en Lima). */
export function sameDepartamento(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = foldPlace(a);
  const y = foldPlace(b);
  if (!x || !y) return false;
  return x === y || (isLimaOrCallao(x) && isLimaOrCallao(y));
}

/** Cantidad de distritos de la tabla (pruebas). */
export function ubigeoCount(): number {
  return Object.keys(DISTRITOS).length;
}
