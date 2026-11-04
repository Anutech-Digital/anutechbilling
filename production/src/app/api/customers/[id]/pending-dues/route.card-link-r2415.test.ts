/**
 * R-2415 — the Full statement preview carries ONE Razorpay link for the total (made / reused by
 * lib/payments/payment-link.server, mocked here) next to the UPI link, in both messages.
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
const card = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/payments/payment-link.server", () => ({ getOrCreateInvoicePayLink: (...a: unknown[]) => card.fn(...a) }));

import { GET as preview, POST as make } from "./route";

const ctx = (id = CUST) => ({ params: Promise.resolve({ id }) });
const get = (path: string) => new NextRequest(`https://app.example${path}`);

beforeEach(() => {
  st.role = "accountant";
  st.customer = { id: CUST, account_manager_id: OWNER };
  st.email = "accounts@acme.in";
  st.total = 72300;
  st.found = true;
  st.loads = [];
  card.fn.mockReset();
});

describe("R-2415 — Full statement carries ONE Razorpay link for the total", () => {
  it("asks for the statement link with every open bill and puts it in both messages", async () => {
    card.fn.mockResolvedValue({ link: { url: "https://rzp.io/i/stmt1", amount: 72_300, billAmount: 72_300, mode: "test" }, notice: null });
    const j = await (await preview(get(`/api/customers/${CUST}/pending-dues`), ctx())).json();
    expect(card.fn).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "T1", customerId: CUST, scope: "statement",
      lines: [{ kind: "invoice", id: "INV-1", amountDue: 72_300 }],
    }));
    expect(j.whatsappText).toContain("Pay by card / UPI / net banking: https://rzp.io/i/stmt1");
    expect(j.emailText).toContain("Pay by card / UPI / net banking: https://rzp.io/i/stmt1");
    expect(j.cardLink).toMatchObject({ url: "https://rzp.io/i/stmt1", amount: 72_300 });
  });

  it("no link → texts unchanged, the notice says why", async () => {
    card.fn.mockResolvedValue({ link: null, notice: { reason: "not_configured", text: "No card / net-banking link — Razorpay is not connected." } });
    const j = await (await preview(get(`/api/customers/${CUST}/pending-dues`), ctx())).json();
    expect(j.whatsappText).not.toContain("net banking");
    expect(j.cardLink).toBeNull();
    expect(j.cardLinkNotice.reason).toBe("not_configured");
  });
});

/* R-2439 (review of R-2415, item 2): a GET only READS the link (prefetch / reload must never make
   or cancel one); the dialog's POST is what makes or brings it up to date. */
describe("R-2439 — GET reads the link, POST makes it", () => {
  const post = (path: string) => new NextRequest(`https://app.example${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin: "https://app.example" }, body: "{}",
  });

  it("GET asks read-only", async () => {
    card.fn.mockResolvedValue({ link: null, notice: { reason: "not_made", text: "No card / net-banking link yet" } });
    const j = await (await preview(get(`/api/customers/${CUST}/pending-dues`), ctx())).json();
    expect(card.fn).toHaveBeenCalledTimes(1);
    expect(card.fn.mock.calls[0][0]).toMatchObject({ readOnly: true });
    expect(j.cardLink).toBeNull();
  });

  it("POST makes / reuses the link and returns the same preview with it in both messages", async () => {
    card.fn.mockResolvedValue({ link: { url: "https://rzp.io/i/stmt2", amount: 72_300, billAmount: 72_300, mode: "test" }, notice: null });
    const res = await make(post(`/api/customers/${CUST}/pending-dues`), ctx());
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(card.fn).toHaveBeenCalledTimes(1);
    expect(card.fn.mock.calls[0][0].readOnly).not.toBe(true);
    expect(j.whatsappText).toContain("https://rzp.io/i/stmt2");
    expect(j.total).toBe(72_300);
  });
});
