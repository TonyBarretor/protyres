/** Secondary attributes found next to a size: ply rating, load/speed index, position, tube type. */
import { findTyreSizes, normalizeSizeText } from "./spec";

export type Position = "DEL" | "TRAC" | "MIX" | "OTR" | "TRL";

export const POSITION_LABEL: Record<Position, string> = {
  DEL: "Delantera",
  TRAC: "Tracción / posterior",
  MIX: "Mixta / all position",
  OTR: "Fuera de carretera",
  TRL: "Trailer",
};

/** "16PR", "16 PR", "12 PLY", "14 lonas" -> 16 / 12 / 14 */
export function extractPly(text: string): number | undefined {
  const m = text.toUpperCase().match(/\b(\d{1,2})\s*(?:PR|PLY|P\.R\.|LONAS|CAPAS)\b/);
  return m ? parseInt(m[1], 10) : undefined;
}

/** Blank out every tyre size so "295/80" is never read as a load index. */
function withoutSizes(text: string): string {
  let t = normalizeSizeText(text);
  for (const s of findTyreSizes(t)) t = t.slice(0, s.index) + " ".repeat(s.length) + t.slice(s.index + s.length);
  return t;
}

const plausibleIndex = (n: number) => n >= 60 && n <= 199;

/** Load/speed index anywhere in the text: "152/148M", "141/139 M", "152/149 J", "108S", "(160L)", "73T". */
export function extractLoadIndex(text: string): { loadIndex: string; speedIndex?: string } | undefined {
  const sized = findTyreSizes(text).find((s) => s.loadIndex);
  if (sized?.loadIndex) return { loadIndex: sized.loadIndex, speedIndex: sized.speedIndex };
  const t = withoutSizes(text);
  for (const m of t.matchAll(/(?<![\d/.])(\d{2,3})\/(\d{2,3})(?:\s?([A-Z]))?(?![A-Z0-9/])/g)) {
    if (plausibleIndex(parseInt(m[1], 10)) && plausibleIndex(parseInt(m[2], 10))) return { loadIndex: `${m[1]}/${m[2]}`, speedIndex: m[3] || undefined };
  }
  for (const m of t.matchAll(/(?<![\d/.])(\d{2,3})\s?([A-Z])(?![A-Z0-9])/g)) {
    if (plausibleIndex(parseInt(m[1], 10)) && m[2] !== "X") return { loadIndex: m[1], speedIndex: m[2] };
  }
  return undefined;
}

/** DEL / POST / MIXTA / TRACCION ... -> normalized position. */
export function extractPosition(text: string): Position | undefined {
  // accents first ("TRACCIÓN" must read as TRACCION), then anything else becomes a space
  const t = ` ${text.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9/ ]+/g, " ")} `;
  if (/\b(OTR|OFF THE ROAD|ON\/OFF|MINERA|MINERO)\b/.test(t)) return "OTR";
  if (/\b(DEL|DELANTERA|DELANTERAS|DELANTERO|DIRECCIONAL|DIRECCION|STEER|FRONT)\b/.test(t)) return "DEL";
  if (/\b(MIX|MIXTA|MIXTO|MIXTAS|ALL POSITION|AP|REGIONAL)\b/.test(t)) return "MIX";
  if (/\b(POST|POSTERIOR|POSTERIORES|TRACC|TRACCION|TRAC|TRACTION|DRIVE|LUG|REAR)\b/.test(t)) return "TRAC";
  if (/\b(TRAILER|TRL|REMOLQUE)\b/.test(t)) return "TRL";
  return undefined;
}

/** TL (tubeless) / TT (tube type; "TCF" and "SET" mean tyre + tube + flap). */
export function extractTube(text: string): "TL" | "TT" | undefined {
  const t = ` ${text.toUpperCase()} `;
  if (/\bTL\b|TUBELESS|SIN CAMARA|SIN CÁMARA/.test(t)) return "TL";
  if (/\bTT\b|\bTCF\b|\bSET\b|CON CAMARA|CON CÁMARA|TUBE TYPE/.test(t)) return "TT";
  return undefined;
}
