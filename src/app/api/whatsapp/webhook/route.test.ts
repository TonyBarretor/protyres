/**
 * Corrida E, punto 1a: la ruta del webhook rechaza con 401 un POST sin firma o con firma inválida cuando hay
 * WHATSAPP_APP_SECRET; con firma válida responde 200. Sin el secreto (piloto) acepta, y al arrancar se advierte.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/lib/bot", () => ({ processInbound: async () => undefined }));

import { appSecretWarning } from "@/lib/whatsapp/webhook";
import { register } from "@/instrumentation";
import { POST } from "./route";

const SECRET = "app-secret-de-prueba";
const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
const sign = (raw: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
const post = (headers: Record<string, string> = {}) => POST(new Request("https://x.example/api/whatsapp/webhook", { method: "POST", body, headers }));

describe("webhook: firma de Meta", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.WHATSAPP_APP_SECRET;
    process.env.WHATSAPP_APP_SECRET = SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.WHATSAPP_APP_SECRET;
    else process.env.WHATSAPP_APP_SECRET = saved;
  });

  it("con el secreto: sin firma o con firma inválida -> 401; válida -> 200", async () => {
    expect((await post()).status).toBe(401);
    expect((await post({ "x-hub-signature-256": "sha256=00" })).status).toBe(401);
    expect((await post({ "x-hub-signature-256": sign(body, "otro-secreto") })).status).toBe(401);
    expect((await post({ "x-hub-signature-256": sign(body) })).status).toBe(200);
  });

  it("sin el secreto (piloto) acepta, y al arrancar se advierte una vez", async () => {
    delete process.env.WHATSAPP_APP_SECRET;
    expect((await post()).status).toBe(200);
    expect(appSecretWarning({})).toContain("WHATSAPP_APP_SECRET no está definida");
    expect(appSecretWarning({ WHATSAPP_APP_SECRET: "x" })).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runtime = process.env.NEXT_RUNTIME;
    process.env.NEXT_RUNTIME = "nodejs";
    try {
      await register();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("WHATSAPP_APP_SECRET");
    } finally {
      if (runtime === undefined) delete process.env.NEXT_RUNTIME;
      else process.env.NEXT_RUNTIME = runtime;
      warn.mockRestore();
    }
  });
});
