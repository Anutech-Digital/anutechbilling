/**
 * verify-landing — where a just-confirmed password signup lands (R-1926), and R-2119 (GP-05):
 * a personal login lands on /money, never the company setup wizard.
 */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { landingAfterVerify, SETUP_WELCOME_PATH } from "./verify-landing";

const UID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function fake(user: Record<string, unknown> | null, tenant: Record<string, unknown> | null) {
  const from = (table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: table === "users" ? user : tenant, error: null }),
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

describe("landingAfterVerify", () => {
  it("an owner with setup not finished → the setup wizard", async () => {
    expect(await landingAfterVerify(fake({ id: UID, tenant_id: T, role: "owner" }, { setup_completed_at: null }), UID)).toBe(SETUP_WELCOME_PATH);
  });
  it("an owner with setup done → dashboard; a team member → dashboard", async () => {
    expect(await landingAfterVerify(fake({ id: UID, tenant_id: T, role: "owner" }, { setup_completed_at: "2026-10-01" }), UID)).toBe("/dashboard");
    expect(await landingAfterVerify(fake({ id: UID, tenant_id: T, role: "sales" }, null), UID)).toBe("/dashboard");
  });
  it("R-2119: role personal → /money (never /setup, never /dashboard)", async () => {
    expect(await landingAfterVerify(fake({ id: UID, tenant_id: T, role: "personal" }, { setup_completed_at: null }), UID)).toBe("/money");
  });
  it("no users row → null (no session)", async () => {
    expect(await landingAfterVerify(fake(null, null), UID)).toBeNull();
  });
});
