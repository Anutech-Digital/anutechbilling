/**
 * R-1540 — one promise, one answer. /collections (lib/queries/collections.ts buildCollectionRows),
 * the follow-up history on the customer card / dialog (followup-rules.ts buildFollowupHistory) and
 * the owner's weekly report (weekly-report.ts buildWeeklyReport) must agree on kept / broken.
 *
 * Before the fix:
 *   • collections.ts:305-309 — broken = date passed AND the customer still owes ANYTHING
 *     (promised amount and payments never looked at);
 *   • followup-rules.ts isPromiseBroken — the same "still owes" rule for the history;
 *   • weekly-report.ts:130-139 — kept = promised amount received between logging and the date.
 * So ₹50,000 owed, ₹10,000 promised and paid on time → report "kept", list + history "broken".
 */
import { describe, it, expect } from "vitest";
import { buildCollectionRows, type CollectionsInput } from "@/lib/queries/collections";
import { buildWeeklyReport } from "./weekly-report";
import { buildFollowupHistory, promiseStatus, type FollowupHistoryRow, type PromisePayment } from "./followup-rules";

const TODAY = "2026-10-17";          // Saturday; week = 12 … 17 Oct
const C = "11111111-1111-4111-8111-111111111111";
const at = (d: string) => `${d}T06:30:00Z`;   // 12:00 IST

const promise = {
  id: "f1", customer_id: C, kind: "promise", note: null, promised_amount: 10000, promised_on: "2026-10-15",
  next_follow_up_on: "2026-10-20", assigned_to: null, created_by: "u1", created_at: at("2026-10-12"),
};

function collectionsInput(payments: PromisePayment[]): CollectionsInput {
  return {
    invoices: [{
      id: "INV-1", customer_id: C, customer_name: "Sharma Traders", amount: 50000, net_payable: 50000, paid_amount: 0,
      status: "overdue", invoice_date: "2026-09-01", due_date: "2026-09-16", quote_id: null,
      taxable_value: null, tax_amount: null, tax_rate: null,
    }],
    subscriptions: [], quoteSubscriptions: [], invoicedQuoteIds: new Set(),
    customers: [{ id: C, name: "Sharma Traders", display_name: null, account_manager_id: null }],
    followups: [promise],
    payments,
  };
}

const historyRow: FollowupHistoryRow = {
  id: promise.id, kind: promise.kind, note: null, promised_amount: promise.promised_amount, promised_on: promise.promised_on,
  next_follow_up_on: promise.next_follow_up_on, assigned_to: null, created_by: "u1", created_at: promise.created_at,
  invoice_id: null, quote_id: null, subscription_id: null,
};

/** Every screen's answer for the same promise + payments. */
function everywhere(payments: PromisePayment[], stillOwes = true) {
  const [row] = buildCollectionRows(collectionsInput(payments), TODAY);
  const [entry] = buildFollowupHistory([historyRow], TODAY, stillOwes, payments);
  const report = buildWeeklyReport({
    today: TODAY,
    owing: stillOwes ? [{ customerId: C, customerName: "Sharma Traders", amountDue: 40000 }] : [],
    followups: [promise],
    payments,
  });
  return {
    list: row?.promiseBroken ? "broken" : row?.promiseStatus,
    history: entry.broken ? "broken" : entry.promiseStatus,
    report: report.promises.outcomes[0]?.result,
  };
}

const pay = (amount: number, d: string, extra: Partial<PromisePayment> = {}): PromisePayment =>
  ({ customer_id: C, amount, credit_applied: 0, received_at: at(d), status: "received", ...extra });

describe("R-1540: one promise status on every screen", () => {
  it("₹50k owed, ₹10k promised by 15 Oct, ₹10k paid on 14 Oct → kept on the list, the history and the report", () => {
    expect(everywhere([pay(10000, "2026-10-14")])).toEqual({ list: "kept", history: "kept", report: "kept" });
  });

  it("only ₹4k of the ₹10k paid → broken everywhere", () => {
    expect(everywhere([pay(4000, "2026-10-14")])).toEqual({ list: "broken", history: "broken", report: "broken" });
  });

  it("paid after the promise date → still broken everywhere (late is not kept)", () => {
    expect(everywhere([pay(10000, "2026-10-16")])).toEqual({ list: "broken", history: "broken", report: "broken" });
  });

  it("advance credit applied is not money paid (R-1565) → broken everywhere", () => {
    expect(everywhere([pay(10000, "2026-10-14", { credit_applied: 10000 })])).toEqual({ list: "broken", history: "broken", report: "broken" });
  });

  it("a refunded / not-received payment does not keep it", () => {
    expect(everywhere([pay(10000, "2026-10-14", { status: "refunded" })])).toEqual({ list: "broken", history: "broken", report: "broken" });
  });

  it("an old kept promise stays kept when a new (not yet due) invoice arrives", () => {
    const [row] = buildCollectionRows(collectionsInput([pay(10000, "2026-10-14")]), TODAY);
    expect(row.promiseBroken).toBe(false);
    expect(row.promiseStatus).toBe("kept");
  });
});

describe("promiseStatus — the one rule", () => {
  const base = { promisedOn: "2026-10-15", promisedAmount: 10000, loggedOn: "2026-10-12", today: TODAY, stillOwes: true };
  const r = (on: string, amount: number) => ({ on, amount });

  it("kept = cash received between logging and the promise date ≥ promised amount", () => {
    expect(promiseStatus({ ...base, receipts: [r("2026-10-12", 6000), r("2026-10-15", 4000)] }).status).toBe("kept");
    expect(promiseStatus({ ...base, receipts: [r("2026-10-11", 6000), r("2026-10-15", 4000)] }).status).toBe("broken");
  });
  it("no amount promised → any cash in the window keeps it", () => {
    expect(promiseStatus({ ...base, promisedAmount: null, receipts: [r("2026-10-13", 1)] }).status).toBe("kept");
    expect(promiseStatus({ ...base, promisedAmount: null, receipts: [] }).status).toBe("broken");
  });
  it("debt cleared → kept", () => {
    expect(promiseStatus({ ...base, stillOwes: false, receipts: [] }).status).toBe("kept");
  });
  it("not paid yet: due today → due; later → open", () => {
    expect(promiseStatus({ ...base, promisedOn: TODAY, receipts: [] }).status).toBe("due");
    expect(promiseStatus({ ...base, promisedOn: "2026-10-30", receipts: [] }).status).toBe("open");
  });
});
