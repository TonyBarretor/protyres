import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRow } from "../ingest/util";
import { JsonStore } from "../store/json-store";
import { brandModelFromName, importFromPriceList, importWooCommerce } from "./library";

let server: http.Server;
let base = "";
let hits = 0;
/** When true the fake shop behaves like Cloudflare: no clearance cookie -> 403 + a "checking your browser" page that sets it. */
let protect = false;
let blockedHits = 0;

// A Chrome/Chromium to drive in the browser test (the dev container has one; on a Mac set PHOTOS_CHROME_PATH or skip).
const CHROME = process.env.PHOTOS_CHROME_PATH ?? ["/opt/pw-browsers/chromium"].find((p) => fs.existsSync(p));

beforeAll(async () => {
  const png = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#336699" } }).png().toBuffer();
  const products = [
    { id: 1, name: "LLANTA GT RADIAL ADVENTURO AT3 P265/65 R18", sku: "LTR1800182", permalink: "", images: [{ src: "/img/a.png" }] },
    { id: 2, name: "LLANTA GT RADIAL ADVENTURO AT3 LT285/70 R17", sku: "LTR1700049", permalink: "", images: [{ src: "/img/b.png" }] }, // same model: one photo
    { id: 3, name: "LLANTA AONAITE AT168 295/80 R22.5", sku: "NOT-IN-LIST", permalink: "", images: [{ src: "/img/c.png" }] }, // matched by name
    { id: 4, name: "VALVULA TR413", sku: "V1", permalink: "", images: [{ src: "/img/d.png" }] }, // no brand -> unmatched
  ];
  server = http.createServer((req, res) => {
    hits++;
    if (protect && !(req.headers.cookie ?? "").includes("clearance=ok")) {
      blockedHits++;
      res.statusCode = 403;
      res.setHeader("content-type", "text/html");
      res.end(`<html><body><h1>Verificación de seguridad en curso</h1><p>Ray ID: test</p><script>document.cookie = "clearance=ok; path=/"; setTimeout(() => location.reload(), 300);</script></body></html>`);
      return;
    }
    if (req.url?.startsWith("/wp-json/wc/store/v1/products")) {
      const page = parseInt(new URL(req.url, "http://x").searchParams.get("page") ?? "1", 10);
      res.setHeader("content-type", "application/json");
      res.setHeader("x-wp-totalpages", "1");
      res.end(JSON.stringify(page === 1 ? products.map((p) => ({ ...p, images: p.images.map((i) => ({ src: base + i.src })) })) : []));
      return;
    }
    if (req.url?.startsWith("/img/")) {
      res.setHeader("content-type", "image/png");
      res.end(png);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => server.close());

describe("photo library", () => {
  it("parses brand + model from shop product names", () => {
    expect(brandModelFromName("LLANTA GT RADIAL ADVENTURO AT3 P265/65 R18")).toEqual({ brand: "Giti", model: "ADVENTURO AT3" });
    expect(brandModelFromName("VALVULA TR413")).toBeNull();
  });

  it("imports a WooCommerce catalogue: match by SKU, then by name; one photo per brand+model; resized JPEG", async () => {
    const store = JsonStore.memory();
    const rows = [
      buildRow({ provider: "JCH", code: "LTR1800182", description: "265/65R18 GT RADIAL ADVENTURO AT3", brand: "GT Radial", model: "Adventuro AT3", size: "265/65R18", cost: 100, source: "excel", sourceRef: "jch" }),
      buildRow({ provider: "JCH", code: "LTR1700049", description: "285/70R17 GT RADIAL ADVENTURO AT3", brand: "GT Radial", model: "Adventuro AT3", size: "285/70R17", cost: 120, source: "excel", sourceRef: "jch" }),
    ].filter((r): r is NonNullable<typeof r> => !!r);
    await store.upsertRows(rows);

    const dry = await importWooCommerce(store, { provider: "JCH", type: "woocommerce", url: base }, { dry: true });
    expect(dry.seen).toBe(4);
    expect(dry.matchedByCode).toBe(2);
    expect(dry.matchedByName).toBe(1);
    expect(dry.unmatched).toBe(1);
    expect(dry.stored).toBe(2); // Adventuro AT3 once + Aonaite AT168
    expect((await store.photoKeys()).size).toBe(0);

    const st = await importWooCommerce(store, { provider: "JCH", type: "woocommerce", url: base }, { image: { maxPx: 300, jpegQuality: 70 } });
    expect(st.stored).toBe(2);
    const p = await store.getPhoto("GT Radial", "Adventuro AT3");
    expect(p?.origin).toBe("JCH");
    expect(p?.code).toBe("LTR1800182");
    const meta = await sharp(Buffer.from(p!.data!, "base64")).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(300);
    expect(await store.getPhoto("Aonaite", "AT168")).not.toBeNull();

    // second run skips what we already have
    const again = await importWooCommerce(store, { provider: "JCH", type: "woocommerce", url: base });
    expect(again.skippedExisting).toBe(2);
    expect(again.stored).toBe(0);
  });

  it.skipIf(!CHROME)("falls back to a real browser when the shop is behind a Cloudflare-style check", async () => {
    protect = true;
    blockedHits = 0;
    try {
      const store = JsonStore.memory();
      const log: string[] = [];
      const st = await importWooCommerce(store, { provider: "JCH", type: "woocommerce", url: base }, { browserOptions: { headless: true, executablePath: CHROME, challengeTimeoutMs: 20000, profileDir: fs.mkdtempSync(path.join(os.tmpdir(), "protyres-chrome-")) }, log: (l) => log.push(l) });
      expect(blockedHits).toBeGreaterThanOrEqual(2); // plain HTTP refused, then the browser's first visit
      expect(log.some((l) => l.includes("abriendo Chrome"))).toBe(true);
      expect(st.seen).toBe(4);
      expect(st.stored).toBe(2);
      const p = await store.getPhoto("Aonaite", "AT168");
      expect((await sharp(Buffer.from(p!.data!, "base64")).metadata()).format).toBe("jpeg");

      // "never" refuses instead of opening a browser
      await expect(importWooCommerce(JsonStore.memory(), { provider: "JCH", type: "woocommerce", url: base }, { browser: "never" })).rejects.toThrow(/HTTP 403/);
    } finally {
      protect = false;
    }
  }, 60000);

  it("imports photos + sheets referenced by price rows (Steel)", async () => {
    const store = JsonStore.memory();
    const row = buildRow({ provider: "Steel", code: "11800053", description: "1000 R20 18PR HF702 SUNFULL", brand: "Sunfull", model: "HF702", size: "1000R20", cost: 209, stock: 1, source: "html", sourceRef: "steel", photoUrl: `${base}/img/s.png`, sheetUrl: `${base}/img/f.png` });
    await store.upsertRows([row!]);
    const st = await importFromPriceList(store, { provider: "Steel", type: "price-list" });
    expect(st.stored).toBe(1);
    const p = await store.getPhoto("Sunfull", "HF702");
    expect(p?.sheetData).toBeTruthy();
    expect(p?.origin).toBe("Steel");
  });
});
