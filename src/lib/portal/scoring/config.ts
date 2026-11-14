/**
 * Corrida G — configuración del puntaje de atractivo (config/portal.json, clave `scoring`). Los pesos y parámetros son
 * una HIPÓTESIS inicial a validar con el vendedor (/portal/validar-ranking y `npm run score:validation-report`).
 */
import { z } from "zod";

export const FACTOR_IDS = ["potencial", "encaje", "espacio", "familiaridad", "cercania", "antiguedad"] as const;
export type FactorId = (typeof FACTOR_IDS)[number];

const WeightsSchema = z.object({
  potencial: z.number().min(0).default(30),
  encaje: z.number().min(0).default(25),
  espacio: z.number().min(0).default(20),
  familiaridad: z.number().min(0).default(10),
  cercania: z.number().min(0).default(10),
  antiguedad: z.number().min(0).default(5),
});

export const ScoringSchema = z.looseObject({
  /** Puntos máximos de cada factor; el puntaje es la suma (sobre 100 si suman 100; si no, se reescala a 0–100). */
  weights: WeightsSchema.prefault({}),
  potencial: z
    .looseObject({
      /** Llantas en piso que valen 1 (escala logarítmica: log(1+llantas)/log(1+llantasRef), tope 1). */
      llantasRef: z.number().int().min(2).default(3000),
    })
    .prefault({}),
  encaje: z
    .looseObject({
      /** Valor de una unidad cuya medida probable tiene stock propio (al menos minStock). */
      conStock: z.number().min(0).max(1).default(1),
      /** Medida en la lista propia o en el stock propio, sin stock suficiente. */
      enCatalogo: z.number().min(0).max(1).default(0.7),
      /** Medida solo en listas de proveedores (se puede conseguir). */
      soloProveedor: z.number().min(0).max(1).default(0.4),
      /** Unidades en stock propio desde las que la medida cuenta "en stock". */
      minStock: z.number().int().min(1).default(4),
    })
    .prefault({}),
  espacio: z
    .looseObject({
      /** Consumo anual estimado = llantas en piso × este factor (no había un supuesto previo en el repo). */
      consumoAnualPorLlanta: z.number().gt(0).max(5).default(0.5),
    })
    .prefault({}),
  familiaridad: z
    .looseObject({
      /**
       * Marcas de vehículo preferidas (como las registra el padrón). Mismo grupo que los accesos rápidos de Prospectos:
       * CNHTC = Sinotruk/Howo/Sitrak; SHAANQI = Shacman. `nombres`: cómo se dicen al vendedor.
       */
      marcas: z.array(z.string().min(1)).default(["SCANIA", "HINO", "SHACMAN", "SHAANQI", "SINOTRUK", "HOWO", "SITRAK", "CNHTC"]),
      nombres: z.record(z.string(), z.string()).default({ SHAANQI: "Shacman", CNHTC: "Sinotruk", HOWO: "Howo", SITRAK: "Sitrak" }),
    })
    .prefault({}),
  cercania: z
    .looseObject({
      /** Departamento (como en el padrón, mayúsculas) -> valor 0–1. Los que no están valen `otros`; sin departamento, 0. */
      departamentos: z.record(z.string(), z.number().min(0).max(1)).default({
        LIMA: 1,
        CALLAO: 1,
        ICA: 0.7,
        JUNIN: 0.6,
        ANCASH: 0.6,
        "LA LIBERTAD": 0.5,
        AREQUIPA: 0.5,
        LAMBAYEQUE: 0.4,
        PIURA: 0.4,
      }),
      otros: z.number().min(0).max(1).default(0.25),
    })
    .prefault({}),
  antiguedad: z
    .looseObject({
      /**
       * Antigüedad media (años) que vale 1 y la que vale 0; entre ambas, lineal y acotado. Por defecto una flota más nueva
       * vale más (renueva llantas nuevas en vez de reencauchar). Para premiar la flota vieja, invertir los números.
       */
      mejor: z.number().min(0).default(5),
      peor: z.number().min(0).default(20),
    })
    .prefault({}),
  niveles: z
    .looseObject({
      /** Parte superior del ranking que es A, y la siguiente que es B; el resto C. */
      a: z.number().gt(0).lt(1).default(0.1),
      b: z.number().gt(0).lt(1).default(0.3),
    })
    .prefault({}),
  frenos: z
    .looseObject({
      /** Estados de crédito que dejan el nivel en C como máximo. */
      creditoTopeC: z.array(z.string()).default(["observado", "rechazado"]),
      /** Oportunidad cerrada perdida en estos últimos días: baja un nivel. */
      perdidaDias: z.number().int().min(1).max(3650).default(90),
    })
    .prefault({}),
  mejores: z
    .looseObject({
      /** Una empresa propia entra en "tus mejores" si nadie registró actividad con ella en estos días. */
      sinActividadDias: z.number().int().min(1).max(365).default(30),
      /** Tamaño del bloque de Hoy y de cada tanda del bot (`mejores` / `más`). */
      hoy: z.number().int().min(1).max(100).default(20),
      bot: z.number().int().min(1).max(10).default(5),
    })
    .prefault({}),
  validacion: z
    .looseObject({
      /** Empresas por ronda de validación y cuántas de cada nivel (se completa con otros niveles si faltan). */
      total: z.number().int().min(3).max(60).default(20),
      porNivel: z.object({ A: z.number().int().min(0), B: z.number().int().min(0), C: z.number().int().min(0) }).default({ A: 7, B: 7, C: 6 }),
    })
    .prefault({}),
});

export type ScoringConfig = z.infer<typeof ScoringSchema>;

/** Los valores por defecto (pruebas y quien no tenga la clave en config/portal.json). */
export function defaultScoringConfig(): ScoringConfig {
  return ScoringSchema.parse({});
}
