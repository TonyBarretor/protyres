/**
 * Textos fijos de la pre-propuesta (config/prepropuesta.json), validados con zod. Ningún texto puede quedar vacío: un
 * campo vacío sería un hueco visible en el PDF. Cada cifra de los casos lleva su fuente (documento y página).
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const text = z.string().trim().min(1);

export const FuenteSchema = z.object({
  /** Nombre legible del documento ("Informe ejecutivo semestral ANCRO S.R.L."). */
  documento: text,
  /** Archivo de referencia en data/referencia-360tyres/. */
  archivo: text,
  /** Página o páginas ("1", "1-2"). */
  pagina: text,
});
export type Fuente = z.infer<typeof FuenteSchema>;

const PuntoSchema = z.object({ destacado: text, texto: text, fuente: text });

const ValorSchema = z.object({
  /** Número tal cual del documento (alto de la barra). */
  valor: z.number().positive(),
  /** Cómo se escribe en el documento ("US$ 290"). */
  texto: text,
  periodo: text,
});

const ComparativoSchema = z.object({ etiqueta: text, antes: ValorSchema, despues: ValorSchema, variacion: text, fuente: FuenteSchema });

const IndicadorSchema = z.object({ valor: text, texto: text, fuente: FuenteSchema });

const CasoSchema = z.object({
  cliente: text,
  titulo: text,
  contexto: text,
  contextoFuente: FuenteSchema,
  comparativos: z.array(ComparativoSchema).max(2).default([]),
  indicadores: z.array(IndicadorSchema).min(1).max(4),
  detalle: text.optional(),
  detalleFuente: FuenteSchema.optional(),
  nota: text.optional(),
  notaFuente: FuenteSchema.optional(),
});
export type CasoConfig = z.infer<typeof CasoSchema>;

export const PrepropuestaConfigSchema = z.looseObject({
  documento: z.object({
    titulo: text,
    subtitulo: text,
    saludo: text,
    introduccion: text,
    pie: text,
    pieFuente: text.optional(),
  }),
  quienesSomos: z.object({
    titulo: text,
    puntos: z.array(PuntoSchema).min(1).max(6),
    serviciosTitulo: text,
    serviciosIntro: text,
    servicios: z.array(text).min(1).max(14),
    serviciosFuente: text,
    productos: text,
    productosFuente: text,
    marcasTitulo: text,
    marcas: z.array(text).min(1).max(16),
    marcasFuente: text,
  }),
  casos: z.object({ titulo: text, principal: CasoSchema, secundario: CasoSchema }),
  flota: z.object({
    titulo: text,
    intro: text,
    nota: text,
    flotaTitulo: text,
    medidasTitulo: text,
    participacionTexto: text,
  }),
  propuesta: z.object({
    titulo: text,
    intro: text,
    // `_validar`: nota interna (no se dibuja) para textos que no salen de un documento y hay que confirmar con 360 Tyres
    pasos: z.array(z.object({ titulo: text, texto: text, _validar: z.string().optional() })).min(1).max(4),
    cierre: text,
    contactoTitulo: text,
    firma: text,
  }),
});
export type PrepropuestaConfig = z.infer<typeof PrepropuestaConfigSchema>;

export function prepropuestaConfigPath(): string {
  return process.env.PREPROPUESTA_CONFIG || path.join(process.cwd(), "config", "prepropuesta.json");
}

/** Valida un objeto ya leído (tests). Lanza con el detalle de zod. */
export function parsePrepropuestaConfig(raw: unknown, source = "config/prepropuesta.json"): PrepropuestaConfig {
  const parsed = PrepropuestaConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${source} inválido: ${parsed.error.message}`);
  return parsed.data;
}

let cached: PrepropuestaConfig | null = null;

/** config/prepropuesta.json (memorizado; `force` lo vuelve a leer). */
export function loadPrepropuestaConfig(force = false): PrepropuestaConfig {
  if (cached && !force) return cached;
  const file = prepropuestaConfigPath();
  if (!fs.existsSync(/* turbopackIgnore: true */ file)) throw new Error(`No existe ${file} (textos de la pre-propuesta).`);
  cached = parsePrepropuestaConfig(JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")), file);
  return cached;
}

/** Reemplaza {empresa} en un texto de la config. */
export function fillText(template: string, vars: { empresa: string }): string {
  // "flota de {empresa}." con "ZBUSS S.A.C." no debe quedar "S.A.C.."
  const e = vars.empresa.trim();
  return template.replace(/\{empresa\}(\.?)/g, (_m, dot: string) => (dot && e.endsWith(".") ? e : `${e}${dot}`));
}
