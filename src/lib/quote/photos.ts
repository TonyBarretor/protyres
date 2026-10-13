/**
 * Product photos for quotes.
 *
 *   1. the chosen price row carries a photo (Steel publishes one per product)
 *   2. the photos table (uploaded through WhatsApp with "foto <marca> <modelo>", or a web result the salesman approved)
 *   3. any other price row of the same brand+model that has a photo (a Steel photo used for an own-stock item)
 *   4. optional web image search (Google Custom Search) – only proposed to the salesman, never used without approval
 */
import type { PriceStore, ProductPhoto } from "../store/types";
import { photoKey } from "../store/types";
import type { Quote, QuoteItem } from "./types";

export interface ResolvedPhoto {
  url?: string;
  data?: Buffer;
  mimeType?: string;
  sheetUrl?: string;
  source: string;
}

export async function findPhoto(store: PriceStore, brand: string, model: string): Promise<ResolvedPhoto | null> {
  if (!brand || !model) return null;
  const saved = await store.getPhoto(brand, model);
  if (saved) return fromSaved(saved);
  const rows = await store.rowsWithPhoto(brand, model);
  const row = rows.find((r) => r.photoUrl);
  if (row) return { url: row.photoUrl, sheetUrl: row.sheetUrl, source: row.provider };
  return null;
}

function fromSaved(p: ProductPhoto): ResolvedPhoto {
  return {
    url: p.url,
    data: p.data ? Buffer.from(p.data, "base64") : undefined,
    mimeType: p.mimeType,
    sheetUrl: p.sheetData ? `data:image/jpeg;base64,${p.sheetData}` : p.sheetUrl,
    source: p.source === "whatsapp" ? "WhatsApp" : p.source === "web" ? "web" : p.origin ?? (p.source === "provider" ? "proveedor" : "manual"),
  };
}

/** Fill `photoUrl` / `sheetUrl` on every item that has none. Uploaded photos become data: URIs. */
export async function attachPhotos(quote: Quote, store: PriceStore): Promise<number> {
  let found = 0;
  for (const it of quote.items) {
    if (it.photoUrl) {
      found++;
      continue;
    }
    const p = await findPhoto(store, it.brand, it.model);
    if (!p) continue;
    if (p.data) it.photoUrl = `data:${p.mimeType ?? "image/jpeg"};base64,${p.data.toString("base64")}`;
    else it.photoUrl = p.url;
    it.sheetUrl = it.sheetUrl ?? p.sheetUrl;
    it.photoSource = p.source;
    found++;
  }
  return found;
}

export function itemsWithoutPhoto(quote: Quote): QuoteItem[] {
  return quote.items.filter((it) => !it.photoUrl);
}

/** Download an image (or decode a data: URI) with a timeout. Returns null on any failure so the PDF still renders. */
export async function loadImage(src: string, timeoutMs = 8000): Promise<{ data: Buffer; mimeType: string } | null> {
  const dataUri = src.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUri) return { data: Buffer.from(dataUri[2], "base64"), mimeType: dataUri[1] };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(src, { signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 (protyres-cotizador)" } });
    clearTimeout(t);
    if (!res.ok) return null;
    const mimeType = res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    if (!mimeType.startsWith("image/")) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length < 200) return null;
    return { data, mimeType };
  } catch {
    return null;
  }
}

/** Google Custom Search (image mode). Needs GOOGLE_CSE_KEY + GOOGLE_CSE_ID. Returns candidate URLs, best first. */
export async function searchWebPhotos(brand: string, model: string, extra = "llanta"): Promise<string[]> {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_ID;
  if (!key || !cx) return [];
  const q = [brand, model, extra].filter(Boolean).join(" ");
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&searchType=image&num=5&imgType=photo&safe=active&q=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = (await res.json()) as { items?: { link: string; mime?: string }[] };
    return (json.items ?? []).map((i) => i.link).filter((l) => /^https?:\/\//.test(l));
  } catch {
    return [];
  }
}

export function webSearchAvailable(): boolean {
  return !!(process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_ID);
}

export { photoKey };
