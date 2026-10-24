/**
 * R-1553 (18 Oct 2026): GET /api/inbound-emails/[id]/reply — "what was already sent to this
 * enquiry" — checked only the workspace, then read the enquiry and email_log through the admin
 * client. A support/delivery/billing login could list the replies (recipient + subject) to any
 * enquiry. The POST beside it asks mayOpenPage(["/enquiries", "/leads"]) (R-1470); GET asks the same.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const st = vi.hoisted(() => ({ role: "sales" as string | null, adminReads: 0 }));

vi.mock("@/lib/supabase/server", () => {
  const reader = () => {
    st.adminReads += 1;
    const b: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ["select", "eq", "gte", "order", "limit"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: { id: "E1", from_email: "a@b.test", created_at: "2026-10-01T00:00:00Z" } });
    b.then = (resolve: unknown) => (resolve as (v: unknown) => void)({ data: [], error: null });
    return b;
  };
  return {
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: "U1" } } }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { tenant_id: "T1", role: st.role } }) }) }) }),
    }),
    createAdminClientFor: () => ({ from: () => reader() }),
  };
});
vi.mock("@/lib/messaging", () => ({ sendCustomerEmail: vi.fn() }));
vi.mock("@/lib/ai/draft-feedback.server", () => ({ recordDraftFeedback: vi.fn() }));

import { GET } from "./route";

const call = () => GET(new Request("https://app.test/api/inbound-emails/E1/reply"), { params: Promise.resolve({ id: "E1" }) });

beforeEach(() => { st.role = "sales"; st.adminReads = 0; });

describe("GET /api/inbound-emails/[id]/reply — role gate (R-1553)", () => {
  it.each(["billing", "accountant", "support", "delivery", "partner_agent", null])(
    "%s → 403 before any admin read", async (role) => {
      st.role = role;
      const res = await call();
      expect(res.status).toBe(403);
      expect(st.adminReads).toBe(0);
    },
  );

  it.each(["owner", "manager", "sales", "sales_senior"])("%s still sees the replies", async (role) => {
    st.role = role;
    const res = await call();
    expect(res.status).toBe(200);
    expect(st.adminReads).toBeGreaterThan(0);
  });
});
