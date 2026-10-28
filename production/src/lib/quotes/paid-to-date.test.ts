/**
 * R-2055 — Pardeep's localhost run, 28 Oct 2026: Starter ×10, Annual, billed quarterly,
 * Q-F588-27-0052 ₹38,232; first part ₹9,558 paid; parts 28 Jan / 28 Apr / 28 Jul 2027.
 */
import { describe, it, expect } from "vitest";
import { planForQuote, splitDue } from "@/lib/billing/instalments";
import { rupee } from "@/lib/utils";
import { paidToDateOf, paidToDateOfPlan, paidToDateLine, committedLine, PARTS_WORDING } from "./paid-to-date";
import { quoteMoneyActions } from "./money-stage";
import { quoteListTab } from "./list-tab";
import { cashNote, unifiedStatus } from "./status-badge";
import { quoteInFocus } from "./focus";
import { quoteLifecycle } from "./lifecycle";

const START = "2026-10-28";
const Q = {
  status: "accepted",
  subtotal: 32_400, discount_pct: 0, tax_rate: 18, amount: 38_232,
  billing_cycle: "quarterly" as const,
  line_items: [{ id: "l1", name: "Google Workspace Business Starter", qty: 10, rate: 3240, commitment: "annual_yearly" }],
  payment_status: "partial",
  payment_amount: 9_558,
  invoice_id: null,
  subscription_billing_id: null,
};

describe("R-2055 paid to date", () => {
  it("first part paid → paid to date, ₹28,674 committed over 3 parts, next on 28 Jan 2027", () => {
    const p = paidToDateOf(Q, START)!;
    expect(p).not.toBeNull();
    expect(p.committed).toBe(28_674);
    expect(p.partsLeft).toBe(3);
    expect(p.next.gross).toBe(9_558);
    expect(p.next.billOn).toBe("2027-01-28");
    expect(paidToDateLine(p, "28 Jan 2027")).toBe("Paid to date — next part ₹9,558 on 28 Jan 2027");
    expect(committedLine(p)).toBe("Committed for the rest of the year ₹28,674 (3 parts)");
  });

  it("not paid / fully paid / yearly / part request / invoiced → not paid to date", () => {
    expect(paidToDateOf({ ...Q, payment_amount: 0, payment_status: "awaiting" }, START)).toBeNull();
    expect(paidToDateOf({ ...Q, payment_amount: 38_232, payment_status: "received" }, START)).toBeNull();
    expect(paidToDateOf({ ...Q, billing_cycle: "yearly" as never }, START)).toBeNull();
    expect(paidToDateOf({ ...Q, subscription_billing_id: "b1" }, START)).toBeNull();
    expect(paidToDateOf({ ...Q, invoice_id: "i1" }, START)).toBeNull();
    expect(paidToDateOf({ ...Q, payment_amount: 5_000 }, START)).toBeNull();
  });

  it("quote page money line: no 'still due', no Record next instalment before the bill date, R-2044 wording", () => {
    const plan = planForQuote(Q, START)!;
    const d = splitDue(plan, { todayISO: START, received: 9_558 });
    const m = quoteMoneyActions({
      status: "accepted", paymentStatus: "partial", invoiceId: null, total: 38_232, received: 9_558,
      splitBilledCycle: "quarterly",
      splitDue: { dueGross: d.dueGross, outstanding: d.outstanding, count: plan.count,
        next: { gross: d.next!.gross, billOn: "28 Jan 2027", index: d.next!.index } },
    }, rupee);
    expect(m.note).toContain("Paid to date — next part ₹9,558 (2 of 4) on 28 Jan 2027");
    expect(m.note).toContain(PARTS_WORDING);
    expect(m.note).not.toMatch(/still due|still outstanding|GST invoice on its date/);
    expect(m.canRecordPayment).toBe(false);
    expect(m.outstanding).toBe(0);
  });

  it("the part's date has come and its payment request exists → open the request, never a second Record", () => {
    const plan = planForQuote(Q, START)!;
    const d = splitDue(plan, { todayISO: "2027-01-28", received: 9_558 });
    expect(d.outstanding).toBe(9_558);
    const m = quoteMoneyActions({
      status: "accepted", paymentStatus: "partial", invoiceId: null, total: 38_232, received: 9_558,
      splitBilledCycle: "quarterly",
      splitDue: { dueGross: d.dueGross, outstanding: d.outstanding, count: plan.count,
        next: { gross: d.next!.gross, billOn: "28 Jan 2027", index: d.next!.index } },
      nextPartRequest: { id: "q-req", number: "Q-F588-27-0060" },
    }, rupee);
    expect(m.canRecordPayment).toBe(false);
    expect(m.openRequest).toEqual({ id: "q-req", number: "Q-F588-27-0060" });
    expect(m.note).toContain("Q-F588-27-0060");
    expect(m.note).not.toMatch(/still due/);
  });

  it("Quotes list: not under Awaiting payment, not Partly paid, not in the Partial tile", () => {
    expect(quoteListTab(Q)).toBe("accepted");
    expect(unifiedStatus(Q).label).toBe("Paid to date");
    expect(cashNote(Q)?.text).toBe("₹9,558 paid to date");
    expect(quoteInFocus(Q, "partial")).toBe(false);
    /* An ordinary part-paid quote keeps its old home. */
    const plain = { ...Q, billing_cycle: "yearly" as never };
    expect(quoteListTab(plain)).toBe("awaiting");
    expect(unifiedStatus(plain).label).toBe("Partly paid");
  });

  it("lifecycle Paid step says paid to date, not Part-paid … still due", () => {
    const p = paidToDateOfPlan(planForQuote(Q, START), 9_558)!;
    const { steps } = quoteLifecycle({
      status: "accepted", paymentStatus: "partial", invoiceId: null, hasSignature: false,
      provisionStatus: "done", signerName: null, paid: false, money: { received: 9_558, due: 28_674 },
      paidToDate: paidToDateLine(p, "28 Jan 2027"),
    });
    const paid = steps.find((s) => s.stage === "paid")!;
    expect(paid.state).toBe("done");
    expect(paid.detail).toBe("Paid to date — next part ₹9,558 on 28 Jan 2027.");
  });
});
