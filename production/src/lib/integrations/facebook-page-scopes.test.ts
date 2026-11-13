/** R-2706: insights permissions are asked only when the Meta app has them (else Meta refuses the whole login). */
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(), createAdminClient: vi.fn() }));
import { facebookPageScopes } from "./facebook-page";

describe("Facebook Page connect scopes", () => {
  it("does not ask read_insights / instagram_manage_insights by default", () => {
    const s = facebookPageScopes({});
    expect(s).toContain("pages_manage_posts");
    expect(s).not.toContain("read_insights");
    expect(s).not.toContain("instagram_manage_insights");
  });
  it("asks them when META_INSIGHTS_SCOPES=1", () => {
    expect(facebookPageScopes({ META_INSIGHTS_SCOPES: "1" })).toMatch(/,read_insights,instagram_manage_insights$/);
  });
});
