/**
 * config/providers.json – how each file / provider must be read.
 *
 * {
 *   "sources": [
 *     { "match": "^STOCK PROTYRES",      "provider": "Protyres", "kind": "stock" },
 *     { "match": "^SourceOwnProvider",   "provider": "Protyres", "kind": "own", "priceIncludesTax": true, "maxDiscountPct": 20 },
 *     { "match": "jch",                  "provider": "JCH",   "kind": "provider", "priceIncludesTax": false,
 *       "columns": { "code": "B", "description": "C", "model": "D", "brand": "E", "price": "F", "stock": "G,H,I" } },
 *     { "match": "steel",                "provider": "Steel", "kind": "provider", "priceIncludesTax": false }
 *   ]
 * }
 * `match` is a case-insensitive regular expression tested against the file name.
 */
import fs from "node:fs";
import path from "node:path";
import type { ColumnKey, IngestOptions, RowKind } from "./types";

export interface SourceConfig {
  match: string;
  provider: string;
  kind?: RowKind;
  priceIncludesTax?: boolean;
  maxDiscountPct?: number;
  currency?: string;
  columns?: Partial<Record<ColumnKey, string>>;
  keepNonTyre?: boolean;
}

export interface ProvidersConfig {
  sources?: SourceConfig[];
  /** provider -> defaults when a file is ingested with --provider but no `match` rule; `aliases` = other names the bot accepts */
  providers?: Record<string, Omit<SourceConfig, "match" | "provider"> & { aliases?: string[] }>;
}

let cached: ProvidersConfig | null = null;

export function loadProvidersConfig(force = false): ProvidersConfig {
  if (cached && !force) return cached;
  const file = process.env.PROVIDERS_CONFIG || path.join(process.cwd(), "config", "providers.json");
  cached = fs.existsSync(/* turbopackIgnore: true */ file) ? (JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")) as ProvidersConfig) : {};
  return cached;
}

export function __setProvidersConfigForTests(c: ProvidersConfig | null): void {
  cached = c;
}

/** Options for a file, from the `sources` rules (by file name) or the `providers` defaults (by provider name). */
export function resolveSourceOptions(fileName: string, providerHint?: string, cfg = loadProvidersConfig()): Partial<IngestOptions> & { provider?: string } {
  for (const rule of cfg.sources ?? []) {
    let re: RegExp;
    try {
      re = new RegExp(rule.match, "i");
    } catch {
      continue;
    }
    if (re.test(fileName)) {
      const { match: _m, ...rest } = rule;
      return { ...rest, defaultCurrency: rule.currency };
    }
  }
  if (providerHint) {
    const key = Object.keys(cfg.providers ?? {}).find((k) => k.toLowerCase() === providerHint.toLowerCase());
    if (key) {
      const { aliases: _aliases, ...d } = cfg.providers![key];
      return { ...d, provider: providerHint, defaultCurrency: d.currency };
    }
  }
  return providerHint ? { provider: providerHint } : {};
}
