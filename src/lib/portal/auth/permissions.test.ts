import { describe, expect, it } from "vitest";
import type { PortalUser, UserRole } from "../store/types";
import { canEditCompany, canSeeAll } from "./permissions";

const user = (id: number, rol: UserRole, activo = true): PortalUser => ({ id, nombre: `u${id}`, whatsapp: null, rol, activo, createdAt: new Date() });
const mine = { ownerUserId: 1 };
const other = { ownerUserId: 2 };
const free = { ownerUserId: null };

describe("permissions", () => {
  it("vendedor edits only his companies", () => {
    expect(canEditCompany(user(1, "vendedor"), mine)).toBe(true);
    expect(canEditCompany(user(1, "vendedor"), other)).toBe(false);
    expect(canEditCompany(user(1, "vendedor"), free)).toBe(false);
  });

  it("supervisor and admin edit everything; tecnico is read-only", () => {
    for (const rol of ["supervisor", "admin"] as const) for (const c of [mine, other, free]) expect(canEditCompany(user(9, rol), c)).toBe(true);
    for (const c of [mine, other, free]) expect(canEditCompany(user(1, "tecnico"), c)).toBe(false);
  });

  it("inactive or missing user / company -> no", () => {
    expect(canEditCompany(user(1, "admin", false), mine)).toBe(false);
    expect(canEditCompany(null, mine)).toBe(false);
    expect(canEditCompany(user(1, "admin"), null)).toBe(false);
  });

  it("canSeeAll: supervisor and admin only", () => {
    expect(canSeeAll(user(1, "supervisor"))).toBe(true);
    expect(canSeeAll(user(1, "admin"))).toBe(true);
    expect(canSeeAll(user(1, "vendedor"))).toBe(false);
    expect(canSeeAll(user(1, "tecnico"))).toBe(false);
    expect(canSeeAll(user(1, "admin", false))).toBe(false);
    expect(canSeeAll(null)).toBe(false);
  });
});
