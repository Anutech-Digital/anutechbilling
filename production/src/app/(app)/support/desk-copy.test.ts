/**
 * R-1487: the desk subtitle says "across all workspaces" ONLY to a platform admin — the one
 * person whose list really spans companies. Everyone else sees their own company's tickets
 * (RLS support_tickets_select_own_tenant + the API's tenant filter), and the copy says so.
 */
import { describe, it, expect } from "vitest";
import { supportDeskSubtitle } from "./desk-copy";

describe("supportDeskSubtitle (R-1487)", () => {
  it("a company's own user is told it is their company's tickets, not all workspaces", () => {
    const s = supportDeskSubtitle(false);
    expect(s).not.toMatch(/all workspaces/i);
    expect(s).toMatch(/your company/i);
  });
  it("a platform admin is told the list spans all workspaces", () => {
    expect(supportDeskSubtitle(true)).toMatch(/across all workspaces/i);
  });
  it("unknown (still loading) reads as the narrow, own-company copy", () => {
    expect(supportDeskSubtitle(undefined)).toBe(supportDeskSubtitle(false));
  });
});
