import { describe, it, expect } from "vitest";
import { decideMembership, normalizeEmail } from "./membership";

describe("decideMembership — first-time sign-in tenant assignment", () => {
  it("joins the inviting tenant when an invite matches", () => {
    const d = decideMembership({ tenant_id: "tenant-democo", role: "owner" });
    expect(d).toEqual({ mode: "join", tenantId: "tenant-democo", role: "owner" });
  });

  it("creates a NEW tenant when there is no invite (no tenant leak)", () => {
    expect(decideMembership(null)).toEqual({ mode: "new" });
    expect(decideMembership(undefined)).toEqual({ mode: "new" });
  });

  it("never joins on a malformed invite with an empty tenant_id", () => {
    expect(decideMembership({ tenant_id: "", role: "sales" })).toEqual({ mode: "new" });
  });

  it("carries the invited role through", () => {
    const d = decideMembership({ tenant_id: "t1", role: "sales" });
    expect(d.mode === "join" && d.role).toBe("sales");
  });
});

describe("normalizeEmail", () => {
  it("lower-cases and trims", () => {
    expect(normalizeEmail("  Info@omegaco.test ")).toBe("info@omegaco.test");
  });
  it("handles null/undefined", () => {
    expect(normalizeEmail(null)).toBe("");
    expect(normalizeEmail(undefined)).toBe("");
  });
});
