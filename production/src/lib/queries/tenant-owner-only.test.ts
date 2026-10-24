// R-1798 (R-1129 follow-up) — a manager's update to `tenants` matches 0 rows under the
// owner-only RLS policy, and `.single()` turns that into PGRST116 "JSON object requested,
// multiple (or no) rows returned". The user must see the §24 message instead.
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
import { OWNER_ONLY_COMPANY, tenantUpdateError } from "./tenant";

describe("tenant update — 0 rows means 'not the owner'", () => {
  it("maps PGRST116 to the owner-only message with a next step", () => {
    const err = tenantUpdateError({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" });
    expect(err.message).toBe("Only the owner can change company details");
    expect(OWNER_ONLY_COMPANY.description).toMatch(/ask the workspace owner/i);
    expect(OWNER_ONLY_COMPANY.description).toMatch(/nothing was saved/i);
  });
  it("leaves other errors alone", () => {
    const err = tenantUpdateError({ code: "23505", message: "duplicate key" });
    expect(err.message).toBe("duplicate key");
  });
});
