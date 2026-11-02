/**
 * R-2382 — the Subscriptions list's Payment column. Owner's case (2 Nov 2026, staging,
 * cycle = monthly): a row reads "48d overdue" / "Active" and nothing says whether the
 * period is paid. Each status below is one row he can meet.
 */
import { describe, expect, it } from "vitest";
import { formatDate } from "@/lib/utils";
import {
  subscriptionPaymentStatus, matchesPaymentFilter, paymentFilterCounts, paymentStatusText,
  type PaymentStatusSub,
} from "./payment-status";

const TODAY = "2026-11-02";
const SUB: PaymentStatusSub = {
  id: "s1", status: "active", outstanding_amount: 0,
  renewal_date: "2027-03-01", start_date: "2026-03-01", payment_due_date: null,
  quote_id: "q1", renewal_quote_id: null, written_off_at: null, billed_externally_until: null,
};

describe("subscriptionPaymentStatus", () => {
  it("paid: nothing owed, a bill exists, term runs → Paid till <renewal date> (green)", () => {
    const p = subscriptionPaymentStatus({ sub: SUB, today: TODAY });
    expect(p).toMatchObject({ kind: "paid", tone: "success", label: "Paid till 1 Mar 2027", owed: 0, overdue: false });
  });

  it("paid, billed in parts: Paid till the CURRENT period's end, not the term's", () => {
    const p = subscriptionPaymentStatus({
      sub: SUB, today: TODAY,
      period: { subscription_id: "s1", period_start: "2026-11-01", period_end: "2026-11-30", bill_on: "2026-11-01", invoice_id: "inv1" },
    });
    expect(p.label).toBe("Paid till 30 Nov 2026");
    expect(p.kind).toBe("paid");
  });

  it("due: owed, unpaid invoice fell due 15 Sep → Due ₹X since <date> · N days (red, overdue)", () => {
    const p = subscriptionPaymentStatus({
      sub: { ...SUB, outstanding_amount: 14406 },
      due: { paid_amount: 0, pay_by: "2026-09-15", age_from: "2026-09-15" },
      today: TODAY,
    });
    expect(p).toMatchObject({ kind: "overdue", tone: "danger", label: "Due ₹14,406", owed: 14406, overdue: true });
    expect(p.detail).toBe(`since ${formatDate("2026-09-15")} · 48 days`);
  });

  it("due, not yet late: Due ₹X by <date> (amber), not overdue", () => {
    const p = subscriptionPaymentStatus({
      sub: { ...SUB, outstanding_amount: 5000 },
      due: { paid_amount: 0, pay_by: "2026-11-20", age_from: "2026-11-20" },
      today: TODAY,
    });
    expect(p).toMatchObject({ kind: "due", tone: "warning", overdue: false, detail: "by 20 Nov 2026" });
  });

  it("part-paid: money received on its quote and some still owed → Part-paid · ₹X due", () => {
    const p = subscriptionPaymentStatus({
      sub: { ...SUB, outstanding_amount: 4000 },
      due: { paid_amount: 6000, pay_by: "2026-10-01", age_from: "2026-10-01" },
      today: TODAY,
    });
    expect(p).toMatchObject({ kind: "part_paid", label: "Part-paid · ₹4,000 due", overdue: true, tone: "danger" });
    expect(p.detail).toBe("since 1 Oct 2026 · 32 days");
  });

  it("request sent: nothing owed yet, an open renewal quote was sent → Request sent <date> (amber)", () => {
    const p = subscriptionPaymentStatus({
      sub: { ...SUB, renewal_date: "2026-11-10", renewal_quote_id: "rq" },
      renewalQuote: { id: "rq", status: "sent", payment_status: "pending", amount: 12000, created_date: "2026-10-25" },
      today: TODAY,
    });
    expect(p).toMatchObject({ kind: "request_sent", tone: "warning", label: "Request sent 25 Oct 2026", detail: "₹12,000 renewal" });
  });

  it("a paid or replaced renewal quote is not a request", () => {
    const paid = subscriptionPaymentStatus({
      sub: { ...SUB, renewal_quote_id: "rq" },
      renewalQuote: { id: "rq", status: "accepted", payment_status: "received", amount: 1, created_date: "2026-10-25" },
      today: TODAY,
    });
    expect(paid.kind).toBe("paid");
    const replaced = subscriptionPaymentStatus({
      sub: { ...SUB, renewal_quote_id: "rq" },
      renewalQuote: { id: "rq", status: "sent", payment_status: null, superseded_by: "rq2", amount: 1 },
      today: TODAY,
    });
    expect(replaced.kind).toBe("paid");
  });

  it("no bill: the owner's monthly row — renewal 48 days past, nothing billed → No bill for this period", () => {
    const p = subscriptionPaymentStatus({ sub: { ...SUB, renewal_date: "2026-09-15" }, today: TODAY });
    expect(p).toMatchObject({ kind: "no_bill", tone: "muted", label: "No bill for this period", detail: `term ended ${formatDate("2026-09-15")}` });
  });

  it("no bill: billed in parts and this period's invoice not raised yet", () => {
    const p = subscriptionPaymentStatus({
      sub: SUB, today: TODAY,
      period: { subscription_id: "s1", period_start: "2026-11-01", period_end: "2026-11-30", bill_on: "2026-11-01", invoice_id: null },
    });
    expect(p).toMatchObject({ kind: "no_bill", detail: "period from 1 Nov 2026" });
  });

  it("no bill: imported subscription with no quote at all never claims Paid", () => {
    const p = subscriptionPaymentStatus({ sub: { ...SUB, quote_id: null }, today: TODAY });
    expect(p.kind).toBe("no_bill");
  });

  it("ended / written off / billed elsewhere: quiet grey, no clock", () => {
    expect(subscriptionPaymentStatus({ sub: { ...SUB, status: "cancelled" }, today: TODAY }).label).toBe("Ended");
    expect(subscriptionPaymentStatus({ sub: { ...SUB, written_off_at: "2026-10-01T00:00:00Z", outstanding_amount: 500 }, today: TODAY }).label).toBe("Written off");
    const ext = subscriptionPaymentStatus({ sub: { ...SUB, billed_externally_until: "2026-12-31" }, today: TODAY });
    expect(ext).toMatchObject({ kind: "none", label: "Billed elsewhere", detail: "till 31 Dec 2026" });
  });

  it("an ended subscription that still owes shows what it owes", () => {
    const p = subscriptionPaymentStatus({
      sub: { ...SUB, status: "expired", outstanding_amount: 900 },
      due: { paid_amount: 0, pay_by: null, age_from: "2026-10-01" },
      today: TODAY,
    });
    expect(p.owed).toBe(900);
    expect(p.overdue).toBe(true);
  });
});

describe("Payment filter chips", () => {
  const rows = [
    subscriptionPaymentStatus({ sub: SUB, today: TODAY }), // paid
    subscriptionPaymentStatus({ sub: { ...SUB, outstanding_amount: 100 }, due: { paid_amount: 0, pay_by: "2026-10-01", age_from: "2026-10-01" }, today: TODAY }), // overdue
    subscriptionPaymentStatus({ sub: { ...SUB, outstanding_amount: 100 }, due: { paid_amount: 0, pay_by: "2026-12-01", age_from: "2026-12-01" }, today: TODAY }), // due later
    subscriptionPaymentStatus({ sub: { ...SUB, renewal_date: "2026-09-01" }, today: TODAY }), // no bill
  ];

  it("Paid / Due / Overdue counts — Due holds every row that owes, Overdue the late ones", () => {
    expect(paymentFilterCounts(rows)).toEqual({ paid: 1, due: 2, overdue: 1 });
    expect(rows.filter((r) => matchesPaymentFilter(r, "due"))).toHaveLength(2);
    expect(rows.filter((r) => matchesPaymentFilter(r, ""))).toHaveLength(4);
  });

  it("CSV text joins both lines", () => {
    expect(paymentStatusText(rows[1])).toBe("Due ₹100 (since 1 Oct 2026 · 32 days)");
    expect(paymentStatusText(rows[0])).toBe("Paid till 1 Mar 2027");
  });
});
