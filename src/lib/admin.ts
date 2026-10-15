/**
 * Administrators of the bot: ADMIN_NUMBERS=18605180534,51955344340 (WhatsApp numbers, digits only, with country code).
 * Only they can register a new provider from WhatsApp ("proveedor nuevo: NOMBRE") or delete one ("borrar proveedor
 * NOMBRE"). With ADMIN_NUMBERS empty nobody can (the CLI `npm run ingest` still can).
 */
export function adminNumbers(): string[] {
  return (process.env.ADMIN_NUMBERS ?? "")
    .split(",")
    .map((s) => s.replace(/\D/g, ""))
    .filter(Boolean);
}

export function isAdmin(phone: string | undefined): boolean {
  const p = (phone ?? "").replace(/\D/g, "");
  return !!p && adminNumbers().includes(p);
}
