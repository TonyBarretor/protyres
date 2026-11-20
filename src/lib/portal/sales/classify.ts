/**
 * ventas-odoo, puntos 2 a 4: qué es cada línea del reporte de ventas de Odoo a partir de su DESCRIPCIÓN.
 *
 * La descripción trae el código del producto entre corchetes y, en los neumáticos, la medida, la marca y el diseño en
 * texto libre: "[P0759] 235/75R17.5 18PR FENIXWAY VALOR 89". La medida sale del mismo normalizador del cotizador
 * (src/lib/tyre/spec.ts) y la marca de su catálogo de marcas (src/lib/tyre/brands.ts); el diseño es lo que queda tras
 * quitar medida, marca, lonas, índices y palabras de posición/origen.
 *
 * Tipo de línea:
 *  - servicio: código o texto de servicio (SERV..., SERPER, SA019, REPANEU, reencauche CTH...). Cada uno con su tipo
 *    normalizado por el TEXTO (no por el código: [SERV.VARI] "SERVICIO DE BALANCEO" es balanceo, [SERV.BA] y
 *    [SERV.BALAN] son el mismo balanceo).
 *  - neumatico: hay una medida de neumático y no es un accesorio (aro, guardacámara, válvula...). "SERV. ENLLA
 *    265/60R18 ..." con código de producto es un neumático vendido con el enllante incluido.
 *  - otro: aros, parches, Sika, grasa, cemento, válvulas, herramientas y cargos (mora, descuentos, gastos).
 *
 * `seguro: false` marca lo que se clasificó por descarte o con una regla de respaldo: va a la lista "no se pudo
 * clasificar con seguridad" de la vista previa.
 */
import { findBrandInText, fold, titleCase } from "../../tyre/brands";
import { extractPly, extractLoadIndex } from "../../tyre/attrs";
import { findTyreSizes, normalizeSizeText, parseTyreSize } from "../../tyre/spec";
import type { SaleLineType, ServiceType } from "../store/types";

export interface LineClass {
  /** Código entre corchetes ("P0759", "SERV.ENLL"), o null si no trae. */
  codigo: string | null;
  tipoLinea: SaleLineType;
  tipoServicio: ServiceType | null;
  /** Subtipo de "otro": aro, parche, sika, grasa, cemento, valvula, camara, herramienta, cargo, vehiculo, equipo, accesorio. */
  tipoOtro: string | null;
  /** Medida canónica (parseTyreSize().canonical) o null. */
  medida: string | null;
  marca: string | null;
  diseno: string | null;
  seguro: boolean;
  /** Por qué no es seguro (o una nota de cómo se decidió). */
  nota: string | null;
}

export const SERVICE_LABELS: Record<ServiceType, string> = {
  enllante: "Enllante",
  desenllante: "Desenllante",
  balanceo: "Balanceo",
  alineamiento: "Alineamiento",
  rotacion: "Rotación",
  parchado: "Parchado",
  cambio_neumaticos: "Cambio de neumáticos",
  mantenimiento_correctivo: "Mantenimiento correctivo",
  reencauche: "Reencauche",
  contrato_personal: "Contrato de neumáticos: personal",
  contrato_insumos: "Contrato de neumáticos: insumos",
  contrato_equipos: "Contrato de neumáticos: equipos",
  software: "Software",
  otros: "Otros servicios",
};

export const LINE_TYPE_LABELS: Record<SaleLineType, string> = { neumatico: "Neumáticos", servicio: "Servicios", otro: "Otros productos" };

/** Componentes del contrato de neumáticos: si una empresa compra alguno, "tiene contrato de servicio". */
export const CONTRACT_SERVICE_TYPES: ServiceType[] = ["contrato_personal", "contrato_insumos", "contrato_equipos"];

/** Texto comparable: mayúsculas, sin tildes, espacios simples. */
function up(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** "[P0759] 235/75R17.5 ..." → { codigo: "P0759", resto: "235/75R17.5 ..." }. */
export function splitCode(descripcion: string): { codigo: string | null; resto: string } {
  const m = /^\s*\[([^\]]+)\]\s*(.*)$/s.exec(descripcion ?? "");
  if (!m) return { codigo: null, resto: (descripcion ?? "").trim() };
  return { codigo: m[1].trim() || null, resto: m[2].trim() };
}

/** Código de producto de inventario (P0759, P01634, 1479): los neumáticos y accesorios del almacén. */
const PRODUCT_CODE = /^P?\d{3,6}$/i;
const SERVICE_CODE = /^(SERV|SER[A-Z]|SA019$|REPANEU$|CTH\d)/i;

const SERVICE_RULES: [RegExp, ServiceType][] = [
  [/CONTRATO.*PERSONAL/, "contrato_personal"],
  [/CONTRATO.*INSUMO/, "contrato_insumos"],
  [/CONTRATO.*(BALANCEADORA|HERRAMIENTA|EQUIPO)/, "contrato_equipos"],
  [/REENCAUCHE/, "reencauche"],
  [/DESENLLANT/, "desenllante"],
  [/ENLLANT|ENLLA\b|MONTAJE DE LLANTA/, "enllante"],
  [/BALANCEO/, "balanceo"],
  [/ALINEAMIENTO/, "alineamiento"],
  [/ROTACION/, "rotacion"],
  [/PARCHADO|REPARACION DE NEUMATICO/, "parchado"],
  [/CAMBIO (DE )?NEUMATICO/, "cambio_neumaticos"],
  [/MANTENIMIENTO CORRECTIVO/, "mantenimiento_correctivo"],
  [/SOFTWARE/, "software"],
];

/** Tipo de servicio por el texto de la descripción (sin el código). */
export function serviceTypeOf(text: string): ServiceType {
  const t = up(text);
  for (const [re, tipo] of SERVICE_RULES) if (re.test(t)) return tipo;
  return "otros";
}

const OTHER_RULES: [RegExp, string][] = [
  [/^ARO\b|\bARO \d|\bARO DISCO\b|\bORING\b/, "aro"],
  [/\bPARCHE\b/, "parche"],
  [/\bSIKA|\bGUN MK6\b|PISTOLA (CALAFATEO|SIKAFLEX)/, "sika"],
  [/\bGRASA\b|\bPASTA DE MONT/, "grasa"],
  [/\bCEMENTO\b|\bPEGAMENTO\b/, "cemento"],
  [/\bVALVULA\b|\bPITON\b|\bEXTENSION JDI\b|\bTAPAS DE METAL\b/, "valvula"],
  [/\bGUARDACAMARA\b|\bCAMARA\b|\bFLAP\b/, "camara"],
  [/\bPALANCA\b|\bTARRAJA\b|\bEXTRACTOR\b|\bPICO PARA\b|\bRODILLO\b|\bMEDIDOR\b|\bAGUJA\b|\bCRAYON\b|\bPERNO\b/, "herramienta"],
  [/^(MORA|DESCUENTOS?|GASTOS? )/, "cargo"],
];

/**
 * Medida de una venta: la canónica del cotizador sin el prefijo LT / P / ST / T ("LT265/65R17" y "265/65R17" son la misma
 * llanta para el historial, el filtro de la ficha y la última venta). El sufijo comercial C se conserva (otra llanta).
 */
export function saleMedida(canonical: string | null | undefined): string | null {
  return canonical ? canonical.replace(/^(LT|P|ST|T)(?=\d)/, "") : null;
}

/** Medida, con dos arreglos de escritura del reporte que el normalizador general no toma: "295/8022.5" y "24.5 32 12PR". */
function sizeOf(text: string) {
  const fixed = normalizeSizeText(text)
    .replace(/(?<![\d.])(\d{3}\/\d{2})(\d{2}\.5)(?![\d.])/, "$1R$2")
    .replace(/^(\d{1,2}\.\d)\s+(\d{2})(?=\s+\d{1,2}\s?PR\b)/, "$1-$2")
    .replace(/^(\d{1,2}\.5)\/(2\d)(?=\s)/, "$1L-$2"); // "19.5/24" = 19.5L-24
  return { size: parseTyreSize(fixed), text: fixed };
}

const DESIGN_NOISE = new Set([
  "TL", "TT", "TCF", "SET", "KOREA", "JP", "JAPON", "INDIA", "CHINA", "THAILAND", "TAILANDIA", "POS", "POST", "DEL", "MIX", "MIXTA", "MIXTO",
  "SUPER", "ON", "OFF", "ON-OFF", "ON/OFF", "TRAC", "TRACCION", "RADIAL", "XL", "RUNFLAT", "RFT", "LLANTAS", "LLANTA", "REC", "SERV", "SERV.",
  "ENLLA", "ENLLAN", "NEUMATICA", "SOLIDA", "IMPLEMENT", "DE", "Y", "+", "ARO", "RECAMBIO", "RECA",
]);

/** Diseño: lo que queda tras quitar las medidas, la marca, lonas, índices de carga/velocidad y palabras de ruido. */
function designOf(text: string, brandAlias: string | null): string | null {
  let norm = normalizeSizeText(text);
  for (const m of findTyreSizes(norm).reverse()) norm = norm.slice(0, m.index) + " " + norm.slice(m.index + m.length);
  // como fold() pero conserva el "+" pegado al final de un diseño ("XZE2+"); un "+" suelto ("LLANTA + ARO") se va
  let t = ` ${up(norm)
    .replace(/[^A-Z0-9+]+/g, " ")
    .replace(/(^|[^A-Z0-9])\++/g, "$1 ")} `.replace(/\s+/g, " ");
  if (brandAlias) t = t.replace(` ${brandAlias.toUpperCase()} `, " ");
  const tokens = t
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !DESIGN_NOISE.has(w))
    .filter((w) => !/^A?\d{1,2}PR$/.test(w)) // lonas
    .filter((w) => !/^\d{2,3}[A-Z]\d?$/.test(w)) // índice de carga y velocidad: 87W, 160A8
    .filter((w, i) => !(i === 0 && /^\d{2,3}$/.test(w))) // resto de "152/148M" al inicio
    .filter((w) => !/^(E|L|G|R|I)\s?\d$/.test(w)); // E-3/L-3, R-4, I-3 (código de banda OTR)
  const out = titleCase(tokens.join(" ").replace(/\s+/g, " ").trim());
  return out || null;
}

/** Clasifica una descripción del reporte de Odoo. */
export function classifyLine(descripcion: string): LineClass {
  const { codigo, resto } = splitCode(descripcion);
  const t = up(resto);
  const base = { codigo, medida: null, marca: null, diseno: null } as const;
  const productCode = !!codigo && PRODUCT_CODE.test(codigo);

  // 1. servicios por código o texto ("SERV. ENLLA <medida>" con código de producto NO es servicio: es la llanta con enllante)
  const textService = /^(SERVICIO|SERV\b|SERV\.|MANTENIMIENTO CORRECTIVO|REPARACION DE NEUMATICOS)/.test(t);
  const sized = sizeOf(resto);
  if ((codigo && SERVICE_CODE.test(codigo)) || (textService && !(productCode && sized.size))) {
    if (codigo && /^AR\d/i.test(codigo)) {
      // [AR0082] "SERV. ENLLA ARO 16" FIERRO": código de aro con texto de servicio
      return { ...base, tipoLinea: "otro", tipoServicio: null, tipoOtro: "aro", seguro: false, nota: "código de aro (AR) con texto de servicio de enllante: se tomó como aro" };
    }
    const tipo = serviceTypeOf(t);
    const nota = /DESENLLANT.*ENLLAN/.test(t) ? "desenllante y enllante en la misma línea: se tomó como desenllante" : null;
    return { ...base, tipoLinea: "servicio", tipoServicio: tipo, tipoOtro: null, seguro: tipo !== "otros" || /CALIBRACION|CAPACITACION|MARCADO|NFU|AUXILIO|REVISION ARO|PITON/.test(t), nota };
  }
  if (codigo && /^AR\d/i.test(codigo) && !/LLANTA/.test(t)) return { ...base, tipoLinea: "otro", tipoServicio: null, tipoOtro: "aro", seguro: true, nota: null };

  // 2. accesorios y cargos (antes que la medida: "ARO 8.25X22.5" o "GUARDACAMARA 7.50-16" traen una medida)
  for (const [re, tipoOtro] of OTHER_RULES) {
    if (re.test(t) && !/\bLLANTA\b/.test(t)) return { ...base, tipoLinea: "otro", tipoServicio: null, tipoOtro, seguro: true, nota: null };
  }

  // 3. neumáticos
  const brand = findBrandInText(resto);
  if (sized.size) {
    const combo = /\bARO\b/.test(t) && /\bLLANTA\b/.test(t);
    return {
      ...base,
      tipoLinea: "neumatico",
      tipoServicio: null,
      tipoOtro: null,
      medida: saleMedida(sized.size.canonical),
      marca: brand?.brand ?? null,
      diseno: designOf(sized.text, brand?.alias ?? null),
      seguro: !combo && (productCode || !codigo),
      nota: combo ? "llanta con aro en la misma línea: se contó como neumático" : productCode || !codigo ? null : `código ${codigo} poco usual para un neumático`,
    };
  }
  if (productCode && (extractPly(resto) !== undefined || brand || extractLoadIndex(resto))) {
    return { ...base, tipoLinea: "neumatico", tipoServicio: null, tipoOtro: null, marca: brand?.brand ?? null, diseno: designOf(sizeOf(resto).text, brand?.alias ?? null), seguro: false, nota: "neumático sin medida reconocida" };
  }

  // 4. el resto: otros productos, por descarte
  const tipoOtro = /HILUX|TOYOTA|VEHICULO/.test(t) ? "vehiculo" : /MACHINE|MAQUINA/.test(t) ? "equipo" : "accesorio";
  return { ...base, tipoLinea: "otro", tipoServicio: null, tipoOtro, seguro: false, nota: "sin regla: se tomó como otro producto" };
}
