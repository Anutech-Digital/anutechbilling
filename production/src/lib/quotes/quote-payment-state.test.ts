/* R-1710 — a quote's payment state from money, also after it is invoiced (T-A1 / Q-0030:
   ₹20,000 of ₹38,232 before the invoice; the page then said only "Invoiced"). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quotePaymentState, invoicedPartPaid, partPaidLine } from "./quote-payment-state";
import { quoteLifecycle } from "./lifecycle";
import { quoteInFocus } from "./focus";
import { unifiedStatus, cashNote } from "./status-badge";

const TA1 = { status: "accepted" as const, payment_status: "invoiced" as const, invoice_id: "INV-A1", amount: 38232, payment_amount: 20000, superseded_by: null };

describe("quotePaymentState (R-1710)", () => {
  it.each([
    ["invoiced, part-paid", TA1, "part-paid", 20000, 18232],
    ["invoiced, nothing in", { ...TA1, payment_amount: 0 }, "pending", 0, 38232],
    ["invoiced, paid in full", { ...TA1, payment_amount: 38232 }, "paid", 38232, 0],
    ["invoiced, part-paid, rest credit-noted (open balance 0) — nothing to chase", { ...TA1, open_balance: 0 }, "paid", 20000, 0],
    ["partial before the invoice", { ...TA1, payment_status: "partial" as const, invoice_id: null }, "part-paid", 20000, 18232],
    ["received", { ...TA1, payment_status: "received" as const, payment_amount: 38232 }, "paid", 38232, 0],
    ["awaiting", { ...TA1, payment_status: "awaiting" as const, payment_amount: 0 }, "pending", 0, 38232],
  ] as const)("%s", (_l, q, state, received, due) => {
    expect(quotePaymentState(q)).toEqual({ state, received, due });
  });

  it("invoicedPartPaid is only the invoiced + part-paid case", () => {
    expect(invoicedPartPaid(TA1)).toBe(true);
    expect(invoicedPartPaid({ ...TA1, payment_status: "partial" })).toBe(false);
    expect(invoicedPartPaid({ ...TA1, payment_amount: 0 })).toBe(false);
  });
});

describe("the stage no longer hides the half payment (R-1710)", () => {
  it("stepper: the Paid step says what came in and what is left", () => {
    const m = quotePaymentState(TA1);
    const paid = quoteLifecycle({
      status: "accepted", paymentStatus: "invoiced", invoiceId: "INV-A1", hasSignature: false,
      provisionStatus: "not_required", paid: false, money: m,
    }).steps.find((s) => s.stage === "paid")!;
    expect(paid.state).not.toBe("done");
    expect(paid.detail).toBe("Part-paid — ₹20,000 received · ₹18,232 still due.");
    expect(partPaidLine(m)).toBe("₹20,000 received · ₹18,232 still due");
  });

  it("list badge and cash line: Invoiced · Partly paid, both halves of the money", () => {
    expect(unifiedStatus(TA1)).toEqual({ label: "Invoiced · Partly paid", kind: "danger" });
    expect(cashNote(TA1)).toEqual({ text: "₹20,000 paid · ₹18,232 left", tone: "owed" });
    expect(unifiedStatus({ ...TA1, payment_amount: 0 }).label).toBe("Invoiced");
  });

  it("the Part-paid tile (/quotes?focus=partial, /payments Partial Quotes) counts it", () => {
    expect(quoteInFocus(TA1, "partial")).toBe(true);
    expect(quoteInFocus({ ...TA1, payment_amount: 0 }, "partial")).toBe(false);
    expect(quoteInFocus({ ...TA1, payment_amount: 38232 }, "partial")).toBe(false);
  });

  it("the quote page header and the /payments tile read the same helpers", () => {
    const SRC = join(__dirname, "../..");
    const page = readFileSync(join(SRC, "app/(app)/quotes/[id]/page.tsx"), "utf8");
    expect(page).toMatch(/invoicedPartPaid\(quote\)/);
    expect(page).toMatch(/money: quotePaymentState\(quote\)/);
    const payments = readFileSync(join(SRC, "app/(app)/payments/page.tsx"), "utf8");
    expect(payments).toMatch(/quoteInFocus\(q, "partial"\)/);
    expect(payments).not.toMatch(/payment_status === "partial"\)/);
  });
});
