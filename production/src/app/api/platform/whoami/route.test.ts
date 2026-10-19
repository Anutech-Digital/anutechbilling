/** R-730 — GET /api/platform/whoami answers about the caller only, never returns the list. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const st = vi.hoisted(() => ({ user: null as { email?: string } | null }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: st.user }, error: null }) } }),
}));

import { GET } from "./route";

beforeEach(() => {
  vi.stubEnv("PLATFORM_ADMIN_EMAILS", "boss@anutech.in,other@anutech.in");
});
afterEach(() => vi.unstubAllEnvs());

describe("R-730 /api/platform/whoami", () => {
  it("an admin gets true — and only a boolean, not the allowlist", async () => {
    st.user = { email: "Boss@anutech.in" };
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ isPlatformAdmin: true });
    expect(JSON.stringify(body)).not.toContain("other@anutech.in");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("a normal user gets false", async () => {
    st.user = { email: "sales@client.in" };
    expect(await (await GET()).json()).toEqual({ isPlatformAdmin: false });
  });

  it("signed out gets false", async () => {
    st.user = null;
    expect(await (await GET()).json()).toEqual({ isPlatformAdmin: false });
  });
});
