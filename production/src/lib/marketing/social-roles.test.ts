/** R-2709: the marketing person approves and runs social posts; owner and manager may too. */
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({ withTenant: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/integrations/facebook-page", () => ({ readFacebookPage: vi.fn() }));
import { canReviewSocial, canWriteSocial } from "./social-content";

describe("R-2709 who approves social posts", () => {
  it("marketing, owner and manager approve; others cannot", () => {
    for (const r of ["marketing", "owner", "manager"]) { expect(canReviewSocial(r)).toBe(true); expect(canWriteSocial(r)).toBe(true); }
    for (const r of ["sales", "billing", "accountant", null]) { expect(canReviewSocial(r)).toBe(false); expect(canWriteSocial(r)).toBe(false); }
  });
});
