/**
 * Google Drive (service account) – list and download the price lists the client shares in one folder.
 * Google Sheets are exported as .xlsx; .xlsx/.csv/.pdf are downloaded as-is.
 * Untested against the live API until the client shares a folder; the REST calls follow Drive v3 docs.
 */
import fs from "node:fs";
import { JWT } from "google-auth-library";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

const SHEET = "application/vnd.google-apps.spreadsheet";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function credentials(): { client_email: string; private_key: string } | null {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (json) return JSON.parse(json);
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  if (file && fs.existsSync(/* turbopackIgnore: true */ file)) return JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8"));
  return null;
}

export function driveConfigured(): boolean {
  return !!credentials() && !!process.env.GOOGLE_DRIVE_FOLDER_ID;
}

export class DriveClient {
  private jwt: JWT;
  constructor(creds: { client_email: string; private_key: string }) {
    this.jwt = new JWT({ email: creds.client_email, key: creds.private_key, scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
  }

  static fromEnv(): DriveClient | null {
    const c = credentials();
    return c ? new DriveClient(c) : null;
  }

  private async token(): Promise<string> {
    const t = await this.jwt.getAccessToken();
    if (!t.token) throw new Error("could not get Google access token");
    return t.token;
  }

  async listFolder(folderId: string): Promise<DriveFile[]> {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const fields = encodeURIComponent("files(id,name,mimeType,modifiedTime),nextPageToken");
    const out: DriveFile[] = [];
    let pageToken = "";
    do {
      const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ""}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${await this.token()}` } });
      if (!res.ok) throw new Error(`Drive list ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
      out.push(...(json.files ?? []));
      pageToken = json.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }

  /** Returns the bytes and the effective file name (Sheets become name.xlsx). */
  async download(file: DriveFile): Promise<{ data: Buffer; name: string; mimeType: string }> {
    const headers = { Authorization: `Bearer ${await this.token()}` };
    if (file.mimeType === SHEET) {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent(XLSX)}`, { headers });
      if (!res.ok) throw new Error(`Drive export ${res.status}: ${await res.text()}`);
      return { data: Buffer.from(await res.arrayBuffer()), name: `${file.name}.xlsx`, mimeType: XLSX };
    }
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`, { headers });
    if (!res.ok) throw new Error(`Drive download ${res.status}: ${await res.text()}`);
    return { data: Buffer.from(await res.arrayBuffer()), name: file.name, mimeType: file.mimeType };
  }
}
