import { describe, expect, it } from "vitest";
import { SettingsSchema } from "../settings";
import { priceProviderItem } from "./pricing";

const pricing = (marginBase?: "cost" | "price") => SettingsSchema.parse({ company: { name: "X" }, pricing: { currency: "USD", provider: { marginPct: 15, ...(marginBase ? { marginBase } : {}) } }, quote: {} }).pricing;

describe("provider margin", () => {
  it("defaults to the settings' margin on cost", () => {
    expect(pricing().provider.marginBase).toBe("cost");
    expect(priceProviderItem(422.3, pricing())).toBe(485.65);
  });
  it("per-quote margin overrides the settings: cost base = markup", () => {
    expect(priceProviderItem(422.3, pricing("cost"), 10)).toBe(464.53);
    expect(priceProviderItem(422.3, pricing("cost"), 0)).toBe(422.3);
  });
  it("price base: the margin is a share of the sale price", () => {
    expect(priceProviderItem(422.3, pricing("price"), 10)).toBe(469.22);
    expect(priceProviderItem(422.3, pricing("price"))).toBe(496.82); // 422.30 / 0.85
  });
});
