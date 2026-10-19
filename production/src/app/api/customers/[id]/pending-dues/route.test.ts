/**
 * R-1526 — the "Send pending dues" routes.
 *   • GET  /api/customers/{id}/pending-dues       preview (sends nothing)
 *   • GET  /api/customers/{id}/pending-dues/pdf   the statement PDF
 *   • POST /api/customers/{id}/pending-dues/email a person pressed Send
 * Role gate = the roles that can open /collections. Email only through lib/messaging's
 * sendCustomerEmail (mocked — nothing real is sent), PDF attached, to the customer's own billing
 * email; a real send logs a payment follow-up (kind email) through followup-log.server.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "44444444-4444-4444-8444-444444444444";
const CUST = "33333333-3333-4333-8333-333333333333";

const st = vi.hoisted(() => ({
  role: "accountant" as string,
  customer: null as Record<string, unknown> | null,
  email: "accounts@acme.in" as string | null,
  sendStatus: "sent" as "sent" | "stubbed" | "failed",
  total: 72300,
  found: true,
  inserts: [] as Record<string, unknown>[],
  sends: [] as Record<string, unknown>[],
  loads: [] as Array<{ customerId: string; tenantId: string }>,
}));

vi.mock("@/lib/supabase/server", () => {
  const chain = (table: string) => {
    let inserted: Record<string, unknown> | null = null;
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "in", "update"]) q[m] = () => q;
    q.insert = (row: Record<string, unknown>) => {
      inserted = row;
      if (table !== "customer_email_sends") st.inserts.push(row);   // R-1544's send claim: lib/collections/email-send-once.test.ts
      return q;
    };
    const one = async () => {
      if (table === "users") return { data: { tenant_id: "T1", role: st.role }, error: null };
      if (table === "customers") return { data: st.customer, error: null };
      if (["invoices", "quotes", "subscriptions"].includes(table)) return { data: { customer_id: CUST }, error: null };
      if (table === "customer_email_sends") return { data: { id: "S1" }, error: null };
      if (table === "payment_followups") {
        return inserted ? { data: { id: "F1", assigned_to: inserted.assigned_to }, error: null } : { data: null, error: null };
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
  primaryContactEmail: async () => ({ email: st.email, name: "Rahul", fromLegacy: false }),
  primaryContactFor: async () => ({ customerId: CUST, name: "Rahul", email: st.email, phone: "9876543210", fromLegacy: false }),
}));
vi.mock("@/lib/messaging", () => ({
  sendCustomerEmail: async (m: Record<string, unknown>) => {
    st.sends.push(m);
    return st.sendStatus === "failed"
      ? { status: "failed", providerId: null, errorMessage: "Customer messages are off in Automation.", provider: "stub" }
      : { status: st.sendStatus, providerId: st.sendStatus === "sent" ? "p1" : null, errorMessage: null, provider: st.sendStatus === "sent" ? "resend" : "stub" };
  },
}));
vi.mock("@/lib/collections/pending-dues.server", async () => {
  const { buildPendingDuesStatement } = await import("@/lib/collections/pending-dues");
  const raw = () => ({
    customer: { id: CUST, name: "Acme Ltd", display_name: null, gstin: null, address: null, city: null, state: null },
    tenant: {
      name: "Demo Co", gstin: null, email: null, phone: null, address: null, upi_vpa: null, upi_payee_name: null, logo_url: null,
      remit_bank_name: null, remit_account_name: null, remit_account_number: null, remit_ifsc: null, remit_branch: null,
    },
    invoices: st.total > 0 ? [{
      id: "INV-1", amount: st.total, net_payable: st.total, paid_amount: 0, status: "overdue",
      invoice_date: "2026-09-01", due_date: "2026-09-15", quote_id: "Q-1", currency: "INR",
    }] : [],
    subscriptions: [],
    invoicedQuoteIds: new Set<string>(),
  });
  return {
    loadPendingDuesRaw: async (_db: unknown, o: { customerId: string; tenantId: string }) => { st.loads.push(o); return st.found ? raw() : null; },
    pendingDuesPdfFor: async (_db: unknown, o: { customerId: string; tenantId: string; today: string }) => {
      st.loads.push(o);
      if (!st.found) return null;
      const r = raw();
      return { pdf: Buffer.from("%PDF-1.4 fake"), statement: buildPendingDuesStatement(r, o.today), raw: r };
    },
  };
});
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));
vi.stubEnv("PDF_SIGNING_SECRET", "test-only-signing-secret-r1526");

import { GET as preview } from "./route";
import { GET as pdf } from "./pdf/route";
import { POST as email } from "./email/route";

const ctx = (id = CUST) => ({ params: Promise.resolve({ id }) });
const get = (path: string) => new NextRequest(`https://app.example${path}`);
const post = (body: unknown) => new NextRequest(`https://app.example/api/customers/${CUST}/pending-dues/email`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const BODY = { subject: "Statement of pending dues: ₹72,300", message: "Hi Rahul, please find attached the statement: ₹72,300.\n\n• Invoice INV-1", nextFollowUpOn: "2026-10-20", requestId: "99999999-9999-4999-8999-999999999999" };

beforeEach(() => {
  st.role = "accountant";
  st.customer = { id: CUST, account_manager_id: OWNER };
  st.email = "accounts@acme.in";
  st.sendStatus = "sent";
  st.total = 72300;
  st.found = true;
  st.inserts = [];
  st.sends = [];
  st.loads = [];
});

describe("role gate — same roles as /collections", () => {
  it("support cannot preview, open the PDF or send (403), and nothing is read or sent", async () => {
    st.role = "support";
    expect((await preview(get(`/api/customers/${CUST}/pending-dues`), ctx())).status).toBe(403);
    expect((await pdf(get(`/api/customers/${CUST}/pending-dues/pdf`), ctx())).status).toBe(403);
    expect((await email(post(BODY), ctx())).status).toBe(403);
    expect(st.loads).toHaveLength(0);
    expect(st.sends).toHaveLength(0);
  });

  it("billing / accountant / sales may open the preview; reads are pinned to the caller's company", async () => {
    for (const role of ["billing", "accountant", "sales"]) {
      st.role = role;
      expect((await preview(get(`/api/customers/${CUST}/pending-dues`), ctx())).status).toBe(200);
    }
    expect(st.loads.every((l) => l.tenantId === "T1" && l.customerId === CUST)).toBe(true);
  });
});

describe("GET preview", () => {
  it("total, bills, the §24 no-UPI note, targets, a signed 7-day statement link in the WhatsApp text", async () => {
    const res = await preview(get(`/api/customers/${CUST}/pending-dues`), ctx());
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.total).toBe(72300);
    expect(j.lines.map((l: { id: string }) => l.id)).toEqual(["INV-1"]);
    expect(j.qrNotice.reason).toBe("no-upi");
    expect(j.email).toBe("accounts@acme.in");
    expect(j.whatsapp).toBe("919876543210");
    expect(j.whatsappText).toContain("₹72,300");
    expect(j.whatsappText).toMatch(new RegExp(`/api/v1/documents/statement/${CUST}/pdf\\?token=\\d+\\.[0-9a-f]{64}`));
    expect(j.about).toEqual({ invoiceId: "INV-1", subscriptionId: null, quoteId: "Q-1" });
  });

  it("not a uuid / not in this company → 404", async () => {
    expect((await preview(get("/api/customers/x/pending-dues"), ctx("not-a-uuid"))).status).toBe(404);
    st.found = false;
    expect((await preview(get(`/api/customers/${CUST}/pending-dues`), ctx())).status).toBe(404);
  });
});

describe("GET pdf", () => {
  it("returns the PDF inline", async () => {
    const res = await pdf(get(`/api/customers/${CUST}/pending-dues/pdf`), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/Pending-dues-Acme-Ltd-\d{4}-\d{2}-\d{2}\.pdf/);
  });
});

describe("POST email — through the chokepoint, PDF attached, then the follow-up is logged", () => {
  it("sends to the customer's own email with the statement PDF and logs kind=email", async () => {
    const res = await email(post(BODY), ctx());
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j).toMatchObject({ ok: true, sentTo: "accounts@acme.in", logged: true, total: 72300 });
    expect(st.sends).toHaveLength(1);
    const m = st.sends[0] as { to: string; kind: string; route: { tenantId: string }; attachments: Array<{ filename: string; contentType: string }> };
    expect(m.to).toBe("accounts@acme.in");
    expect(m.kind).toBe("pending_dues_statement");
    expect(m.route.tenantId).toBe("T1");
    expect(m.attachments[0].filename).toMatch(/^Pending-dues-Acme-Ltd-.*\.pdf$/);
    expect(m.attachments[0].contentType).toBe("application/pdf");
    expect(st.inserts).toHaveLength(1);
    expect(st.inserts[0]).toMatchObject({
      tenant_id: "T1", customer_id: CUST, kind: "email", next_follow_up_on: "2026-10-20",
      note: "Hi Rahul, please find attached the statement: ₹72,300.", invoice_id: "INV-1",
    });
  });

  it("the body cannot choose the recipient", async () => {
    expect((await email(post({ ...BODY, to: "someone@else.in" }), ctx())).status).toBe(400);
    expect(st.sends).toHaveLength(0);
  });

  it("no next follow-up date → refused, nothing sent", async () => {
    expect((await email(post({ ...BODY, nextFollowUpOn: "" }), ctx())).status).toBe(400);
    expect(st.sends).toHaveLength(0);
  });

  it("nothing owed now → 409, nothing sent", async () => {
    st.total = 0;
    expect((await email(post(BODY), ctx())).status).toBe(409);
    expect(st.sends).toHaveLength(0);
  });

  it("no billing email → 422 with how to fix it", async () => {
    st.email = null;
    const res = await email(post(BODY), ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/primary contact/);
  });

  it("refused by the Customer messages switch → error, nothing logged", async () => {
    st.sendStatus = "failed";
    expect((await email(post(BODY), ctx())).status).toBe(502);
    expect(st.inserts).toHaveLength(0);
  });
});
