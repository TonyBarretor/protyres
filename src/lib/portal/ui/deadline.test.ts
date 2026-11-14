import { describe, expect, it } from "vitest";
import { PortalTimeoutError, withDeadline } from "./deadline";

describe("withDeadline", () => {
  it("devuelve el resultado si llega a tiempo", async () => {
    expect(await withDeadline(Promise.resolve(7), 50, "Prospectos")).toBe(7);
  });

  it("falla con un error claro si la carga no termina a tiempo (la página no espera 300 s)", async () => {
    const never = new Promise<number>(() => undefined);
    const t = Date.now();
    await expect(withDeadline(never, 30, "Prospectos")).rejects.toBeInstanceOf(PortalTimeoutError);
    await expect(withDeadline(never, 30, "Prospectos")).rejects.toThrow(/Prospectos/);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("propaga el error original", async () => {
    await expect(withDeadline(Promise.reject(new Error("boom")), 50, "x")).rejects.toThrow("boom");
  });
});
