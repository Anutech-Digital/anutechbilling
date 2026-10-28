/* R-2025 (0): a bank line booked as a customer ADVANCE (R-1863) reads "Advance" on the bank
   page — not "Payment" (Pardeep, localhost 27 Oct, Acme ₹4,00,000). */
import { describe, expect, it } from "vitest";
import { advancePaymentIds, bankRowStatusLabel } from "./bank-row-label";

describe("R-2025 bankRowStatusLabel", () => {
  it("an advance payment reads Advance", () => {
    expect(bankRowStatusLabel("payment", true)).toBe("Advance");
  });
  it("an ordinary payment still reads Payment", () => {
    expect(bankRowStatusLabel("payment", false)).toBe("Payment");
  });
  it("the advance flag never changes other kinds", () => {
    expect(bankRowStatusLabel("expense", true)).toBe("Expense");
    expect(bankRowStatusLabel("vendor_bill", false)).toBe("Bill");
    expect(bankRowStatusLabel("transfer", false)).toBe("Inter-account");
    expect(bankRowStatusLabel("split", false)).toBe("Salaries");
    expect(bankRowStatusLabel("owner_equity", false)).toBe("Owner drawings / capital");
    expect(bankRowStatusLabel("manual", false)).toBe("Reconciled");
    expect(bankRowStatusLabel(null, false)).toBe("Unmatched");
  });
});


describe("R-2025 advancePaymentIds — the same rule as bank_advance_payment()", () => {
  const pays = [
    { id: "p-adv", quote_id: "Q-ADV", notes: "Advance on account — bank credit of 20 Oct 2026" },
    { id: "p-sale", quote_id: "Q-SALE", notes: "Bank credit" },
    { id: "p-used", quote_id: "Q-INV", notes: "Advance on account — bank credit of 20 Oct 2026" },
  ];
  const quotes = [
    { id: "Q-ADV", plan: "Advance on account", amount: 0, invoice_id: null, line_items: [] },
    { id: "Q-SALE", plan: "Google Workspace", amount: 11800, invoice_id: "INV-1", line_items: [{}] },
    { id: "Q-INV", plan: "Advance on account", amount: 0, invoice_id: "INV-9", line_items: [] },
  ];
  it("only the R-1863 holder (note + ₹0 line-less 'Advance on account', never invoiced) counts", () => {
    expect([...advancePaymentIds(pays, quotes)]).toEqual(["p-adv"]);
  });
  it("a payment whose quote is missing is not an advance", () => {
    expect(advancePaymentIds(pays, []).size).toBe(0);
  });
});
