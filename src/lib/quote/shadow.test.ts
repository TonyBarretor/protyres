import { describe, expect, it } from "vitest";
import { JsonStore } from "../store/json-store";
import { diffViews, summarizeShadow, type QuoteShadowEntry } from "./shadow";

const entry = (o: Partial<QuoteShadowEntry> = {}): QuoteShadowEntry => ({
  phone: "51900000001",
  text: "Fenixway 295/80R22.5 x4 para Transportes Ficticios",
  rules: { items: [{ medida: "295/80R22.5", marca: "Fenixway", cantidad: 4 }] },
  model: { items: [{ medida: "295/80R22.5", marca: "Fenixway", cantidad: 4 }] },
  diffs: [],
  rejected: [],
  ...o,
});

describe("quote_shadow", () => {
  it("diferencias por campo (ítems y cabecera); mayúsculas no cuentan", () => {
    const d = diffViews(
      { items: [{ medida: "295/80R22.5", marca: "Fenixway", cantidad: 4 }], cliente: "ACME" },
      { items: [{ medida: "295/80R22.5", marca: "fenixway", cantidad: 6 }, { medida: "11R22.5", cantidad: 1 }], cliente: "ACME", correo: "a@b.pe" },
    );
    expect(d).toEqual([
      { field: "items", rules: "1", model: "2" },
      { field: "cantidad", item: 1, rules: "4", model: "6" },
      { field: "correo", rules: "—", model: "a@b.pe" },
    ]);
  });

  it("store JSON: guarda y lista (más nuevo primero, desde una fecha, con límite)", async () => {
    const s = JsonStore.memory();
    await s.logQuoteShadow(entry({ at: new Date("2026-11-01T10:00:00Z") }));
    await s.logQuoteShadow(entry({ at: new Date("2026-11-10T10:00:00Z"), diffs: [{ field: "cantidad", item: 1, rules: "4", model: "6" }] }));
    const all = await s.listQuoteShadow();
    expect(all.map((r) => r.id)).toEqual([2, 1]);
    expect(all[0].diffs).toHaveLength(1);
    expect(await s.listQuoteShadow({ since: new Date("2026-11-05T00:00:00Z") })).toHaveLength(1);
    expect(await s.listQuoteShadow({ limit: 1 })).toHaveLength(1);
  });

  it("resumen: totales, campos, descartes y errores", () => {
    const s = summarizeShadow([
      entry({ diffs: [{ field: "cantidad", item: 1, rules: "4", model: "6" }, { field: "marca", item: 1, rules: "A", model: "B" }], rejected: ["marca «X» no existe", "cantidad 6 no está en el texto"] }),
      entry({ diffs: [{ field: "cantidad", item: 1, rules: "4", model: "2" }] }),
      entry({ model: null, modelError: "invalido" }),
      entry(),
    ]);
    expect(s).toEqual({
      total: 4,
      withModel: 3,
      differing: 2,
      errors: [{ reason: "invalido", count: 1 }],
      byField: [
        { field: "cantidad", cases: 2 },
        { field: "marca", cases: 1 },
      ],
      byRejection: [
        { kind: "cantidad", count: 1 },
        { kind: "marca", count: 1 },
      ],
    });
  });
});
