/**
 * Corrida H, punto 1 — error de producción "UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1" (asignarme,
 * 16/11) y "no pude registrar el audio: … Received an instance of Date". Contra Postgres real, con la misma conexión que
 * producción (pooler en modo transacción, pg-options.ts, pool de 5).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgPortalStore } from "../lib/portal/store/pg-portal-store";
import { PgStore } from "../lib/store/pg-store";
import type { PriceRow } from "../lib/ingest/types";
import { testDbUrl, truncateAll } from "./harness";

let portal: PgPortalStore;
let prices: PgStore;

beforeAll(async () => {
  await truncateAll(testDbUrl());
  portal = PgPortalStore.connect(testDbUrl());
  prices = await PgStore.connect(testDbUrl());
});
afterAll(async () => {
  await portal?.close();
  await prices?.close();
});

function row(i: number): PriceRow {
  return {
    id: `t-${i}`, provider: "PRUEBA", kind: "provider", description: `Llanta ${i}`, brand: "VALOR", model: "99", size: "295/80R22.5",
    sizeDisplay: "295/80R22.5", sizeRaw: "295/80R22.5", isTyre: true, cost: 100 + i, priceIncludesTax: false, currency: "USD", priceDate: "2026-11-16", source: "excel", sourceRef: "prueba.xlsx",
  } as PriceRow;
}

describe("transacciones con el pool de producción", () => {
  it("crear una oportunidad (asignarme) no falla con UNSAFE_TRANSACTION", async () => {
    await portal.upsertCompanies([{ ruc: "20100000001", razonSocial: "PRUEBA TX SAC" }]);
    const company = (await portal.getCompanyByRuc("20100000001"))!;
    const u = await portal.upsertUser({ nombre: "Vendedor Prueba", whatsapp: "51900000001", rol: "vendedor" });
    const op = await portal.createOpportunity({ companyId: company.id, ownerUserId: u.id, createdBy: u.id });
    expect(op.companyId).toBe(company.id);
    const moved = await portal.moveStage(op.id, "cita_agendada", u.id);
    expect(moved?.id).toBe(op.id);
  });

  it("muchas transacciones a la vez (más que el pool) terminan todas", async () => {
    const company = (await portal.getCompanyByRuc("20100000001"))!;
    const ops = await Promise.all(Array.from({ length: 12 }, () => portal.createOpportunity({ companyId: company.id })));
    expect(new Set(ops.map((o) => o.id)).size).toBe(12);
  });

  it("si la transacción falla, se deshace y la conexión queda limpia", async () => {
    const company0 = (await portal.getCompanyByRuc("20100000001"))!;
    const op = await portal.createOpportunity({ companyId: company0.id });
    const before = await portal.stageHistory(op.id);
    // la etapa inválida falla dentro de la transacción, después de tocar el historial: todo se deshace
    await expect(portal.moveStage(op.id, "no_existe" as never, null)).rejects.toThrow(/Etapa desconocida/);
    expect(await portal.stageHistory(op.id)).toHaveLength(before.length);
    expect((await portal.getOpportunity(op.id))?.etapa).toBe("prospecto");
    // las siguientes consultas no heredan una transacción abierta ("there is already a transaction in progress")
    const n = await Promise.all(Array.from({ length: 8 }, () => portal.countCompanies()));
    expect(n.every((x) => x >= 1)).toBe(true);
    const company = (await portal.getCompanyByRuc("20100000001"))!;
    await expect(portal.createOpportunity({ companyId: company.id })).resolves.toBeTruthy();
  });

  it("cargar una lista de precios (transacción de drizzle) con reemplazo", async () => {
    const r1 = await prices.upsertRows([row(1), row(2), row(3)], { replace: { provider: "PRUEBA" } });
    expect(r1.inserted).toBe(3);
    const r2 = await prices.upsertRows([row(4)], { replace: { provider: "PRUEBA" } });
    expect(r2.removed).toBe(3);
  });
});

describe("uso de modelo y de audio", () => {
  it("registra el audio con la fecha (topes de voz)", async () => {
    const at = new Date();
    await prices.recordUsage({ phone: "51900000001", purpose: "voz", model: "nova-3", audioSeconds: 12.5, costUsd: 0.001, at });
    await prices.recordUsage({ phone: "51900000001", purpose: "reporte", model: "claude-haiku", inputTokens: 10, outputTokens: 5, costUsd: 0.0001, at });
    const sum = await prices.usageSummary(new Date(at.getTime() - 60_000));
    const me = sum.filter((s) => s.phone === "51900000001");
    expect(me.find((s) => s.purpose === "voz")).toBeTruthy();
    expect(me.find((s) => s.purpose === "reporte")).toBeTruthy();
  });
});
