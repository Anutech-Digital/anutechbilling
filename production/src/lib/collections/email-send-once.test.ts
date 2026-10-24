/**
 * R-1544 — a payment reminder / pending-dues email goes to the customer ONCE per press of Send,
 * however often the browser retries; a follow-up never links another customer's bill.
 *
 * Before the fix:
 *   • api/collections/reminder/email/route.ts:68 and api/customers/[id]/pending-dues/email/route.ts:71
 *     called sendCustomerEmail with no idempotency key — a timeout + Send again mailed twice
 *     (only `disabled={busy}` in the dialogs guarded it, and that resets on the error).
 *   • reminder/email/route.ts:36-38 took invoiceId / quoteId / subscriptionId from the body and
 *     followup-log.server.ts inserted them unchecked — the DB trigger only checks the COMPANY,
 *     so customer A's follow-up could point at customer B's invoice.
 * Nothing real is sent: lib/messaging is mocked; the database is an in-memory fake with the
 * (tenant_id, request_id) unique key of customer_email_sends.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "44444444-4444-4444-8444-444444444444";
const CUST = "33333333-3333-4333-8333-333333333333";
const OTHER = "55555555-5555-4555-8555-555555555555";
const SUB_MINE = "66666666-6666-4666-8666-666666666666";
const SUB_OTHER = "77777777-7777-4777-8777-777777777777";
const REQ = "99999999-9999-4999-8999-999999999999";
const REQ2 = "88888888-8888-4888-8888-888888888888";

type Row = Record<string, unknown>;

const st = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  sendStatus: "sent" as "sent" | "stubbed" | "failed",
  sends: [] as Row[],
  n: 0,
}));

vi.mock("@/lib/supabase/server", () => {
  const from = (table: string) => {
    let op: "select" | "insert" | "update" = "select";
    let payload: Row | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    let limit = Infinity;
    const rows = () => (st.tables[table] ??= []);
    const run = async (): Promise<{ data: Row[] | null; error: { code: string; message: string } | null }> => {
      await Promise.resolve();
      if (op === "insert") {
        const row: Row = { id: `${table}-${++st.n}`, created_by: ME, ...payload };
        if (table === "customer_email_sends"
          && rows().some((r) => r.tenant_id === row.tenant_id && r.request_id === row.request_id)) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        rows().push(row);
        return { data: [row], error: null };
      }
      const hit = rows().filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of hit) Object.assign(r, payload);
        return { data: hit, error: null };
      }
      return { data: hit.slice(0, limit), error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      order: () => q,
      limit: (n: number) => { limit = n; return q; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return q; },
      insert: (row: Row) => { op = "insert"; payload = row; return q; },
      update: (patch: Row) => { op = "update"; payload = patch; return q; },
      maybeSingle: async () => { const r = await run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      single: async () => { const r = await run(); return { data: r.data?.[0] ?? null, error: r.error ?? (r.data?.[0] ? null : { code: "PGRST116", message: "no rows" }) }; },
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => run().then(ok, bad),
    };
    return q;
  };
  return {
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: ME, email: "me@example.invalid" } } }) },
      from,
    }),
  };
});
vi.mock("@/lib/contacts/primary", () => ({
  primaryContactEmail: async () => ({ email: "accounts@sharma.in", name: "Rahul", fromLegacy: false }),
}));
vi.mock("@/lib/messaging", () => ({
  sendCustomerEmail: async (m: Row) => {
    st.sends.push(m);
    await new Promise((r) => setTimeout(r, 5));   // a slow provider: a retry can arrive meanwhile
    return st.sendStatus === "failed"
      ? { status: "failed", providerId: null, errorMessage: "The mail server timed out.", provider: "resend" }
      : { status: st.sendStatus, providerId: st.sendStatus === "sent" ? "p1" : null, errorMessage: null, provider: st.sendStatus === "sent" ? "resend" : "stub" };
  },
}));
vi.mock("@/lib/collections/pending-dues.server", async () => {
  const { buildPendingDuesStatement } = await import("@/lib/collections/pending-dues");
  return {
    pendingDuesPdfFor: async (_db: unknown, o: { customerId: string; tenantId: string; today: string }) => {
      const raw = {
        customer: { id: o.customerId, name: "Sharma Traders", display_name: null, gstin: null, address: null, city: null, state: null },
        tenant: {
          name: "Demo Co", gstin: null, email: null, phone: null, address: null, upi_vpa: null, upi_payee_name: null, logo_url: null,
          remit_bank_name: null, remit_account_name: null, remit_account_number: null, remit_ifsc: null, remit_branch: null,
        },
        invoices: [{
          id: "INV-101", amount: 72300, net_payable: 72300, paid_amount: 0, status: "overdue",
          invoice_date: "2026-09-01", due_date: "2026-09-15", quote_id: "Q-1", currency: "INR",
        }],
        subscriptions: [],
        invoicedQuoteIds: new Set<string>(),
      };
      return { pdf: Buffer.from("%PDF-1.4 fake"), statement: buildPendingDuesStatement(raw, o.today), raw };
    },
  };
});
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));

import { POST as reminderEmail } from "@/app/api/collections/reminder/email/route";
import { POST as duesEmail } from "@/app/api/customers/[id]/pending-dues/email/route";
import { POST as addFollowup } from "@/app/api/collections/followups/route";

const json = (url: string, body: unknown) => new NextRequest(url, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const remind = (body: Row) => reminderEmail(json("https://app.example/api/collections/reminder/email", body));
const dues = (body: Row) => duesEmail(
  json(`https://app.example/api/customers/${CUST}/pending-dues/email`, body),
  { params: Promise.resolve({ id: CUST }) },
);

const REMIND = {
  customerId: CUST, subject: "Payment reminder: ₹72,300 pending", message: "Hi Rahul, ₹72,300 is pending.",
  nextFollowUpOn: "2026-10-20", invoiceId: "INV-101", quoteId: "Q-1", requestId: REQ,
};
const DUES = { subject: "Statement of pending dues", message: "Hi Rahul, statement attached.", nextFollowUpOn: "2026-10-20", requestId: REQ };

const followups = () => st.tables.payment_followups ?? [];

beforeEach(() => {
  st.sendStatus = "sent";
  st.sends = [];
  st.n = 0;
  st.tables = {
    users: [{ id: ME, tenant_id: "T1", role: "accountant" }],
    customers: [{ id: CUST, account_manager_id: OWNER }, { id: OTHER, account_manager_id: OWNER }],
    invoices: [{ id: "INV-101", customer_id: CUST }, { id: "INV-OTHER", customer_id: OTHER }],
    quotes: [{ id: "Q-1", customer_id: CUST }, { id: "Q-OTHER", customer_id: OTHER }],
    subscriptions: [{ id: SUB_MINE, customer_id: CUST }, { id: SUB_OTHER, customer_id: OTHER }],
    payment_followups: [],
    customer_email_sends: [],
  };
});

describe("R-1544: one Send = one email, even when the browser retries", () => {
  it("reminder: the same requestId twice → ONE email, ONE follow-up; the retry gets the first answer", async () => {
    const first = await remind(REMIND);
    expect(first.status).toBe(200);
    const again = await remind(REMIND);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, sentTo: "accounts@sharma.in", alreadySent: true });
    expect(st.sends).toHaveLength(1);
    expect(followups()).toHaveLength(1);
  });

  it("reminder: a retry that arrives while the first is still sending → refused, still ONE email", async () => {
    const [a, b] = await Promise.all([remind(REMIND), remind(REMIND)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(st.sends).toHaveLength(1);
    expect(followups()).toHaveLength(1);
  });

  it("reminder: a send that FAILED may be tried again with the same requestId (nothing reached the customer)", async () => {
    st.sendStatus = "failed";
    expect((await remind(REMIND)).status).toBe(502);
    st.sendStatus = "sent";
    expect((await remind(REMIND)).status).toBe(200);
    expect(st.sends).toHaveLength(2);
    expect(followups()).toHaveLength(1);
  });

  it("reminder: a new Send (new requestId) is a new email", async () => {
    await remind(REMIND);
    await remind({ ...REMIND, requestId: REQ2 });
    expect(st.sends).toHaveLength(2);
  });

  it("reminder: no requestId → 400, nothing sent", async () => {
    const { requestId: _drop, ...noId } = REMIND;
    void _drop;
    expect((await remind(noId)).status).toBe(400);
    expect(st.sends).toHaveLength(0);
  });

  it("pending dues: the same requestId twice → ONE email", async () => {
    expect((await dues(DUES)).status).toBe(200);
    const again = await dues(DUES);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, alreadySent: true });
    expect(st.sends).toHaveLength(1);
    expect(followups()).toHaveLength(1);
  });
});

describe("R-1544: a follow-up only links this customer's own bills", () => {
  it("reminder with another customer's invoice → 422 BEFORE sending; nothing sent, nothing logged", async () => {
    const res = await remind({ ...REMIND, invoiceId: "INV-OTHER", quoteId: undefined });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/not this customer's/);
    expect(st.sends).toHaveLength(0);
    expect(followups()).toHaveLength(0);
  });

  it("reminder with another customer's subscription or quote → 422, nothing sent", async () => {
    expect((await remind({ ...REMIND, invoiceId: undefined, quoteId: undefined, subscriptionId: SUB_OTHER })).status).toBe(422);
    expect((await remind({ ...REMIND, invoiceId: undefined, quoteId: "Q-OTHER" })).status).toBe(422);
    expect(st.sends).toHaveLength(0);
  });

  it("an id that does not exist (or this person cannot see) is refused too", async () => {
    expect((await remind({ ...REMIND, invoiceId: "INV-NOPE", quoteId: undefined })).status).toBe(422);
    expect(st.sends).toHaveLength(0);
  });

  it("Follow-up dialog (POST /api/collections/followups) with another customer's invoice → 422, nothing saved", async () => {
    const res = await addFollowup(json("https://app.example/api/collections/followups", {
      customerId: CUST, kind: "call", nextFollowUpOn: "2026-10-20", invoiceId: "INV-OTHER",
    }));
    expect(res.status).toBe(422);
    expect(followups()).toHaveLength(0);
  });

  it("this customer's own invoice, quote and subscription are fine", async () => {
    const res = await addFollowup(json("https://app.example/api/collections/followups", {
      customerId: CUST, kind: "call", nextFollowUpOn: "2026-10-20", invoiceId: "INV-101", quoteId: "Q-1", subscriptionId: SUB_MINE,
    }));
    expect(res.status).toBe(200);
    expect(followups()).toHaveLength(1);
  });
});
