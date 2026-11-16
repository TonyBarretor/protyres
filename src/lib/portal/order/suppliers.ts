/**
 * Corrida H, punto 3b: lista de proveedores (a quién se le compra lo que no está en stock propio).
 *
 * Fuente: el Excel de contactos del vendedor (EMPRESA · CONTACTO · TELEFONO · CORREO · MARCAS), importado con
 * `npm run portal:import-suppliers -- <archivo.xlsx>` a la tabla `suppliers` (datos del sistema, nunca en git: el Excel
 * y los teléfonos viven bajo data/). Este módulo es puro: lee el Excel, empareja cada proveedor con el proveedor del
 * cotizador (config/providers.json y las listas de precios: "JCH LLANTAS" -> "JCH", "STEELS Y ASOCIADOS" -> "Steel") y
 * sugiere a quién pedir una marca que no está en ninguna lista (columna MARCAS; "CHINAS" vale para las marcas chinas
 * de quote.brandOrigin; los que "VENDEN DE TODO" solo si ningún otro la nombra).
 */
import ExcelJS from "exceljs";
import { modelSimilarity } from "../../quote/match";
import { fold, knownBrand } from "../../tyre/brands";
import { foldKey, supplierKey, type Supplier } from "../../store/types";

const HEADERS: Record<"name" | "contact" | "phone" | "email" | "brands", RegExp> = {
  name: /^(?:empresa|proveedor|razon social)$/,
  contact: /^(?:contacto|persona de contacto|vendedor)$/,
  phone: /^(?:telefono|celular|cel|movil|whatsapp)$/,
  email: /^(?:correo|email|e mail|mail)$/,
  brands: /^(?:marcas?|rubro|productos)$/,
};

const cellText = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v && typeof v.text === "string") return v.text;
    if ("result" in v) return String(v.result ?? "");
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v);
};

/** "WEST LAKE - CONTINENTAL - DUNLOP" / "CAMARAS, PROTECTORES" -> ["WEST LAKE", "CONTINENTAL", "DUNLOP"]. */
export function splitBrands(text: string): string[] {
  return text
    .split(/\s+-\s+|,|;|\/|\n/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Teléfono como se escribe en el pedido: solo dígitos agrupados ("987 654 321"); vacío si no hay. */
export function cleanPhone(text: string): string {
  const d = text.replace(/\D/g, "");
  if (/^9\d{8}$/.test(d)) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  return text.replace(/\s+/g, " ").trim();
}

/** Lee el Excel de contactos: la primera hoja con encabezados EMPRESA y MARCAS (en cualquier columna y fila). */
export async function parseSuppliersXlsx(buffer: Buffer): Promise<{ suppliers: Supplier[]; warnings: string[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const warnings: string[] = [];
  for (const ws of wb.worksheets) {
    let header = 0;
    const cols: Partial<Record<keyof typeof HEADERS, number>> = {};
    for (let r = 1; r <= Math.min(ws.rowCount, 30) && !header; r++) {
      const row = ws.getRow(r);
      const found: Partial<Record<keyof typeof HEADERS, number>> = {};
      row.eachCell((c, col) => {
        const t = fold(cellText(c.value));
        for (const [k, re] of Object.entries(HEADERS) as [keyof typeof HEADERS, RegExp][]) if (re.test(t) && found[k] === undefined) found[k] = col;
      });
      if (found.name !== undefined && (found.brands !== undefined || found.phone !== undefined)) {
        header = r;
        Object.assign(cols, found);
      }
    }
    if (!header) continue;
    const out = new Map<string, Supplier>();
    for (let r = header + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const get = (k: keyof typeof HEADERS) => (cols[k] !== undefined ? cellText(row.getCell(cols[k]!).value).replace(/\s+/g, " ").trim() : "");
      const name = get("name");
      if (!name) continue;
      const key = supplierKey(name);
      if (!key) continue;
      if (out.has(key)) warnings.push(`${name}: aparece dos veces; uso la última fila (${r}).`);
      out.set(key, {
        key,
        name: name.toUpperCase(),
        contact: get("contact") || undefined,
        phone: cleanPhone(get("phone")) || undefined,
        email: get("email") || undefined,
        brands: splitBrands(get("brands")).map((b) => b.toUpperCase()),
      });
    }
    return { suppliers: [...out.values()], warnings };
  }
  return { suppliers: [], warnings: ["No encontré una hoja con los encabezados EMPRESA y MARCAS (o TELEFONO)."] };
}

const tokens = (s: string) =>
  fold(s)
    .split(/\s+/)
    .map((t) => t.replace(/s$/, ""))
    .filter((t) => t.length > 1 && !/^(?:y|cia|sac|sa|srl|eirl|del?|la|los|comercial|llanta|asociado)$/.test(t));

/**
 * Proveedor del cotizador para un proveedor de la lista: el que dice `overrides` (config/portal.json
 * orders.supplierProviders), o el que comparte la primera palabra significativa del nombre ("JCH LLANTAS" ~ "JCH",
 * "STEELS Y ASOCIADOS" ~ "Steel"); `aliases` = otros nombres del proveedor del cotizador ("J.CH. Comercial").
 */
export function providerForSupplier(name: string, providers: { name: string; aliases?: string[] }[], overrides: Record<string, string> = {}): string | undefined {
  const k = supplierKey(name);
  const ov = Object.entries(overrides).find(([s]) => supplierKey(s) === k)?.[1];
  if (ov) return providers.find((p) => foldKey(p.name) === foldKey(ov))?.name ?? ov;
  const st = tokens(name);
  if (!st.length) return undefined;
  for (const p of providers) {
    for (const n of [p.name, ...(p.aliases ?? [])]) {
      const pt = tokens(n);
      if (pt.length && pt[0] === st[0]) return p.name;
      if (foldKey(n) === k) return p.name;
    }
  }
  return undefined;
}

/** El proveedor de la lista que corresponde a un proveedor del cotizador ("JCH" -> JCH LLANTAS); undefined si no hay. */
export function supplierForProvider(provider: string, suppliers: Supplier[], overrides: Record<string, string> = {}): Supplier | undefined {
  const k = foldKey(provider);
  return (
    suppliers.find((x) => x.provider && foldKey(x.provider) === k) ??
    suppliers.find((x) => x.key === k) ??
    suppliers.find((x) => providerForSupplier(x.name, [{ name: provider }], overrides) === provider)
  );
}

/** Proveedor de la lista por lo que escribió el vendedor ("jch", "steel", "global tires", "van"). */
export function findSupplier(text: string, suppliers: Supplier[]): Supplier | undefined {
  const k = foldKey(text);
  if (!k) return undefined;
  const exact = suppliers.find((x) => x.key === k || (x.provider && foldKey(x.provider) === k));
  if (exact) return exact;
  const st = tokens(text);
  const byToken = suppliers.filter((x) => st.length && tokens(x.name)[0] === st[0]);
  if (byToken.length === 1) return byToken[0];
  const starts = suppliers.filter((x) => x.key.startsWith(k));
  return starts.length === 1 ? starts[0] : undefined;
}

const GENERIC = /vende de todo|de todo/;

/**
 * A qué proveedores pedir una marca que no está en ninguna lista: los que la nombran en MARCAS (también con otra
 * grafía: "MICHELLIN", "WEST LAKE"), luego los de "CHINAS" si la marca es china (`origin` de quote.brandOrigin) y al
 * último recurso (si nadie más) los que "venden de todo". Máximo `limit`.
 */
export function suggestSuppliers(brand: string, suppliers: Supplier[], opts: { origin?: string; limit?: number } = {}): Supplier[] {
  const want = fold(knownBrand(brand) ?? brand).replace(/\s+/g, "");
  if (!want) return [];
  const direct: Supplier[] = [];
  const chinese: Supplier[] = [];
  const generic: Supplier[] = [];
  for (const x of suppliers) {
    const bs = x.brands.map((b) => fold(knownBrand(b) ?? b).replace(/\s+/g, ""));
    if (bs.some((b) => b === want || (b.length >= 4 && want.length >= 4 && (b.startsWith(want) || want.startsWith(b) || modelSimilarity(b, want) >= 0.85)))) direct.push(x);
    else if (opts.origin && /china/i.test(opts.origin) && bs.some((b) => /^chinas?$/.test(b))) chinese.push(x);
    else if (x.brands.some((b) => GENERIC.test(fold(b)))) generic.push(x);
  }
  // "vende de todo" solo cuando nadie más la nombra
  const named = [...direct, ...chinese];
  return (named.length ? named : generic).slice(0, opts.limit ?? 3);
}

/** "*VAN LLANTAS* (Rosario Valverde, 987 654 321)" */
export function supplierLabel(x: Supplier): string {
  const who = [x.contact ? x.contact.replace(/\b\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()) : "", x.phone ?? ""].filter(Boolean).join(", ");
  return `*${x.name}*${who ? ` (${who})` : ""}`;
}
