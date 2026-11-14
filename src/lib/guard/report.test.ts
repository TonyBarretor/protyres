import { describe, expect, it } from "vitest";
import { loadPortalConfig } from "../portal/config";
import { loadUsageForDashboard } from "../portal/dashboard/usage";
import { JsonPortalStore } from "../portal/store";
import { JsonStore } from "../store/json-store";
import { loadUsageReport } from "./report";

const FRANK = "51900000001";
const JAIME = "51900000002";
const now = new Date("2026-11-13T20:00:00Z"); // 15:00 en Lima

async function seeded(): Promise<JsonStore> {
  const s = JsonStore.memory();
  const at = (iso: string) => new Date(iso);
  await s.recordUsage({ phone: FRANK, purpose: "reporte", model: "claude-haiku-4-5", inputTokens: 3000, outputTokens: 400, costUsd: 0.005, at: at("2026-11-13T15:00:00Z") });
  await s.recordUsage({ phone: FRANK, purpose: "cotizador_pedido", model: "claude-haiku-4-5", inputTokens: 1000, outputTokens: 200, costUsd: 0.002, at: at("2026-11-13T16:00:00Z") });
  await s.recordUsage({ phone: FRANK, purpose: "voz", model: "nova-3", audioSeconds: 90, costUsd: 0.00645, at: at("2026-11-13T16:00:00Z") });
  await s.recordUsage({ phone: JAIME, purpose: "cotizador_pedido", model: "claude-haiku-4-5", inputTokens: 500, outputTokens: 100, costUsd: 0.001, at: at("2026-11-10T16:00:00Z") });
  // ayer en Lima (04:00 UTC del 13 = 23:00 del 12 en Lima): no es de hoy
  await s.recordUsage({ phone: "sistema", purpose: "lista_precios", model: "claude-haiku-4-5", inputTokens: 20000, outputTokens: 5000, costUsd: 0.045, at: at("2026-11-13T04:00:00Z") });
  // hace 8 días: fuera de los 7
  await s.recordUsage({ phone: FRANK, purpose: "reporte", model: "claude-haiku-4-5", inputTokens: 9, outputTokens: 9, costUsd: 9, at: at("2026-11-05T16:00:00Z") });
  await s.logBlocked({ phone: "51977777777", kind: "text", reason: "no_registrado", at: at("2026-11-13T16:00:00Z") });
  return s;
}

describe("resumen de consumo (llm:usage y tablero)", () => {
  it("hoy y 7 días (Lima), por usuario y propósito, topes con % de hoy y mensajes no procesados", async () => {
    const r = await loadUsageReport(await seeded(), loadPortalConfig().limits, { now, names: new Map([[FRANK, "Frank Rodríguez"]]) });
    expect(r.today.total).toMatchObject({ llmCalls: 2, tokens: 4600, audioMinutes: 1.5 });
    expect(r.today.byUser.map((u) => u.label)).toEqual(["Frank Rodríguez (51900000001)"]);
    expect(r.today.byPurpose.map((p) => p.key).sort()).toEqual(["cotizador_pedido", "reporte", "voz"]);
    expect(r.week.total.llmCalls).toBe(4);
    expect(r.week.byUser.map((u) => u.key).sort()).toEqual([FRANK, JAIME, "sistema"].sort());
    expect(r.week.total.costUsd).toBeCloseTo(0.05945, 6);
    const userCalls = r.caps.find((c) => c.scope === "usuario" && c.metric === "llmCalls");
    expect(userCalls).toMatchObject({ label: "Frank Rodríguez", used: 2, limit: 150 });
    expect(userCalls!.pct).toBeCloseTo(2 / 150, 6);
    expect(r.caps.find((c) => c.scope === "global" && c.metric === "audioMinutes")).toMatchObject({ used: 1.5, limit: 120 });
    expect(r.blocked).toEqual([{ reason: "no_registrado", phones: 1, messages: 1 }]);
  });

  it("tablero: solo el admin ve el bloque", async () => {
    const store = await seeded();
    const portal = JsonPortalStore.memory();
    const base = { id: 1, activo: true };
    expect(await loadUsageForDashboard({ ...base, rol: "supervisor" }, portal, { store, now })).toBeNull();
    expect(await loadUsageForDashboard({ ...base, rol: "vendedor" }, portal, { store, now })).toBeNull();
    expect((await loadUsageForDashboard({ ...base, rol: "admin" }, portal, { store, now }))?.today.total.llmCalls).toBe(2);
  });
});
