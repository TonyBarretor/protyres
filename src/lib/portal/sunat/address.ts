/**
 * Corrida L — dirección de SUNAT armada en una línea legible: "Jr. Monterrosa 271, Dpto. 902, Santiago de Surco, Lima".
 *
 * Piezas tal como vienen del padrón (ver parse.ts; los "-" y "----" ya son null). Orden:
 *   vía + nombre + número (o "Km 38.2") · Int. · Dpto. · Mz. Lt. · zona ("Urb. El Palomar", "A.H. San Pedro") · distrito,
 *   provincia, departamento (del ubigeo; los repetidos una sola vez: "Santiago de Surco, Lima", "Cayma, Arequipa",
 *   "El Tambo, Huancayo, Junín").
 * Nombres en tipo título: en medio, "de", "del", "y", "e" en minúscula y el artículo tras "de" también ("Malecón de la
 * Marina", pero "Villa El Salvador", "Club El Golf Los Incas"); las piezas con dígitos ("3-A", "C402", "1QA") y los números
 * romanos quedan en mayúsculas. "S\N" (sin número) -> "S/N".
 */
import { lookupUbigeo } from "./ubigeo";

/**
 * Piezas de la dirección. OJO: en las filas reales la columna "CÓDIGO DE ZONA" trae el TIPO de zona ("URB.", "A.H.") y
 * "TIPO DE ZONA" trae el NOMBRE ("EL PALOMAR"): aquí van por su contenido (tipoZona = lo de "CÓDIGO DE ZONA").
 * `dpto` es la columna DEPARTAMENTO: el número de departamento u oficina ("Dpto. 902"), no la región.
 */
export interface SunatPiezas {
  tipoVia: string | null;
  nombreVia: string | null;
  /** Columna "CÓDIGO DE ZONA" (trae el tipo: "URB.", "A.H."...). */
  tipoZona: string | null;
  /** Columna "TIPO DE ZONA" (trae el nombre: "EL PALOMAR"). */
  nombreZona: string | null;
  numero: string | null;
  interior: string | null;
  lote: string | null;
  /** Columna DEPARTAMENTO: departamento u oficina dentro del edificio. */
  dpto: string | null;
  manzana: string | null;
  kilometro: string | null;
}

/** Tipos de vía del padrón -> forma legible ("" = solo el nombre: OTR. trae el nombre completo, "MONTEROSA 239"). */
const VIA: Record<string, string> = {
  "AV.": "Av.",
  "JR.": "Jr.",
  "CAL.": "Calle",
  "PJ.": "Psje.",
  "CAR.": "Carretera",
  "PRO.": "Prolongación",
  "PZA.": "Plaza",
  "BL.": "Block",
  "VIA.": "Vía",
  "PQ.": "Parque",
  "MLC.": "Malecón",
  "C.RU": "Camino rural",
  "TRO.": "Trocha",
  "ALM.": "Alameda",
  "T.CA": "Trocha carrozable",
  "CAM.": "Camino",
  "GAL.": "Galería",
  "OVL.": "Óvalo",
  "BLV.": "Bulevar",
  "C.AF": "Camino afirmado",
  "PTE.": "Puente",
  "PLA.": "Plazuela",
  "POR.": "Portal",
  "PAS.": "Paseo",
  "CAN.": "Canal",
  "BAJ.": "Bajada",
  "BYP.": "Bypass",
  "OTR.": "",
};

/** Tipos de zona del padrón -> forma legible ("" = solo el nombre). */
const ZONA: Record<string, string> = {
  "URB.": "Urb.",
  "A.H.": "A.H.",
  "P.J.": "P.J.",
  "C.P.": "C.P.",
  "BAR.": "Barrio",
  "SEC.": "Sector",
  "ASC.": "Asoc.",
  "COO.": "Coop.",
  "CAS.": "Caserío",
  "APV.": "APV",
  "A.V.": "A.V.",
  "RES.": "Residencial",
  "C.H.": "C.H.",
  "FND.": "Fundo",
  "Z.I.": "Zona Industrial",
  "COM.": "Comunidad",
  "C.C.": "C.C.",
  "ANX.": "Anexo",
  "CND.": "Condominio",
  "GRU.": "Grupo",
  "U.V.": "U.V.",
  "LOT.": "Lotización",
  "CMP.": "Campamento",
  "H.U.": "H.U.",
  "VLL.": "Villa",
  "HAC.": "Hacienda",
  "OTR.": "",
};

const SMALL = new Set(["de", "del", "y", "e"]);
const ARTICLE = new Set(["la", "las", "los", "el"]);
const ROMAN = /^(?=[IVXLC]+$)M{0,3}(C[MD]|D?C{0,3})(X[CL]|L?X{0,3})(I[XV]|V?I{0,3})$/;

/** "CANAVAL Y MOREYRA" -> "Canaval y Moreyra"; "SAN FCO.TABLADA" -> "San Fco.Tablada"; "3-A", "C402", "II" quedan. */
export function titleCasePlace(s: string): string {
  const words = s.trim().replace(/\s+/g, " ").split(" ");
  return words
    .map((w, i) => {
      // ordinales: "4TA." -> "4ta.", "2DO" -> "2do"
      if (/^\d+(?:RA|RO|DA|DO|TA|TO|MA|MO|VA|VO|NA|NO)\.?$/i.test(w)) return w.toLocaleLowerCase("es");
      if (/\d/.test(w) || ROMAN.test(w)) return w;
      const lower = w.toLocaleLowerCase("es");
      if (i > 0 && SMALL.has(lower)) return lower;
      if (i > 0 && ARTICLE.has(lower) && words[i - 1].toLocaleLowerCase("es") === "de") return lower;
      return lower.replace(/(^|[.\-(/'])(\p{L})/gu, (_m, a: string, b: string) => a + b.toLocaleUpperCase("es"));
    })
    .join(" ");
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").replace(/\s+/g, " ").trim();
  return !t || /^-+$/.test(t) ? null : t;
};

/** Número, interior, Dpto., Mz., Lt. o Km: un 0 solo ("0", "00", "0.0") es relleno del padrón ("Int. 0"), no un dato. */
const cleanNum = (v: string | null | undefined): string | null => {
  const t = clean(v);
  return t && /^0+(?:\.0+)?$/.test(t) ? null : t;
};

/** "S\N", "SN", "S/N" -> "S/N"; si no, tal cual (en mayúsculas: "271", "3-A"). */
function numeroText(n: string): string {
  return /^S\s*[\\/]?\s*N\.?$/i.test(n) ? "S/N" : n.toUpperCase();
}

/** "38.2", "38,2" -> "Km 38.2". */
function kmText(k: string): string {
  return `Km ${k.replace(",", ".")}`;
}

const typed = (map: Record<string, string>, tipo: string | null, nombre: string | null): string | null => {
  const t = clean(tipo);
  const n = clean(nombre);
  if (!n) return null;
  let label = t ? (map[t.toUpperCase()] ?? titleCasePlace(t)) : "";
  let name = titleCasePlace(n);
  if (label) {
    // el nombre ya trae el tipo ("FUNDO HUACHIPA", "CALLE 7", "INDUSTRIAL HUACHIPA ESTE"): no se repite
    const labelWords = label.split(" ");
    const last = labelWords[labelWords.length - 1].replace(/\.$/, "").toLocaleLowerCase("es");
    const first = name.split(" ")[0].replace(/\.$/, "").toLocaleLowerCase("es");
    if (first === last) label = labelWords.slice(0, -1).join(" ");
    // tipo de varias palabras que el nombre ya trae entero ("Zona Industrial" + "ZONA INDUSTRIAL CONCHUCOS")
    else if (labelWords.length > 1 && (name.toLocaleLowerCase("es") + " ").startsWith(label.toLocaleLowerCase("es") + " ")) label = "";
    // tras el tipo, "de" / "del" van en minúscula ("Malecón de la Marina", "Av. del Ejército")
    if (label) name = name.replace(/^(De|Del)( |$)/, (_m, w: string, sp: string) => w.toLocaleLowerCase("es") + sp).replace(/^de (La|Las|Los|El) /, (_m, a: string) => `de ${a.toLocaleLowerCase("es")} `);
  }
  return [label, name].filter(Boolean).join(" ");
};

/** La calle (sin distrito): "Jr. Monterrosa 271, Dpto. 902"; null si no hay ninguna pieza. */
export function streetLine(p: SunatPiezas): string | null {
  const parts: string[] = [];
  const via = typed(VIA, p.tipoVia, p.nombreVia);
  const numero = cleanNum(p.numero);
  const km = cleanNum(p.kilometro);
  let head = [via, numero ? numeroText(numero) : null].filter(Boolean).join(" ");
  if (km) head = [head, kmText(km)].filter(Boolean).join(" ");
  if (head) parts.push(head);
  const interior = cleanNum(p.interior);
  if (interior) parts.push(`Int. ${interior.toUpperCase()}`);
  const dpto = cleanNum(p.dpto);
  if (dpto) parts.push(`Dpto. ${dpto.toUpperCase()}`);
  const mz = cleanNum(p.manzana);
  const lt = cleanNum(p.lote);
  const mzlt = [mz ? `Mz. ${mz.toUpperCase()}` : null, lt ? `Lt. ${lt.toUpperCase()}` : null].filter(Boolean).join(" ");
  if (mzlt) parts.push(mzlt);
  const zona = typed(ZONA, p.tipoZona, p.nombreZona);
  if (zona) parts.push(zona);
  return parts.length ? parts.join(", ") : null;
}

/** "Santiago de Surco, Lima" / "Cayma, Arequipa" / "El Tambo, Huancayo, Junín" / "Callao"; null sin ubigeo conocido. */
export function placeLine(ubigeo: string | null | undefined): string | null {
  const u = lookupUbigeo(ubigeo);
  if (!u) return null;
  const out: string[] = [];
  for (const x of [u.distrito, u.provincia, u.departamento]) if (out[out.length - 1] !== x) out.push(x);
  return out.join(", ");
}

/**
 * La dirección en una línea: calle + lugar. null si no hay calle (persona natural con todo en "-"): el lugar solo no es
 * una dirección para visitar.
 */
export function buildAddress(p: SunatPiezas | null, ubigeo: string | null | undefined): string | null {
  if (!p) return null;
  const street = streetLine(p);
  if (!street) return null;
  return [street, placeLine(ubigeo)].filter(Boolean).join(", ");
}

/** Todas las piezas vacías. */
export function emptyPiezas(p: SunatPiezas): boolean {
  return Object.values(p).every((v) => v === null);
}
