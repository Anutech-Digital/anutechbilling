/**
 * R-1547 — /api/auth/mfa/{enroll,verify} must not let a password-only (aal1) session add a new
 * authenticator to an account that already has two-step sign-in on, nor reach aal2 through one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Me = { user: { id: string; email: string }; aal: "aal1" | "aal2"; mfaEnrolled: boolean };
let me: Me | null = null;
let factors: { id: string; status: "verified" | "unverified" }[] = [];

const enroll = vi.fn(async () => ({ id: "new-factor", type: "totp" }));
const unstable_update = vi.fn(async (_: unknown) => ({ aal: "aal1" }));

vi.mock("@/server/auth/compat", () => ({ currentAuthUser: async () => me }));
vi.mock("@/server/auth/authjs", () => ({ unstable_update: (a: unknown) => unstable_update(a) }));
vi.mock("@/server/auth/http", async () => {
  const { NextResponse } = await import("next/server");
  return {
    authjsOff: () => null,
    limited: async () => null,
    noStore: (body: unknown, status = 200) => NextResponse.json(body, { status }),
    readJson: async (req: Request) => req.json().catch(() => ({})),
  };
});
vi.mock("@/server/auth/mfa", () => ({
  enroll: () => enroll(),
  unenroll: vi.fn(async () => true),
  listFactors: async () => factors.map((f) => ({ ...f, friendly_name: null, factor_type: "totp", created_at: "", updated_at: "" })),
}));

const { POST } = await import("./route");

const UID = "11111111-1111-4111-8111-111111111111";
const call = (action: string, body: unknown) =>
  POST(new NextRequest(`http://localhost/api/auth/mfa/${action}`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ action }) });

beforeEach(() => {
  enroll.mockClear();
  unstable_update.mockClear();
  factors = [];
  me = { user: { id: UID, email: "a@example.com" }, aal: "aal1", mfaEnrolled: false };
});

describe("POST /api/auth/mfa/enroll (R-1547)", () => {
  it("aal1 with a verified factor → 403 with the next step, nothing enrolled", async () => {
    factors = [{ id: "old", status: "verified" }];
    me = { ...me!, mfaEnrolled: true };
    const r = await call("enroll", {});
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/code from your current authenticator/);
    expect(enroll).not.toHaveBeenCalled();
  });

  it("refuses even when the session flag is stale (factor verified in DB, mfaEnrolled false)", async () => {
    factors = [{ id: "old", status: "verified" }];
    expect((await call("enroll", {})).status).toBe(403);
    expect(enroll).not.toHaveBeenCalled();
  });

  it("first-time enrollment at aal1 is allowed", async () => {
    expect((await call("enroll", {})).status).toBe(200);
    expect(enroll).toHaveBeenCalledOnce();
  });

  it("aal2 may add a second authenticator", async () => {
    factors = [{ id: "old", status: "verified" }];
    me = { ...me!, aal: "aal2", mfaEnrolled: true };
    expect((await call("enroll", {})).status).toBe(200);
  });
});

describe("POST /api/auth/mfa/verify (R-1547)", () => {
  it("aal1 + verified factor + new factor's id → 403, session not touched", async () => {
    factors = [{ id: "old", status: "verified" }, { id: "new", status: "unverified" }];
    me = { ...me!, mfaEnrolled: true };
    const r = await call("verify", { code: "123456", factorId: "new" });
    expect(r.status).toBe(403);
    expect(unstable_update).not.toHaveBeenCalled();
  });

  it("a factor id that is not on this account → 404", async () => {
    factors = [{ id: "old", status: "verified" }];
    const r = await call("verify", { code: "123456", factorId: "someone-elses" });
    expect(r.status).toBe(404);
    expect(unstable_update).not.toHaveBeenCalled();
  });

  it("normal sign-in step-up (existing factor) still goes to the session check", async () => {
    factors = [{ id: "old", status: "verified" }];
    unstable_update.mockResolvedValueOnce({ aal: "aal2" });
    const r = await call("verify", { code: "123456", factorId: "old" });
    expect(r.status).toBe(200);
    expect(unstable_update).toHaveBeenCalledOnce();
  });

  it("first-time enrollment verify still goes to the session check", async () => {
    factors = [{ id: "new", status: "unverified" }];
    unstable_update.mockResolvedValueOnce({ aal: "aal2" });
    expect((await call("verify", { code: "123456", factorId: "new" })).status).toBe(200);
  });
});
