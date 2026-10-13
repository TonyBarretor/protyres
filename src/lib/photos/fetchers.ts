/**
 * How the photo library downloads things. Two ways:
 *
 *   nodeFetcher()     plain HTTP from Node — fast, no browser.
 *   browserFetcher()  a real Google Chrome driven with patchright (undetected Playwright). Some shops (JCH) sit behind Cloudflare's
 *                     "verify you are a browser" challenge, which answers 403 to curl / Node; a real browser passes
 *                     it and every request after that (catalogue pages, pictures) is made from inside the page, so
 *                     it carries the browser's cookies and fingerprint. No AI involved — it's just a download.
 *
 * The browser needs `patchright` (dev dependency) and Google Chrome installed; `PHOTOS_CHROME_PATH` points at
 * another Chrome/Chromium executable if needed.
 */

import fs from "node:fs";
import path from "node:path";

export interface JsonResponse {
  status: number;
  totalPages: number;
  body: unknown;
}

export interface Fetcher {
  readonly kind: "node" | "browser";
  json(url: string): Promise<JsonResponse>;
  /** Raw bytes of a URL, null when it cannot be downloaded. */
  bytes(url: string): Promise<Buffer | null>;
  close(): Promise<void>;
}

/** Thrown when a site refuses plain HTTP (403 / 503 / 429 on the first catalogue page). */
export class BlockedError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
  ) {
    super(`${url} -> HTTP ${status}`);
  }
}

export const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "accept-language": "es-PE,es;q=0.9,en;q=0.8",
};

export function nodeFetcher(timeoutMs = 20000): Fetcher {
  const get = async (url: string, accept: string) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, {
        signal: ctrl.signal,
        headers: {
          ...BROWSER_HEADERS,
          accept,
          referer: new URL(url).origin + "/",
        },
      });
    } finally {
      clearTimeout(t);
    }
  };
  return {
    kind: "node",
    async json(url) {
      const res = await get(url, "application/json");
      const totalPages = parseInt(res.headers.get("x-wp-totalpages") ?? "0", 10) || 0;
      if (!res.ok) return { status: res.status, totalPages, body: null };
      return { status: res.status, totalPages, body: await res.json() };
    },
    async bytes(url) {
      try {
        const res = await get(url, "image/*,*/*;q=0.8");
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer());
      } catch {
        return null;
      }
    },
    async close() {},
  };
}

export interface BrowserOptions {
  /** Show the Chrome window (default). Cloudflare is far more likely to wave a visible browser through. */
  headless?: boolean;
  /** Chrome/Chromium executable; default: the installed Google Chrome (patchright "chrome" channel). */
  executablePath?: string;
  /** Where Chrome keeps its profile between runs (cookies → fewer challenges). Default: .cache/chrome-profile. */
  profileDir?: string;
  /** How long to wait for the "checking your browser" page to clear (ms). */
  challengeTimeoutMs?: number;
  log?: (line: string) => void;
}

const CHALLENGE_HINTS = [/verificaci[oó]n de seguridad/i, /verifica que (t[uú] )?eres/i, /ser humano/i, /just a moment/i, /checking your browser/i, /verify you are (a )?human/i, /ray id/i];

type Page = {
  goto(url: string, opts?: { waitUntil?: "domcontentloaded" | "load"; timeout?: number }): Promise<unknown>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  url(): string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A real Google Chrome driven with patchright (a Playwright fork that hides the automation tell-tales Cloudflare's
 * Turnstile looks for; plain Playwright gets stuck in a "verify you are human" loop). Per patchright's advice: a
 * persistent profile, the installed Chrome, headful, no custom user agent, headers or flags.
 */
export async function browserFetcher(opts: BrowserOptions = {}): Promise<Fetcher> {
  const log = opts.log ?? (() => undefined);
  let pw: typeof import("patchright");
  try {
    pw = await import("patchright");
  } catch {
    throw new Error("falta patchright para abrir Chrome: corre `npm install` y vuelve a intentar");
  }
  const executablePath = opts.executablePath ?? process.env.PHOTOS_CHROME_PATH ?? undefined;
  const headless = opts.headless ?? false;
  const profileDir = opts.profileDir ?? path.join(process.cwd(), ".cache", "chrome-profile");
  fs.mkdirSync(profileDir, { recursive: true });
  const context = await pw.chromium.launchPersistentContext(profileDir, {
    ...(executablePath ? { executablePath } : { channel: "chrome" }),
    headless,
    viewport: null,
  });
  const page = (context.pages()[0] ?? (await context.newPage())) as unknown as Page;
  const cleared = new Set<string>(); // origins whose challenge we already passed
  const timeout = opts.challengeTimeoutMs ?? 120000;

  /** Load `url` in the tab and wait until the "checking your browser" page (if any) is behind us. */
  async function open(url: string): Promise<void> {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    const started = Date.now();
    let warned = false;
    let quietSince = 0;
    for (;;) {
      const text = await page.evaluate(() => (document.body?.innerText ?? "").trim()).catch(() => "");
      if (CHALLENGE_HINTS.some((re) => re.test(text))) {
        quietSince = 0;
        if (!warned) {
          warned = true;
          log("  la web pide verificar el navegador (Cloudflare); esperando a que pase… si aparece una casilla «Verificar que eres humano», márcala en la ventana de Chrome");
        }
      } else if (text.startsWith("[") || text.startsWith("{"))
        return; // the catalogue JSON
      else if (!quietSince) quietSince = Date.now();
      else if (Date.now() - quietSince > 1500) return; // some other content (an image, a page) with no challenge on it
      if (Date.now() - started > timeout) throw new Error(`${url}: la página no mostró el catálogo tras ${Math.round(timeout / 1000)} s (verificación de Cloudflare no superada)`);
      await sleep(500);
    }
  }

  async function ensureCleared(url: string) {
    const origin = new URL(url).origin;
    if (cleared.has(origin)) return;
    await open(url);
    cleared.add(origin);
  }

  const inPageJson = (url: string) =>
    page.evaluate(async (u: string) => {
      const r = await fetch(u, {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      const totalPages = parseInt(r.headers.get("x-wp-totalpages") ?? "0", 10) || 0;
      if (!r.ok) return { status: r.status, totalPages, body: null as unknown };
      return {
        status: r.status,
        totalPages,
        body: (await r.json()) as unknown,
      };
    }, url);

  return {
    kind: "browser",
    async json(url) {
      await ensureCleared(url);
      let res = await inPageJson(url);
      if (res.status === 403 || res.status === 503) {
        // clearance missing or expired: navigate to the URL itself (a navigation can pass the challenge; a fetch can't)
        cleared.delete(new URL(url).origin);
        await ensureCleared(url);
        res = await inPageJson(url);
        if (res.status === 403 || res.status === 503) {
          // last resort: the tab is showing that very URL — read the JSON off the page
          const text = await page.evaluate(() => (document.body?.innerText ?? "").trim()).catch(() => "");
          try {
            return { status: 200, totalPages: 0, body: JSON.parse(text) as unknown };
          } catch {
            /* keep the error status */
          }
        }
      }
      return res;
    },
    async bytes(url) {
      try {
        await ensureCleared(url);
        const b64 = await page.evaluate(async (u: string) => {
          const r = await fetch(u, { credentials: "include" });
          if (!r.ok) return null;
          const buf = new Uint8Array(await (await r.blob()).arrayBuffer());
          let s = "";
          for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + 0x8000)));
          return btoa(s);
        }, url);
        return b64 ? Buffer.from(b64, "base64") : null;
      } catch {
        return null;
      }
    },
    async close() {
      await context.close().catch(() => undefined);
    },
  };
}
