/**
 * R-1444 — the payment reference is optional for every method (Pardeep, staging 14 Oct:
 * "cash/UPI without ref"). A typed reference is still checked (a junk UTR is still refused);
 * a blank one is saved as "<Method> <date> <IST time>" — never blank — because record_payment
 * treats the same reference twice on one quote as a replay and would drop the second payment.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { blankReference, cashReference } from "@/lib/payments/record-payment-toast";
import { recordPaymentSchema } from "@/components/features/quotes/record-payment-dialog";
import { multiInvoicePaymentSchema } from "./multi-invoice-payment-dialog";
import { referenceLabel } from "./payment-entry-fields";

const AT = new Date("2026-10-07T04:30:15Z"); // 10:00:15 IST

describe("R-1444 blank reference is filled, unique per submit", () => {
  it("names the method, the date and the IST time", () => {
    expect(blankReference("upi", "2026-09-01", AT)).toBe("UPI 2026-09-01 10:00:15");
    expect(blankReference("bank_transfer", "2026-09-01", AT)).toBe("Bank transfer 2026-09-01 10:00:15");
    expect(blankReference("cheque", "2026-09-01", AT)).toBe("Cheque 2026-09-01 10:00:15");
  });
  it("cash keeps its old form", () => {
    expect(blankReference("cash", "2026-10-07", AT)).toBe(cashReference("2026-10-07", AT));
  });
});

describe("R-1444 forms accept an empty reference", () => {
  const rp = { amount: 1000, receivedDate: "2026-09-01", tdsDeducted: false, tdsSection: "194J", tdsRatePct: 10 };
  it("Record payment: blank is fine for UPI / bank / cheque; junk is still refused", () => {
    for (const method of ["upi", "bank_transfer", "cheque", "razorpay", "other", "cash"]) {
      expect(recordPaymentSchema.safeParse({ ...rp, method, reference: "" }).success, method).toBe(true);
    }
    expect(recordPaymentSchema.safeParse({ ...rp, method: "upi", reference: "abc" }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ ...rp, method: "bank_transfer", reference: "dfg" }).success).toBe(false);
  });
  it("Pay several invoices: blank bank reference is fine", () => {
    const base = { customerId: "c1", received: 100, receivedDate: "2026-10-17", bankAccountId: "", excessToCredit: true, lines: [] };
    expect(multiInvoicePaymentSchema.safeParse({ ...base, method: "bank_transfer", reference: "" }).success).toBe(true);
  });
  it("the label says Optional and no form marks it required", () => {
    expect(referenceLabel("upi")).toMatch(/\(Optional\)$/);
    expect(referenceLabel("bank_transfer")).toMatch(/\(Optional\)$/);
    for (const f of [
      "src/components/features/quotes/record-payment-dialog.tsx",
      "src/components/features/payments/multi-invoice-payment-dialog.tsx",
      "src/components/features/quotes/edit-payment-dialog.tsx",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/required=\{method !== "cash"\}/);
      expect(src, f).not.toContain('"Transaction reference required"');
      expect(src, f).toContain("blankReference(");
    }
  });
});
