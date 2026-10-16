/**
 * The tyre photo library: product pictures downloaded from the providers' web shops and price lists and stored
 * (resized) in our own database, so a quote never depends on a provider keeping a link alive.
 *
 * Sources:
 *   - woocommerce : any WooCommerce shop (public Store API /wp-json/wc/store/v1/products). Products are matched to
 *                   price rows by SKU = provider code; otherwise brand + model are parsed from the product name.
 *   - price-list  : price rows that already carry photoUrl / sheetUrl (Steel).
 *
 * No AI is involved: matching is by code, then by brand/model text.
 *
 * Downloads go through a Fetcher (fetchers.ts): plain HTTP first; when a shop is behind Cloudflare's browser check
 * (403 to curl/Node, as JCH is) the import switches to a real Chrome window automatically.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { PriceRow } from "../ingest/types";
import { stripToModel } from "../ingest/util";
import type { PriceStore, ProductPhoto } from "../store/types";
import { photoKey } from "../store/types";
import { findBrandInText, knownBrand } from "../tyre/brands";
import { findTyreSizes } from "../tyre/spec";
import { BlockedError, browserFetcher, nodeFetcher, type BrowserOptions, type Fetcher } from "./fetchers";

export interface PhotoSource {
  provider: string;
  type: "woocommerce" | "price-list";
  url?: string;
  /** Open Chrome from the start instead of trying plain HTTP first (sites known to be behind Cloudflare). */
  browser?: boolean;
  note?: string;
}

export interface PhotoSourcesConfig {
  sources: PhotoSource[];
  image: { maxPx: number; jpegQuality: number };
}

export function loadPhotoSources(file = path.join(process.cwd(), "config", "photo-sources.json")): PhotoSourcesConfig {
  const raw = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PhotoSourcesConfig>) : {};
  return { sources: raw.sources ?? [], image: { maxPx: raw.image?.maxPx ?? 600, jpegQuality: raw.image?.jpegQuality ?? 80 } };
}

export interface ImportOptions {
  /** Do not write anything; just report what would be stored. */
  dry?: boolean;
  /** Stop after this many products (testing). */
  limit?: number;
  /** Re-download photos we already have. */
  force?: boolean;
  image?: { maxPx: number; jpegQuality: number };
  /** Download with this instead of plain HTTP (tests, or a browser already open). Not closed by the import. */
  fetcher?: Fetcher;
  /** "auto" (default): plain HTTP, then Chrome if the site blocks it · "always": Chrome from the start · "never". */
  browser?: "auto" | "always" | "never";
  browserOptions?: BrowserOptions;
  log?: (line: string) => void;
}

export interface ImportStats {
  provider: string;
  seen: number;
  matchedByCode: number;
  matchedByName: number;
  unmatched: number;
  stored: number;
  skippedExisting: number;
  failed: number;
  samples: string[];
}

/** Download an image and shrink it to a JPEG that fits the PDF (max side `maxPx`). */
export async function fetchAndShrink(url: string, image: { maxPx: number; jpegQuality: number }, fetcher: Fetcher = nodeFetcher()): Promise<Buffer | null> {
  try {
    let buf = await fetcher.bytes(url);
    if (!buf && fetcher.kind === "browser") buf = await nodeFetcher().bytes(url); // e.g. a picture on another domain the page can't read
    if (!buf || buf.length < 500) return null;
    return await sharp(buf).rotate().resize({ width: image.maxPx, height: image.maxPx, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: image.jpegQuality }).toBuffer();
  } catch {
    return null;
  }
}

/** Shrink an image file (from disk) to the library's JPEG size. */
export async function shrinkFile(file: string, image: { maxPx: number; jpegQuality: number }): Promise<Buffer> {
  const buf = fs.readFileSync(file);
  return sharp(buf).rotate().resize({ width: image.maxPx, height: image.maxPx, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: image.jpegQuality }).toBuffer();
}

/** Save one picture from disk under brand + model (a photo the salesman or the client already has). */
export async function importPhotoFile(store: PriceStore, file: string, brand: string, model: string, opts: { image?: { maxPx: number; jpegQuality: number }; force?: boolean } = {}): Promise<"stored" | "exists"> {
  const key = photoKey(brand, model);
  if (!opts.force && (await store.photoKeys()).has(key)) return "exists";
  const data = await shrinkFile(file, opts.image ?? { maxPx: 600, jpegQuality: 80 });
  await store.setPhoto({ key, brand, model, data: data.toString("base64"), mimeType: "image/jpeg", source: "manual", origin: path.basename(file), createdAt: new Date().toISOString() });
  return "stored";
}

/**
 * Every image of a folder named "Marca - Modelo.jpg" (also "Marca_Modelo.jpg"): one photo each.
 * Files whose name has no separator are skipped and reported.
 */
export async function importPhotoDir(store: PriceStore, dir: string, opts: { image?: { maxPx: number; jpegQuality: number }; force?: boolean; log?: (line: string) => void } = {}): Promise<{ stored: number; exists: number; skipped: string[] }> {
  const log = opts.log ?? (() => undefined);
  const out = { stored: 0, exists: 0, skipped: [] as string[] };
  for (const name of fs.readdirSync(dir).sort()) {
    if (!/\.(jpe?g|png|webp)$/i.test(name)) continue;
    const base = name.replace(/\.[^.]+$/, "");
    const m = base.match(/^\s*(.+?)\s*(?:-|_|–)\s*(.+?)\s*$/);
    if (!m) {
      out.skipped.push(name);
      continue;
    }
    const [, brand, model] = m;
    const r = await importPhotoFile(store, path.join(dir, name), brand.trim(), model.trim(), opts);
    if (r === "stored") out.stored++;
    else out.exists++;
    log(`  ${r === "stored" ? "✓" : "="} ${brand.trim()} ${model.trim()} ← ${name}${r === "exists" ? " (ya existía; --force para reemplazar)" : ""}`);
  }
  return out;
}

/** Brand + model from a shop product name ("LLANTA GT RADIAL ADVENTURO AT3 P265/65 R18"). */
export function brandModelFromName(name: string): { brand: string; model: string } | null {
  const clean = name.replace(/^\s*(llanta|neum[aá]tico|nt?co)\s*:?\s*/i, "").trim();
  const b = findBrandInText(clean);
  if (!b) return null;
  const size = findTyreSizes(clean)[0];
  const model = stripToModel(clean, { sizeRaw: size?.raw ?? "", brandAlias: b.alias });
  if (!model) return null;
  return { brand: b.brand, model };
}

interface WooProduct {
  id: number;
  name: string;
  sku: string;
  permalink: string;
  images: { src: string; thumbnail?: string }[];
}

/** Page through a WooCommerce Store API catalogue. Throws BlockedError when the first page is refused (403/503/429). */
export async function* wooProducts(baseUrl: string, fetcher: Fetcher = nodeFetcher(), perPage = 100): AsyncGenerator<WooProduct> {
  const base = baseUrl.replace(/\/+$/, "");
  for (let page = 1; page < 500; page++) {
    const url = `${base}/wp-json/wc/store/v1/products?per_page=${perPage}&page=${page}`;
    const res = await fetcher.json(url);
    if (!res.body) {
      if (page === 1 && [403, 503, 429].includes(res.status)) throw new BlockedError(url, res.status);
      throw new Error(`${url} -> HTTP ${res.status}`);
    }
    const items = res.body as WooProduct[];
    if (!Array.isArray(items) || items.length === 0) return;
    for (const p of items) yield p;
    if (res.totalPages && page >= res.totalPages) return;
    if (items.length < perPage) return;
  }
}

/** The fetcher an import uses and whether it owns it (must close it). Plain HTTP by default; Chrome when asked for. */
async function openFetcher(source: PhotoSource, opts: ImportOptions): Promise<{ fetcher: Fetcher; owned: boolean }> {
  if (opts.fetcher) return { fetcher: opts.fetcher, owned: false };
  const mode = opts.browser ?? (source.browser ? "always" : "auto");
  if (mode === "always") return { fetcher: await browserFetcher({ ...opts.browserOptions, log: opts.log }), owned: true };
  return { fetcher: nodeFetcher(), owned: true };
}

function blankStats(provider: string): ImportStats {
  return { provider, seen: 0, matchedByCode: 0, matchedByName: 0, unmatched: 0, stored: 0, skippedExisting: 0, failed: 0, samples: [] };
}

/** Import photos from a WooCommerce shop into the library. */
export async function importWooCommerce(store: PriceStore, source: PhotoSource, opts: ImportOptions = {}): Promise<ImportStats> {
  if (!source.url) throw new Error(`la fuente ${source.provider} no tiene url`);
  const log = opts.log ?? (() => undefined);
  const image = opts.image ?? { maxPx: 600, jpegQuality: 80 };
  const stats = blankStats(source.provider);
  const rows = await store.allRows();
  const byCode = new Map<string, PriceRow>();
  for (const r of rows) if (r.code && r.provider.toLowerCase() === source.provider.toLowerCase()) byCode.set(r.code.trim().toUpperCase(), r);
  const have = opts.force ? new Set<string>() : await store.photoKeys();
  const done = new Set<string>();
  let { fetcher, owned } = await openFetcher(source, opts);
  if (fetcher.kind === "browser") log("  abriendo Chrome para descargar el catálogo…");

  /** The catalogue, switching to Chrome when plain HTTP is refused before anything was read. */
  async function* products(): AsyncGenerator<WooProduct> {
    try {
      yield* wooProducts(source.url!, fetcher);
    } catch (e) {
      const mode = opts.browser ?? (source.browser ? "always" : "auto");
      if (!(e instanceof BlockedError) || fetcher.kind !== "node" || mode === "never") throw e;
      log(`  ${e.message}: la web no acepta descargas directas (verificación de Cloudflare); abriendo Chrome para pasar por el navegador…`);
      if (owned) await fetcher.close();
      fetcher = await browserFetcher({ ...opts.browserOptions, log });
      owned = true;
      yield* wooProducts(source.url!, fetcher);
    }
  }

  const handle = async (p: WooProduct) => {
    stats.seen++;
    const img = p.images?.[0]?.src;
    if (!img) return;
    const sku = (p.sku ?? "").trim().toUpperCase();
    const row = sku ? byCode.get(sku) : undefined;
    let brand = row?.brand ?? "";
    let model = row?.model ?? "";
    if (row) stats.matchedByCode++;
    else {
      const bm = brandModelFromName(p.name);
      if (!bm) {
        stats.unmatched++;
        if (stats.samples.length < 8) stats.samples.push(`? ${p.name}`);
        return;
      }
      brand = bm.brand;
      model = bm.model;
      stats.matchedByName++;
    }
    const key = photoKey(brand, model);
    if (done.has(key)) return; // one photo per brand+model (sizes share the picture)
    done.add(key);
    if (have.has(key)) {
      stats.skippedExisting++;
      return;
    }
    if (opts.dry) {
      stats.stored++;
      if (stats.samples.length < 8) stats.samples.push(`${brand} ${model} ← ${sku || p.name} (${img})`);
      return;
    }
    const data = await fetchAndShrink(img, image, fetcher);
    if (!data) {
      stats.failed++;
      log(`  ✗ ${brand} ${model}: no se pudo descargar ${img}`);
      return;
    }
    const photo: ProductPhoto = { key, brand, model, url: img, data: data.toString("base64"), mimeType: "image/jpeg", source: "provider", origin: source.provider, code: sku || undefined, createdAt: new Date().toISOString() };
    await store.setPhoto(photo);
    stats.stored++;
    if (stats.stored % 25 === 0) log(`  … ${stats.stored} fotos guardadas (${stats.seen} productos vistos)`);
  };

  try {
    for await (const p of products()) {
      if (opts.limit && stats.seen >= opts.limit) break;
      await handle(p);
    }
  } finally {
    if (owned) await fetcher.close();
  }
  return stats;
}

/** Import photos (and technical sheets) referenced by price rows that carry photoUrl (Steel). */
export async function importFromPriceList(store: PriceStore, source: PhotoSource, opts: ImportOptions = {}): Promise<ImportStats> {
  const log = opts.log ?? (() => undefined);
  const image = opts.image ?? { maxPx: 600, jpegQuality: 80 };
  const stats = blankStats(source.provider);
  const rows = (await store.allRows()).filter((r) => r.photoUrl && r.provider.toLowerCase() === source.provider.toLowerCase());
  const have = opts.force ? new Set<string>() : await store.photoKeys();
  const byKey = new Map<string, PriceRow>();
  for (const r of rows) {
    const key = photoKey(r.brand, r.model);
    if (key.startsWith("|") || key.endsWith("|")) continue;
    const prev = byKey.get(key);
    if (!prev || (r.stock ?? 0) > (prev.stock ?? 0)) byKey.set(key, r); // prefer the in-stock variant's picture
  }
  const { fetcher, owned } = await openFetcher(source, opts);
  try {
    for (const [key, r] of byKey) {
      if (opts.limit && stats.seen >= opts.limit) break;
      stats.seen++;
      stats.matchedByCode++;
      if (have.has(key)) {
        stats.skippedExisting++;
        continue;
      }
      if (opts.dry) {
        stats.stored++;
        if (stats.samples.length < 8) stats.samples.push(`${r.brand} ${r.model} ← ${r.code} (${r.photoUrl})`);
        continue;
      }
      const [photo, sheet] = await Promise.all([fetchAndShrink(r.photoUrl!, image, fetcher), r.sheetUrl ? fetchAndShrink(r.sheetUrl, { maxPx: 900, jpegQuality: image.jpegQuality }, fetcher) : null]);
      if (!photo) {
        stats.failed++;
        log(`  ✗ ${r.brand} ${r.model}: no se pudo descargar ${r.photoUrl}`);
        continue;
      }
      await store.setPhoto({ key, brand: r.brand, model: r.model, url: r.photoUrl, data: photo.toString("base64"), mimeType: "image/jpeg", sheetUrl: r.sheetUrl, sheetData: sheet?.toString("base64"), source: "provider", origin: source.provider, code: r.code, createdAt: new Date().toISOString() });
      stats.stored++;
      if (stats.stored % 25 === 0) log(`  … ${stats.stored} fotos guardadas`);
    }
  } finally {
    if (owned) await fetcher.close();
  }
  return stats;
}

export async function importPhotos(store: PriceStore, source: PhotoSource, opts: ImportOptions = {}): Promise<ImportStats> {
  if (source.type === "woocommerce") return importWooCommerce(store, source, opts);
  if (source.type === "price-list") return importFromPriceList(store, source, opts);
  throw new Error(`tipo de fuente desconocido: ${(source as PhotoSource).type}`);
}

export { knownBrand };
export { BlockedError, browserFetcher, nodeFetcher } from "./fetchers";
export type { Fetcher } from "./fetchers";
