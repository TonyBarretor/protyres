/**
 * Corrida K — Match Venta: configuración (config/portal.json, clave `match`). Todo lo que el jefe comercial o el técnico
 * pueden querer ajustar sin tocar código: pesos del porcentaje, mínimos, almacenes que forman "Lima", tabla de
 * equivalencias de medida, reglas de aplicación, exclusiones (Estado, leasing), cortes de tamaño de flota y la siembra de
 * productos prioritarios.
 */
import { z } from "zod";

const AplicacionSchema = z.looseObject({
  /** "traccion", "delantera", "mixta", "camioneta" */
  id: z.string().min(1),
  /** Texto para el vendedor en el desglose ("minería y carga pesada"). */
  nombre: z.string().min(1),
  /** La aplicación del producto la contiene (sin tildes ni mayúsculas): "traccion", "on/off". */
  palabras: z.array(z.string()).default([]),
  /** Suma estos puntos (sin pasar de 100) a la empresa que cumple alguna condición de `sube`. Nunca excluye. */
  puntos: z.number().min(0).max(30).default(5),
  sube: z
    .looseObject({
      /** Sector del padrón (carga / pasajeros / mixto). */
      sectores: z.array(z.string()).default([]),
      /** Clases de vehículo (OMNIBUS, REMOLCADOR...) que forman al menos `minPorcionClases` de la flota. */
      clases: z.array(z.string()).default([]),
      minPorcionClases: z.number().min(0).max(1).default(0.2),
      /** Palabras de la razón social ("MINER", "CONSTRUC"). */
      razonSocial: z.array(z.string()).default([]),
    })
    .prefault({}),
  /** La medida casi no sale del padrón (camionetas): el cruce se apoya en ventas reales; se dice en la pantalla. */
  soloVentas: z.boolean().default(false),
});

const EquivalenciaSchema = z.looseObject({
  /** Mismo aro y diámetro exterior dentro de la tolerancia: "migración posible". */
  migracion: z.array(z.looseObject({ desde: z.string(), diferenciaPct: z.number() })).default([]),
  /** Mismo aro, fuera de la tolerancia: "requiere revisión técnica" (aparte, nunca como match). */
  revision: z.array(z.looseObject({ desde: z.string(), diferenciaPct: z.number() })).default([]),
});

export const MatchSchema = z.looseObject({
  /** Almacenes que forman el stock "Lima" (como quedan en stockByWarehouse del reporte de Odoo). */
  almacenesLima: z.array(z.string()).default(["San Luis", "Callao"]),
  /** Pesos del porcentaje de match (suman 100). */
  pesos: z
    .looseObject({ encaje: z.number().min(0).default(50), volumen: z.number().min(0).default(35), historial: z.number().min(0).default(15) })
    .prefault({}),
  /** Con menos llantas en piso en la medida, el factor Volumen vale 0. */
  minLlantasVolumen: z.number().int().min(0).default(6),
  /**
   * Volumen = llantas en piso / (volumenReferencia × disponible de la medida), tope 1. Con 1 (la regla de la
   * especificación) el tope se alcanza con ~10 camiones; ver el ajuste en config/portal.json.
   */
  volumenReferencia: z.number().min(0.1).max(20).default(1),
  /** Las listas muestran desde este porcentaje (las que ya compraron la medida salen siempre). */
  minPctLista: z.number().int().min(0).max(100).default(30),
  /** Historial: compró esa medida / es cliente de otras medidas. */
  historial: z.looseObject({ compro: z.number().min(0).max(1).default(1), clienteOtras: z.number().min(0).max(1).default(0.5) }).prefault({}),
  /** Migración de medida: tolerancia del diámetro exterior (0,03 = ±3%) y factor sobre el encaje. */
  migracion: z.looseObject({ tolerancia: z.number().min(0).max(0.2).default(0.03), factor: z.number().min(0).max(1).default(0.5) }).prefault({}),
  /**
   * Perfil nominal (%) de las medidas sin perfil ("12R22.5", "11R22.5"): por aro, "default" para el resto. 85 en aro
   * 22.5/19.5/17.5 da 1090 mm para 12R22.5 y 1047 mm para 11R22.5 (catálogos: 1085 y 1054 mm).
   */
  perfilConvencional: z.record(z.string(), z.number().min(30).max(120)).default({ "22.5": 85, "19.5": 85, "17.5": 85, default: 95 }),
  /** Tabla de equivalencias por medida prioritaria (generada con `npm run match:equivalencias`; editable). */
  equivalencias: z.record(z.string(), EquivalenciaSchema).default({}),
  /** Cortes del filtro de tamaño de flota (unidades): [10, 30, 100] -> 10 a 29, 30 a 99, 100 o más. */
  cortesFlota: z.array(z.number().int().min(1)).min(1).default([10, 30, 100]),
  /** "Podría llevar ~N": llantas en piso en la medida × este factor (reposición de un año), con tope en el disponible. */
  podriaLlevarFactor: z.number().min(0).max(2).default(0.5),
  /** Vista por empresa: cada producto adicional con match sube el orden estos puntos. */
  bonusPorMatchExtra: z.number().min(0).max(20).default(3),
  /** Llantas de un vehículo sin N_LLANTAS en el padrón, por número de ejes ("default" sin ejes). */
  llantasPorEjes: z.record(z.string(), z.number().int().min(1)).default({ "1": 2, "2": 6, "3": 10, "4": 14, default: 6 }),
  /** Reposición: con una sola compra, pasado este plazo (días) se sugiere reponer. */
  reposicionDias: z.number().int().min(30).default(180),
  /** Reparto de visitas: visitas por día. */
  visitasPorDia: z.number().int().min(1).max(12).default(4),
  /** Lo que no es neumático (aros, cámaras, servicios): queda fuera de Match Venta. Expresiones sobre la descripción. */
  noNeumatico: z.array(z.string()).default(["^ARO\\b", "\\bCAMARA\\b", "GUARDACAMARA", "^SERV", "REENCAUCHE", "PROTECTOR", "VALVULA", "PARCHE"]),
  /** Excluidas por defecto (filtro para incluirlas): entidades del Estado por razón social; bancos de leasing por RUC (sales.leasingRucs) y palabras. */
  excluir: z
    .looseObject({
      estado: z
        .array(z.string())
        .default([
          "MUNICIPALIDAD",
          "GOBIERNO REGIONAL",
          "MINISTERIO",
          "PROYECTO ESPECIAL",
          "PROGRAMA NACIONAL",
          "EJERCITO",
          "POLICIA NACIONAL",
          "MARINA DE GUERRA",
          "FUERZA AEREA",
          "SUPERINTENDENCIA",
          "INSTITUTO NACIONAL",
          "UNIVERSIDAD NACIONAL",
          "SEGURO SOCIAL",
          "PODER JUDICIAL",
          "MINISTERIO PUBLICO",
          "PROVIAS",
          "SERVICIO DE AGUA POTABLE",
        ]),
      leasing: z.array(z.string()).default(["LEASING", "BANCO "]),
    })
    .prefault({}),
  aplicaciones: z.array(AplicacionSchema).default([]),
  /** Siembra (idempotente: solo agrega códigos que no están; nunca vuelve a prender una prioridad quitada). */
  productos: z.array(z.looseObject({ codigo: z.string().min(1), aplicacion: z.string().nullable().default(null), prioridad: z.boolean().default(true) })).default([]),
});

export type MatchConfig = z.infer<typeof MatchSchema>;
export type MatchAplicacionRule = z.infer<typeof AplicacionSchema>;
export type MatchEquivalencia = z.infer<typeof EquivalenciaSchema>;

/** Defaults (pruebas): la config de portal.json sin claves. */
export function defaultMatchConfig(over: Partial<MatchConfig> = {}): MatchConfig {
  return MatchSchema.parse(over);
}
