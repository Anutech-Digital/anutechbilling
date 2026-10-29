/**
 * R-2048 (28 Oct 2026) — follow-ups to R-2044 found by the localhost check:
 *   1. the billing job raised an UNPAID tax invoice for the first part of an accepted-but-unpaid
 *      sale (and, for a customer with no state, an "errors 1") — the first part is now invoiced
 *      only when money covers it; the open sale quote is its payment request;
 *   2. the part request's page showed the sales-quote flow (Needs approval, Signed, Mark
 *      accepted) and its paid toast said "one-time purchase — there is no subscription to renew";
 *   3. wording still said "invoices" (Automation job, reconcile result, Payment options).
 * The money side is proven on the database in supabase/tests/r2048_unpaid_first_part.test.sql.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncSubscriptionInstalments, type InstalmentSub } from "./sync-instalments.server";
import { plannedInstalments } from "./instalments";
import {
  applyBillOutcome, isPartRequest, partLabelOf, partRequestPaymentToast, partRequestSteps,
  partRequestOpenLine, PART_REQUEST_BADGE,
} from "./part-requests";
import { emptySyncResult } from "./sync-instalments.server";
import { quoteLifecycle } from "@/lib/quotes/lifecycle";
import { paymentToast, subscriptionNoteFor } from "@/lib/payments/record-payment-toast";
import { AUTOMATION_JOBS } from "@/lib/automation/jobs";
import { BILLING_CYCLE_OPTIONS } from "@/lib/quotes/billing";

const root = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

function fakeDb(tables: Record<string, unknown[]>, rpc: (fn: string, args: Record<string, unknown>) => unknown) {
  const calls: { rpc: Array<[string, Record<string, unknown>]>; writes: string[] } = { rpc: [], writes: [] };
  const chain = (table: string) => {
    const result = { data: tables[table] ?? [], error: null };
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "not", "order", "range", "limit", "neq"]) c[m] = () => c;
    c.maybeSingle = async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null });
    c.insert = () => { calls.writes.push(`insert ${table}`); return Promise.resolve({ error: null }); };
    c.update = () => { calls.writes.push(`update ${table}`); return c; };
    c.then = (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok);
    return c;
  };
  const db = {
    from: (t: string) => chain(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.rpc.push([fn, args]);
      return { data: rpc(fn, args), error: null };
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

/* The owner's case: E2E Customer, Annual commitment billed quarterly, term from 11 Oct, sale quote
   accepted, no money. ₹1,500 a month → ₹4,500 a quarter → ₹5,310 with GST. */
const sub: InstalmentSub = {
  id: "sub-e2e", tenant_id: "t1", quote_id: "Q-SALE", mrr: 1500, billing_cycle: "quarterly", term_months: 12,
  start_date: "2026-10-11", renewal_date: "2027-10-10",
};
const plan = plannedInstalments(sub);
const rows = plan.map((p) => ({
  id: `b${p.periodIndex}`, period_index: p.periodIndex, bill_on: p.billOn, term_start: p.termStart,
  taxable_amount: p.taxableAmount, invoice_id: null,
}));

describe("R-2048 (1) — the first part of an unpaid sale gets no tax invoice", () => {
  it("the database rule invoices the first part only when money covers it", () => {
    const dir = join(root, "supabase", "migrations");
    const file = readdirSync(dir).find((f) => /_r2048_unpaid_first_part_no_invoice\.sql$/.test(f));
    expect(file).toBeTruthy();
    const sql = read(`supabase/migrations/${file}`);
    expect(sql).toMatch(/^-- deploy-peek: .*R-2048/);
    /* v_first no longer opens the invoice branch on its own. */
    expect(sql).toContain("if v_req_paid or v_on_due or v_paid_up then");
    expect(sql).not.toMatch(/if v_first or v_req_paid/);
    expect(sql).toContain("v_paid_up := public.instalment_credit(v_b.subscription_id) >= v_gross;");
    expect(sql).toContain("'sale_quote', true");
  });

  it("the billing run counts an unpaid sale's first part as waiting on the sale quote — nothing raised, no error", async () => {
    const { db, calls } = fakeDb({ subscription_billings: rows }, (fn) =>
      fn === "bill_subscription_instalment"
        ? { action: "request_open", quote_id: "Q-SALE", status: "accepted", gross: 5310, sale_quote: true }
        : 0);
    const r = await syncSubscriptionInstalments({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: db as any, sub, quote: { amount: 21240, payment_amount: null, invoiced: false }, todayISO: "2026-10-28",
    });
    expect(r.raised).toEqual([]);
    expect(r.requests).toEqual([]);
    expect(r.requestsOpen).toEqual([{ period_index: 1, quote_id: "Q-SALE", status: "accepted" }]);
    expect(calls.rpc.map(([fn]) => fn)).not.toContain("raise_subscription_billing");
  });

  it("a paid first part still gets its invoice", () => {
    const out = emptySyncResult();
    applyBillOutcome(out, 1, { action: "invoice", invoice_id: "INV-1", gross: 5310 }, false);
    expect(out.raised).toEqual([{ period_index: 1, invoice_id: "INV-1", gross: 5310 }]);
  });
});

describe("R-2048 (2) — the part request's page: Sent → Paid → Invoiced, no accept / approval", () => {
  const sentReq = quoteLifecycle({
    status: "sent", paymentStatus: "awaiting", invoiceId: null, hasSignature: false,
    provisionStatus: "not_required", paid: false,
  });

  it("the bar has only Sent, Paid and Invoiced; Paid is what it waits on", () => {
    const steps = partRequestSteps(sentReq.steps, sentReq.dead);
    expect(steps.map((s) => s.label)).toEqual(["Sent", "Paid", "Invoiced"]);
    expect(steps.find((s) => s.state === "current")?.stage).toBe("paid");
    expect(steps.map((s) => s.detail).join(" ")).not.toMatch(/accept|sign/i);
    expect(steps[2].detail).toBe("The tax invoice is raised when this is paid.");
  });

  it("paid and invoiced → all three done", () => {
    const done = quoteLifecycle({
      status: "sent", paymentStatus: "invoiced", invoiceId: "INV-2", hasSignature: false,
      provisionStatus: "not_required", paid: true,
    });
    const steps = partRequestSteps(done.steps, done.dead);
    expect(steps.every((s) => s.state === "done")).toBe(true);
  });

  it("a quote with subscription_billing_id is a part request; a sales quote is not", () => {
    expect(isPartRequest({ subscription_billing_id: "b2" })).toBe(true);
    expect(isPartRequest({ subscription_billing_id: null })).toBe(false);
    expect(isPartRequest(null)).toBe(false);
    expect(PART_REQUEST_BADGE).toBe("Payment request");
    expect(partRequestOpenLine("28 Jan 2027")).toContain("Customer stopped");
    expect(partRequestOpenLine("28 Jan 2027")).not.toMatch(/accept/i);
  });

  it("the quote page hides approval, the accept row and Mark accepted on a part request", () => {
    const page = read("src/app/(app)/quotes/[id]/page.tsx");
    expect(page).toContain("const sendGate          = !partRequest && approvalNeed");
    expect(page).toContain("const approvalPill      = !partRequest && approvalNeed");
    expect(page).toContain(`{!partRequest && (quote.status === "sent" || quote.status === "viewed")`);
    expect(page).toContain("partRequestSteps(lifecycle.steps, lifecycle.dead)");
    expect(page).toContain("{PART_REQUEST_BADGE}");
  });
});

describe("R-2048 (2) — the paid toast on a part request", () => {
  const base = paymentToast({
    outstanding: 0, isFullyPaid: true, convertedNow: false, subscriptionCreated: false, invoicePaid: false,
    hasExistingInvoice: false, isRenewalQuote: false, renewalRolledForward: false, overpaidCredit: 0,
    tdsRecorded: false, tdsAttempted: false, tdsAmount: 0, paymentId: "p1", receiptVoucherNo: null,
    customerName: "E2E Customer", invoiceId: null,
    subscriptionNote: subscriptionNoteFor({
      isFirstPayment: true, subscriptionCreated: false, isRenewalQuote: false, isAddSeats: false,
      creditActivatedAt: null, existingSubs: 0,
      lines: [{ name: "Advance payment for Q2 · 11 Jan–10 Apr 2027", qty: 1, rate: 4500, commitment: null }],
    }),
    receiptUploadFailed: false,
  });

  it("the generic toast is what the owner saw (the bug)", () => {
    expect(base.lines.join(" ")).toMatch(/one-time purchase — there is no subscription to renew/);
  });

  it("says the part's tax invoice was raised and the subscription continues", () => {
    const t = partRequestPaymentToast(base, { part: "Q2", invoiceId: "INV-F588-27-0040", isFullyPaid: true, error: null });
    expect(t.title).toBe("Paid — tax invoice INV-F588-27-0040 raised for Q2 (subscription continues)");
    expect(t.lines.join(" ")).not.toMatch(/one-time purchase|no subscription to renew/);
    expect(t.tone).toBe("success");
  });

  it("when the invoice could not be raised now, says why and that the next run raises it", () => {
    const t = partRequestPaymentToast(base, { part: "Q2", invoiceId: null, isFullyPaid: true, error: "No state on the customer." });
    expect(t.tone).toBe("warning");
    expect(t.title).toBe("Paid — the tax invoice for Q2 was not raised yet");
    expect(t.lines[0]).toBe("No state on the customer.");
  });

  it("reads the part's short name from the request's line", () => {
    expect(partLabelOf("Advance payment for Q2 · 11 Jan–10 Apr 2027")).toBe("Q2");
    expect(partLabelOf("Advance payment for month 3 · 1 Dec–31 Dec 2026")).toBe("month 3");
    expect(partLabelOf("Workspace Starter")).toBeNull();
  });
});

describe("R-2048 (3) — wording says payment requests, not invoices", () => {
  it("Automation job", () => {
    expect(AUTOMATION_JOBS.billing.label).toBe("Instalment payment requests");
    expect(AUTOMATION_JOBS.billing.what).toBe(
      "Sends a payment request for each subscription part when it falls due; the tax invoice is raised when it is paid.");
  });

  it("Payment options (shared by the quote builder, leads and bank reconcile)", () => {
    expect(BILLING_CYCLE_OPTIONS.map((o) => o.label)).toEqual([
      "Annual — 1 payment/yr (popular)",
      "Half-yearly — 2 payments/yr",
      "Quarterly — 4 payments/yr",
      "Monthly — 12 payments/yr",
    ]);
  });
});
