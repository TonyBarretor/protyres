/**
 * Corrida G — explicación del puntaje en lenguaje del vendedor, a partir de companies.score_detalle. Sin pesos, sin
 * porcentajes del modelo ni nombres de variables: los números son de la empresa (unidades, llantas, parte de la flota).
 *
 *   explainLine  una línea con los 2–3 factores que más aportan, lo que falta y los frenos:
 *                "82 buses · 586 llantas · 96% en 295/80R22.5, que tienes en stock · Lima · aún no es cliente"
 *   explainWhy   el bloque "Por qué este nivel" de la ficha: cada factor en palabras, con cuánto aporta, y los frenos.
 *
 * El nivel orienta, no decide: la UI y el bot lo presentan siempre como estimación (ESTIMATE_NOTE).
 */
import { fmtInt } from "../ui/labels";
import type { Nivel, ScoreBrake, ScoreDetail, ScoreFactor, ScoreFactorId } from "../store/types";
import { titleCase } from "./score";

export const ESTIMATE_NOTE = "Es una estimación con los datos del padrón y tus ventas: orienta a quién llamar primero, no decide por ti.";

export const NIVEL_LABEL: Record<Nivel, string> = { A: "Nivel A", B: "Nivel B", C: "Nivel C" };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const pct = (part: number, total: number) => (total > 0 ? Math.round((100 * part) / total) : 0);

function depName(dep: string): string {
  return titleCase(dep);
}

function unitsNoun(sector: unknown, n: number): string {
  if (sector === "pasajeros") return n === 1 ? "bus" : "buses";
  return n === 1 ? "unidad" : "unidades";
}

const SIZE_PHRASE: Record<string, string> = {
  stock: "que tienes en stock",
  catalogo: "que está en tu lista",
  proveedor: "que consigues con proveedores",
  no: "que no está en tu catálogo",
};

/** El factor dicho en pocas palabras (null si no aporta nada que decir). */
function factorPhrase(f: ScoreFactor): string | null {
  const d = f.dato;
  switch (f.id) {
    case "potencial": {
      if (f.sinDato) return `${fmtInt(num(d.unidades))} ${unitsNoun(d.sector, num(d.unidades))} · sin dato de llantas`;
      return `${fmtInt(num(d.unidades))} ${unitsNoun(d.sector, num(d.unidades))} · ${fmtInt(num(d.llantas))} llantas`;
    }
    case "encaje": {
      if (f.sinDato) return "sin medida inferida";
      return `${pct(num(d.unidadesMedida), num(d.unidades))}% en ${str(d.medida)}, ${SIZE_PHRASE[str(d.nivelMedida)] ?? SIZE_PHRASE.no}`;
    }
    case "espacio": {
      if (!d.cliente) return "aún no es cliente";
      if (f.sinDato) return "ya es cliente";
      const share = pct(num(d.vendidos12m), num(d.consumoAnual));
      return share >= 100 ? "ya te compra todo lo que consume" : `te compra ~${share}% de lo que consume`;
    }
    case "familiaridad": {
      if (f.sinDato || num(d.unidadesPreferidas) <= 0) return null;
      return `${pct(num(d.unidadesPreferidas), num(d.unidades))}% ${str(d.marcas)}`;
    }
    case "cercania":
      return f.sinDato ? "sin departamento" : depName(str(d.departamento));
    case "antiguedad": {
      if (f.sinDato) return "sin año de la flota";
      const a = Math.round(num(d.anios));
      return `flota de ${a} ${a === 1 ? "año" : "años"} en promedio`;
    }
  }
}

export function brakePhrase(b: ScoreBrake): string {
  if (b.id === "credito") return `crédito ${b.estado}`;
  return b.dias === 0 ? "oportunidad perdida hoy" : `oportunidad perdida hace ${b.dias} ${b.dias === 1 ? "día" : "días"}`;
}

/**
 * Una línea: los 3 factores de la flota que más puntos aportan (en el orden de la línea de ejemplo: tamaño, medidas,
 * marcas, lugar, antigüedad) y siempre si ya es cliente (es lo primero que el vendedor quiere saber), más los datos que
 * faltan y los frenos.
 */
export function explainLine(detail: ScoreDetail | null | undefined): string {
  if (!detail?.factores?.length) return "";
  const ORDER: ScoreFactorId[] = ["potencial", "encaje", "familiaridad", "cercania", "antiguedad", "espacio"];
  const top = new Set<ScoreFactorId>(["espacio"]);
  for (const id of [...detail.factores]
      .filter((f) => f.id !== "espacio" && !f.sinDato && f.puntos > 0)
      .sort((a, b) => b.puntos - a.puntos || ORDER.indexOf(a.id) - ORDER.indexOf(b.id))
      .slice(0, 3)
      .map((f) => f.id))
    top.add(id);
  const parts: string[] = [];
  for (const id of ORDER) {
    const f = detail.factores.find((x) => x.id === id);
    if (!f) continue;
    // lo que falta se dice (vale 0); de lo demás, solo lo que más aporta
    if (!top.has(id) && !f.sinDato) continue;
    if (f.sinDato && id === "familiaridad") continue;
    const p = factorPhrase(f);
    if (p) parts.push(p);
  }
  for (const b of detail.frenos ?? []) parts.push(brakePhrase(b));
  return parts.join(" · ");
}

export const FACTOR_TITLE: Record<ScoreFactorId, string> = {
  potencial: "Tamaño de la flota",
  encaje: "Medidas que vendes",
  espacio: "Espacio por ganar",
  familiaridad: "Marcas de vehículo que conoces",
  cercania: "Cercanía",
  antiguedad: "Antigüedad de la flota",
};

export type Strength = "mucho" | "bastante" | "poco" | "nada";

export function strengthOf(f: ScoreFactor): Strength {
  if (f.sinDato || f.valor <= 0.05) return "nada";
  if (f.valor >= 0.75) return "mucho";
  if (f.valor >= 0.4) return "bastante";
  return "poco";
}

export const STRENGTH_LABEL: Record<Strength, string> = { mucho: "suma mucho", bastante: "suma bastante", poco: "suma poco", nada: "no suma" };

/** Texto largo de un factor para la ficha. */
function factorSentence(f: ScoreFactor): string {
  const d = f.dato;
  switch (f.id) {
    case "potencial":
      return f.sinDato
        ? `${fmtInt(num(d.unidades))} ${unitsNoun(d.sector, num(d.unidades))}, pero el padrón no trae sus llantas: no suma hasta tener el dato.`
        : `${fmtInt(num(d.unidades))} ${unitsNoun(d.sector, num(d.unidades))} con ${fmtInt(num(d.llantas))} llantas en piso.`;
    case "encaje":
      if (f.sinDato) return "No se pudo inferir la medida de sus unidades: no suma hasta tenerla.";
      return `${pct(num(d.unidadesMedida), num(d.unidades))}% de la flota usa ${str(d.medida)}, ${SIZE_PHRASE[str(d.nivelMedida)] ?? SIZE_PHRASE.no}. ${pct(num(d.unidadesEnCatalogo), num(d.unidades))}% de sus unidades usa medidas que manejas.`;
    case "espacio":
      if (!d.cliente) return d.soloDemo ? "Aún no es cliente (sus ventas cargadas son de demostración y no cuentan)." : "Aún no es cliente: todo su consumo está por ganar.";
      if (f.sinDato) return "Ya es cliente, pero sin llantas en piso no se puede estimar cuánto más consume.";
      return `Le vendiste ${fmtInt(num(d.vendidos12m))} llantas en 12 meses de unas ${fmtInt(num(d.consumoAnual))} que consume al año (estimado).`;
    case "familiaridad":
      if (f.sinDato || num(d.unidadesPreferidas) <= 0) return "Ninguna unidad de las marcas de vehículo que mejor conoces.";
      return `${pct(num(d.unidadesPreferidas), num(d.unidades))}% de la flota es ${str(d.marcas)}.`;
    case "cercania":
      return f.sinDato ? "El padrón no trae su departamento: no suma." : `Opera sobre todo en ${depName(str(d.departamento))}.`;
    case "antiguedad":
      return f.sinDato ? "Sin año de fabricación de la flota: no suma." : `Sus unidades tienen ${Math.round(num(d.anios))} años en promedio.`;
  }
}

export interface WhyItem {
  id: ScoreFactorId;
  titulo: string;
  texto: string;
  fuerza: Strength;
  /** 0–1, para una barra (sin números a la vista). */
  valor: number;
}

/** El bloque "Por qué este nivel": los factores de más a menos aporte y los frenos en palabras. */
export function explainWhy(detail: ScoreDetail | null | undefined): { factores: WhyItem[]; frenos: string[] } {
  if (!detail?.factores?.length) return { factores: [], frenos: [] };
  const factores = [...detail.factores]
    .sort((a, b) => b.puntos - a.puntos)
    .map((f) => ({ id: f.id, titulo: FACTOR_TITLE[f.id], texto: factorSentence(f), fuerza: strengthOf(f), valor: f.sinDato ? 0 : f.valor }));
  const frenos = (detail.frenos ?? []).map((b) =>
    b.id === "credito" ? `Crédito ${b.estado}: el nivel queda en C como máximo.` : `${brakePhrase(b).replace(/^o/, "O")}: baja un nivel.`,
  );
  return { factores, frenos };
}
