/* R-1709 — an invoice's payment state from MONEY: amount, money received (paid_amount +
   advances adjusted at issue), credit / debit notes and write-off. One answer for the
   "Paid this month" tile, the status chips and the row badge. */
import { describe, it, expect } from "vitest";
import { invoicePaymentState, invoiceMoneyIn, type InvoicePaymentFacts } from "./payment-state";

const base = { amount: 38232, net_payable: 38232, paid_amount: 0, adjusted_advances: null, written_off_at: null };

describe("invoicePaymentState (R-1709)", () => {
  const cases: [string, InvoicePaymentFacts, string, number][] = [
    // label, facts, state, money in
    ["draft", { ...base, status: "draft" }, "draft", 0],
    ["void", { ...base, status: "void" }, "void", 0],
    ["nothing in yet", { ...base, status: "pending" }, "unpaid", 0],
    ["overdue status, nothing in", { ...base, status: "overdue" }, "unpaid", 0],
    ["receipt after the invoice (paid_amount) → partial", { ...base, status: "pending", paid_amount: 20000 }, "partial", 20000],
    ["advance adjusted at issue → partial", { ...base, status: "pending", net_payable: 18232, adjusted_advances: [{ payment_id: "p1", amount: 20000 }] }, "partial", 20000],
    ["advance entry without an amount still means money came in", { ...base, status: "pending", adjusted_advances: [{}] }, "partial", 0],
    ["paid by receipts", { ...base, status: "paid", paid_amount: 38232 }, "paid", 38232],
    ["paid by advance + receipt", { ...base, status: "paid", net_payable: 18232, paid_amount: 18232, adjusted_advances: [{ amount: 20000 }] }, "paid", 38232],
    /* T-L5: a credit note settled it — ₹38,232 never came in. */
    ["settled by a credit note → Credited", { ...base, status: "paid", net_payable: 0, credit_noted: 38232 }, "credited", 0],
    ["part paid, rest credited → Credited", { ...base, status: "paid", net_payable: 18232, paid_amount: 20000, credit_noted: 18232 }, "credited", 20000],
    /* ₹1,00,000 paid, then a ₹10,000 credit note: fully paid; the ₹10,000 went to customer credit. */
    ["paid in full, credit note after → Paid, money capped at the value", { ...base, status: "paid", amount: 100000, net_payable: 90000, paid_amount: 100000, credit_noted: 10000 }, "paid", 90000],
    /* R-2095 (staging, a part invoice re-issued): paid in full, then credit notes for the WHOLE
       invoice — it is cancelled; the money went to customer credit. It read "Paid". */
    ["paid in full, then credited in full → Credited, no money in", { ...base, status: "paid", paid_amount: 38232, net_payable: 0, credit_noted: 38232 }, "credited", 0],
    ["credited in full within ₹1 → Credited", { ...base, status: "paid", paid_amount: 38232, net_payable: 1, credit_noted: 38231 }, "credited", 1],
    ["debit note raises what must come in", { ...base, status: "paid", amount: 1000, net_payable: 1200, paid_amount: 1200, debit_noted: 200 }, "paid", 1200],
    /* Older invoices were marked paid without paid_amount (credit_note_refund.sql:170): trust the status. */
    ["legacy paid row, no money columns → Paid at its value", { ...base, status: "paid", net_payable: 0 }, "paid", 38232],
    ["written off, nothing in", { ...base, status: "pending", written_off_at: "2026-10-23T06:00:00Z" }, "written-off", 0],
    ["written off after a part payment keeps the money in", { ...base, status: "overdue", paid_amount: 5000, written_off_at: "2026-10-23T06:00:00Z" }, "written-off", 5000],
    ["paid stays paid even if written_off_at is set", { ...base, status: "paid", paid_amount: 38232, written_off_at: "2026-10-23T06:00:00Z" }, "paid", 38232],
  ];

  it.each(cases)("%s", (_label, facts, state, moneyIn) => {
    expect(invoicePaymentState(facts)).toBe(state);
    expect(invoiceMoneyIn(facts)).toBe(moneyIn);
  });

  it("notes not read (undefined) never turn a paid invoice into Credited", () => {
    expect(invoicePaymentState({ ...base, status: "paid", net_payable: 0 })).toBe("paid");
  });
});
