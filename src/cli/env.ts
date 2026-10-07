import "dotenv/config";

export function fmtTable(rows: Record<string, string | number | null | undefined>[]): string {
  if (rows.length === 0) return "(sin filas)";
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (vals: (string | number | null | undefined)[]) => vals.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ");
  return [line(cols), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(cols.map((c) => r[c])))].join("\n");
}
