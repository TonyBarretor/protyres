import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonPortalStore } from "./json-portal-store";
import { expectedSchema } from "./migrate-guard";

describe("portal_conversations (JSON)", () => {
  it("guarda, lee, borra y sobrevive al archivo", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-conv-"));
    const file = path.join(dir, "store.json");
    const s = new JsonPortalStore(file);
    expect(await s.getPortalConversation("51900000001")).toBeNull();
    await s.setPortalConversation("+51 900 000 001", { pending: { kind: "choose_company", options: [{ id: 1, label: "A" }] } });
    const got = await s.getPortalConversation("51900000001");
    expect(got?.phone).toBe("51900000001");
    expect(got?.state).toEqual({ pending: { kind: "choose_company", options: [{ id: 1, label: "A" }] } });
    (got!.state.pending as { kind: string }).kind = "mutated"; // copia: no cambia lo guardado
    expect(((await s.getPortalConversation("51900000001"))!.state.pending as { kind: string }).kind).toBe("choose_company");
    await s.flush();
    const again = new JsonPortalStore(file);
    const loaded = await again.getPortalConversation("51900000001");
    expect(loaded?.updatedAt).toBeInstanceOf(Date);
    expect(loaded?.state).toEqual({ pending: { kind: "choose_company", options: [{ id: 1, label: "A" }] } });
    await again.setPortalConversation("51900000001", null);
    expect(await again.getPortalConversation("51900000001")).toBeNull();
    await again.setPortalConversation("51900000001", { a: 1 });
    await again.setPortalConversation("51900000001", {});
    expect(await again.getPortalConversation("51900000001")).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("la migración declara la tabla y la guardia lee sus columnas", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "src/cli/migrate.ts"), "utf8");
    const stmt = /`(create table if not exists portal_conversations[\s\S]*?)`/.exec(src)?.[1];
    expect(stmt).toBeTruthy();
    expect(expectedSchema([stmt!]).get("portal_conversations")).toEqual(["phone", "state", "updated_at"]);
  });
});
