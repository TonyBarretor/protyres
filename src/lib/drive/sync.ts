/**
 * Pull every price list / stock export in the shared Drive folder into the store.
 * Which provider a file belongs to, and how to read it, comes from config/providers.json (see ingest/sources.ts):
 * the `match` rules are tested against the file name; otherwise the text before " - " or "_" is the provider.
 */
import { ingestCsv, ingestExcel } from "../ingest/tabular";
import { ingestPdf } from "../ingest/pdf";
import { resolveSourceOptions } from "../ingest/sources";
import type { IngestResult } from "../ingest/types";
import type { PriceStore } from "../store/types";
import { DriveClient } from "./client";

export function providerFromFileName(name: string): string {
  const cfg = resolveSourceOptions(name);
  if (cfg.provider) return cfg.provider;
  const base = name.replace(/\.[^.]+$/, "");
  const m = base.split(/\s+[-–]\s+|_/)[0].trim();
  return m || base;
}

export interface SyncReport {
  files: { name: string; provider: string; rows: number; skipped?: string; warnings: string[] }[];
}

export async function syncDriveFolder(store: PriceStore, opts: { folderId?: string; client?: DriveClient; force?: boolean } = {}): Promise<SyncReport> {
  const folderId = opts.folderId ?? process.env.GOOGLE_DRIVE_FOLDER_ID;
  const client = opts.client ?? DriveClient.fromEnv();
  if (!folderId || !client) throw new Error("Google Drive not configured (GOOGLE_DRIVE_FOLDER_ID + service account)");
  const report: SyncReport = { files: [] };
  const files = await client.listFolder(folderId);
  const seen = await store.getSyncMarks();
  for (const f of files) {
    const provider = providerFromFileName(f.name);
    const mark = seen[f.id];
    if (!opts.force && mark && mark === f.modifiedTime) {
      report.files.push({ name: f.name, provider, rows: 0, skipped: "sin cambios", warnings: [] });
      continue;
    }
    let result: IngestResult | null = null;
    let kind: IngestResult["rows"][number]["kind"] | undefined;
    try {
      const { data, name } = await client.download(f);
      const cfg = resolveSourceOptions(name, provider);
      kind = cfg.kind;
      const common = { ...cfg, provider, sourceRef: name, priceDate: cfg.priceDate ?? f.modifiedTime.slice(0, 10) };
      if (/\.(xlsx?|htm|html)$/i.test(name)) result = await ingestExcel(data, common);
      else if (/\.csv$/i.test(name)) result = ingestCsv(data.toString("utf8"), common);
      else if (/\.pdf$/i.test(name)) result = await ingestPdf(data, common);
      else {
        report.files.push({ name: f.name, provider, rows: 0, skipped: "tipo no soportado", warnings: [] });
        continue;
      }
    } catch (err) {
      report.files.push({ name: f.name, provider, rows: 0, skipped: `error: ${(err as Error).message}`, warnings: [] });
      continue;
    }
    await store.upsertRows(result.rows, { replace: { provider, sourceRef: result.stats.sourceRef, kind: kind ?? result.rows[0]?.kind } });
    await store.setSyncMark(f.id, f.modifiedTime);
    report.files.push({ name: f.name, provider, rows: result.rows.length, warnings: result.warnings });
  }
  return report;
}
