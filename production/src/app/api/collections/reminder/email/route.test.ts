/**
 * R-1518 — POST /api/collections/reminder/email: a person pressed Send. The email goes through
 * lib/messaging (sendCustomerEmail — never a raw sender), to the customer's own billing email
 * (never one from the body), and only a real send logs the follow-up (kind email, first line,
 * next date). Nothing real is sent here: lib/messaging is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "44444444-4444-4444-8444-444444444444";
const CUST = "33333333-3333-4333-8333-333333333333";

const db = vi.hoisted(() => ({
  role: "accountant" as string,
  customer: null as Record<string, unknown> | null,
  email: "accounts@sharma.in" as string | null,
  sendStatus: "sent" as "sent" | "stubbed" | "failed",
  insertError: null as { code: string; message: string } | null,
  inserts: [] as Record<string, unknown>[],
  sends: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/supabase/server", () => {
  const chain = (table: string) => {
    let inserted: Record<string, unknown> | null = null;
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "in"]) q[m] = () => q;
    q.insert = (row: Record<string, unknown>) => { inserted = row; db.inserts.push(row); return q; };
    const one = async () => {
      if (table === "users") return { data: { tenant_id: "T1", role: db.role }, error: null };
      if (table === "customers") return { data: db.customer, error: null };
      if (table === "payment_followups") {
        if (inserted) return db.insertError ? { data: null, error: db.insertError } : { data: { id: "F1", assigned_to: inserted.assigned_to }, error: null };
        return { data: null, error: null };
      }
      return { data: null, error: null };
    };
    q.single = one;
    q.maybeSingle = one;
    return q;
  };
  return {
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: ME, email: "me@example.invalid" } } }) },
      from: chain,
    }),
  };
});
vi.mock("@/lib/contacts/primary", () => ({
  primaryContactEmail: async () => ({ email: db.email, name: "Rahul", fromLegacy: false }),
}));
vi.mock("@/lib/messaging", () => ({
  sendCustomerEmail: async (m: Record<string, unknown>) => {
    db.sends.push(m);
    return db.sendStatus === "failed"
      ? { status: "failed", providerId: null, errorMessage: "Customer messages are off in Automation.", provider: "stub" }
      : { status: db.sendStatus, providerId: db.sendStatus === "sent" ? "p1" : null, errorMessage: null, provider: db.sendStatus === "sent" ? "resend" : "stub" };
  },
}));
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));

import { POST } from "./route";

const call = (body: unknown) =>
  POST(new NextRequest("https://example.invalid/api/collections/reminder/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

const MSG = "Hi Rahul, a gentle reminder from Anutech: ₹72,500 is pending for Sharma Traders, 12 days overdue.\n\n• Invoice INV-101: ₹68,000";
const base = { customerId: CUST, subject: "Payment reminder: ₹72,500 pending", message: MSG, nextFollowUpOn: "2026-10-20", invoiceId: "INV-101", quoteId: "Q-1" };

beforeEach(() => {
  db.role = "accountant";
  db.customer = { id: CUST, account_manager_id: OWNER };
  db.email = "accounts@sharma.in";
  db.sendStatus = "sent";
  db.insertError = null;
  db.inserts = [];
  db.sends = [];
});

describe("send + log", () => {
  it("sends the edited text to the customer's billing email through sendCustomerEmail, then logs it", async () => {
    const res = await call(base);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sentTo: "accounts@sharma.in", followupId: "F1", logged: true });
    expect(db.sends).toEqual([{
      to: "accounts@sharma.in", subject: base.subject, text: MSG, route: { tenantId: "T1" }, kind: "payment_reminder",
    }]);
    expect(db.inserts).toEqual([{
      tenant_id: "T1", customer_id: CUST, kind: "email",
      note: "Hi Rahul, a gentle reminder from Anutech: ₹72,500 is pending for Sharma Traders, 12 days overdue.",
      promised_amount: null, promised_on: null, next_follow_up_on: "2026-10-20", assigned_to: OWNER,
      invoice_id: "INV-101", quote_id: "Q-1", subscription_id: null,
    }]);
  });

  it("no next follow-up date → 400, nothing sent, nothing logged", async () => {
    const res = await call({ ...base, nextFollowUpOn: undefined });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/next follow-up date/);
    expect(db.sends).toEqual([]);
    expect(db.inserts).toEqual([]);
  });

  it("a recipient in the body is refused — the address comes from the customer only", async () => {
    const res = await call({ ...base, to: "someone@else.com" });
    expect(res.status).toBe(400);
    expect(db.sends).toEqual([]);
  });

  it("no billing email → 422 with where to add one, nothing sent", async () => {
    db.email = null;
    const res = await call(base);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/customer page/);
    expect(db.sends).toEqual([]);
  });

  it("refused by the Customer messages switch → 502 with the reason, nothing logged", async () => {
    db.sendStatus = "failed";
    const res = await call(base);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/Customer messages are off.*nothing was logged/);
    expect(db.inserts).toEqual([]);
  });

  it("email not set up (stub) → 503, nothing logged — a stub reached nobody", async () => {
    db.sendStatus = "stubbed";
    const res = await call(base);
    expect(res.status).toBe(503);
    expect(db.inserts).toEqual([]);
  });

  it("sent but the log failed → ok with a warning not to send again", async () => {
    db.insertError = { code: "42501", message: "rls" };
    const res = await call(base);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.logged).toBe(false);
    expect(json.warning).toMatch(/do not send the email again/);
    expect(json.warning).not.toMatch(/rls/);
    expect(db.sends).toHaveLength(1);
  });

  it.each(["support", "delivery"])("%s cannot open Payment Follow-up → 403, nothing sent", async (role) => {
    db.role = role;
    const res = await call(base);
    expect(res.status).toBe(403);
    expect(db.sends).toEqual([]);
  });
});
