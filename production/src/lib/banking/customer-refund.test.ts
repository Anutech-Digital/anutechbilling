/* R-2322 — Banking → Reconcile → a money-out line → "Customer refund".
   Owner's example (R-2319 staging run, 31 Oct): a refund to a customer (Novoguild ₹41,832) had no
   customer-refund choice. The refundable list comes from customer_refundable_items (server); these
   helpers decide what the screen offers for THIS line and what it says. */
import { describe, expect, it } from "vitest";

import {
  defaultRefundReason, guessRefundCustomer, pickDefaultRefundItem, refundItemLabel, refundItemProblem, refundReasonProblem,
  type RefundableItem,
} from "./customer-refund";

const cn: RefundableItem = {
  payment_id: "p-cn", kind: "credit_note", refundable: 41832, whole_only: false,
  invoice_id: "INV-ANU-26-0042", credit_notes: "CN-ANU-26-0007", voucher_no: "RV-0042", received_on: "2026-09-12",
};
const adv: RefundableItem = {
  payment_id: "p-adv", kind: "advance", refundable: 10000, whole_only: true,
  invoice_id: null, credit_notes: null, voucher_no: "RV-0050", received_on: "2026-10-21",
};

describe("refundItemLabel", () => {
  it("names the credit note and invoice, or the advance receipt", () => {
    expect(refundItemLabel(cn)).toBe("Credit note CN-ANU-26-0007 on INV-ANU-26-0042 · up to ₹41,832");
    expect(refundItemLabel(adv)).toBe("Unused advance RV-0050 (21 Oct 2026) · ₹10,000");
  });
});

describe("refundItemProblem — the bank line is the amount", () => {
  it("a credit note takes any amount up to its open credit, never more", () => {
    expect(refundItemProblem(cn, 41832)).toBeNull();
    expect(refundItemProblem(cn, 1500)).toBeNull();
    expect(refundItemProblem(cn, 41833)).toBe("Only ₹41,832 can be refunded here — issue a credit note for the rest first.");
  });
  it("an advance goes back whole", () => {
    expect(refundItemProblem(adv, 10000)).toBeNull();
    expect(refundItemProblem(adv, 6000)).toBe("This advance is ₹10,000 — an advance is refunded whole, so the line must be ₹10,000.");
  });
});

describe("pickDefaultRefundItem", () => {
  it("prefers an exact amount, else the first one that fits, else nothing", () => {
    expect(pickDefaultRefundItem([cn, adv], 10000)).toBe("p-adv");
    expect(pickDefaultRefundItem([adv, cn], 1500)).toBe("p-cn");
    expect(pickDefaultRefundItem([adv], 1500)).toBeNull();
    expect(pickDefaultRefundItem([], 1500)).toBeNull();
  });
});

describe("refundReasonProblem", () => {
  it("needs 5+ characters (it is printed on the refund voucher)", () => {
    expect(refundReasonProblem("  ab ")).toBe("Write why the money went back (at least 5 characters).");
    expect(refundReasonProblem("Seats removed")).toBeNull();
  });
});

describe("guessRefundCustomer", () => {
  const customers = [
    { id: "c1", name: "Novoguild Technologies Pvt Ltd" },
    { id: "c2", name: "Acme" },
    { id: "c3", name: "Info Systems" },
  ];
  it("finds the customer whose name is in the narration", () => {
    expect(guessRefundCustomer("NEFT-HDFCN52026103112345-NOVOGUILD TECHNOLOGIES-REFUND", customers)).toBe("c1");
    expect(guessRefundCustomer("IMPS/ACME/REFUND", customers)).toBe("c2");
  });
  it("no guess on common words or two matches", () => {
    expect(guessRefundCustomer("NEFT SYSTEMS UPGRADE", customers)).toBeNull();
    expect(guessRefundCustomer("NOVOGUILD ACME", customers)).toBeNull();
    expect(guessRefundCustomer(null, customers)).toBeNull();
  });
});

describe("defaultRefundReason", () => {
  it("names what is refunded, so the voucher says it without typing", () => {
    expect(defaultRefundReason(cn)).toBe("Refund of credit note CN-ANU-26-0007 on INV-ANU-26-0042");
    expect(defaultRefundReason(adv)).toBe("Refund of unused advance RV-0050");
  });
});
