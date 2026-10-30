/**
 * R-2176 — POST /api/personal/support-ticket: the session user is the ONLY identity. No user id,
 * tenant or customer comes from the request; the service-role client is made for the session
 * user and every read/write in filePersonalSupportTicket is pinned to that user.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getUser, adminFor, file, profile } = vi.hoisted(() => {
  const profile: { row: { role: string; full_name: string | null } | null; askedFor: string[] } = { row: null, askedFor: [] };
  const adminFor = vi.fn((id: string) => ({
    __admin: id,
    from: (t: string) => {
      if (t !== "users") throw new Error("unexpected table " + t);
      return { select: () => ({ eq: (_c: string, v: string) => { profile.askedFor.push(v); return { maybeSingle: async () => ({ data: profile.row }) }; } }) };
    },
  }));
  return { getUser: vi.fn(), adminFor, file: vi.fn(), profile };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser } }),
  createAdminClientFor: (id: string) => adminFor(id),
}));
vi.mock("@/lib/support/personal-report", async (orig) => ({
  ...(await orig<typeof import("@/lib/support/personal-report")>()),
  filePersonalSupportTicket: (...a: unknown[]) => file(...a),
}));

import { POST } from "./route";

const req = (body: unknown) => new Request("http://x/api/personal/support-ticket", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  getUser.mockReset(); adminFor.mockClear(); file.mockReset();
  profile.row = { role: "personal", full_name: "Asha" }; profile.askedFor = [];
});

describe("POST /api/personal/support-ticket (R-2176)", () => {
  it("not signed in → 401, nothing filed", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const res = await POST(req({ text: "hi" }) as never);
    expect(res.status).toBe(401);
    expect(file).not.toHaveBeenCalled();
  });

  it("files for the SESSION user — a user id in the body is ignored", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "me" } } });
    file.mockResolvedValue({ ok: true, ticketId: "TKT-ABC-01" });
    const res = await POST(req({ text: "Broken", type: "bug", severity: "high", pagePath: "/assets", userId: "someone-else" }) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticketId: "TKT-ABC-01" });
    expect(adminFor).toHaveBeenCalledWith("me");
    expect(profile.askedFor).toEqual(["me"]);
    expect(file).toHaveBeenCalledWith(expect.objectContaining({ __admin: "me" }), "me", "Asha", { text: "Broken", type: "bug", severity: "high", pagePath: "/assets" });
  });

  it("unknown kind/severity fall back to bug/medium; over-long text is refused", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "me" } } });
    file.mockResolvedValue({ ok: true, ticketId: "T" });
    await POST(req({ text: "x", type: "hack", severity: "nope" }) as never);
    expect(file.mock.calls[0][3]).toMatchObject({ type: "bug", severity: "medium", pagePath: "" });
    const res = await POST(req({ text: "x".repeat(9000) }) as never);
    expect(res.status).toBe(400);
  });

  it("a business login (or no users row) → 403, nothing filed — it reports into Admin → Feedback", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "me" } } });
    profile.row = { role: "owner", full_name: "O" };
    expect((await POST(req({ text: "x" }) as never)).status).toBe(403);
    profile.row = null;
    expect((await POST(req({ text: "x" }) as never)).status).toBe(403);
    expect(file).not.toHaveBeenCalled();
  });

  it("a refusal keeps its status and honest message", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "me" } } });
    file.mockResolvedValue({ ok: false, code: "NOT_LINKED", status: 409, error: "Your report was NOT sent." });
    const res = await POST(req({ text: "x" }) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Your report was NOT sent.", code: "NOT_LINKED" });
  });
});
