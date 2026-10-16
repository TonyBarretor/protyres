import { describe, expect, it } from "vitest";
import { JsonStore } from "../store/json-store";
import { photoKey } from "../store/types";
import { findPhoto, nearestPhotoKey } from "./photos";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64").toString("base64");
const photo = (brand: string, model: string) => ({ key: photoKey(brand, model), brand, model, data: png, mimeType: "image/png", source: "provider" as const, origin: "JCH", createdAt: "2026-10-15T00:00:00.000Z" });

describe("photo lookup", () => {
  it("falls back to the same brand under a longer or shorter model name", async () => {
    const store = JsonStore.memory();
    await store.setPhoto(photo("Marshal", "Road Venture KL71 M/T"));
    await store.setPhoto(photo("Marshal", "Road Venture MT51"));
    await store.setPhoto(photo("Fenixway", "Valor 96 TCF"));
    await store.setPhoto(photo("Fenixway", "Valor 99"));
    expect(await nearestPhotoKey(store, "Marshal", "KL71")).toBe(photoKey("Marshal", "Road Venture KL71 M/T"));
    expect(await nearestPhotoKey(store, "Fenixway", "Valor 96")).toBe(photoKey("Fenixway", "Valor 96 TCF"));
    expect(await nearestPhotoKey(store, "Fenixway", "Valor 99")).toBeNull(); // exact key exists: no fallback needed
    expect(await nearestPhotoKey(store, "Marshal", "AT")).toBeNull(); // too short to trust
    expect(await nearestPhotoKey(store, "Kumho", "KL71")).toBeNull(); // another brand never matches
    const found = await findPhoto(store, "Marshal", "KL71");
    expect(found?.data?.length).toBeGreaterThan(0);
    expect(found?.source).toBe("JCH");
  });
});
