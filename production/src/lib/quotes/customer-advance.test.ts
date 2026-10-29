import { describe, it, expect } from "vitest";
import {
  isCustomerAdvanceQuote, customerAdvanceStatus, advanceAvailable, advanceToUse, ADVANCE_QUOTE_PLAN,
} from "./customer-advance";
import { unifiedStatus, cashNote } from "./status-badge";
import { quoteInFocus } from "./focus";

/* The owner's example (R-2023, staging 27 Oct): LINKS INFOTECH paid ₹47,348 before anything was
   sold; R-1863 booked it on Q-A378-27-0019 — ₹0, no lines, accepted, payment_status received. */
const LINKS_ADVANCE = {
  id: "Q-A378-27-0019",
  plan: ADVANCE_QUOTE_PLAN,
  amount: 0,
  line_items: [] as unknown[],
  invoice_id: null,
  status: "accepted" as const,
  payment_status: "received" as const,
  payment_amount: 47348,
  is_one_off: true,
};

describe("R-2023 — a customer advance is not a sale", () => {
  it("recognises the R-1863 holder quote and nothing else", () => {
    expect(isCustomerAdvanceQuote(LINKS_ADVANCE)).toBe(true);
    expect(isCustomerAdvanceQuote({ ...LINKS_ADVANCE, amount: 5900 })).toBe(false);
    expect(isCustomerAdvanceQuote({ ...LINKS_ADVANCE, invoice_id: "INV-1" })).toBe(false);
    expect(isCustomerAdvanceQuote({ ...LINKS_ADVANCE, plan: "Google Workspace" })).toBe(false);
    expect(isCustomerAdvanceQuote({ ...LINKS_ADVANCE, line_items: [{ name: "x" }] })).toBe(false);
    expect(isCustomerAdvanceQuote(null)).toBe(false);
  });

  it("the list badge reads 'Customer advance', never 'Paid' / 'Accepted'", () => {
    const s = unifiedStatus(LINKS_ADVANCE as never);
    expect(s.label).toBe("Customer advance");
    expect(s.label).not.toMatch(/paid|accepted/i);
  });

  it("the list cash note says the advance amount, not ₹0", () => {
    expect(cashNote(LINKS_ADVANCE as never)?.text).toBe("₹47,348 advance");
  });

  it("is not counted as 'paid, GST invoice not raised' (to-invoice focus)", () => {
    expect(quoteInFocus(LINKS_ADVANCE, "to-invoice")).toBe(false);
    // An ordinary paid quote still is.
    expect(quoteInFocus({ ...LINKS_ADVANCE, plan: "Google Workspace", amount: 47348, line_items: [{}] }, "to-invoice")).toBe(true);
  });

  it("status line: available, else fully used", () => {
    expect(customerAdvanceStatus(47348)).toBe("Customer advance · ₹47,348 available");
    expect(customerAdvanceStatus(0)).toBe("Customer advance · fully used");
  });

  it("available = open credit rows only", () => {
    expect(advanceAvailable([{ amount: 40000, status: "open" }, { amount: 7348, status: "used" }])).toBe(40000);
  });

  it("Use advance: full by default, partial when typed, never above the bill or the advance", () => {
    expect(advanceToUse({ available: 47348, owed: 5900, typed: null })).toBe(5900);
    expect(advanceToUse({ available: 47348, owed: 59000, typed: null })).toBe(47348);
    expect(advanceToUse({ available: 47348, owed: 5900, typed: 2000 })).toBe(2000);
    expect(advanceToUse({ available: 47348, owed: 5900, typed: 99999 })).toBe(5900);
    expect(advanceToUse({ available: 47348, owed: 5900, typed: -5 })).toBe(0);
  });
});
