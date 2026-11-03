// R-2230 (Zoho Billing audit A6) — every payment-request part has a due date, and "unpaid now"
// counts what the part requests still owe. The owner's real case: a quarterly part's request of
// ₹1,632 showed "₹1,632 due · No payment due date", and the customer page said "Unpaid invoices
// now ₹0" next to Outstanding ₹1,632.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  partRequestsOwed, oldestPartDue, oldestPartDueBySubscription, partRequestFor, unpaidNow,
  partRequestChipText, type OpenPartRequest,
} from "./part-request-dues";
import { buildDuesRows, type DuesSubRow } from "@/lib/queries/payments";
import { subscriptionExceptions } from "@/lib/subscriptions/exceptions";
import { creditExposure } from "@/lib/credit/activate-on-credit";

const TODAY = "2026-11-02";
// R-2391: the "N days left" chip reads the clock (todayIST()), so the test pins it to TODAY in
// IST — at both ends of that IST day (00:01 IST = 18:31 UTC the day before; 23:59 IST). Before
// R-2391 it read the real clock and went red at 00:00 IST 3 Nov ("13 days left").
const TODAY_EDGES = ["2026-11-01T18:31:00Z", "2026-11-02T18:29:00Z"] as const;
afterEach(() => { vi.useRealTimers(); });
const req = (o: Partial<OpenPartRequest> = {}): OpenPartRequest => ({
  quote_id: "Q-27-0101", customer_id: "c1", subscription_id: "S1", billing_id: "B1",
  term_start: "2026-08-01", period_index: 2, due_on: "2026-11-16", still_due: 1632, is_lead: true, ...o,
});
const sub = (o: Partial<DuesSubRow> = {}): DuesSubRow => ({
  id: "S1", customer_id: "c1", customer_name: "E2E Test Co", plan: "Google Workspace Business Starter",
  outstanding_amount: 1632, status: "active", last_reminder_at: null, created_at: "2026-08-01T10:00:00Z",
  start_date: "2026-08-01", payment_due_date: null, quote_id: "Q-SALE", renewal_quote_id: null, ...o,
});

describe("R-2230 — what open part requests owe", () => {
  it("a request covering two subscriptions (R-2092 group) is counted once", () => {
    const rows = [
      req(),
      req({ subscription_id: "S2", billing_id: "B2", is_lead: false }),
      req({ quote_id: "Q-27-0102", billing_id: "B3", period_index: 3, due_on: "2026-12-01", still_due: 500 }),
    ];
    expect(partRequestsOwed(rows)).toBe(2132);
    expect(oldestPartDue(rows)).toBe("2026-11-16");
    expect(oldestPartDueBySubscription(rows).get("S2")).toBe("2026-11-16");
    expect(partRequestFor(rows, { subscriptionId: "S1", termStart: "2026-08-01", periodIndex: 3 })?.quote_id).toBe("Q-27-0102");
    expect(partRequestFor(rows, { subscriptionId: "S1", termStart: "2027-08-01", periodIndex: 2 })).toBeUndefined();
  });

  it("unpaid now = unpaid invoices + part requests (₹0 + ₹1,632 = Outstanding ₹1,632)", () => {
    expect(unpaidNow(0, [req()])).toEqual({ invoices: 0, requests: 1632, total: 1632, requestsDueFrom: "2026-11-16" });
    expect(unpaidNow(1180, [])).toEqual({ invoices: 1180, requests: 0, total: 1180, requestsDueFrom: null });
  });

  it("the schedule row names the request, what it owes and its due date", () => {
    expect(partRequestChipText(req(), TODAY)).toBe("Payment request Q-27-0101 · ₹1,632 due 16 Nov 2026");
    expect(partRequestChipText(req({ due_on: "2026-10-28" }), TODAY)).toBe("Payment request Q-27-0101 · ₹1,632 · 5 days overdue (due 28 Oct 2026)");
    expect(partRequestChipText(req({ due_on: TODAY }), TODAY)).toBe("Payment request Q-27-0101 · ₹1,632 due today");
  });
});

describe("R-2230 — the subscriptions list / Payments row get the request's due date", () => {
  it.each(TODAY_EDGES)("no invoice, an open part request → pay by its due date (was: No payment due date) — clock %s", (now) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    const [row] = buildDuesRows([sub()], [], [], [], [], TODAY, undefined, [req()]);
    expect(row.pay_by).toBe("2026-11-16");
    expect(row.pay_by_kind).toBe("request");
    const chip = subscriptionExceptions({ ...sub(), pay_by: row.pay_by }).find((f) => f.key === "payment-due");
    expect(chip?.label).toBe("Pay by 16 Nov 2026 · 14 days left");
    expect(chip?.label).not.toMatch(/No payment due date/);
  });

  it("an older unpaid invoice still wins; another subscription's request is not this one's", () => {
    const [row] = buildDuesRows(
      [sub()], [], [],
      [{ id: "INV-1", quote_id: "Q-SALE", invoice_date: "2026-10-01", due_date: "2026-10-31", status: "pending", amount: 500, net_payable: 500, paid_amount: 0 }],
      [], TODAY, undefined, [req(), req({ subscription_id: "S9", due_on: "2026-10-01" })],
    );
    expect(row.pay_by).toBe("2026-10-31");
    expect(row.pay_by_kind).toBe("invoice");
  });

  it("no request and no invoice → unchanged (agreed date, else none)", () => {
    expect(buildDuesRows([sub({ payment_due_date: "2026-11-20" })], [], [], [], [], TODAY)[0].pay_by).toBe("2026-11-20");
    expect(buildDuesRows([sub()], [], [], [], [], TODAY)[0].pay_by).toBeNull();
  });
});

describe("R-2230 — the credit limit counts open part requests (same as activate_quote_on_credit)", () => {
  it("₹1,360 on a request + ₹2,360 this sale is over a ₹3,000 limit", () => {
    const e = creditExposure({ openInvoices: [], quoteAmount: 2360, quoteInvoiceId: null, creditLimit: 3000, partRequestsOwed: 1360 });
    expect(e).toMatchObject({ owed: 1360, thisInvoice: 2360, total: 3720, over: true });
  });
  it("without requests nothing changes", () => {
    const e = creditExposure({ openInvoices: [], quoteAmount: 2360, quoteInvoiceId: null, creditLimit: 3000 });
    expect(e).toMatchObject({ owed: 0, total: 2360, over: false });
  });
});
