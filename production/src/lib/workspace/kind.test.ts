/**
 * R-2110 (GP-01, goal G-PERSONAL): the workspace kind and the 'personal' role.
 *   · parseWorkspaceKind falls back to 'business' for anything that is not a known kind —
 *     a missing column (before the migration), null, or a stray value;
 *   · 'personal' is a UserRole with every Record<UserRole> entry filled (no business power);
 *   · 'personal' is NOT invitable — an owner can never hand a colleague a personal seat.
 */
import { describe, it, expect } from "vitest";
import { parseWorkspaceKind, WORKSPACE_KINDS, isPersonalWorkspace } from "./kind";
import {
  USER_ROLES, INVITABLE_ROLES, ROLE_LABEL, PERMISSIONS, GATEWAY_LIMITED_BY_ROLE, can,
} from "@/lib/auth/roles";
import { ROLE_HOME } from "@/lib/nav";

describe("parseWorkspaceKind (R-2110)", () => {
  it("unknown, null or missing → business", () => {
    for (const v of [null, undefined, "", "x", "Personal ", 7, {}]) {
      expect(parseWorkspaceKind(v)).toBe("business");
    }
  });
  it("known kinds pass through", () => {
    expect(parseWorkspaceKind("personal")).toBe("personal");
    expect(parseWorkspaceKind("business")).toBe("business");
    expect(WORKSPACE_KINDS).toEqual(["personal", "business"]);
  });
  it("isPersonalWorkspace only for 'personal'", () => {
    expect(isPersonalWorkspace("personal")).toBe(true);
    expect(isPersonalWorkspace(null)).toBe(false);
    expect(isPersonalWorkspace("business")).toBe(false);
  });
});

describe("the 'personal' role (R-2110)", () => {
  it("is a UserRole but not invitable", () => {
    expect(USER_ROLES).toContain("personal");
    expect(INVITABLE_ROLES as readonly string[]).not.toContain("personal");
  });
  it("has a label, a home and no business permission", () => {
    expect(ROLE_LABEL.personal).toBe("Personal");
    expect(ROLE_HOME.personal).toBe("/vault/personal");
    expect(Object.values(PERMISSIONS.personal).every((v) => v === false)).toBe(true);
    expect(can("personal", "can_export_data")).toBe(false);
    expect(GATEWAY_LIMITED_BY_ROLE.personal).toBe(true);
  });
});
