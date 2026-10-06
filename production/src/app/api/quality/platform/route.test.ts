/** R-263: the "All workspaces" numbers are for the platform owner only — checked before the service role exists. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const createAdminClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser } }),
  createAdminClient: () => createAdminClient(),
}));
vi.mock("@/lib/platform", () => ({ isPlatformAdmin: (e: string | null | undefined) => e === "founder@example.invalid" }));

import { GET } from "./route";

beforeEach(() => { getUser.mockReset(); createAdminClient.mockReset(); });

describe("GET /api/quality/platform", () => {
  it("401 when signed out", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await GET()).status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("403 for anyone not on the founder allowlist — and the service role is never created", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "owner@tenant.example.invalid" } } });
    const res = await GET();
    expect(res.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
