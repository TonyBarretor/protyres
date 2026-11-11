/**
 * Cruce del texto `vendedor` de las ventas (y de las claves de `goals.users`) con los usuarios del portal. Puro.
 *
 * Regla tolerante (decisión C2), en orden:
 *  1. Si el texto trae un número de 8+ dígitos, se compara con el WhatsApp del usuario.
 *  2. Se comparan los nombres sin tildes, sin mayúsculas y por palabras (de 2+ letras): coincide si todas las palabras
 *     del nombre más corto están en el más largo ("Frank" ↔ "Frank Rodríguez"; "FRANK RODRIGUEZ MIRANO" ↔ "Frank Rodríguez").
 *  3. Si coinciden varios usuarios, gana el que coincide exacto; si no hay uno exacto, la venta queda "sin vendedor
 *     identificado" (no se le atribuye a nadie, pero sí cuenta en el total del equipo).
 */
import { digits, foldText } from "../store/shared";
import type { PortalUser } from "../store/types";

type UserLike = Pick<PortalUser, "id" | "nombre" | "whatsapp">;

export function nameTokens(s: string | null | undefined): string[] {
  return foldText(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/** true si los dos nombres se refieren a la misma persona según la regla 2. */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const set = new Set(long);
  return short.every((t) => set.has(t));
}

/** Usuario al que corresponde el texto (WhatsApp o nombre), o null si no hay uno claro. */
export function matchUser<U extends UserLike>(text: string | null | undefined, users: readonly U[]): U | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const num = digits(raw);
  if (num.length >= 8) {
    const byPhone = users.find((u) => u.whatsapp && digits(u.whatsapp) === num);
    if (byPhone) return byPhone;
  }
  const candidates = users.filter((u) => namesMatch(raw, u.nombre));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const exact = candidates.filter((u) => nameTokens(u.nombre).join(" ") === nameTokens(raw).join(" "));
    if (exact.length === 1) return exact[0];
  }
  return null;
}

/** Memoriza el cruce por texto (muchas ventas con el mismo `vendedor`). Devuelve el id del usuario o null. */
export function vendorMatcher(users: readonly UserLike[]): (vendedor: string | null | undefined) => number | null {
  const cache = new Map<string, number | null>();
  return (vendedor) => {
    const key = (vendedor ?? "").trim();
    if (!cache.has(key)) cache.set(key, matchUser(key, users)?.id ?? null);
    return cache.get(key)!;
  };
}
