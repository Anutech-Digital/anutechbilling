/**
 * R-2692: approving a post WITH a post time turns the social-publish job on (through
 * ensureSocialJobOn — the database decides owner/manager and never overrides an owner's OFF);
 * approving without a time, or any other action, leaves the switch alone. Marketing still
 * cannot approve through the API.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ role: "manager" as string, scheduled: "2026-11-12T10:00:00Z" as string | null, status: "review" }));
const ensure = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@/server/auth/session", () => ({ getTenantSession: async () => ({ userId: "u1", tenantId: "t1" }) }));
vi.mock("@/server/db", () => ({
  withTenant: async () => [{ status: state.status, platform: "facebook", format: "post", media_url: null, caption: "Hello" }],
}));
vi.mock("@/lib/automation/social-jobs.server", () => ({ ensureSocialJobOn: ensure }));
vi.mock("@/lib/marketing/social-content", () => ({
  socialRole: async () => state.role,
  canWriteSocial: (r: string | null) => r === "owner" || r === "manager" || r === "marketing",
  canReviewSocial: (r: string | null) => r === "owner" || r === "manager",
  validMediaUrl: () => true,
  updateSocial: async (_s: unknown, id: string, patch: { status?: string }) => ({ id, status: patch.status ?? state.status, scheduled_at: state.scheduled }),
  claimApproved: async () => null,
  completePublish: async () => {},
  publishSocial: async () => "x",
}));

import { PATCH } from "./route";

const ID = "11111111-2222-3333-4444-555555555555";
const call = (body: unknown) => PATCH(new Request(`http://x/api/marketing/social-content/${ID}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: ID }) });

describe("R-2692 social approve turns on scheduled posting", () => {
  beforeEach(() => { ensure.mockClear(); state.role = "manager"; state.scheduled = "2026-11-12T10:00:00Z"; state.status = "review"; });

  it("approve with a post time → social-publish turned on, result returned", async () => {
    const res = await call({ action: "approve" });
    expect(res.status).toBe(200);
    expect(ensure).toHaveBeenCalledWith("social-publish");
    expect(await res.json()).toMatchObject({ item: { status: "approved" }, autoPostOn: true });
  });

  it("approve without a post time → switch untouched", async () => {
    state.scheduled = null;
    const res = await call({ action: "approve" });
    expect(res.status).toBe(200);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("submit by marketing → switch untouched; approve by marketing → 403", async () => {
    state.role = "marketing"; state.status = "draft";
    expect((await call({ action: "submit" })).status).toBe(200);
    state.status = "review";
    expect((await call({ action: "approve" })).status).toBe(403);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("the approval stands even when the switch could not be checked", async () => {
    ensure.mockResolvedValueOnce(null as unknown as boolean);
    const res = await call({ action: "approve" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ item: { status: "approved" }, autoPostOn: null });
  });
});
